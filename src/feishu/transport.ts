import type { FeishuAttachment, FeishuCardAction, FeishuConfig, FeishuMessage } from "./types.ts";
import { loadConfig } from "./config.ts";
import { debugLog } from "./debug.ts";
import {
  extractPlainTextForTrigger,
  shouldAcceptGroupMessage,
} from "./group-trigger.ts";
import { buildMarkdownCardParts, buildPostMessages, chooseMessageMode } from "./rich-text.ts";
import { withRetry } from "./retry.ts";
import { extractTextFromMsgType } from "./interactive-card.ts";
import { FeishuCardActionWebhook } from "./card-action-webhook.ts";

const TEXT_CHUNK_MAX_BYTES = 120 * 1024;
const HISTORY_MAX_PAGES = 3;
const HISTORY_MAX_MESSAGES = 50;
const HISTORY_MAX_CHARS = 12_000;
const QUOTE_MAX_MESSAGES = 4;
const QUOTE_MAX_ATTACHMENTS = 24;

export type FeishuContextMessageMetadata = {
  messageId: string;
  msgType: string;
  chatId?: string;
  parentId?: string;
  rootId?: string;
  threadId?: string;
  createTime?: number;
};

export type FeishuContextMessage = Partial<FeishuContextMessageMetadata> & {
  sender: string;
  text: string;
  attachments?: FeishuAttachment[];
  notice?: "unavailable" | "truncated";
};

export class BotUnavailableError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "BotUnavailableError";
  }
}

export class FeishuTransport {
  private sdkClient: any;
  private wsClient: any;
  private cardActionWebhook: FeishuCardActionWebhook | undefined;
  private running = false;
  private botOpenId: string | undefined;
  private readonly chatModeCache = new Map<string, "p2p" | "group" | "topic">();
  /** 本 bot 发出的消息 id，用于 alsoOnReply 判定 parent/root */
  private readonly botOutboundMessageIds = new Set<string>();
  private readonly botOutboundMessageOrder: string[] = [];
  private readonly pendingReactions = new Map<string, Promise<string | undefined>>();
  private readonly markdownCopySources = new Map<string, string>();
  private readonly markdownCopySourceOrder: string[] = [];
  private markdownCopySeq = 0;
  private readonly config: FeishuConfig;
  private readonly onMessage: (msg: FeishuMessage) => Promise<void>;
  private readonly onCardAction: (action: FeishuCardAction) => Promise<object | undefined | void>;

  private sendRetries() {
    return this.config.sendMaxRetries ?? 2;
  }

  private async apiCall<T = any>(label: string, fn: () => Promise<T>): Promise<T> {
    return withRetry(fn, { maxRetries: this.sendRetries(), label });
  }

  constructor(
    config: FeishuConfig,
    onMessage: (msg: FeishuMessage) => Promise<void>,
    onCardAction: (action: FeishuCardAction) => Promise<object | undefined | void>,
  ) {
    this.config = config;
    this.onMessage = onMessage;
    this.onCardAction = onCardAction;
  }

  /** 热读有效配置（含 runtime-overrides）；失败回退 constructor 快照 */
  private effectiveConfig(): FeishuConfig {
    return loadConfig() || this.config;
  }

  async start() {
    if (this.running) return;
    const lark = await import("@larksuiteoapi/node-sdk");
    const domain = this.config.domain === "lark" ? lark.Domain.Lark : lark.Domain.Feishu;

    this.sdkClient = new lark.Client({
      appId: this.config.appId,
      appSecret: this.config.appSecret,
      appType: lark.AppType.SelfBuild,
      domain,
      loggerLevel: lark.LoggerLevel.error,
    });

    await this.probeBotOpenId();

    const dispatcher = new lark.EventDispatcher({ loggerLevel: lark.LoggerLevel.error }).register({
      "im.message.receive_v1": async (data: unknown) => this.handleRawMessage(data),
      "im.message.reaction.created_v1": async () => undefined,
      "im.chat.member.bot.added_v1": async () => undefined,
    });

    // Always register the WS card action handler. When the app is connected
    // via WebSocket (which is always the case with WSClient), the Feishu
    // platform delivers card action callbacks through the WS channel.
    // Without this handler the EventDispatcher returns an invalid response
    // to the platform, causing error 200672 on the client.
    dispatcher.register({
      "card.action.trigger": async (data: unknown) => this.handleCardAction(data),
    });

    // Optional webhook server as a backup delivery channel (only used when
    // the developer console is explicitly configured for webhook delivery).
    if (this.cardActionMode() === "webhook") {
      this.cardActionWebhook = new FeishuCardActionWebhook(this.config, async (action) => this.handleCardActionAction(action, "webhook"));
      await this.cardActionWebhook.start();
      debugLog("feishu.card.webhook.endpoint", {
        endpoint: this.cardActionWebhook.getEndpointLabel(),
      });
    }

    this.wsClient = new lark.WSClient({
      appId: this.config.appId,
      appSecret: this.config.appSecret,
      domain,
      loggerLevel: lark.LoggerLevel.error,
    });

    this.running = true;
    try {
      this.wsClient.start({ eventDispatcher: dispatcher });
    } catch (error) {
      this.running = false;
      try { await this.cardActionWebhook?.stop(); } catch {}
      this.cardActionWebhook = undefined;
      throw error;
    }
  }

