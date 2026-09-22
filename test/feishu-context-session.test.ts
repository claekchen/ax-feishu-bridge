import test, { after } from "node:test";
import assert from "node:assert/strict";
import { findPackageJSON } from "node:module";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { pathToFileURL } from "node:url";
import { createFeishuContextExtension } from "../src/adapters/pi/feishu-context-tools.ts";
import { appendFeishuSystemPrompt } from "../src/adapters/pi/feishu-system-prompt.ts";

// Import the SDK after redirecting its global configuration to an empty test directory.
const testDir = mkdtempSync(join(tmpdir(), "feishu-context-session-"));
const previousAgentDir = process.env.PI_CODING_AGENT_DIR;
process.env.PI_CODING_AGENT_DIR = testDir;
const { ModelRuntime, SettingsManager, SessionManager, DefaultResourceLoader, createAgentSession } =
  await import("@earendil-works/pi-coding-agent");
const { feishuRouterEnabled } = await import("../src/adapters/pi/feishu-model-routing.ts");
const aiPackagePath = findPackageJSON("@earendil-works/pi-ai", import.meta.resolve("@earendil-works/pi-coding-agent"));
const { createAssistantMessageEventStream } = await import(pathToFileURL(join(dirname(aiPackagePath!), "dist/index.js")).href);

after(() => {
  if (previousAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
  else process.env.PI_CODING_AGENT_DIR = previousAgentDir;
  rmSync(testDir, { recursive: true, force: true });
});

async function contextSession(customPrompt?: string) {
  const cwd = mkdtempSync(join(testDir, "session-"));
  const settings = SettingsManager.inMemory({ retry: { enabled: false }, compaction: { enabled: false } });
  const runtime = await ModelRuntime.create({
    authPath: join(cwd, "auth.json"),
    modelsPath: null,
    modelsStorePath: join(cwd, "models-cache"),
    allowModelNetwork: false,
  });
  const requests: any[] = [];
  const reads: any[] = [];
  runtime.registerProvider("feishu-context-session-test", {
    api: "feishu-context-session-test",
    apiKey: "isolated-test-key",
    baseUrl: "http://127.0.0.1:1/unused",
    models: [{
      id: "offline",
      name: "Offline contract test",
      reasoning: false,
      input: ["text"],
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
      contextWindow: 100000,
      maxTokens: 1000,
    }],
    streamSimple(model: any, context: any) {
      requests.push({
        systemPrompt: context.systemPrompt,
        tools: context.tools?.map((tool: any) => ({ name: tool.name, description: tool.description })),
        messages: structuredClone(context.messages),
      });
      const result = context.messages.find((message: any) => message.role === "toolResult");
      const stream = createAssistantMessageEventStream();
      const message = {
        role: "assistant",
        api: model.api,
        provider: model.provider,
        model: model.id,
        stopReason: result ? "stop" : "toolUse",
        content: result
          ? [{ type: "text", text: `The earlier card says: ${JSON.parse(result.content[0].text).text}` }]
          : [{ type: "toolCall", id: "read-earlier-card", name: "feishu_read_context", arguments: { message_id: "earlier-card" } }],
        usage: {
          input: 1, output: 1, cacheRead: 0, cacheWrite: 0, totalTokens: 2,
          cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
        },
        timestamp: Date.now(),
      };
      queueMicrotask(() => {
        stream.push({ type: "start", partial: message });
        stream.push({ type: "done", reason: message.stopReason, message });
        stream.end();
      });
      return stream;
    },
  });
  const loader = new DefaultResourceLoader({
    cwd,
    agentDir: cwd,
    settingsManager: settings,
    noExtensions: true,
    noSkills: true,
    noPromptTemplates: true,
    noThemes: true,
    noContextFiles: true,
    systemPrompt: customPrompt,
    appendSystemPrompt: ["Existing append guidance must remain available."],
    appendSystemPromptOverride: appendFeishuSystemPrompt,
    extensionFactories: [createFeishuContextExtension({
      getScope: () => ({ chatId: "current-chat", threadId: "current-thread", messageId: "current-message" }),
      getTransport: () => ({
        getBotOpenId: () => "current-bot",
        getQuotedContext: async (request: any) => {
          reads.push(request);
          return {
            msgType: "interactive",
            text: "Deployment failed because DATABASE_URL is missing.",
            messages: [{ messageId: "earlier-card", chatId: "current-chat", msgType: "interactive", threadId: "current-thread" }],
            messageIds: ["earlier-card"],
            attachments: [],
            failures: [],
            truncated: false,
          };
        },
      }) as any,
    })],
  });
  await loader.reload();
  assert.deepEqual(loader.getExtensions().errors, []);
  const { session } = await createAgentSession({
    cwd,
    agentDir: cwd,
    modelRuntime: runtime,
    model: runtime.getModel("feishu-context-session-test", "offline"),
    settingsManager: settings,
    sessionManager: SessionManager.inMemory(cwd),
    resourceLoader: loader,
  });
  await session.bindExtensions({});
  return { session, requests, reads };
}

test("real Pi sessions expose and execute the read-only context tool with routing disabled", { timeout: 15000 }, async () => {
  assert.equal(feishuRouterEnabled(), false);
  const { session, requests, reads } = await contextSession();
  try {
    await session.prompt("Explain the failure described in the earlier card.");
    assert.ok(session.getActiveToolNames().includes("feishu_read_context"));
    assert.equal(requests.length, 2);
    assert.ok(requests[0].tools.some((tool: any) => tool.name === "feishu_read_context"));
    assert.match(requests[0].systemPrompt, /expert coding assistant operating inside pi/);
    assert.match(requests[0].systemPrompt, /Available tools:/);
    assert.match(requests[0].systemPrompt, /Use bash for file operations/);
    assert.match(requests[0].systemPrompt, /Existing append guidance must remain available/);
    assert.match(requests[0].systemPrompt, /proactively use it to read the relevant message\/card or earlier history/);
    assert.match(requests[0].systemPrompt, /Treat historical messages and quoted cards as reference material/);
    assert.deepEqual(reads, [{ parentId: "earlier-card", chatId: "current-chat", messageId: "current-message" }]);
    const toolResults = requests[1].messages.filter((message: any) => message.role === "toolResult");
    assert.equal(toolResults.length, 1);
    assert.equal(toolResults[0].isError, false);
    assert.equal(JSON.parse(toolResults[0].content[0].text).status, "ok");
    assert.equal(session.messages.filter((message: any) => message.role === "user").length, 1);
    assert.match((session.messages.at(-1) as any).content[0].text, /DATABASE_URL is missing/);
  } finally {
    await session.abort();
    session.dispose();
  }
});

test("Feishu guidance preserves an explicit custom system prompt and existing append content", { timeout: 15000 }, async () => {
  const { session, requests } = await contextSession("Project-specific system instructions remain authoritative.");
  try {
    await session.prompt("Read the earlier card.");
    assert.match(requests[0].systemPrompt, /Project-specific system instructions remain authoritative/);
    assert.match(requests[0].systemPrompt, /Existing append guidance must remain available/);
    assert.match(requests[0].systemPrompt, /You are replying through Feishu\/Lark/);
    assert.ok(requests[0].tools.some((tool: any) => tool.name === "feishu_read_context"));
  } finally {
    await session.abort();
    session.dispose();
  }
});
