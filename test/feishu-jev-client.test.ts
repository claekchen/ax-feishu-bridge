import test from "node:test";
import assert from "node:assert/strict";
import { JevDecisionClient } from "../src/adapters/pi/feishu-jev-client.ts";
import { SOL_MODEL } from "../src/adapters/pi/feishu-model-routing.ts";

const input = { prompt: "test", currentRequest: "test", history: "", apiKey: "test-only" };
const success = { model: SOL_MODEL, score: 1, confidence: 0.9, reason: "jev" };
const uncertain = { model: undefined, score: 1, confidence: 0.2, reason: "jev_low_confidence_or_invalid" };

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}

test("Jev opens after two errors and recovers with one successful probe", async () => {
  let now = 0;
  let calls = 0;
  const client = new JevDecisionClient({
    now: () => now,
    ask: async () => {
      calls += 1;
      if (calls <= 2) throw new Error("Jev returned HTTP 502");
      return success;
    },
  });
  assert.equal((await client.decide(input)).reason, "jev_error");
  const opened = await client.decide(input);
  assert.equal(opened.error, "http_502");
  assert.equal(opened.retryAfterMs, 30_000);
  assert.equal((await client.decide(input)).reason, "jev_cooldown");
  now = 29_999;
  assert.equal((await client.decide(input)).retryAfterMs, 1);
  assert.equal(calls, 2);
  now = 30_000;
  assert.deepEqual(await client.decide(input), success);
  assert.deepEqual(await client.decide(input), success);
  assert.equal(calls, 4);
});

test("failed probes extend cooldown exponentially and cap it at two minutes", async () => {
  let now = 0;
  let calls = 0;
  const client = new JevDecisionClient({ now: () => now, ask: async () => {
    calls += 1;
    throw new TypeError("network failure");
  } });
  await client.decide(input);
  assert.equal((await client.decide(input)).retryAfterMs, 30_000);
  for (const delay of [60_000, 120_000, 120_000]) {
    now += (await client.decide(input)).retryAfterMs!;
    assert.equal((await client.decide(input)).retryAfterMs, delay);
    assert.equal((await client.decide(input)).reason, "jev_cooldown");
  }
  assert.equal(calls, 5);
});

test("at most two normal calls run and only one recovery probe runs", async () => {
  let now = 0;
  const pending: Array<ReturnType<typeof deferred<typeof success>>> = [];
  const client = new JevDecisionClient({ now: () => now, ask: () => {
    const item = deferred<typeof success>();
    pending.push(item);
    return item.promise;
  } });
  const first = client.decide(input);
  const second = client.decide(input);
  assert.equal((await client.decide(input)).reason, "jev_busy");
  assert.equal(pending.length, 2);
  pending[0].reject(new Error("down"));
  pending[1].reject(new Error("down"));
  await Promise.all([first, second]);
  now = 30_000;
  const probe = client.decide(input);
  assert.equal((await client.decide(input)).reason, "jev_busy");
  assert.equal(pending.length, 3);
  pending[2].resolve(success);
  assert.deepEqual(await probe, success);
});

test("late successes cannot close a cooldown opened by a newer failure", async () => {
  let calls = 0;
  const late = deferred<typeof success>();
  const client = new JevDecisionClient({ now: () => 0, ask: async () => {
    calls += 1;
    if (calls === 2) return late.promise;
    throw new Error("down");
  } });
  await client.decide(input);
  const older = client.decide(input);
  assert.equal((await client.decide(input)).retryAfterMs, 30_000);
  late.resolve(success);
  assert.deepEqual(await older, success);
  assert.equal((await client.decide(input)).reason, "jev_cooldown");
  assert.equal(calls, 3);
});

test("late failures cannot poison successful recovery or extend a newer cooldown", async () => {
  let now = 0;
  let calls = 0;
  const late = deferred<typeof success>();
  const client = new JevDecisionClient({ now: () => now, ask: async () => {
    calls += 1;
    if (calls === 2) return late.promise;
    if (calls === 4) return success;
    throw new Error("down");
  } });
  await client.decide(input);
  const older = client.decide(input);
  await client.decide(input);
  now = 30_000;
  assert.deepEqual(await client.decide(input), success);
  late.reject(new Error("old failure"));
  assert.equal((await older).reason, "jev_error");
  assert.equal((await client.decide(input)).retryAfterMs, undefined);
  assert.equal((await client.decide(input)).retryAfterMs, 30_000);
});

test("late failures leave the deadline from a failed recovery probe unchanged", async () => {
  let now = 0;
  let calls = 0;
  const late = deferred<typeof success>();
  const client = new JevDecisionClient({ now: () => now, ask: async () => {
    calls += 1;
    if (calls === 2) return late.promise;
    throw new Error("down");
  } });
  await client.decide(input);
  const older = client.decide(input);
  await client.decide(input);
  now = 30_000;
  assert.equal((await client.decide(input)).retryAfterMs, 60_000);
  now += 10;
  late.reject(new Error("old failure"));
  assert.equal((await older).retryAfterMs, 59_990);
  assert.equal((await client.decide(input)).retryAfterMs, 59_990);
  assert.equal(calls, 4);
});

test("valid low confidence is success and resets both failures and probe backoff", async () => {
  let now = 0;
  const responses: Array<typeof success | typeof uncertain | Error> = [
    new Error("down"), uncertain, new Error("down"), new Error("down"),
    new Error("down"), uncertain, new Error("down"), new Error("down"),
  ];
  const client = new JevDecisionClient({ now: () => now, ask: async () => {
    const response = responses.shift()!;
    if (response instanceof Error) throw response;
    return response;
  } });
  await client.decide(input);
  assert.deepEqual(await client.decide(input), uncertain);
  assert.equal((await client.decide(input)).retryAfterMs, undefined);
  assert.equal((await client.decide(input)).retryAfterMs, 30_000);
  now = 30_000;
  assert.equal((await client.decide(input)).retryAfterMs, 60_000);
  now = 90_000;
  assert.deepEqual(await client.decide(input), uncertain);
  assert.equal((await client.decide(input)).retryAfterMs, undefined);
  assert.equal((await client.decide(input)).retryAfterMs, 30_000);
});

test("malformed decisions count as failures and errors never echo request data", async () => {
  const invalid = { ...uncertain, score: undefined };
  const client = new JevDecisionClient({ now: () => 0, ask: async () => invalid });
  assert.equal((await client.decide(input)).error, "invalid_response");
  assert.equal((await client.decide(input)).retryAfterMs, 30_000);
  const unsafe = new JevDecisionClient({ now: () => 0, ask: async () => { throw new Error(`failed for ${input.apiKey}: ${input.prompt}`); } });
  const result = await unsafe.decide(input);
  assert.equal(result.error, "request_failed");
  assert.equal(JSON.stringify(result).includes(input.apiKey), false);
});

test("non-finite and out-of-range scores and confidence are malformed responses", async () => {
  for (const invalid of [
    { ...success, score: NaN }, { ...success, score: 4 }, { ...success, score: -1 },
    { ...success, confidence: Infinity }, { ...success, confidence: 1.1 }, { ...success, confidence: -0.1 },
  ]) {
    const client = new JevDecisionClient({ now: () => 0, ask: async () => invalid });
    assert.equal((await client.decide(input)).error, "invalid_response");
  }
});