  async stop() {
    this.running = false;
    try { await this.wsClient?.stop?.(); } catch {}
    try { await this.cardActionWebhook?.stop(); } catch {}
    this.cardActionWebhook = undefined;
  }

  isRunning() {
    return this.running;
  }

  getBotOpenId() {
    return this.botOpenId;
  }

  private async probeBotOpenId() {
    try {
      const res = await this.sdkClient.request({
        url: "/open-apis/bot/v3/info",
        method: "GET",
      });
      this.botOpenId = res?.bot?.open_id || res?.data?.bot?.open_id || res?.data?.open_id;
      if (!this.botOpenId) {
        throw new Error(`bot/v3/info response missing open_id: ${JSON.stringify(res).slice(0, 200)}`);
      }
    } catch (error) {
      throw new BotUnavailableError(error instanceof Error ? error.message : String(error));
    }
  }

  private async handleRawMessage(data: any) {
    const event = data?.event || data;
    const message = event?.message;
    const sender = event?.sender;
    if (!message) return;

    const cfg = this.effectiveConfig();
    if (sender?.sender_type === "bot" && cfg.ignoreBotMessages !== false) {
      debugLog("feishu.message.ignored_bot", {
        messageId: message.message_id,
        messageType: message.message_type,
      });
      return;
    }

    debugLog("feishu.message.received", {
      messageId: message.message_id,
      chatType: message.chat_type,
      messageType: message.message_type,
      senderType: sender?.sender_type || "unknown",
      hasRootId: Boolean(message.root_id),
      hasParentId: Boolean(message.parent_id),
      hasThreadId: Boolean(message.thread_id),
      content: message.content || "",
    });

    if (message.chat_type === "group") {
      const text = extractPlainTextForTrigger(message.message_type || "text", message.content || "");
      const mentioned = this.isMentioned(message);
      const replyToBot = this.isReplyToBot(message);
      const decision = shouldAcceptGroupMessage({
        chatType: "group",
        groupPolicy: cfg.groupPolicy,
        mentioned,
        text,
        keywords: cfg.groupKeywords || [],
        alsoOnReply: Boolean(cfg.groupAlsoOnReply),
        replyToBot,
      });
      if (!decision.accept) {
        debugLog(`feishu.message.ignored_${decision.reason}`, {
          messageId: message.message_id,
          reason: decision.reason,
          mentioned,
          replyToBot,
          keywords: cfg.groupKeywords || [],
        });
        return;
      }
      if (decision.reason !== "open") {
        debugLog("feishu.message.trigger", {
          messageId: message.message_id,
          reason: decision.reason,
        });
      }
    }

    const chatMode = await this.getChatMode(message.chat_id, message.chat_type);
    const msg: FeishuMessage = {
      messageId: message.message_id,
      chatId: message.chat_id,
      chatType: message.chat_type,
      chatMode,
      senderOpenId: sender?.sender_id?.open_id || "unknown",
      msgType: message.message_type,
      content: message.content || "",
      rootId: message.root_id,
      parentId: message.parent_id,
      threadId: message.thread_id,
      createTime: messageTime(message.create_time),
      mentions: message.mentions,
    };

    if (cfg.reactEmoji) {
      this.startReaction(msg.messageId, cfg.reactEmoji);
    }
    debugLog("feishu.message.dispatch", { messageId: msg.messageId });
    void this.onMessage(msg).catch((error) => {
      debugLog("feishu.message.dispatch_error", {
        messageId: msg.messageId,
        error: error instanceof Error ? error.message : String(error),
      });
    });
  }

