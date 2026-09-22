import test from "node:test";
import assert from "node:assert/strict";
import { askJevDifficulty, isManualSelection, isPriorityRequest, modelForDifficulty, ASTRA_MODEL, FLASH_MODEL, SOL_MODEL, TERRA_MODEL } from "../src/adapters/pi/feishu-model-routing.ts";
import { PiConversationRuntime } from "../src/adapters/pi/PiConversationRuntime.ts";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { getRuntimeSource, setRuntimeSource } from "../src/feishu/config.ts";
import { buildPromptWithQuote, buildPromptWithRecentMessages, parseBotCommand } from "../src/feishu/messages.ts";

test("priority routing recognizes KDH workspaces and Codex review requests", () => {
  assert.equal(isPriorityRequest("/srv/work/kdh/repo", "hello"), true);
  assert.equal(isPriorityRequest("/srv/work/other", "Please run Codex Review on this PR"), true);
  assert.equal(isPriorityRequest("/srv/work/other", "帮我做代码审查"), true);
  assert.equal(isPriorityRequest("/srv/work/other", "简单问候"), false);
});

test("Jev difficulty maps to four model tiers conservatively", () => {
  assert.deepEqual(modelForDifficulty({ score: 0.1, confidence: 0.95 }), FLASH_MODEL);
  assert.deepEqual(modelForDifficulty({ score: 1, confidence: 0.95 }), TERRA_MODEL);
  assert.deepEqual(modelForDifficulty({ score: 1.99, confidence: 0.99 }), SOL_MODEL);
  assert.deepEqual(modelForDifficulty({ score: 3, confidence: 1 }), ASTRA_MODEL);
  assert.equal(modelForDifficulty({ score: 3, confidence: 0.3 }), undefined);
  assert.equal(modelForDifficulty({ confidence: 1 }), undefined);
});

