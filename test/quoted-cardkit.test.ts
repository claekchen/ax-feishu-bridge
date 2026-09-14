import test from "node:test";
import assert from "node:assert/strict";
import { extractTextFromInteractiveCard } from "../src/feishu/interactive-card.ts";
import { FeishuTransport } from "../src/feishu/transport.ts";

test("extracts visible text from raw CardKit message content", () => {
  const content = JSON.stringify({
    card_schema: 2,
    json_card: JSON.stringify({
      schema: "2.0",
      header: { title: { tag: "plain_text", content: "回复" } },
      body: {
        elements: [{
          tag: "markdown",
          property: {
            elements: [{ tag: "plain_text", property: { content: "PR: https://github.com/acme/repo/pull/42" } }],
          },
        }],
      },
    }),
  });

  const { text } = extractTextFromInteractiveCard(content);
  assert.equal(text, "回复\nPR: https://github.com/acme/repo/pull/42");
  assert.doesNotMatch(text, /json_card|card_schema/);
});

test("requests raw card content when loading a quoted message", async () => {
  let request: unknown;
  const transport = new FeishuTransport({ sendMaxRetries: 0 } as never, async () => {}, async () => {});
  (transport as any).sdkClient = {
    im: { message: { get: async (input: unknown) => {
      request = input;
      return {
        data: { items: [{
          message_id: "om_parent",
          msg_type: "interactive",
          body: { content: JSON.stringify({
            card_schema: 2,
            json_card: JSON.stringify({
              schema: "2.0",
              body: { elements: [{ tag: "markdown", content: "quoted answer" }] },
            }),
          }) },
        }] },
      };
    } } },
  };

  const quoted = await transport.getQuotedContext({ parentId: "om_parent" });
  assert.deepEqual(request, {
    path: { message_id: "om_parent" },
    params: { card_msg_content_type: "raw_card_content" },
  });
  assert.equal(quoted?.text, "quoted answer");
});
