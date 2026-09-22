import test from "node:test";
import assert from "node:assert/strict";
import { ContinuationRouting } from "../src/adapters/pi/feishu-continuation-routing.ts";

const model = { provider: "cliproxyapi", id: "gpt-6-astra" };
const turn = { sessionId: "session-a", workspace: "/workspace/project", model };
const request = { sessionId: turn.sessionId, workspace: turn.workspace, currentRequest: "继续" };

test("only short standalone continuation requests reuse the completed model", () => {
  const routing = new ContinuationRouting();
  routing.record("conversation", turn);
  for (const currentRequest of [
    "继续", "继续吧", "接着做", "下一步", "  继续吧！  ", "下一步。",
    "continue", "CONTINUE!", "go on", "go   on.", "proceed", "keep going", "carry on", "please continue",
  ]) {
    assert.deepEqual(routing.get("conversation", { ...request, currentRequest }), model, currentRequest);
  }
  for (const currentRequest of [
    "", " ", "继续修复鉴权", "继续，但改用另一个模型", "下一步先重构接口",
    "continue with a security review", "please continue and deploy", "don't continue",
    '"继续"', "'continue'", "“继续”", "「继续」", "`continue`", "> continue",
    "/continue", "./continue", "/tmp/继续", "https://example.com/continue", "continue.ts",
    "继续\n下一步", "go\non", "continue!!", "Explain the word continue", "请解释继续是什么意思",
  ]) {
    assert.equal(routing.get("conversation", { ...request, currentRequest }), undefined, currentRequest);
  }
});

test("affinity expires after thirty minutes and lookups do not renew it", () => {
  let now = 100;
  const routing = new ContinuationRouting({ now: () => now });
  routing.record("conversation", turn);
  now += 30 * 60 * 1000 - 1;
  assert.deepEqual(routing.get("conversation", request), model);
  now += 1;
  assert.equal(routing.get("conversation", request), undefined);
});

test("only recording another successful turn renews affinity", () => {
  let now = 0;
  const routing = new ContinuationRouting({ now: () => now, ttlMs: 1000 });
  routing.record("conversation", turn);
  now = 900;
  const fallback = { provider: "kaon", id: "deepseek-flash" };
  routing.record("conversation", { ...turn, model: fallback });
  now = 1100;
  assert.deepEqual(routing.get("conversation", request), fallback);
  now = 1900;
  assert.equal(routing.get("conversation", request), undefined);
});

test("session or workspace changes invalidate the previous affinity", () => {
  const routing = new ContinuationRouting();
  for (const changed of [{ sessionId: "session-b" }, { workspace: "/workspace/another" }]) {
    routing.record("conversation", turn);
    assert.equal(routing.get("conversation", { ...request, ...changed }), undefined);
    assert.equal(routing.get("conversation", request), undefined);
  }
  routing.record("conversation", { ...turn, sessionId: "session-b" });
  assert.deepEqual(routing.get("conversation", { ...request, sessionId: "session-b" }), model);
});

test("clear and reset remove affinity without leaking it between conversations", () => {
  const routing = new ContinuationRouting();
  routing.record("a", turn);
  routing.record("b", turn);
  assert.equal(routing.get("c", request), undefined);
  routing.clear("a");
  assert.equal(routing.get("a", request), undefined);
  assert.deepEqual(routing.get("b", request), model);
  routing.reset();
  assert.equal(routing.get("b", request), undefined);
});

test("bounded affinity retains the latest successful turns rather than recently read entries", () => {
  const routing = new ContinuationRouting({ maxEntries: 2 });
  routing.record("a", turn);
  routing.record("b", turn);
  assert.deepEqual(routing.get("a", request), model);
  routing.record("c", turn);
  assert.equal(routing.get("a", request), undefined);
  assert.deepEqual(routing.get("b", request), model);
  assert.deepEqual(routing.get("c", request), model);
  routing.record("b", turn);
  routing.record("d", turn);
  assert.equal(routing.get("c", request), undefined);
  assert.deepEqual(routing.get("b", request), model);
  assert.deepEqual(routing.get("d", request), model);
});

test("model objects cannot mutate recorded affinity through shared references", () => {
  const routing = new ContinuationRouting();
  const original = { ...model };
  routing.record("conversation", { ...turn, model: original });
  original.id = "changed-at-source";
  const selected = routing.get("conversation", request)!;
  selected.id = "changed-by-consumer";
  assert.deepEqual(routing.get("conversation", request), model);
});

test("invalid expiry and capacity options cannot create unbounded affinity", () => {
  assert.throws(() => new ContinuationRouting({ ttlMs: Infinity }), RangeError);
  assert.throws(() => new ContinuationRouting({ ttlMs: 0 }), RangeError);
  assert.throws(() => new ContinuationRouting({ maxEntries: 0 }), RangeError);
  assert.throws(() => new ContinuationRouting({ maxEntries: 1.5 }), RangeError);
});
