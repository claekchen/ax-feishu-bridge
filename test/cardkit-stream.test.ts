import test from "node:test";
import assert from "node:assert/strict";
import { CardKitStream } from "../src/feishu/cardkit-stream.ts";

test("CardKit creates a reply-in-progress card before the first text delta", async () => {
  const originalFetch = globalThis.fetch;
  const calls: Array<{ url: string; init?: RequestInit }> = [];
  globalThis.fetch = async (input, init) => {
    const url = String(input);
    calls.push({ url, init });

    if (url.endsWith("/tenant_access_token/internal")) {
      return new Response(JSON.stringify({ code: 0, tenant_access_token: "token", expire: 7200 }));
    }
    if (url.endsWith("/cardkit/v1/cards")) {
      return new Response(JSON.stringify({ code: 0, data: { card_id: "card-1" } }));
    }
    if (url.endsWith("/messages/incoming-1/reply")) {
      return new Response(JSON.stringify({ code: 0, data: { message_id: "outgoing-1" } }));
    }
    if (url.endsWith("/card-1/settings")) {
      return new Response(JSON.stringify({ code: 0 }));
    }
    if (url.endsWith("/cardkit/v1/cards/card-1")) {
      return new Response(JSON.stringify({ code: 0 }));
    }
    throw new Error(`unexpected fetch: ${url}`);
  };

  try {
    const stream = new CardKitStream(
      "app-id",
      "app-secret",
      "feishu",
      "incoming-1",
      async () => {},
      { conversationKey: "p2p:user", runId: "run-1" },
    );

    await stream.startImmediately();

    assert.equal(calls.length, 3);
    assert.match(calls[0].url, /tenant_access_token\/internal$/);
    assert.match(calls[1].url, /cardkit\/v1\/cards$/);
    assert.match(calls[2].url, /messages\/incoming-1\/reply$/);

    const createPayload = JSON.parse(String(calls[1].init?.body));
    const waitingCard = JSON.parse(createPayload.data);
    assert.equal(waitingCard.header.title.content, "回复中");
    assert.equal(waitingCard.body.elements[0].content, "正在回复…");

    await stream.close();
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("CardKit closes with the shorter authoritative answer after a failed preview", async () => {
  const originalFetch = globalThis.fetch;
  const calls: Array<{ url: string; payload: any }> = [];
  globalThis.fetch = async (input, init) => {
    const url = String(input);
    calls.push({ url, payload: JSON.parse(String(init?.body)) });
    if (url.endsWith("/tenant_access_token/internal")) {
      return new Response(JSON.stringify({ code: 0, tenant_access_token: "token", expire: 7200 }));
    }
    if (url.endsWith("/cardkit/v1/cards")) {
      return new Response(JSON.stringify({ code: 0, data: { card_id: "card-recovery" } }));
    }
    if (url.endsWith("/messages/incoming-recovery/reply")) {
      return new Response(JSON.stringify({ code: 0, data: { message_id: "outgoing-recovery" } }));
    }
    return new Response(JSON.stringify({ code: 0 }));
  };

  const fallbackReplies: string[] = [];
  const stream = new CardKitStream(
    "app-id", "app-secret", "feishu", "incoming-recovery",
    async (text) => { fallbackReplies.push(text); },
    { conversationKey: "p2p:user", runId: "run-recovery", pushIntervalMs: 60000 },
  );
  try {
    await stream.startImmediately();
    stream.append("A long unfinished answer from the model that failed. ");
    await (stream as any).tick();
    stream.append("Recovered.");
    stream.ensureFinal("Recovered draft.");
    await (stream as any).tick();
    await stream.close("Recovered.");

    const contentUpdates = calls.filter((call) => call.url.endsWith("/elements/content/content"));
    assert.equal(contentUpdates[0].payload.content, "A long unfinished answer from the model that failed. ");
    assert.equal(contentUpdates[1].payload.content, "Recovered draft.");
    assert.equal(contentUpdates.at(-1)?.payload.content, "Recovered.");
    const settings = calls.find((call) => call.url.endsWith("/card-recovery/settings"));
    assert.deepEqual(JSON.parse(settings!.payload.settings).config, {
      streaming_mode: false, summary: { content: "Recovered." },
    });
    const finalUpdate = calls.find((call) => call.url.endsWith("/cardkit/v1/cards/card-recovery"));
    const finalCard = JSON.parse(finalUpdate!.payload.card.data);
    assert.equal(finalCard.body.elements[0].content, "Recovered.");
    assert.equal(finalCard.header.title.content, "回复");
    assert.equal(finalCard.config.streaming_mode, false);
    assert.deepEqual(fallbackReplies, []);
  } finally {
    await stream.close();
    globalThis.fetch = originalFetch;
  }
});
