import test from "node:test";
import assert from "node:assert/strict";
import { FeishuTransport } from "../src/feishu/transport.ts";

test("sends a completion mention to the requester", async () => {
  let request: any;
  const transport = new FeishuTransport({ language: "zh" } as never, async () => {}, async () => {});
  (transport as any).sdkClient = {
    im: { message: { reply: async (input: unknown) => {
      request = input;
      return { data: { message_id: "om_notice" } };
    } } },
  };

  await transport.replyCompletionMention("om_question", "ou_requester");

  assert.equal(request.path.message_id, "om_question");
  assert.equal(request.data.msg_type, "post");
  assert.equal(request.data.reply_in_thread, true);
  const post = JSON.parse(request.data.content);
  assert.deepEqual(post.zh_cn.content, [[
    { tag: "at", user_id: "ou_requester" },
    { tag: "text", text: " 回复完成" },
  ]]);
});