async function withRuntime(run: (runtime: any) => Promise<void>) {
  const dir = mkdtempSync(join(tmpdir(), "feishu-router-"));
  const previousAgentDir = process.env.PI_CODING_AGENT_DIR;
  const previousSource = getRuntimeSource();
  process.env.PI_CODING_AGENT_DIR = dir;
  setRuntimeSource({ ...previousSource, debugLogPath: join(dir, "debug.log") });
  try {
    mkdirSync(join(dir, "feishu"), { recursive: true });
    writeFileSync(join(dir, "feishu", "model-router.json"), JSON.stringify({ enabled: true }));
    // Bypass the constructor to keep production state files out of unit tests.
    const runtime: any = Object.create(PiConversationRuntime.prototype);
    Object.assign(runtime, {
      cwd: dir,
      state: { sessions: {}, models: {}, workspaces: {} },
      sessions: new Map(),
      sessionFileStats: new Map(),
      queues: new Map(),
      activeRuns: new Map(),
      timeouts: {},
    });
    await run(runtime);
  } finally {
    setRuntimeSource(previousSource);
    if (previousAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
    else process.env.PI_CODING_AGENT_DIR = previousAgentDir;
    rmSync(dir, { recursive: true, force: true });
  }
}

test("a second turn routes only after the preceding turn has finished", async () => {
  await withRuntime(async (runtime) => {
    const calls: string[] = [];
    let releaseFirst!: () => void;
    let firstStarted!: () => void;
    const waitForFirstStart = new Promise<void>((resolve) => { firstStarted = resolve; });
    const waitForRelease = new Promise<void>((resolve) => { releaseFirst = resolve; });
    const session: any = { sessionId: "test-session", model: SOL_MODEL, messages: [] };
    runtime.ensureSessionFresh = async () => { calls.push("refresh"); return session; };
    runtime.routeModel = async (_key: string, prompt: string) => { calls.push(`route:${prompt}`); return SOL_MODEL; };
    runtime.runPromptWithTimeouts = async (_session: any, prompt: string) => {
      calls.push(`start:${prompt}`);
      if (prompt === "first") {
        firstStarted();
        await waitForRelease;
      }
      session.messages.push({ role: "assistant", stopReason: "stop", content: [{ type: "text", text: prompt }] });
      calls.push(`end:${prompt}`);
    };
    const first = runtime.promptWithImages("test", "first", [], async () => {});
    await waitForFirstStart;
    const second = runtime.promptWithImages("test", "second", [], async () => {});
    await new Promise((resolve) => setImmediate(resolve));
    assert.deepEqual(calls, ["refresh", "route:first", "start:first"]);
    releaseFirst();
    await Promise.all([first, second]);
    assert.ok(calls.indexOf("route:second") > calls.indexOf("end:first"));
  });
});

test("Jev rejects invalid scores and confidence instead of choosing an extreme tier", () => {
  for (const score of [-1, 3.1, NaN, Infinity]) {
    assert.equal(modelForDifficulty({ score, confidence: 1 }), undefined);
  }
  for (const confidence of [-1, 1.1, NaN, Infinity, "1"]) {
    assert.equal(modelForDifficulty({ score: 1, confidence }), undefined);
  }
});

test("explicit Flash selection is manual while legacy Flash defaults remain automatic", () => {
  assert.equal(isManualSelection(FLASH_MODEL), false);
  assert.equal(isManualSelection({ ...FLASH_MODEL, routingMode: "manual" }), true);
  assert.equal(isManualSelection(SOL_MODEL), true);
  assert.equal(isManualSelection({ ...SOL_MODEL, routingMode: "auto" }), false);
});

test("Jev keeps the current request and file content when quoted context is long", async () => {
  const currentRequest = "Find the subtle concurrency bug in the attached file";
  const prompt = buildPromptWithRecentMessages(
    buildPromptWithQuote(`${currentRequest}\nATTACHED_CODE_MARKER`, { msgType: "text", text: "x".repeat(8000) }),
    [{ sender: "someone", text: "y".repeat(8000) }],
  );
  let body: any;
  const fetcher = (async (_url: any, options: any) => {
    body = JSON.parse(options.body);
    return new Response(JSON.stringify({ answers: { difficulty: { score: 3, confidence: 0.9 } } }));
  }) as typeof fetch;
  const decision = await askJevDifficulty({ prompt, currentRequest, history: "Prior task", apiKey: "test-only" }, fetcher);
  assert.deepEqual(decision.model, ASTRA_MODEL);
  assert.equal(body.state.current_request, currentRequest);
  assert.equal(body.state.request_context.includes("ATTACHED_CODE_MARKER"), true);
  assert.ok(body.state.request_context.length <= 8000);
});

test("routing uses current user text for fixed rules and ignores unrelated group mentions", async () => {
  await withRuntime(async (runtime) => {
    runtime.state.models.test = { ...FLASH_MODEL, routingMode: "manual" };
    runtime.getModelRuntime = async () => ({
      getModel: (provider: string, id: string) => ({ provider, id, input: ["text", "image"] }),
      hasConfiguredAuth: () => true,
    });
    const prompt = buildPromptWithRecentMessages("hello", [{ sender: "someone", text: "kdh codex review" }]);
    assert.equal((await runtime.routeModel("test", prompt, false, "hello")).id, FLASH_MODEL.id);
    assert.equal((await runtime.routeModel("test", prompt, false, "codex review this PR")).id, SOL_MODEL.id);
  });
});

test("routing never hot reloads an active session and retains user history across tool results", async () => {
  await withRuntime(async (runtime) => {
    let body: any;
    const previousFetch = globalThis.fetch;
    globalThis.fetch = (async (_url: any, options: any) => {
      body = JSON.parse(options.body);
      return new Response(JSON.stringify({ answers: { difficulty: { score: 2, confidence: 0.9 } } }));
    }) as typeof fetch;
    try {
      runtime.ensureSessionFresh = async () => { throw new Error("An active session must not be refreshed by routing"); };
      runtime.getSession = async () => ({ messages: [
        { role: "user", content: "CURRENT_TASK_CONTEXT" },
        ...Array.from({ length: 10 }, () => ({ role: "toolResult", content: "verbose tool output" })),
      ] });
      runtime.getModelRuntime = async () => ({
        getApiKey: async () => "test-only",
        getModel: (provider: string, id: string) => ({ provider, id, input: ["text"] }),
        hasConfiguredAuth: () => true,
      });
      assert.equal((await runtime.routeModel("test", "continue", false)).id, SOL_MODEL.id);
      assert.equal(body.state.recent_history.includes("CURRENT_TASK_CONTEXT"), true);
      assert.equal(body.state.recent_history.includes("verbose tool output"), false);
    } finally {
      globalThis.fetch = previousFetch;
    }
  });
});

test("image preflight and routing retain vision-capable manual models", async () => {
  await withRuntime(async (runtime) => {
    runtime.state.models.test = { ...ASTRA_MODEL, routingMode: "manual" };
    runtime.getModelRuntime = async () => ({
      getModel: (provider: string, id: string) => ({ provider, id, input: id === FLASH_MODEL.id ? ["text"] : ["text", "image"] }),
      hasConfiguredAuth: () => true,
    });
    assert.equal((await runtime.getSelectedModel("test", true)).id, ASTRA_MODEL.id);
    assert.equal((await runtime.routeModel("test", "Explain the screenshot", true)).id, ASTRA_MODEL.id);
    runtime.state.models.test = { ...FLASH_MODEL, routingMode: "manual" };
    assert.equal((await runtime.getSelectedModel("test", true)).id, SOL_MODEL.id);
    assert.equal((await runtime.routeModel("test", "Explain the screenshot", true)).id, SOL_MODEL.id);
  });
});

test("manual selection has an explicit command to return to automatic routing", () => {
  assert.deepEqual(parseBotCommand("/model auto"), { name: "model", automatic: true });
  assert.deepEqual(parseBotCommand("/model"), { name: "model" });
});

test("unavailable Jev preserves the active model rather than a legacy Flash default", async () => {
  await withRuntime(async (runtime) => {
    const session = { model: { ...SOL_MODEL, input: ["text"] }, messages: [] };
    runtime.state.models.test = { ...FLASH_MODEL };
    runtime.sessions.set("test", Promise.resolve(session));
    runtime.getSession = async () => session;
    runtime.getModelRuntime = async () => ({
      getApiKey: async () => undefined,
      getModel: (provider: string, id: string) => ({ provider, id, input: ["text"] }),
      hasConfiguredAuth: () => true,
    });
    assert.equal((await runtime.routeModel("test", "continue", false)).id, SOL_MODEL.id);
  });
});

test("the first image loads extension-provided vision models without refreshing a live session", async () => {
  await withRuntime(async (runtime) => {
    let loaded = false;
    const flash = { ...FLASH_MODEL, input: ["text"] };
    const sol = { ...SOL_MODEL, input: ["text", "image"] };
    runtime.getModelRuntime = async () => ({
      getModel: (_provider: string, id: string) => id === FLASH_MODEL.id ? flash : loaded ? sol : undefined,
      getAvailable: async () => loaded ? [flash, sol] : [flash],
      hasConfiguredAuth: () => true,
    });
    runtime.getSession = async () => { loaded = true; return { model: flash, messages: [] }; };
    runtime.ensureSessionFresh = async () => { throw new Error("Image preflight must not refresh a live session"); };
    const selected = await runtime.getSelectedModel("test", true);
    assert.equal(loaded, true);
    assert.equal(selected.id, SOL_MODEL.id);
    assert.equal(selected.supportsImage, true);
  });
});
