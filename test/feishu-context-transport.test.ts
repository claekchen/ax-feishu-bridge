import test, { after, before } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { FeishuTransport } from "../src/feishu/transport.ts";
import { getRuntimeSource, setRuntimeSource } from "../src/feishu/config.ts";

const originalSource = getRuntimeSource();
const logDir = mkdtempSync(join(tmpdir(), "feishu-context-transport-"));
before(() => setRuntimeSource({ ...originalSource, debugLogPath: join(logDir, "debug.log") }));
after(() => { setRuntimeSource(originalSource); rmSync(logDir, { recursive: true, force: true }); });

function message(id: string, time: number, text = id, extra: Record<string, unknown> = {}) {
  return {
    message_id: id, create_time: String(time), chat_id: "oc_chat", msg_type: "text",
    sender: { id: "ou_user", sender_name: "Alice", sender_type: "user" },
    body: { content: JSON.stringify({ text }) }, ...extra,
  };
}

function transportWith(handlers: { list?: (request: any) => Promise<any>; get?: (request: any) => Promise<any> }) {
  const transport = new FeishuTransport({ appId: "cli_own", sendMaxRetries: 0 } as never, async () => {}, async () => {});
  (transport as any).sdkClient = {
    im: { v1: { message: { list: handlers.list } }, message: { get: handlers.get } },
  };
  return transport;
}

test("initial history is bounded before the current event and preserves other bots' cards", async () => {
  let request: any;
  const transport = transportWith({ list: async (value) => {
    request = value;
    return { code: 0, data: { items: [
      message("om_later", 101_001), message("om_current", 101_000),
      message("om_card", 100_900, "", { msg_type: "interactive", sender: { id: "cli_other", sender_name: "Alert bot", sender_type: "app" }, body: { content: JSON.stringify({ json_card: JSON.stringify({ elements: [{ tag: "markdown", content: "Alert details" }] }) }) } }),
      message("om_own", 100_800, "own reply", { sender: { id: "cli_own", sender_type: "app" } }),
      message("om_old", 100_100, "earlier", { parent_id: "om_parent", root_id: "om_root", thread_id: "omt_thread" }),
    ] } };
  } });
  const rows = await transport.getRecentGroupMessages("oc_chat", undefined, ["om_current"], 20, { beforeMs: 101_000 });
  assert.equal(request.params.start_time, undefined);
  assert.equal(request.params.end_time, "101");
  assert.equal(request.params.card_msg_content_type, "raw_card_content");
  assert.deepEqual(rows.map((row) => row.messageId), ["om_old", "om_card"]);
  assert.equal(rows[0].createTime, 100_100);
  assert.equal(rows[0].parentId, "om_parent");
  assert.equal(rows[0].rootId, "om_root");
  assert.equal(rows[0].threadId, "omt_thread");
  assert.equal(rows[1].text, "Alert details");
});

test("thread history paginates, deduplicates, and applies local millisecond bounds", async () => {
  const requests: any[] = [];
  const transport = transportWith({ list: async (request) => {
    requests.push(request);
    return requests.length === 1
      ? { data: { has_more: true, page_token: "next", items: [
        message("om_future", 104_000, "future", { thread_id: "omt_t" }),
        message("om_excluded", 102_000, "excluded", { thread_id: "omt_t" }),
        message("om_new", 101_500, "new", { thread_id: "omt_t" }),
      ] } }
      : { data: { has_more: false, items: [
        message("om_new", 101_500, "duplicate", { thread_id: "omt_t" }),
        message("om_old", 100_500, "old", { thread_id: "omt_t" }),
        message("om_before", 99_999, "too old", { thread_id: "omt_t" }),
      ] } };
  } });
  const rows = await transport.getRecentGroupMessages("oc_chat", 100_000, ["om_excluded"], 20, { threadId: "omt_t", beforeMs: 103_000 });
  assert.equal(requests.length, 2);
  assert.equal(requests[0].params.container_id_type, "thread");
  assert.equal(requests[0].params.container_id, "omt_t");
  assert.equal(requests[0].params.start_time, undefined);
  assert.equal(requests[0].params.end_time, undefined);
  assert.equal(requests[1].params.page_token, "next");
  assert.deepEqual(rows.map((row) => row.messageId), ["om_old", "om_new"]);
});

