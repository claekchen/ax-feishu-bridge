import test from "node:test";
import assert from "node:assert/strict";
import { FeishuMessageHandler } from "../src/feishu/message-handler.ts";

const PNG_1X1 = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=",
  "base64",
);

test("downloads quoted attachments from the parent message", async () => {
  const downloads: string[] = [];
  const transport = {
    downloadImage: async (messageId: string) => {
      downloads.push(messageId);
      return { bytes: PNG_1X1, mimeType: "image/png" };
    },
  };
  const handler = new FeishuMessageHandler({} as never, () => transport as never);

  const result = await (handler as any).processAttachments(
    { messageId: "om_current" },
    [{ kind: "image", fileKey: "img_quoted", sourceMessageId: "om_parent" }],
    true,
  );

  assert.deepEqual(downloads, ["om_parent"]);
  assert.equal(result.imageInputs.length, 1);
});
