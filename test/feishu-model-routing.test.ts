import test from "node:test";
import assert from "node:assert/strict";
import { askJevDifficulty, isAllowedRoutingModel, isManualSelection, isPriorityRequest, modelForDifficulty, FLASH_MODEL, LUNA_MODEL } from "../src/adapters/pi/feishu-model-routing.ts";
import { PiConversationRuntime } from "../src/adapters/pi/PiConversationRuntime.ts";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { getRuntimeSource, setRuntimeSource } from "../src/feishu/config.ts";
import { buildPromptWithQuote, buildPromptWithRecentMessages, parseBotCommand } from "../src/feishu/messages.ts";
import { ContinuationRouting } from "../src/adapters/pi/feishu-continuation-routing.ts";

const retiredSolModel = { provider: "cliproxyapi", id: "gpt-6-sol" };
const retiredAstraModel = { provider: "cliproxyapi", id: "gpt-6-astra" };

test("priority routing recognizes KDH workspaces and Codex review requests", () => {
  assert.equal(isPriorityRequest("/srv/work/kdh/repo", "hello"), true);
  assert.equal(isPriorityRequest("/srv/work/other", "Please run Codex Review on this PR"), true);
  assert.equal(isPriorityRequest("/srv/work/other", "帮我做代码审查"), true);
  assert.equal(isPriorityRequest("/srv/work/other", "简单问候"), false);
});

test("Jev difficulty stays on the sole primary model while provider fallback remains separate", () => {
  assert.deepEqual(modelForDifficulty({ score: 0, confidence: 0.95 }), LUNA_MODEL);
  assert.deepEqual(modelForDifficulty({ score: 0.5, confidence: 0.6 }), LUNA_MODEL);
  assert.deepEqual(modelForDifficulty({ score: 0.51, confidence: 0.95 }), LUNA_MODEL);
  assert.deepEqual(modelForDifficulty({ score: 1, confidence: 0.95 }), LUNA_MODEL);
  assert.deepEqual(modelForDifficulty({ score: 1.5, confidence: 0.95 }), LUNA_MODEL);
  assert.deepEqual(modelForDifficulty({ score: 1.99, confidence: 0.99 }), LUNA_MODEL);
  assert.deepEqual(modelForDifficulty({ score: 2.5, confidence: 0.95 }), LUNA_MODEL);
  assert.deepEqual(modelForDifficulty({ score: 3, confidence: 1 }), LUNA_MODEL);
  assert.equal(isAllowedRoutingModel(LUNA_MODEL), true);
  assert.equal(isAllowedRoutingModel(FLASH_MODEL), true);
  assert.equal(isAllowedRoutingModel(retiredSolModel), false);
  assert.equal(isAllowedRoutingModel(retiredAstraModel), false);
  assert.equal(isAllowedRoutingModel(undefined), false);
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
      continuationRouting: new ContinuationRouting(),
      routingGeneration: 0,
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
    const session: any = { sessionId: "test-session", model: LUNA_MODEL, messages: [] };
    runtime.ensureSessionFresh = async () => { calls.push("refresh"); return session; };
    runtime.routeModel = async (_key: string, prompt: string) => { calls.push(`route:${prompt}`); return LUNA_MODEL; };
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

test("manual selections are restricted to the two budget-approved models", () => {
  assert.deepEqual(FLASH_MODEL, { provider: "kaon", id: "aliyunus/deepseek-v4.1-flash" });
  assert.equal(isManualSelection(FLASH_MODEL), false);
  assert.equal(isManualSelection({ ...FLASH_MODEL, routingMode: "manual" }), true);
  assert.equal(isManualSelection(retiredSolModel), false);
  assert.equal(isManualSelection({ ...retiredSolModel, routingMode: "manual" }), false);
  assert.equal(isManualSelection({ ...retiredSolModel, routingMode: "auto" }), false);
  assert.equal(isManualSelection(LUNA_MODEL), true);
  assert.equal(isManualSelection({ ...LUNA_MODEL, routingMode: "auto" }), false);
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
  assert.deepEqual(decision.model, LUNA_MODEL);
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
    assert.equal((await runtime.routeModel("test", prompt, false, "codex review this PR")).id, LUNA_MODEL.id);
  });
});

