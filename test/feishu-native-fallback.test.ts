import test, { after } from "node:test";
import assert from "node:assert/strict";
import { findPackageJSON } from "node:module";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { pathToFileURL } from "node:url";
import { createFlashFallbackExtension, type FallbackRun } from "../src/adapters/pi/feishu-model-fallback.ts";
import { FLASH_MODEL, SOL_MODEL } from "../src/adapters/pi/feishu-model-routing.ts";

// Set the global SDK directory before importing Pi so tests never read real credentials or extensions.
const testDir = mkdtempSync(join(tmpdir(), "feishu-native-fallback-"));
const previousAgentDir = process.env.PI_CODING_AGENT_DIR;
process.env.PI_CODING_AGENT_DIR = testDir;
const { ModelRuntime, SettingsManager, SessionManager, DefaultResourceLoader, createAgentSession } =
  await import("@earendil-works/pi-coding-agent");
const aiPackagePath = findPackageJSON("@earendil-works/pi-ai", import.meta.resolve("@earendil-works/pi-coding-agent"));
const { createAssistantMessageEventStream } = await import(pathToFileURL(join(dirname(aiPackagePath!), "dist/index.js")).href);

after(() => {
  if (previousAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
  else process.env.PI_CODING_AGENT_DIR = previousAgentDir;
  rmSync(testDir, { recursive: true, force: true });
});

type Reply = { stopReason: "stop" | "toolUse" | "error" | "aborted"; content?: any[]; errorMessage?: string };
type Request = { model: string; messages: any[] };

async function withSession(
  reply: (request: Request, index: number, signal: AbortSignal | undefined) => Reply | Promise<Reply>,
  check: (fixture: any) => Promise<void>,
  options: { stopped?: boolean; stopOnModelChange?: boolean } = {},
) {
  const cwd = mkdtempSync(join(testDir, "session-"));
  const settings = SettingsManager.inMemory({
    retry: { enabled: false, maxRetries: 1, baseDelayMs: 1 },
    compaction: { enabled: false },
  });
  const runtime = await ModelRuntime.create({
    authPath: join(cwd, "auth.json"),
    modelsPath: null,
    allowModelNetwork: false,
    modelsStorePath: join(cwd, "models-cache"),
  });
  const requests: Request[] = [];
  const fallbacks: { from: string; error: string }[] = [];
  const events: any[] = [];
  const run: FallbackRun = { stopped: options.stopped ?? false };
  let toolExecutions = 0;
  for (const target of [SOL_MODEL, FLASH_MODEL]) {
    runtime.registerProvider(target.provider, {
      api: "feishu-native-fallback-test",
      apiKey: "isolated-test-key",
      baseUrl: "http://127.0.0.1:1/unused",
      models: [{
        id: target.id,
        name: target.id,
        reasoning: false,
        input: ["text"],
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
        contextWindow: 100000,
        maxTokens: 1000,
      }],
      streamSimple(model: any, context: any, streamOptions: any) {
        const stream = createAssistantMessageEventStream();
        const request = { model: `${model.provider}/${model.id}`, messages: structuredClone(context.messages) };
        const index = requests.push(request) - 1;
        queueMicrotask(async () => {
          try {
            const result = await reply(request, index, streamOptions?.signal);
            const message = {
              role: "assistant",
              api: model.api,
              provider: model.provider,
              model: model.id,
              content: result.content ?? [],
              usage: {
                input: 1, output: 1, cacheRead: 0, cacheWrite: 0, totalTokens: 2,
                cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
              },
              timestamp: Date.now(),
              ...result,
            };
            stream.push({ type: "start", partial: message });
            if (result.stopReason === "error" || result.stopReason === "aborted") {
              stream.push({ type: "error", reason: result.stopReason, error: message });
            } else {
              stream.push({ type: "done", reason: result.stopReason, message });
            }
            stream.end();
          } catch (error) {
            stream.end();
            throw error;
          }
        });
        return stream;
      },
    });
  }
  const loader = new DefaultResourceLoader({
    cwd,
    agentDir: cwd,
    settingsManager: settings,
    noExtensions: true,
    noSkills: true,
    noPromptTemplates: true,
    noThemes: true,
    noContextFiles: true,
    systemPrompt: "A local SDK contract test.",
    extensionFactories: [
      createFlashFallbackExtension({
        settings,
        getRun: () => run,
        onFallback: (from, error) => fallbacks.push({ from, error }),
      }),
      (pi) => {
        pi.on("model_select", async () => {
          if (options.stopOnModelChange) {
            await Promise.resolve();
            run.stopped = true;
          }
        });
      },
    ],
  });
  await loader.reload();
  assert.deepEqual(loader.getExtensions().errors, []);
  const { session } = await createAgentSession({
    cwd,
    agentDir: cwd,
    settingsManager: settings,
    modelRuntime: runtime,
    model: runtime.getModel(SOL_MODEL.provider, SOL_MODEL.id),
    sessionManager: SessionManager.inMemory(cwd),
    resourceLoader: loader,
    tools: ["record_action"],
    customTools: [{
      name: "record_action",
      label: "Record action",
      description: "Record one completed side effect.",
      parameters: { type: "object", properties: {}, additionalProperties: false } as any,
      execute: async () => {
        toolExecutions += 1;
        return { content: [{ type: "text", text: "Action already completed" }], details: {} };
      },
    }],
  });
  session.subscribe((event) => events.push(event));
  try {
    await session.bindExtensions({});
    await check({ session, requests, fallbacks, events, run, settings, toolExecutions: () => toolExecutions });
  } finally {
    await session.abort();
    session.dispose();
  }
}

test("native fallback resumes after a completed tool without replaying the user prompt", { timeout: 15000 }, async () => {
  await withSession((_request, index) => {
    if (index === 0) return { stopReason: "toolUse", content: [{ type: "toolCall", id: "one-action", name: "record_action", arguments: {} }] };
    if (index === 1) return { stopReason: "error", errorMessage: "401 quota exhausted" };
    return { stopReason: "stop", content: [{ type: "text", text: "Recovered after the completed action" }] };
  }, async ({ session, requests, fallbacks, events, toolExecutions, settings }) => {
    await session.prompt("Perform exactly one action and report the result.");
    assert.deepEqual(requests.map((request: Request) => request.model), [
      "cliproxyapi/gpt-6-sol", "cliproxyapi/gpt-6-sol", "kaon/aliyunus/deepseek-v4.1-flash",
    ]);
    assert.equal(toolExecutions(), 1);
    assert.equal(fallbacks.length, 1);
    assert.equal(fallbacks[0].error, "401 quota exhausted");
    assert.equal(events.filter((event: any) => event.type === "auto_retry_start").length, 1);
    const fallbackMessages = requests[2].messages;
    assert.equal(fallbackMessages.filter((message: any) => message.role === "user").length, 1);
    assert.equal(fallbackMessages.filter((message: any) => message.role === "toolResult").length, 1);
    assert.equal(fallbackMessages.at(-1).toolCallId, "one-action");
    assert.equal(session.messages.filter((message: any) => message.role === "user").length, 1);
    assert.equal(session.messages.at(-1).content[0].text, "Recovered after the completed action");
    assert.equal(settings.getRetrySettings().enabled, false);
  });
});

test("a failed Flash fallback is bounded to one attempt even for retryable errors", { timeout: 15000 }, async () => {
  await withSession(() => ({ stopReason: "error", errorMessage: "503 service unavailable" }), async ({ session, requests, fallbacks, events }) => {
    await session.prompt("Answer once.");
    assert.deepEqual(requests.map((request: Request) => request.model), ["cliproxyapi/gpt-6-sol", "kaon/aliyunus/deepseek-v4.1-flash"]);
    assert.equal(fallbacks.length, 1);
    assert.equal(events.filter((event: any) => event.type === "auto_retry_start").length, 1);
    assert.equal(session.messages.at(-1).stopReason, "error");
    assert.equal(session.messages.at(-1).errorMessage, "503 service unavailable");
  });
});

test("stopped runs do not enable a fallback", { timeout: 15000 }, async () => {
  await withSession(() => ({ stopReason: "error", errorMessage: "503 service unavailable" }), async ({ session, requests, fallbacks }) => {
    await session.prompt("Do not recover a stopped run.");
    assert.equal(requests.length, 1);
    assert.deepEqual(fallbacks, []);
  }, { stopped: true });
});

test("a stop during the asynchronous model switch prevents native retry", { timeout: 15000 }, async () => {
  await withSession(() => ({ stopReason: "error", errorMessage: "503 service unavailable" }), async ({ session, requests, fallbacks, run }) => {
    await session.prompt("Stop while selecting fallback.");
    assert.equal(run.stopped, true);
    assert.equal(requests.length, 1);
    assert.deepEqual(fallbacks, []);
  }, { stopOnModelChange: true });
});

test("aborting an in-flight provider call does not become a fallback", { timeout: 15000 }, async () => {
  let started: () => void;
  const requestStarted = new Promise<void>((resolve) => { started = resolve; });
  await withSession((_request, _index, signal) => new Promise<Reply>((resolve) => {
    const finish = () => resolve({ stopReason: "aborted", errorMessage: "Operation aborted" });
    signal?.addEventListener("abort", finish, { once: true });
    if (signal?.aborted) finish();
    started();
  }), async ({ session, requests, fallbacks }) => {
    const prompt = session.prompt("Wait for cancellation.");
    await requestStarted;
    await session.abort();
    await prompt;
    assert.equal(requests.length, 1);
    assert.deepEqual(fallbacks, []);
    assert.equal(session.messages.at(-1).stopReason, "aborted");
  });
});