  private async handleCardAction(data: any) {
    // After EventDispatcher/RequestHandle.parse() the event fields are
    // flattened to the top level. data.event is gone; use data directly.
    const messageId = data?.context?.open_message_id || data?.open_message_id;
    const chatId = data?.context?.open_chat_id || data?.open_chat_id;
    const operatorOpenId = data?.operator?.open_id;
    if (!messageId || !operatorOpenId) return;
    debugLog("feishu.card.action", {
      messageId,
      chatId,
      hasToken: Boolean(data?.token),
      value: data?.action?.value,
    });
    const result = await this.handleCardActionAction({
      messageId,
      chatId,
      operatorOpenId,
      token: typeof data?.token === "string" ? data.token : undefined,
      value: data?.action?.value,
    }, "ws");
    // The WSClient sends the return value back to the Feishu platform as
    // the card callback response. It must use the wrapped format:
    //   { "card": { "type": "raw", "data": { ... card JSON ... } } }
    if (result) {
      return { card: { type: "raw", data: result } };
    }
    return result;
  }

  private async handleCardActionAction(action: FeishuCardAction, mode: "ws" | "webhook") {
    // 仅返回回调响应即可；不要再 im.message.patch 一份 schema 1.0，
    // 否则会把 CardKit schema 2.0 卡改坏（200830 / 前端 200671）。
    return this.onCardAction(action);
  }

  private cardActionMode() {
    return this.config.cardActionMode || "webhook";
  }

  private isMentioned(message: any): boolean {
    const mentions = Array.isArray(message.mentions) ? message.mentions : [];
    if (!mentions.length) return false;
    const botOpenId = this.botOpenId;
    if (!botOpenId) return true;
    return mentions.some((m: any) => m?.id?.open_id === botOpenId || m?.id?.union_id === botOpenId);
  }

  /** 是否回复/跟帖到本 bot 发出的消息 */
  private isReplyToBot(message: any): boolean {
    const parentId = typeof message.parent_id === "string" ? message.parent_id : "";
    const rootId = typeof message.root_id === "string" ? message.root_id : "";
    if (parentId && this.botOutboundMessageIds.has(parentId)) return true;
    if (rootId && this.botOutboundMessageIds.has(rootId)) return true;
    return false;
  }

  /** 供 ReplyCard / CardKit 登记出站消息 id */
  rememberOutboundMessageId(messageId: string) {
    this.rememberBotOutboundMessageId(messageId);
  }

  private rememberBotOutboundMessageId(messageId: string | undefined) {
    if (!messageId) return;
    if (this.botOutboundMessageIds.has(messageId)) return;
    this.botOutboundMessageIds.add(messageId);
    this.botOutboundMessageOrder.push(messageId);
    while (this.botOutboundMessageOrder.length > 500) {
      const oldest = this.botOutboundMessageOrder.shift();
      if (oldest) this.botOutboundMessageIds.delete(oldest);
    }
  }

  private async getChatMode(chatId: string, chatType: "p2p" | "group"): Promise<"p2p" | "group" | "topic"> {
    if (chatType === "p2p") return "p2p";
    const cached = this.chatModeCache.get(chatId);
    if (cached) return cached;
    try {
      const res = await this.sdkClient.im.v1.chat.get({ path: { chat_id: chatId } });
      const mode = res?.data?.chat_mode === "topic" ? "topic" : "group";
      this.chatModeCache.set(chatId, mode);
      debugLog("feishu.chat.mode", { chatId, mode });
      return mode;
    } catch (error) {
      debugLog("feishu.chat.mode_error", {
        chatId,
        error: error instanceof Error ? error.message : String(error),
      });
      return "group";
    }
  }

  startReaction(messageId: string, emojiType: string) {
    this.pendingReactions.set(messageId, this.addReaction(messageId, emojiType));
  }

  async clearReaction(messageId: string) {
    const pending = this.pendingReactions.get(messageId);
    this.pendingReactions.delete(messageId);
    if (!pending) return;
    const reactionId = await pending;
    if (!reactionId) return;
    try {
      await this.sdkClient.im.messageReaction.delete({
        path: { message_id: messageId, reaction_id: reactionId },
      });
    } catch {}
  }

  private async addReaction(messageId: string, emojiType: string): Promise<string | undefined> {
    try {
      const response = await this.sdkClient.im.messageReaction.create({
        path: { message_id: messageId },
        data: { reaction_type: { emoji_type: emojiType } },
      });
      return response?.data?.reaction_id;
    } catch {
      return undefined;
    }
  }

