import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { FeishuMessageHandler } from "../src/feishu/message-handler.ts";
import { FeishuBridgeStore } from "../src/feishu/bridge-store.ts";
import { getRuntimeSource, setRuntimeSource } from "../src/feishu/config.ts";
import { runtimeOverridesPath, setRuntimeOverridesPath } from "../src/feishu/runtime-config.ts";
import { conversationKey } from "../src/feishu/messages.ts";
import type { FeishuMessage } from "../src/feishu/types.ts";

function message(id = "om_current", extra: Partial<FeishuMessage> = {}): FeishuMessage {
  return { messageId: id, chatId: "oc_chat", chatType: "group", threadId: "omt_topic", senderOpenId: "ou_user", msgType: "text", content: JSON.stringify({ text: "看看" }), createTime: 4000, ...extra };
}

async function withHandler(check: (fixture: any) => Promise<void>) {
  const dir = mkdtempSync(join(tmpdir(), "feishu-context-handler-"));
  const previous = getRuntimeSource();
  const previousOverrides = runtimeOverridesPath();
  const source = { ...previous, envPrefix: "CONTEXT_TEST", configPath: join(dir, "config.json"), dedupePath: join(dir, "dedupe.json"), debugLogPath: join(dir, "debug.jsonl"), bridgePath: join(dir, "bridge.json") };
  setRuntimeSource(source);
  setRuntimeOverridesPath(join(dir, "overrides.json"));
  writeFileSync(source.configPath, JSON.stringify({ appId: "test-app", appSecret: "test-secret", groupRecentMessageLimit: 20, streamingReply: false }));
  const prompts: any[][] = [];
  const historyCalls: any[][] = [];
  const quotedCalls: any[] = [];
  const replies: string[] = [];
  const runtime: any = {
    getSelectedModel: async () => ({ provider: "test", id: "vision", supportsImage: true }),
    promptWithImages: async (...args: any[]) => { prompts.push(args); await args[3]("Done"); },
    stopConversation: async (_key: string, onReply: (text: string) => Promise<void>) => { await onReply("Stopped"); },
  };
  const transport: any = {
    getBotOpenId: () => "ou_bot",
    getQuotedContext: async (msg: any) => { quotedCalls.push(msg); return null; },
    getRecentGroupMessages: async (...args: any[]) => { historyCalls.push(args); return []; },
    replyCard: async () => "om_reply",
    updateCard: async () => {},
    replyText: async (_id: string, text: string) => { replies.push(text); },
    clearReaction: async () => {},
  };
  const store = new FeishuBridgeStore();
  const handler = new FeishuMessageHandler(runtime, () => transport, store);
  try { await check({ handler, store, transport, runtime, prompts, historyCalls, quotedCalls, replies }); }
  finally {
    setRuntimeSource(previous);
    setRuntimeOverridesPath(previousOverrides);
    rmSync(dir, { recursive: true, force: true });
  }
}

test("first mention includes prior thread messages and the quoted card exactly once", async () => {
  await withHandler(async ({ handler, transport, prompts, store }) => {
    let historyArgs: any[];
    transport.getRecentGroupMessages = async (...args: any[]) => {
      historyArgs = args;
      return [
        { sender: "Alice", text: "Discussed the rollback yesterday", messageId: "om_history" },
        { sender: "Alert", text: "CARD_MARKER", messageId: "om_card" },
      ];
    };
    transport.getQuotedContext = async () => ({ msgType: "interactive", text: "CARD_MARKER\nhttps://example.com/trace/123", attachments: [], messageIds: ["om_card"] });
    const msg = message("om_current", { parentId: "om_card" });
    await handler.handle(msg);
    assert.equal(historyArgs![1], undefined);
    assert.deepEqual(historyArgs![4], { threadId: "omt_topic", beforeMs: 4000 });
    assert.equal(prompts.length, 1);
    assert.match(prompts[0][1], /Discussed the rollback yesterday/);
    assert.match(prompts[0][1], /https:\/\/example.com\/trace\/123/);
    assert.equal(prompts[0][1].split("CARD_MARKER").length - 1, 1);
    assert.equal(prompts[0][7], "看看");
    assert.deepEqual(prompts[0][8], { chatId: "oc_chat", threadId: "omt_topic", messageId: "om_current", createTime: 4000 });
    assert.equal(store.getRoute(conversationKey(msg)).lastContextTime, 4000);
  });
});

