import test from "node:test";
import assert from "node:assert/strict";
import { isPriorityRequest, modelForDifficulty, FLASH_MODEL, SOL_MODEL, TERRA_MODEL } from "../src/adapters/pi/feishu-model-routing.ts";
import { PiConversationRuntime } from "../src/adapters/pi/PiConversationRuntime.ts";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

test("priority routing recognizes KDH workspaces and Codex review requests", () => {
  assert.equal(isPriorityRequest("/srv/work/kdh/repo", "hello"), true);
  assert.equal(isPriorityRequest("/srv/work/other", "Please run Codex Review on this PR"), true);
  assert.equal(isPriorityRequest("/srv/work/other", "帮我做代码审查"), true);
  assert.equal(isPriorityRequest("/srv/work/other", "简单问候"), false);
});

test("Jev difficulty maps to three authenticated model tiers conservatively", () => {
  assert.deepEqual(modelForDifficulty({ score: 0.1, confidence: 0.95 }), FLASH_MODEL);
  assert.deepEqual(modelForDifficulty({ score: 1, confidence: 0.95 }), SOL_MODEL);
  assert.deepEqual(modelForDifficulty({ score: 1.0 + Number.EPSILON, confidence: 0.95 }), TERRA_MODEL);
  assert.deepEqual(modelForDifficulty({ score: 1.99, confidence: 0.99 }), SOL_MODEL);
  assert.equal(modelForDifficulty({ score: 2, confidence: 0.3 }), undefined);
  assert.equal(modelForDifficulty({ confidence: 1 }), undefined);
});

test("a failed assistant turn retries once on DeepSeek Flash and replies once", async () => {
  const home = mkdtempSync(join(tmpdir(), "feishu-router-"));
  const previousHome = process.env.HOME;
  process.env.HOME = home;
  try {
    mkdirSync(join(home, ".pi", "agent", "feishu"), { recursive: true });
    writeFileSync(join(home, ".pi", "agent", "feishu", "model-router.json"), JSON.stringify({ enabled: true }));
    const runtime = new PiConversationRuntime(home) as any;
    const calls: string[] = [];
    const replies: string[] = [];
    const session: any = {
      sessionId: "test-session",
      model: { ...SOL_MODEL },
      messages: [],
      setModel: async (model: any) => { session.model = model; },
    };
    runtime.ensureSessionFresh = async () => session;
    runtime.getModelRuntime = async () => ({
      getModel: (provider: string, id: string) => ({ provider, id }),
      hasConfiguredAuth: () => true,
    });
    runtime.runPromptWithTimeouts = async (_session: any, text: string) => {
      calls.push(`${session.model.provider}/${session.model.id}`);
      session.messages.push(session.model.id === SOL_MODEL.id
        ? { role: "assistant", stopReason: "error", errorMessage: "upstream failure", content: [] }
        : { role: "assistant", stopReason: "stop", content: [{ type: "text", text: "Recovered" }] });
    };
    await runtime.promptWithImages("p2p:test", "Do the task", [], async (answer: string) => { replies.push(answer); }, undefined, undefined, SOL_MODEL);
    assert.deepEqual(calls, ["cliproxyapi/gpt-5.6-sol", "kaon/aliyunus/deepseek-v4.1-flash"]);
    assert.deepEqual(replies, ["Recovered"]);
  } finally {
    if (previousHome === undefined) delete process.env.HOME;
    else process.env.HOME = previousHome;
    rmSync(home, { recursive: true, force: true });
  }
});
