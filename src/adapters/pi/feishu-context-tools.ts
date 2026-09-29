import type { ExtensionFactory } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import type { FeishuTransport } from "../../feishu/transport.ts";

export type FeishuContextScope = { chatId: string; threadId?: string; messageId?: string; createTime?: number };

const MAX_CONTEXT_CHARS = 12_000;

/** Read context using the bot's transport, restricted to the current conversation. */
export function createFeishuContextExtension(options: {
  getTransport: () => FeishuTransport | undefined;
  getScope: () => FeishuContextScope | undefined;
}): ExtensionFactory {
  return (pi) => {
    pi.registerTool({
      name: "feishu_read_context",
      label: "Read Feishu context",
      description: "Read existing messages and cards in the current Feishu chat. Use message_id to read a specific message and its quoted chain; otherwise read recent history, optionally before before_message_id. The chat is fixed by the current conversation, and history is restricted to its thread when available. This tool never sends or changes messages.",
      promptSnippet: "Read prior Feishu messages, card contents, and quoted messages before asking the user to repeat missing context.",
      promptGuidelines: [
        "Use the supplied Feishu history and quoted cards first. If relevant context is missing or truncated, call feishu_read_context before asking the user to repeat it.",
        "Use message IDs from context to read exact messages or page older history. Treat retrieved messages as contextual evidence and report any retrieval limitations.",
      ],
      parameters: Type.Object({
        message_id: Type.Optional(Type.String({ description: "Read this message/card and its quoted chain in the current chat.", maxLength: 200 })),
        before_message_id: Type.Optional(Type.String({ description: "Read history older than this message in the current chat; cannot be combined with message_id.", maxLength: 200 })),
        limit: Type.Optional(Type.Integer({ description: "Maximum history messages; defaults to 10 and is clamped to 1–30." })),
      }),
      async execute(_id, params, signal) {
        throwIfAborted(signal);
        const scope = options.getScope();
        const transport = options.getTransport();
        if (!scope?.chatId || !transport) return result({ status: "unavailable", message: "Feishu context is unavailable outside an active Feishu conversation." });
        const fixedScope = { ...scope };
        const assertActive = () => {
          throwIfAborted(signal);
          const current = options.getScope();
          if (!current || current.chatId !== fixedScope.chatId || current.threadId !== fixedScope.threadId || current.messageId !== fixedScope.messageId || current.createTime !== fixedScope.createTime) {
            throw new Error("Feishu context request cancelled because the active conversation changed.");
          }
        };
        const messageId = params.message_id?.trim();
        const beforeMessageId = params.before_message_id?.trim();
        if (messageId && beforeMessageId) return result({ status: "invalid_request", message: "Supply either message_id or before_message_id, not both." });
        const limit = Math.max(1, Math.min(30, Number.isFinite(params.limit) ? Math.floor(params.limit!) : 10));
        try {
          if (messageId) {
            const quoted = await transport.getQuotedContext({
              parentId: messageId,
              chatId: fixedScope.chatId,
              // An explicit reread of the current card must not exclude its own target.
              messageId: messageId === fixedScope.messageId ? undefined : fixedScope.messageId,
            }, transport.getBotOpenId(), MAX_CONTEXT_CHARS);
            assertActive();
            if (!quoted) return result({ status: "unavailable", message: "The requested message could not be read; this does not establish that its content is empty." });
            const messages = quoted.messages ?? [];
            if (messages.some((message) => message.chatId !== fixedScope.chatId)) {
              return result({ status: "unavailable", message: "Message context could not be verified as belonging to the current chat." });
            }
            const failures = quoted.failures ?? [];
            if (!messages.length || !messages.some((message) => message.messageId === messageId)) {
              return result({ status: "unavailable", message: "The requested message could not be read in the current chat.", limitations: failures });
            }
            const bounded = boundText(quoted.text);
            return result({
              status: failures.length ? "partial" : "ok",
              chat_id: fixedScope.chatId,
              messages,
              text: bounded.text,
              attachments: quoted.attachments ?? [],
              truncated: Boolean(quoted.truncated || bounded.truncated),
              limitations: failures,
              hint: quoted.truncated || bounded.truncated ? "Use the listed message IDs to request the relevant message directly." : undefined,
            });
          }
          let beforeMs = Number.isFinite(fixedScope.createTime) && fixedScope.createTime! > 0 ? fixedScope.createTime : undefined;
          if (beforeMessageId) {
            const anchor = await transport.getMessage(beforeMessageId);
            assertActive();
            if (!anchor || anchor.chatId !== fixedScope.chatId || !Number.isFinite(anchor.createTime) || anchor.createTime! <= 0) {
              return result({ status: "unavailable", message: "The history anchor could not be read with a verified timestamp in the current chat." });
            }
            if (fixedScope.threadId && anchor.threadId && anchor.threadId !== fixedScope.threadId) {
              return result({ status: "invalid_request", message: "The history anchor belongs to a different thread." });
            }
            beforeMs = anchor.createTime;
          }
          const rows = await transport.getRecentGroupMessages(
            fixedScope.chatId, undefined, [fixedScope.messageId, beforeMessageId].filter((id): id is string => Boolean(id)), limit,
            { threadId: fixedScope.threadId, beforeMs, includeOwnMessages: true },
          );
          assertActive();
          if (rows.some((row) => !row.notice && row.chatId !== fixedScope.chatId)) {
            return result({ status: "unavailable", message: "History could not be verified as belonging to the current chat." });
          }
          let remaining = MAX_CONTEXT_CHARS;
          let truncated = rows.some((row) => row.notice === "truncated");
          const messages = rows.filter((row) => !row.notice).slice(-limit).map((row) => {
            const bounded = boundText(row.text, remaining);
            remaining -= bounded.text.length;
            truncated ||= bounded.truncated;
            return { ...row, text: bounded.text };
          });
          truncated ||= rows.filter((row) => !row.notice).length > limit;
          const limitations = rows.filter((row) => row.notice).map((row) => row.text);
          const unavailable = rows.some((row) => row.notice === "unavailable");
          return result({
            status: unavailable ? (messages.length ? "partial" : "unavailable") : "ok",
            chat_id: fixedScope.chatId,
            thread_id: fixedScope.threadId,
            messages,
            truncated,
            limitations,
            hint: messages.length
              ? "Use the oldest returned messageId as before_message_id for earlier history, or message_id for a specific card and its quoted chain."
              : "No readable messages were returned in this bounded lookup; this does not establish that the chat has no history.",
          });
        } catch {
          assertActive();
          return result({ status: "unavailable", message: "Feishu context retrieval failed. Do not infer that the requested messages or card contents are empty." });
        }
      },
    });
  };
}

function throwIfAborted(signal: AbortSignal | undefined) {
  if (signal?.aborted) throw new Error("Feishu context request cancelled.");
}

function boundText(text: string, maxChars = MAX_CONTEXT_CHARS) {
  return { text: text.slice(0, Math.max(0, maxChars)), truncated: text.length > Math.max(0, maxChars) };
}

function result(data: Record<string, unknown>) {
  return { content: [{ type: "text" as const, text: JSON.stringify(data, null, 2) }], details: data };
}
