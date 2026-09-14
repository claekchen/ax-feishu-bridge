import test from "node:test";
import assert from "node:assert/strict";
import { FeishuTransport } from "../src/feishu/transport.ts";

test("removes the bot processing reaction after a message finishes", async () => {
  const calls: unknown[] = [];
  const transport = new FeishuTransport({ sendMaxRetries: 0 } as never, async () => {}, async () => {});
  (transport as any).sdkClient = {
    im: { messageReaction: {
      create: async (input: unknown) => {
        calls.push(["create", input]);
        return { data: { reaction_id: "reaction-1" } };
      },
      delete: async (input: unknown) => {
        calls.push(["delete", input]);
      },
    } },
  };

  transport.startReaction("om_message", "Typing");
  await transport.clearReaction("om_message");

  assert.deepEqual(calls, [
    ["create", {
      path: { message_id: "om_message" },
      data: { reaction_type: { emoji_type: "Typing" } },
    }],
    ["delete", {
      path: { message_id: "om_message", reaction_id: "reaction-1" },
    }],
  ]);
});