  async replyText(messageId: string, text: string) {
    const mode = chooseMessageMode(text);
    if (mode === "interactive") {
      await this.replyMarkdownCard(messageId, text);
      return;
    }
    if (mode === "post") {
      await this.replyPost(messageId, text);
      return;
    }
    debugLog("feishu.reply.text", { messageId, length: text.length });
    const chunks = splitText(text, TEXT_CHUNK_MAX_BYTES);
    for (const chunk of chunks) {
      const res = await this.apiCall("feishu.reply.text", () => this.sdkClient.im.message.reply({
        path: { message_id: messageId },
        data: { msg_type: "text", content: JSON.stringify({ text: chunk }) },
      }));
      this.rememberBotOutboundMessageId((res as any)?.data?.message_id as string | undefined);
    }
  }

  async replyPlainText(messageId: string, text: string): Promise<string | undefined> {
    debugLog("feishu.reply.plain_text", { messageId, length: text.length });
    const chunks = splitText(text, TEXT_CHUNK_MAX_BYTES);
    let lastId: string | undefined;
    for (const chunk of chunks) {
      const res = await this.apiCall("feishu.reply.plain_text", () => this.sdkClient.im.message.reply({
        path: { message_id: messageId },
        data: { msg_type: "text", content: JSON.stringify({ text: chunk }) },
      }));
      lastId = (res as any)?.data?.message_id as string | undefined;
      this.rememberBotOutboundMessageId(lastId);
    }
    return lastId;
  }

  /** 更新已发出的 text 消息正文 */
  async updateText(messageId: string, text: string) {
    debugLog("feishu.update.text", { messageId, length: text.length });
    const chunk = splitText(text || "…", TEXT_CHUNK_MAX_BYTES)[0] || "…";
    await this.apiCall("feishu.update.text", () => this.sdkClient.im.v1.message.patch({
      path: { message_id: messageId },
      data: { content: JSON.stringify({ text: chunk }) },
    }));
  }

  async sendText(chatId: string, text: string) {
    const mode = chooseMessageMode(text);
    if (mode === "interactive") {
      await this.sendMarkdownCard(chatId, text);
      return;
    }
    if (mode === "post") {
      await this.sendPost(chatId, text);
      return;
    }
    debugLog("feishu.send.text", { chatId, length: text.length });
    const chunks = splitText(text, TEXT_CHUNK_MAX_BYTES);
    for (const chunk of chunks) {
      const res = await this.apiCall("feishu.send.text", () => this.sdkClient.im.message.create({
        params: { receive_id_type: "chat_id" },
        data: {
          receive_id: chatId,
          msg_type: "text",
          content: JSON.stringify({ text: chunk }),
        },
      }));
      this.rememberBotOutboundMessageId((res as any)?.data?.message_id as string | undefined);
    }
  }

  async replyMarkdownCard(messageId: string, text: string) {
    debugLog("feishu.reply.markdown_card", { messageId, length: text.length });
    for (const { card } of this.buildMarkdownCardPartsWithCopySources(text)) {
      const res = await this.apiCall("feishu.reply.markdown_card", () => this.sdkClient.im.message.reply({
        path: { message_id: messageId },
        data: { msg_type: "interactive", content: JSON.stringify(card) },
      }));
      this.rememberBotOutboundMessageId((res as any)?.data?.message_id as string | undefined);
    }
  }

  async sendMarkdownCard(chatId: string, text: string) {
    debugLog("feishu.send.markdown_card", { chatId, length: text.length });
    for (const { card } of this.buildMarkdownCardPartsWithCopySources(text)) {
      const res = await this.apiCall("feishu.send.markdown_card", () => this.sdkClient.im.message.create({
        params: { receive_id_type: "chat_id" },
        data: {
          receive_id: chatId,
          msg_type: "interactive",
          content: JSON.stringify(card),
        },
      }));
      this.rememberBotOutboundMessageId((res as any)?.data?.message_id as string | undefined);
    }
  }

  getMarkdownCopySource(copySourceId: string) {
    return this.markdownCopySources.get(copySourceId);
  }

  private buildMarkdownCardPartsWithCopySources(text: string) {
    return buildMarkdownCardParts(text, this.config.language, () => this.createMarkdownCopySourceId())
      .map((part) => {
        const copySourceId = extractCopySourceId(part.card);
        if (copySourceId) this.rememberMarkdownCopySource(copySourceId, part.markdown);
        return part;
      });
  }

  private rememberMarkdownCopySource(copySourceId: string, markdown: string) {
    this.markdownCopySources.set(copySourceId, markdown);
    this.markdownCopySourceOrder.push(copySourceId);
    while (this.markdownCopySourceOrder.length > 200) {
      const oldest = this.markdownCopySourceOrder.shift();
      if (oldest) this.markdownCopySources.delete(oldest);
    }
  }

  private createMarkdownCopySourceId() {
    this.markdownCopySeq += 1;
    return `${Date.now().toString(36)}-${this.markdownCopySeq.toString(36)}`;
  }