test("image-only quoted messages are downloaded from their own message ID", async () => {
  await withHandler(async ({ handler, transport, prompts }) => {
    transport.getQuotedContext = async () => ({ msgType: "image", text: "", attachments: [{ kind: "image", fileKey: "img_parent", sourceMessageId: "om_parent" }], messageIds: ["om_parent"] });
    const downloaded: string[] = [];
    transport.downloadImage = async (id: string) => {
      downloaded.push(id);
      return { bytes: Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=", "base64"), mimeType: "image/png" };
    };
    await handler.handle(message("om_image_request", { parentId: "om_parent", content: JSON.stringify({ text: "" }) }));
    assert.deepEqual(downloaded, ["om_parent"]);
    assert.equal(prompts.length, 1);
    assert.equal(prompts[0][2].length, 1);
    assert.match(prompts[0][1], /Referenced image or file attachment/);
  });
});

test("two identical requests referencing different cards are both handled", async () => {
  await withHandler(async ({ handler, transport, prompts }) => {
    transport.getQuotedContext = async (msg: any) => ({ msgType: "interactive", text: msg.parentId, attachments: [], messageIds: [msg.parentId] });
    await handler.handle(message("om_one", { parentId: "om_card_one" }));
    await handler.handle(message("om_two", { parentId: "om_card_two", createTime: 5000 }));
    assert.equal(prompts.length, 2);
    assert.match(prompts[0][1], /om_card_one/);
    assert.match(prompts[1][1], /om_card_two/);
  });
});

test("commands skip context I/O and cannot move the consumed-history cursor", async () => {
  await withHandler(async ({ handler, store, historyCalls, quotedCalls, replies }) => {
    const first = message("om_first", { createTime: 1000 });
    await handler.handle(first);
    store.attachSession(conversationKey(first), "session-created-later");
    await handler.handle(message("om_stop", { createTime: 2000, parentId: "om_card", content: JSON.stringify({ text: "/stop" }) }));
    assert.equal(historyCalls.length, 1);
    assert.equal(quotedCalls.length, 0);
    assert.deepEqual(replies, ["Stopped"]);
    assert.equal(store.getRoute(conversationKey(first)).lastContextTime, 1000);
    await handler.handle(message("om_next", { createTime: 3000, content: JSON.stringify({ text: "接着看历史" }) }));
    assert.equal(historyCalls[1][1], 1000);
    assert.equal(store.getRoute(conversationKey(first)).lastContextTime, 3000);
  });
});

test("history failures are passed to the model and do not advance the cursor", async () => {
  await withHandler(async ({ handler, store, transport, prompts }) => {
    const first = message("om_first", { createTime: 1000 });
    await handler.handle(first);
    transport.getRecentGroupMessages = async () => [{ sender: "Context retrieval", text: "History unavailable", notice: "unavailable" }];
    await handler.handle(message("om_next", { createTime: 2000, content: JSON.stringify({ text: "检查前面的错误" }) }));
    assert.match(prompts[1][1], /History unavailable/);
    assert.equal(store.getRoute(conversationKey(first)).lastContextTime, 1000);
  });
});

test("runtime setup failures or stopped turns do not mark unseen history consumed", async () => {
  await withHandler(async ({ handler, store, runtime }) => {
    const first = message("om_first", { createTime: 1000 });
    await handler.handle(first);
    runtime.promptWithImages = async () => {};
    await handler.handle(message("om_failed", { createTime: 2000, content: JSON.stringify({ text: "检查之前的消息" }) }));
    assert.equal(store.getRoute(conversationKey(first)).lastContextTime, 1000);
  });
});

test("history retains a readable parent card when direct quote retrieval fails", async () => {
  await withHandler(async ({ handler, transport, prompts }) => {
    transport.getQuotedContext = async () => ({ msgType: "unknown", text: "Quoted context incomplete", attachments: [], messageIds: [], failures: ["message unavailable"] });
    transport.getRecentGroupMessages = async (_chat: string, _since: any, excluded: string[]) => {
      assert.equal(excluded.includes("om_card"), false);
      return [{ sender: "Alert", text: "Fallback card body from history", messageId: "om_card" }];
    };
    await handler.handle(message("om_current", { parentId: "om_card" }));
    assert.match(prompts[0][1], /Fallback card body from history/);
  });
});

test("a quoted card remains usable when its image is unsupported or cannot download", async () => {
  for (const supportsImage of [false, true]) {
    await withHandler(async ({ handler, transport, runtime, prompts, replies }) => {
      runtime.getSelectedModel = async () => ({ provider: "test", id: "model", supportsImage });
      transport.getQuotedContext = async () => ({ msgType: "interactive", text: "Useful card text without its image", attachments: [{ kind: "image", fileKey: "img_parent", sourceMessageId: "om_card" }], messageIds: ["om_card"] });
      transport.downloadImage = async () => { throw new Error("Test unavailable image"); };
      await handler.handle(message("om_current", { parentId: "om_card", content: JSON.stringify({ text: "" }) }));
      assert.equal(prompts.length, 1);
      assert.match(prompts[0][1], /Useful card text without its image/);
      assert.equal(replies.length, 0);
    });
  }
});