test("explicit context reads may include bot answers while automatic history still excludes them", async () => {
  const transport = transportWith({ list: async () => ({ data: { items: [
    message("om_own", 900, "prior answer", { sender: { id: "cli_own", sender_type: "app" } }),
    message("om_outbound", 800, "remembered answer"),
    message("om_private", 700, "other chat", { chat_id: "oc_private", sender: { id: "cli_own", sender_type: "app" } }),
    message("om_future", 1200, "later answer", { sender: { id: "cli_own", sender_type: "app" } }),
  ] } }) });
  (transport as any).botOutboundMessageIds.add("om_outbound");
  assert.deepEqual(await transport.getRecentGroupMessages("oc_chat", undefined, [], 20, { beforeMs: 1000 }), []);
  const rows = await transport.getRecentGroupMessages("oc_chat", undefined, [], 20, { beforeMs: 1000, includeOwnMessages: true });
  assert.deepEqual(rows.map((row) => row.messageId), ["om_outbound", "om_own"]);
});

test("thread history rejects cross-chat, cross-thread and undated replies", async () => {
  const transport = transportWith({ list: async () => ({ data: { items: [
    message("om_wrong_chat", 500, "private", { chat_id: "oc_other", thread_id: "omt_t" }),
    message("om_wrong_thread", 500, "unrelated", { thread_id: "omt_other" }),
    message("om_undated", 500, "unknown", { create_time: undefined, thread_id: "omt_t" }),
    message("om_allowed", 500, "relevant", { thread_id: "omt_t" }),
  ] } }) });
  const rows = await transport.getRecentGroupMessages("oc_chat", undefined, [], 20, { threadId: "omt_t", beforeMs: 1000 });
  assert.deepEqual(rows.map((row) => row.messageId), ["om_allowed"]);
});

test("history stops at the page budget and reports truncation", async () => {
  let calls = 0;
  const transport = transportWith({ list: async () => {
    calls += 1;
    return { data: { has_more: true, page_token: `page_${calls}`, items: [message(`om_${calls}`, 10_000 - calls)] } };
  } });
  const rows = await transport.getRecentGroupMessages("oc_chat", undefined, [], 1000);
  assert.equal(calls, 3);
  assert.equal(rows[0].notice, "truncated");
  assert.equal(rows.filter((row) => row.messageId).length, 3);
});

test("history bounds text and retains readable image-only references", async () => {
  const transport = transportWith({ list: async () => ({ data: { items: [
    message("om_image", 100_000, "", { msg_type: "image", body: { content: JSON.stringify({ image_key: "img_one" }) } }),
    ...Array.from({ length: 10 }, (_, index) => message(`om_${index}`, 90_000 - index, "x".repeat(20_000))),
  ] } }) });
  const rows = await transport.getRecentGroupMessages("oc_chat", undefined, [], 50);
  assert.ok(rows.reduce((sum, row) => sum + row.text.length, 0) <= 12_000);
  assert.equal(rows[0].notice, "truncated");
  const image = rows.find((row) => row.messageId === "om_image")!;
  assert.equal(image.text, "[Image attachment]");
  assert.deepEqual(image.attachments, [{ kind: "image", fileKey: "img_one", sourceMessageId: "om_image" }]);
});

test("history keeps completed pages and reports non-throwing API errors", async () => {
  let calls = 0;
  const transport = transportWith({ list: async () => ++calls === 1
    ? { data: { has_more: true, page_token: "next", items: [message("om_read", 1000)] } }
    : { code: 99991672, msg: "permission missing" },
  });
  const rows = await transport.getRecentGroupMessages("oc_chat", undefined, [], 20);
  assert.equal(rows[0].notice, "unavailable");
  assert.equal(rows[1].messageId, "om_read");
});

test("quotes expand both immediate reply and root card with references and attachments", async () => {
  const requested: string[] = [];
  const records: Record<string, any> = {
    om_parent: message("om_parent", 3000, "look at the root", { parent_id: "om_mid", root_id: "om_root", thread_id: "omt_t" }),
    om_root: message("om_root", 1000, "", { msg_type: "interactive", body: { content: JSON.stringify({ elements: [{ tag: "markdown", content: "ROOT_ALERT_DETAILS" }, { tag: "img", img_key: "img_root" }] }) } }),
    om_mid: message("om_mid", 2000, "previous reply", { parent_id: "om_root", root_id: "om_root" }),
  };
  const transport = transportWith({ get: async (request) => {
    assert.equal(request.params.card_msg_content_type, "raw_card_content");
    const id = request.path.message_id;
    requested.push(id);
    return { data: { items: [records[id]] } };
  } });
  const quoted = await transport.getQuotedContext({ parentId: "om_parent", rootId: "om_root", chatId: "oc_chat", messageId: "om_current" });
  assert.deepEqual(requested, ["om_parent", "om_root", "om_mid"]);
  assert.deepEqual(quoted?.messageIds, requested);
  assert.match(quoted!.text, /look at the root/);
  assert.match(quoted!.text, /ROOT_ALERT_DETAILS/);
  assert.equal(quoted!.messages[0].threadId, "omt_t");
  assert.equal(quoted!.messages[0].createTime, 3000);
  assert.deepEqual(quoted!.attachments, [{ kind: "image", fileKey: "img_root", sourceMessageId: "om_root" }]);
});