  async replyCompletionMention(messageId: string, userOpenId: string) {
    const primaryLocale = this.config.language === "en" ? "en_us" : "zh_cn";
    const fallbackLocale = primaryLocale === "en_us" ? "zh_cn" : "en_us";
    const content = (text: string) => ({
      content: [[
        { tag: "at", user_id: userOpenId },
        { tag: "text", text },
      ]],
    });
    const res = await this.sdkClient.im.message.reply({
      path: { message_id: messageId },
      data: {
        msg_type: "post",
        reply_in_thread: true,
        content: JSON.stringify({
          [primaryLocale]: content(primaryLocale === "en_us" ? " Reply complete" : " 回复完成"),
          [fallbackLocale]: content(fallbackLocale === "en_us" ? " Reply complete" : " 回复完成"),
        }),
      },
    });
    this.rememberBotOutboundMessageId((res as any)?.data?.message_id as string | undefined);
  }

  async replyPost(messageId: string, text: string) {
    debugLog("feishu.reply.post", { messageId, length: text.length });
    for (const post of buildPostMessages(text, this.config.language)) {
      const res = await this.sdkClient.im.message.reply({
        path: { message_id: messageId },
        data: { msg_type: "post", content: JSON.stringify(post) },
      });
      this.rememberBotOutboundMessageId((res as any)?.data?.message_id as string | undefined);
    }
  }

  async sendPost(chatId: string, text: string) {
    debugLog("feishu.send.post", { chatId, length: text.length });
    for (const post of buildPostMessages(text, this.config.language)) {
      const res = await this.sdkClient.im.message.create({
        params: { receive_id_type: "chat_id" },
        data: {
          receive_id: chatId,
          msg_type: "post",
          content: JSON.stringify(post),
        },
      });
      this.rememberBotOutboundMessageId((res as any)?.data?.message_id as string | undefined);
    }
  }

  async replyCard(messageId: string, card: object) {
    debugLog("feishu.reply.card", { messageId });
    const res = await this.sdkClient.im.message.reply({
      path: { message_id: messageId },
      data: { msg_type: "interactive", content: JSON.stringify(card) },
    });
    const id = res?.data?.message_id as string | undefined;
    this.rememberBotOutboundMessageId(id);
    return id;
  }

  async updateCard(messageId: string, card: object) {
    debugLog("feishu.update.card", { messageId });
    await this.sdkClient.im.v1.message.patch({
      path: { message_id: messageId },
      data: { content: JSON.stringify(card) },
    });
  }

