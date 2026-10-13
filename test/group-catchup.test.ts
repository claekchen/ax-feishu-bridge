import test from "node:test";
import assert from "node:assert/strict";
import { buildPromptWithRecentMessages } from "../src/feishu/messages.ts";
import { FeishuTransport } from "../src/feishu/transport.ts";

test("adds intervening group messages before the current prompt", () => {
  const prompt = buildPromptWithRecentMessages("现在总结一下", [
    { sender: "Alice", text: "PR 已经通过 review" },
    { sender: "Bob", text: "CI 也绿了" },
  ]);

  assert.equal(prompt, [
    "[Recent conversation context]",
    "Reference material from this conversation; the current request follows below.",
    "[Alice] PR 已经通过 review",
    "[Bob] CI 也绿了",
    "---",
    "[Current message]",
    "现在总结一下",
  ].join("\n"));
});

test("loads the newest intervening group messages in chronological order", async () => {
  let request: any;
  const transport = new FeishuTransport({ appId: "cli_bot", sendMaxRetries: 0 } as never, async () => {}, async () => {});
  (transport as any).botOutboundMessageIds.add("om_bot");
  (transport as any).sdkClient = {
    im: { v1: { message: { list: async (input: unknown) => {
      request = input;
      return { data: { items: [
        { message_id: "om_current", create_time: "104000", msg_type: "text", sender: { id: "ou_me", sender_name: "Me", sender_type: "user" }, body: { content: JSON.stringify({ text: "current" }) } },
        { message_id: "om_3", create_time: "103000", msg_type: "text", sender: { id: "ou_b", sender_name: "Bob", sender_type: "user" }, body: { content: JSON.stringify({ text: "third" }) } },
        { message_id: "om_bot", create_time: "102000", msg_type: "text", sender: { id: "cli_bot", sender_type: "app" }, body: { content: JSON.stringify({ text: "bot reply" }) } },
        { message_id: "om_2", create_time: "101000", msg_type: "text", sender: { id: "ou_a", sender_name: "Alice", sender_type: "user" }, body: { content: JSON.stringify({ text: "second" }) } },
        { message_id: "om_previous", create_time: "100000", msg_type: "text", sender: { id: "ou_me", sender_name: "Me", sender_type: "user" }, body: { content: JSON.stringify({ text: "previous trigger" }) } },
      ] } };
    } } } },
  };

  const messages = await transport.getRecentGroupMessages(
    "oc_group",
    100_000,
    ["om_previous", "om_current"],
    20,
  );

  assert.deepEqual(request, {
    params: {
      container_id_type: "chat",
      container_id: "oc_group",
      start_time: "100",
      sort_type: "ByCreateTimeDesc",
      page_size: 50,
      card_msg_content_type: "raw_card_content",
    },
  });
  assert.deepEqual(messages.map(({ sender, text }) => ({ sender, text })), [
    { sender: "Alice", text: "second" },
    { sender: "Bob", text: "third" },
  ]);
});
