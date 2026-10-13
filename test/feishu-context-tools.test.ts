import test from "node:test";
import assert from "node:assert/strict";
import { createFeishuContextExtension, type FeishuContextScope } from "../src/adapters/pi/feishu-context-tools.ts";

function fixture(transport: any, initialScope: FeishuContextScope | undefined = { chatId: "chat-current", threadId: "thread-current", messageId: "message-current" }) {
  let definition: any;
  let scope = initialScope;
  createFeishuContextExtension({ getTransport: () => transport, getScope: () => scope })({
    registerTool: (tool: any) => { definition = tool; },
  } as any);
  assert.equal(definition.name, "feishu_read_context");
  return {
    definition,
    setScope: (value: FeishuContextScope | undefined) => { scope = value; },
    async read(params: Record<string, unknown> = {}, signal?: AbortSignal) {
      const output = await definition.execute("test-call", params, signal);
      return JSON.parse(output.content[0].text);
    },
  };
}

test("the native context tool reads an exact card and its verified quote metadata", async () => {
  const calls: any[] = [];
  const tool = fixture({
    getBotOpenId: () => "bot-current",
    getQuotedContext: async (...args: any[]) => {
      calls.push(args);
      return {
        text: "Alert: failed deployment",
        messages: [{ messageId: "card", chatId: "chat-current", msgType: "interactive" }],
        messageIds: ["card"],
        attachments: [{ kind: "image", fileKey: "image-key", sourceMessageId: "card" }],
        failures: [],
        truncated: false,
      };
    },
  });
  const result = await tool.read({ message_id: "card" });
  assert.equal(result.status, "ok");
  assert.equal(result.text, "Alert: failed deployment");
  assert.deepEqual(result.attachments, [{ kind: "image", fileKey: "image-key", sourceMessageId: "card" }]);
  assert.deepEqual(calls, [[{ parentId: "card", chatId: "chat-current", messageId: "message-current" }, "bot-current", 12000]]);
});

test("the native context tool bounds history and pages using a verified same-chat anchor", async () => {
  const calls: any[] = [];
  const tool = fixture({
    getMessage: async (id: string) => ({ messageId: id, chatId: "chat-current", threadId: "thread-current", createTime: 150000 }),
    getRecentGroupMessages: async (...args: any[]) => {
      calls.push(args);
      return [{ sender: "User", text: "Prior task", messageId: "older", chatId: "chat-current", createTime: 140000 }];
    },
  });
  const result = await tool.read({ before_message_id: "anchor", limit: 999 });
  assert.equal(result.status, "ok");
  assert.deepEqual(calls[0], ["chat-current", undefined, ["message-current", "anchor"], 30, { threadId: "thread-current", beforeMs: 150000, includeOwnMessages: true }]);
  assert.equal(result.messages[0].messageId, "older");
  await tool.read({ limit: -3 });
  assert.equal(calls[1][3], 1);
  await tool.read();
  assert.equal(calls[2][3], 10);
});

test("an explicit current-card reread does not exclude the target from the quoted walker", async () => {
  const tool = fixture({
    getBotOpenId: () => "bot-current",
    getQuotedContext: async (request: any) => {
      assert.equal(request.parentId, "message-current");
      assert.equal(request.messageId, undefined);
      return {
        text: "The current card's actual contents",
        messages: [{ messageId: "message-current", chatId: "chat-current", msgType: "interactive" }],
        attachments: [],
        failures: [],
      };
    },
  });
  const result = await tool.read({ message_id: "message-current" });
  assert.equal(result.status, "ok");
  assert.equal(result.text, "The current card's actual contents");
});

test("native history includes prior bot answers and defaults to the triggering event's time", async () => {
  const calls: any[] = [];
  const tool = fixture({
    getMessage: async () => ({ messageId: "older-anchor", chatId: "chat-current", createTime: 90000 }),
    getRecentGroupMessages: async (...args: any[]) => {
      calls.push(args);
      return [{ sender: "bot-current", text: "The bot's prior answer", messageId: "old-answer", chatId: "chat-current", createTime: 80000 }];
    },
  }, { chatId: "chat-current", threadId: "thread-current", messageId: "message-current", createTime: 100000 });
  const history = await tool.read();
  assert.deepEqual(calls[0][4], { threadId: "thread-current", beforeMs: 100000, includeOwnMessages: true });
  assert.equal(history.messages[0].text, "The bot's prior answer");
  await tool.read({ before_message_id: "older-anchor" });
  assert.deepEqual(calls[1][4], { threadId: "thread-current", beforeMs: 90000, includeOwnMessages: true });
});