  async getRecentGroupMessages(
    chatId: string,
    sinceMs: number | undefined,
    excludedMessageIds: string[],
    limit: number,
    options: { threadId?: string; beforeMs?: number; includeOwnMessages?: boolean } = {},
  ): Promise<FeishuContextMessage[]> {
    if (!chatId || !Number.isFinite(limit) || limit <= 0) return [];
    const maximum = Math.min(HISTORY_MAX_MESSAGES, Math.floor(limit));
    const since = Number.isFinite(sinceMs) ? sinceMs : undefined;
    const before = Number.isFinite(options.beforeMs) ? options.beforeMs : undefined;
    const seen = new Set(excludedMessageIds);
    const pageTokens = new Set<string>();
    const messages: FeishuContextMessage[] = [];
    let pageToken: string | undefined;
    let truncated = false;
    let failure = false;
    let totalChars = 0;
    try {
      for (let page = 0; page < HISTORY_MAX_PAGES; page += 1) {
        const res = await this.apiCall<any>("feishu.list_recent_messages", () =>
          this.sdkClient.im.v1.message.list({
            params: {
              container_id_type: options.threadId ? "thread" : "chat",
              container_id: options.threadId || chatId,
              // The thread container does not support server-side time filters.
              ...(!options.threadId && since !== undefined ? { start_time: String(Math.floor(since / 1000)) } : {}),
              ...(!options.threadId && before !== undefined ? { end_time: String(Math.ceil(before / 1000)) } : {}),
              sort_type: "ByCreateTimeDesc",
              page_size: 50,
              card_msg_content_type: "raw_card_content",
              ...(pageToken ? { page_token: pageToken } : {}),
            },
          }),
        );
        assertMessageResponse(res);
        const items = Array.isArray(res?.data?.items) ? res.data.items : [];
        let reachedSince = false;
        for (const item of items) {
          const metadata = messageMetadata(item);
          const messageId = metadata.messageId;
          const senderId = String(item?.sender?.id || "");
          if (!messageId || seen.has(messageId)) continue;
          seen.add(messageId);
          if (item.deleted || (metadata.chatId && metadata.chatId !== chatId)
            || (options.threadId && metadata.threadId && metadata.threadId !== options.threadId)
            || (!options.includeOwnMessages && (this.botOutboundMessageIds.has(messageId)
              || senderId === this.config.appId || (this.botOpenId && senderId === this.botOpenId)))) continue;
          if (metadata.createTime !== undefined) {
            if (since !== undefined && metadata.createTime < since) { reachedSince = true; continue; }
            if (before !== undefined && metadata.createTime >= before) continue;
          } else if (options.threadId && (since !== undefined || before !== undefined)) {
            // An undated thread reply cannot be proven to precede the current turn.
            continue;
          }
          const extracted = extractTextFromMsgType(metadata.msgType, messageContent(item), this.botOpenId);
          const rawText = readableContextText(metadata.msgType, messageContent(item), extracted.text, extracted.attachments);
          if (!rawText) continue;
          if (messages.length >= maximum || totalChars >= HISTORY_MAX_CHARS - 200) {
            truncated = true;
            break;
          }
          const remaining = Math.min(3000, HISTORY_MAX_CHARS - 200 - totalChars);
          const text = boundContextText(rawText, remaining);
          truncated ||= text.length < rawText.length;
          totalChars += text.length;
          messages.push({
            ...metadata,
            sender: String(item?.sender?.sender_name || senderId || "unknown"),
            text,
            ...(extracted.attachments.length ? {
              attachments: extracted.attachments.slice(0, QUOTE_MAX_ATTACHMENTS).map((attachment) => ({ ...attachment, sourceMessageId: messageId })),
            } : {}),
          });
        }
        if (reachedSince || !res?.data?.has_more) break;
        if (messages.length >= maximum || totalChars >= HISTORY_MAX_CHARS - 200 || page + 1 >= HISTORY_MAX_PAGES) {
          truncated = true;
          break;
        }
        const nextToken = res?.data?.page_token;
        if (typeof nextToken !== "string" || !nextToken || pageTokens.has(nextToken)) {
          truncated = true;
          break;
        }
        pageTokens.add(nextToken);
        pageToken = nextToken;
      }
    } catch (error) {
      failure = true;
      debugLog("feishu.list_recent_messages.error", {
        chatId,
        threadId: options.threadId,
        error: error instanceof Error ? error.message : String(error),
      });
    }
    messages.reverse();
    messages.sort((a, b) => a.createTime !== undefined && b.createTime !== undefined ? a.createTime - b.createTime : 0);
    if (failure) messages.unshift({ sender: "Context retrieval", text: "[History unavailable or incomplete: the Feishu message API request failed.]", notice: "unavailable" });
    else if (truncated) messages.unshift({ sender: "Context retrieval", text: "[History truncated: only bounded recent context is included.]", notice: "truncated" });
    return messages;
  }

  /** Fetch raw message content and references without sending any messages. */
  async getMessage(messageId: string): Promise<(FeishuContextMessageMetadata & { content: string }) | undefined> {
    if (!messageId) return undefined;
    try {
      const res = await this.apiCall<any>("feishu.get_message", () =>
        this.sdkClient.im.message.get({
          path: { message_id: messageId },
          params: { card_msg_content_type: "raw_card_content" },
        }),
      );
      assertMessageResponse(res);
      const item = Array.isArray(res?.data?.items) ? res.data.items[0] : res?.data?.message || res?.data;
      if (!item || item.deleted || (!item.body && item.content === undefined)) return undefined;
      return { ...messageMetadata(item, messageId), content: messageContent(item) };
    } catch (error) {
      debugLog("feishu.get_message.error", {
        messageId,
        error: error instanceof Error ? error.message : String(error),
      });
      return undefined;
    }
  }