test("budget routing skips Jev and selects Luna for every difficulty", async () => {
  await withRuntime(async (runtime) => {
    runtime.getSession = async () => ({ sessionId: "budget-session", messages: [] });
    runtime.getModelRuntime = async () => ({
      getModel: (provider: string, id: string) => ({ provider, id, input: ["text", "image"] }),
      hasConfiguredAuth: () => true,
    });
    for (const prompt of ["hello", "ordinary task", "difficult architecture task"]) {
      assert.equal((await runtime.routeModel("test", prompt, false, prompt)).id, LUNA_MODEL.id);
    }
  });
});

test("image preflight and routing use Luna and ignore retired manual models", async () => {
  await withRuntime(async (runtime) => {
    runtime.state.models.test = { ...retiredAstraModel, routingMode: "manual" };
    runtime.getSession = async () => ({ model: retiredAstraModel, messages: [] });
    runtime.getModelRuntime = async () => ({
      getModel: (provider: string, id: string) => ({ provider, id, input: id === FLASH_MODEL.id ? ["text"] : ["text", "image"] }),
      hasConfiguredAuth: () => true,
    });
    assert.equal((await runtime.getSelectedModel("test", true)).id, LUNA_MODEL.id);
    assert.equal((await runtime.routeModel("test", "Explain the screenshot", true)).id, LUNA_MODEL.id);
    runtime.state.models.test = { ...FLASH_MODEL, routingMode: "manual" };
    assert.equal((await runtime.getSelectedModel("test", true)).id, LUNA_MODEL.id);
    assert.equal((await runtime.routeModel("test", "Explain the screenshot", true)).id, LUNA_MODEL.id);
  });
});

test("manual selection has an explicit command to return to automatic routing", () => {
  assert.deepEqual(parseBotCommand("/model auto"), { name: "model", automatic: true });
  assert.deepEqual(parseBotCommand("/model"), { name: "model" });
});

test("retired selections fall back to the allowed Luna primary", async () => {
  await withRuntime(async (runtime) => {
    const session = { model: { ...retiredSolModel, input: ["text"] }, messages: [] };
    runtime.state.models.test = { ...retiredSolModel, routingMode: "manual" };
    runtime.sessions.set("test", Promise.resolve(session));
    runtime.getSession = async () => session;
    runtime.getModelRuntime = async () => ({
      getModel: (provider: string, id: string) => ({ provider, id, input: ["text"] }),
      hasConfiguredAuth: () => true,
    });
    assert.equal((await runtime.routeModel("test", "continue", false)).id, LUNA_MODEL.id);
  });
});

test("the first image loads extension-provided vision models without refreshing a live session", async () => {
  await withRuntime(async (runtime) => {
    let loaded = false;
    const flash = { ...FLASH_MODEL, input: ["text"] };
    const sol = { ...LUNA_MODEL, input: ["text", "image"] };
    runtime.getModelRuntime = async () => ({
      getModel: (_provider: string, id: string) => id === FLASH_MODEL.id ? flash : loaded ? sol : undefined,
      getAvailable: async () => loaded ? [flash, sol] : [flash],
      hasConfiguredAuth: () => true,
    });
    runtime.getSession = async () => { loaded = true; return { model: flash, messages: [] }; };
    runtime.ensureSessionFresh = async () => { throw new Error("Image preflight must not refresh a live session"); };
    const selected = await runtime.getSelectedModel("test", true);
    assert.equal(loaded, true);
    assert.equal(selected.id, LUNA_MODEL.id);
    assert.equal(selected.supportsImage, true);
  });
});