test("context requests require an active scope and reject conflicting selectors before reading", async () => {
  let calls = 0;
  const tool = fixture({ getRecentGroupMessages: async () => { calls += 1; return []; } });
  assert.equal((await tool.read({ message_id: "one", before_message_id: "two" })).status, "invalid_request");
  tool.setScope(undefined);
  assert.equal((await tool.read()).status, "unavailable");
  assert.equal(calls, 0);
});

test("unverified or cross-chat history anchors fail closed before listing history", async () => {
  for (const anchor of [
    undefined,
    { chatId: "other-chat", createTime: 1000 },
    { createTime: 1000 },
    { chatId: "chat-current" },
    { chatId: "chat-current", createTime: NaN },
    { chatId: "chat-current", createTime: 1000, threadId: "different-thread" },
  ]) {
    let calls = 0;
    const tool = fixture({
      getMessage: async () => anchor,
      getRecentGroupMessages: async () => { calls += 1; return []; },
    });
    const result = await tool.read({ before_message_id: "anchor" });
    assert.notEqual(result.status, "ok");
    assert.equal(calls, 0);
  }
});

test("every retrieved item must belong to the fixed chat and blocked text is not exposed", async () => {
  for (const chatId of [undefined, "other-chat"]) {
    const tool = fixture({
      getBotOpenId: () => "bot-current",
      getQuotedContext: async () => ({
        text: "must not leak",
        messages: [{ messageId: "card", chatId }],
        attachments: [],
        failures: [],
      }),
      getRecentGroupMessages: async () => [{ messageId: "card", sender: "User", text: "must not leak", chatId }],
    });
    for (const result of [await tool.read({ message_id: "card" }), await tool.read()]) {
      assert.equal(result.status, "unavailable");
      assert.equal(JSON.stringify(result).includes("must not leak"), false);
    }
  }
});

test("retrieval errors, partial quote chains, and truncation remain explicit", async () => {
  const tool = fixture({
    getBotOpenId: () => "bot-current",
    getQuotedContext: async () => ({
      text: "x".repeat(14000),
      messages: [{ messageId: "card", chatId: "chat-current" }],
      attachments: [],
      truncated: true,
      failures: ["An ancestor message was unavailable"],
    }),
    getRecentGroupMessages: async () => [
      { messageId: "older", chatId: "chat-current", sender: "User", text: "Known evidence" },
      { sender: "Context retrieval", text: "History page unavailable", notice: "unavailable" },
    ],
  });
  const exact = await tool.read({ message_id: "card" });
  assert.equal(exact.status, "partial");
  assert.equal(exact.truncated, true);
  assert.equal(exact.text.length, 12000);
  assert.equal(exact.limitations.length, 1);
  const history = await tool.read();
  assert.equal(history.status, "partial");
  assert.deepEqual(history.limitations, ["History page unavailable"]);
  assert.equal(history.messages.length, 1);
  const unavailable = fixture({ getRecentGroupMessages: async () => { throw new Error("credential details must not leak"); } });
  const failed = await unavailable.read();
  assert.equal(failed.status, "unavailable");
  assert.equal(JSON.stringify(failed).includes("credential"), false);
  const empty = await fixture({ getRecentGroupMessages: async () => [] }).read();
  assert.match(empty.hint, /does not establish/);
});

test("history content is bounded even when the transport returns oversized messages", async () => {
  const tool = fixture({ getRecentGroupMessages: async () => Array.from({ length: 40 }, (_, i) => ({
    messageId: `message-${i}`, chatId: "chat-current", sender: "User", text: "x".repeat(1000),
  })) });
  const result = await tool.read({ limit: 30 });
  assert.equal(result.messages.length, 30);
  assert.equal(result.messages.reduce((length: number, message: any) => length + message.text.length, 0), 12000);
  assert.equal(result.truncated, true);
});

test("cancelled or replaced conversations never return delayed context", async () => {
  let calls = 0;
  const controller = new AbortController();
  controller.abort();
  const early = fixture({ getRecentGroupMessages: async () => { calls += 1; return []; } });
  await assert.rejects(early.read({}, controller.signal), /cancelled/);
  assert.equal(calls, 0);
  for (const mode of ["abort", "scope"]) {
    let resolve: (value: any[]) => void;
    const pending = new Promise<any[]>((yes) => { resolve = yes; });
    const controller = new AbortController();
    const tool = fixture({ getRecentGroupMessages: () => pending });
    const read = tool.read({}, controller.signal);
    if (mode === "abort") controller.abort();
    else tool.setScope({ chatId: "different-chat", messageId: "new-message" });
    resolve!([{ chatId: "chat-current", sender: "User", text: "Delayed evidence" }]);
    await assert.rejects(read, /cancelled/);
  }
});