test("image-only quoted messages retain attachments without requiring text", async () => {
  const transport = transportWith({ get: async () => ({ data: { items: [message("om_image", 1000, "", {
    msg_type: "image", body: { content: JSON.stringify({ image_key: "img_one" }) },
  })] } }) });
  const quoted = await transport.getQuotedContext({ parentId: "om_image", chatId: "oc_chat" });
  assert.equal(quoted!.text, "");
  assert.equal(quoted!.attachments[0].sourceMessageId, "om_image");
  assert.deepEqual(quoted!.messageIds, ["om_image"]);
});

test("quote expansion stops at four requests and does not let a long reply hide root content", async () => {
  const requested: string[] = [];
  const transport = transportWith({ get: async (request) => {
    const id = request.path.message_id;
    requested.push(id);
    const index = Number(id.slice(3));
    return { data: { items: [message(id, index, `ROOT_${index}_` + "x".repeat(10_000), { parent_id: `om_${index + 1}` })] } };
  } });
  const quoted = await transport.getQuotedContext({ parentId: "om_1", rootId: "om_2", chatId: "oc_chat" }, undefined, 2000);
  assert.equal(requested.length, 4);
  assert.equal(quoted!.truncated, true);
  assert.ok(quoted!.text.length <= 2000);
  assert.match(quoted!.text, /ROOT_1_/);
  assert.match(quoted!.text, /ROOT_2_/);
});

test("quote failures are explicit and cross-chat references are never included or expanded", async () => {
  const requested: string[] = [];
  const transport = transportWith({ get: async (request) => {
    const id = request.path.message_id;
    requested.push(id);
    return id === "om_bad" ? { data: { items: [message(id, 1000, "SECRET_OTHER_CHAT", { chat_id: "oc_private", parent_id: "om_secret" })] } }
      : { data: { items: [] } };
  } });
  const quoted = await transport.getQuotedContext({ parentId: "om_bad", rootId: "om_missing", chatId: "oc_chat" });
  assert.deepEqual(requested, ["om_bad", "om_missing"]);
  assert.deepEqual(quoted!.messageIds, []);
  assert.equal(quoted!.failures.length, 2);
  assert.match(quoted!.text, /Quoted context incomplete/);
  assert.doesNotMatch(quoted!.text, /SECRET_OTHER_CHAT/);
});

test("card references without raw bodies report the limitation without invented card API calls", async () => {
  let calls = 0;
  const transport = transportWith({ get: async () => {
    calls += 1;
    return { data: { items: [message("om_card", 1000, "", { msg_type: "interactive", body: { content: JSON.stringify({ type: "card", data: { card_id: "card_reference" } }) } })] } };
  } });
  const quoted = await transport.getQuotedContext({ parentId: "om_card", chatId: "oc_chat" });
  assert.equal(calls, 1);
  assert.match(quoted!.text, /Card body unavailable/);
  assert.deepEqual(quoted!.failures, ["om_card: card body unavailable"]);
});

test("incoming event timestamps survive normalization", async () => {
  let received: any;
  const transport = new FeishuTransport({ appId: "cli_own" } as never, async (message) => { received = message; }, async () => {});
  (transport as any).effectiveConfig = () => ({ appId: "cli_own" });
  (transport as any).getChatMode = async () => "p2p";
  await (transport as any).handleRawMessage({ event: { sender: { sender_type: "user", sender_id: { open_id: "ou_user" } }, message: {
    message_id: "om_current", chat_id: "oc_chat", chat_type: "p2p", message_type: "text", content: JSON.stringify({ text: "hello" }), create_time: "1789999123456",
  } } });
  assert.equal(received.createTime, 1789999123456);
});