function installRoutingSession(runtime: any) {
  const session: any = {
    sessionId: "routing-session", model: { ...FLASH_MODEL, input: ["text"] }, messages: [],
    setModel: async (model: any) => { session.model = model; },
    dispose: () => {},
  };
  runtime.sessions.set("test", Promise.resolve(session));
  runtime.getSession = async () => session;
  runtime.ensureSessionFresh = async () => session;
  runtime.getModelRuntime = async () => ({
    getApiKey: async () => "test-only",
    getModel: (provider: string, id: string) => ({ provider, id, input: ["text", "image"] }),
    hasConfiguredAuth: () => true,
  });
  return session;
}

function completedAssistant(model = LUNA_MODEL) {
  return { role: "assistant", provider: model.provider, model: model.id, stopReason: "stop", content: [{ type: "text", text: "Done" }] };
}

test("a bare continuation keeps the actual successful fallback model without consulting Jev", async () => {
  await withRuntime(async (runtime) => {
    const session = installRoutingSession(runtime);
    runtime.runPromptWithTimeouts = async () => {
      session.model = { ...FLASH_MODEL, input: ["text"] };
      session.messages.push(completedAssistant(FLASH_MODEL));
    };
    await runtime.promptWithImages("test", "Analyze a difficult concurrency bug", [], async () => {});
    assert.equal((await runtime.routeModel("test", "继续")).id, FLASH_MODEL.id);
    assert.equal((await runtime.routeModel("test", "codex review")).id, LUNA_MODEL.id);
  });
});

test("new requirements and enriched continuation prompts use the budget-capped primary", async () => {
  await withRuntime(async (runtime) => {
    const session = installRoutingSession(runtime);
    runtime.continuationRouting.record("test", { sessionId: session.sessionId, workspace: runtime.cwd, model: LUNA_MODEL });
    assert.equal((await runtime.routeModel("test", "继续")).id, LUNA_MODEL.id);
    for (const [prompt, currentRequest] of [
      ["继续，并检查并发锁", "继续，并检查并发锁"],
      [buildPromptWithQuote("继续", { msgType: "text", text: "A new task" }), "继续"],
      [buildPromptWithRecentMessages("继续", [{ sender: "someone", text: "Another task" }]), "继续"],
      ["继续\n\nATTACHED_FILE", "继续"],
    ]) {
      assert.equal((await runtime.routeModel("test", prompt, false, currentRequest)).id, LUNA_MODEL.id);
    }
  });
});

test("failed, aborted, stopped, intercepted, and reset turns cannot reuse an older success", async () => {
  for (const mode of ["error", "aborted", "stopped", "intercepted", "reset"]) {
    await withRuntime(async (runtime) => {
      const session = installRoutingSession(runtime);
      session.messages.push(completedAssistant());
      runtime.continuationRouting.record("test", { sessionId: session.sessionId, workspace: runtime.cwd, model: LUNA_MODEL });
      runtime.runPromptWithTimeouts = async () => {
        if (mode === "error") throw new Error("Test provider failure");
        if (mode === "aborted") session.messages.push({ ...completedAssistant(), stopReason: "aborted" });
        if (mode === "stopped") runtime.activeRuns.get("test").stopped = true;
        if (mode === "reset") {
          runtime.resetMemory();
          session.messages.push(completedAssistant(LUNA_MODEL));
        }
      };
      await runtime.promptWithImages("test", "Start a different task", [], async () => {});
      assert.equal(runtime.continuationRouting.get("test", {
        sessionId: session.sessionId, workspace: runtime.cwd, currentRequest: "continue",
      }), undefined, mode);
    });
  }
});

test("the budget cap routes retired models to Luna and applies the fixed rules without Jev", async () => {
  await withRuntime(async (runtime) => {
    const session = installRoutingSession(runtime);
    session.model = { ...retiredAstraModel, input: ["text"] };
    runtime.state.models.test = { ...retiredAstraModel, routingMode: "manual" };
    for (let i = 0; i < 4; i++) assert.equal((await runtime.routeModel("test", "A new task")).id, LUNA_MODEL.id);
    assert.equal((await runtime.routeModel("test", "kdh task")).id, LUNA_MODEL.id);
  });
});