  async getQuotedContext(
    msg: { parentId?: string; rootId?: string; chatId?: string; messageId?: string },
    botOpenId?: string,
    maxChars = 8000,
  ) {
    const queue = [msg.parentId, msg.rootId].filter((id): id is string => Boolean(id));
    if (!queue.length) return null;
    const visited = new Set<string>(msg.messageId ? [msg.messageId] : []);
    const messages: FeishuContextMessageMetadata[] = [];
    const blocks: Array<{ messageId: string; msgType: string; text: string }> = [];
    const attachments: FeishuAttachment[] = [];
    const attachmentKeys = new Set<string>();
    const failures: string[] = [];
    let expectedChat = msg.chatId;
    let requests = 0;
    let truncated = false;
    while (queue.length && requests < QUOTE_MAX_MESSAGES) {
      const targetId = queue.shift()!;
      if (visited.has(targetId)) continue;
      visited.add(targetId);
      requests += 1;
      const parent = await this.getMessage(targetId);
      if (!parent) {
        failures.push(`${targetId}: message unavailable`);
        continue;
      }
      if (expectedChat && parent.chatId && parent.chatId !== expectedChat) {
        failures.push(`${targetId}: reference belongs to a different chat`);
        continue;
      }
      expectedChat ||= parent.chatId;
      const { content, ...metadata } = parent;
      messages.push(metadata);
      const extracted = extractTextFromMsgType(parent.msgType, content, botOpenId);
      const text = readableContextText(parent.msgType, content, extracted.text, []);
      if (isCardReferenceOnly(parent.msgType, content)) failures.push(`${targetId}: card body unavailable`);
      blocks.push({ messageId: parent.messageId, msgType: parent.msgType, text });
      for (const attachment of extracted.attachments) {
        const key = `${parent.messageId}:${attachment.kind}:${attachment.fileKey}`;
        if (attachmentKeys.has(key)) continue;
        attachmentKeys.add(key);
        if (attachments.length >= QUOTE_MAX_ATTACHMENTS) { truncated = true; continue; }
        attachments.push({ ...attachment, sourceMessageId: parent.messageId });
      }
      for (const reference of [parent.parentId, parent.rootId]) {
        if (reference && !visited.has(reference) && !queue.includes(reference)) queue.push(reference);
      }
    }
    truncated ||= queue.some((id) => !visited.has(id));
    const maxText = Number.isFinite(maxChars) ? Math.max(0, Math.min(32_000, Math.floor(maxChars))) : 8000;
    const warning = failures.length ? `[Quoted context incomplete: ${failures.join("; ")}]` : "";
    // Share the text budget so a long immediate reply cannot hide the root card.
    const labels = blocks.map((block) => `[Quoted message ${block.messageId} (${block.msgType})]`);
    const overhead = warning.length + labels.reduce((sum, label) => sum + label.length + 3, 0) + 100;
    const perMessage = Math.max(0, Math.floor((maxText - overhead) / Math.max(1, blocks.length)));
    const readable = blocks.length === 1 ? blocks[0].text : blocks.map((block, index) => {
      const original = block.text || "[Attachment only]";
      const bounded = boundContextText(original, perMessage);
      truncated ||= bounded.length < original.length;
      return `${labels[index]}\n${bounded}`;
    }).join("\n\n");
    const rawText = [warning, readable, ...(truncated ? ["[Quoted context truncated: content or reference limit reached.]"] : [])].filter(Boolean).join("\n\n");
    const text = boundContextText(rawText, maxText);
    truncated ||= text.length < rawText.length;
    return {
      msgType: messages[0]?.msgType || "unknown",
      text,
      attachments,
      messageIds: messages.map((message) => message.messageId),
      messages,
      truncated,
      failures,
    };
  }

  async downloadMessageResource(messageId: string, fileKey: string, type: "image" | "file"): Promise<{ bytes: Buffer; mimeType?: string }> {
    debugLog("feishu.download.resource.start", { messageId, fileKey, type });
    const result = await this.sdkClient.im.v1.messageResource.get({
      params: { type },
      path: { message_id: messageId, file_key: fileKey },
    });
    const bytes = await streamToBuffer(readableFromDownload(result));
    const rawContentType = result.headers?.["content-type"] || result.headers?.["Content-Type"];
    const mimeType = typeof rawContentType === "string" ? rawContentType.split(";")[0]?.trim() : undefined;
    debugLog("feishu.download.resource.done", { messageId, fileKey, type, bytes: bytes.length, mimeType });
    return { bytes, mimeType: mimeType || undefined };
  }

  async downloadImage(messageId: string, imageKey: string): Promise<{ bytes: Buffer; mimeType?: string }> {
    try {
      return await this.downloadMessageResource(messageId, imageKey, "image");
    } catch (resourceError) {
      debugLog("feishu.download.image.resource_failed", {
        messageId,
        imageKey,
        error: resourceError instanceof Error ? resourceError.message : String(resourceError),
      });
    }

    debugLog("feishu.download.image.fallback_start", { messageId, imageKey });
    const result = await this.sdkClient.im.v1.image.get({
      path: { image_key: imageKey },
    });
    const bytes = await streamToBuffer(readableFromDownload(result));
    debugLog("feishu.download.image.fallback_done", { messageId, imageKey, bytes: bytes.length });
    return { bytes, mimeType: "image/jpeg" };
  }
}

function messageTime(value: unknown): number | undefined {
  if (typeof value !== "string" && typeof value !== "number") return undefined;
  if (typeof value === "string" && !value.trim()) return undefined;
  const time = Number(value);
  return Number.isFinite(time) && time >= 0 ? time : undefined;
}

function messageMetadata(item: any, fallbackId = ""): FeishuContextMessageMetadata {
  const body = item?.body || item || {};
  return {
    messageId: String(item?.message_id || body.message_id || fallbackId),
    msgType: String(item?.msg_type || item?.message_type || body.msg_type || body.message_type || "unknown"),
    chatId: item?.chat_id || body.chat_id,
    parentId: item?.parent_id || body.parent_id,
    rootId: item?.root_id || body.root_id,
    threadId: item?.thread_id || body.thread_id,
    createTime: messageTime(item?.create_time ?? body.create_time),
  };
}

function messageContent(item: any): string {
  const content = (item?.body || item)?.content;
  return typeof content === "string" ? content : JSON.stringify(content || {});
}

function assertMessageResponse(response: any) {
  if (response?.code !== undefined && response.code !== 0) {
    throw new Error(`Feishu message API returned code ${response.code}`);
  }
  if (!response?.data) throw new Error("Feishu message API returned no data");
}

function boundContextText(text: string, maximum: number): string {
  if (text.length <= maximum) return text;
  const suffix = "\n…(truncated)";
  return maximum <= suffix.length ? suffix.slice(0, maximum) : `${text.slice(0, maximum - suffix.length)}${suffix}`;
}

function isCardReferenceOnly(msgType: string, content: string): boolean {
  if (msgType !== "interactive") return false;
  try {
    const parsed = JSON.parse(content);
    const card = parsed?.data || parsed;
    return Boolean(card?.card_id && !card?.json_card && !card?.elements && !card?.body && !card?.header);
  } catch {
    return false;
  }
}

function readableContextText(msgType: string, content: string, text: string, attachments: FeishuAttachment[]): string {
  if (isCardReferenceOnly(msgType, content)) return "[Card body unavailable: Feishu returned only a card reference.]";
  if (text.trim()) return text.trim();
  return attachments.map((attachment) => attachment.kind === "image" ? "[Image attachment]" : `[File attachment: ${attachment.fileName || attachment.fileKey}]`).join("\n");
}

function splitText(text: string, maxBytes: number) {
  const out: string[] = [];
  let rest = text.trim() || "(empty response)";
  while (textPayloadSize(rest) > maxBytes) {
    const cut = findCutIndexByBytes(rest, maxBytes);
    out.push(rest.slice(0, cut));
    rest = rest.slice(cut);
  }
  out.push(rest);
  return out;
}

function findCutIndexByBytes(text: string, maxBytes: number) {
  let low = 1;
  let high = text.length;
  let best = 1;
  while (low <= high) {
    const mid = Math.floor((low + high) / 2);
    const safeMid = avoidHalfSurrogate(text, mid);
    if (safeMid > 0 && textPayloadSize(text.slice(0, safeMid)) <= maxBytes) {
      best = safeMid;
      low = mid + 1;
    } else {
      high = mid - 1;
    }
  }

  const newline = text.lastIndexOf("\n", best);
  if (newline > 0 && newline >= Math.floor(best * 0.6)) return newline + 1;
  return Math.max(1, best);
}

function avoidHalfSurrogate(text: string, index: number) {
  if (index <= 0 || index >= text.length) return index;
  const prev = text.charCodeAt(index - 1);
  if (prev >= 0xd800 && prev <= 0xdbff) return index - 1;
  return index;
}

function byteSize(text: string) {
  return Buffer.byteLength(text, "utf8");
}

function textPayloadSize(text: string) {
  return byteSize(JSON.stringify({ text }));
}

function extractCopySourceId(card: object) {
  const elements = (card as any)?.body?.elements;
  if (!Array.isArray(elements)) return undefined;
  for (const element of elements) {
    const behaviors = element?.behaviors;
    if (!Array.isArray(behaviors)) continue;
    for (const behavior of behaviors) {
      const value = behavior?.value;
      if (value?.action === "pi_feishu_copy_markdown" && typeof value.copySourceId === "string") {
        return value.copySourceId;
      }
    }
  }
  return undefined;
}

async function streamToBuffer(readable: NodeJS.ReadableStream): Promise<Buffer> {
  const chunks: Buffer[] = [];
  for await (const chunk of readable as AsyncIterable<Buffer | string>) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  }
  return Buffer.concat(chunks);
}

function readableFromDownload(result: any): NodeJS.ReadableStream {
  return typeof result?.getReadableStream === "function" ? result.getReadableStream() : result;
}
