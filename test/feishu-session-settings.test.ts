import test from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createFeishuSessionSettings } from "../src/adapters/pi/feishu-session-settings.ts";

function fixture() {
  const root = mkdtempSync(join(tmpdir(), "feishu-session-settings-"));
  const cwd = join(root, "workspace");
  const agentDir = join(root, "agent");
  mkdirSync(join(cwd, ".pi"), { recursive: true });
  mkdirSync(agentDir, { recursive: true });
  const globalPath = join(agentDir, "settings.json");
  const projectPath = join(cwd, ".pi", "settings.json");
  const globalText = JSON.stringify({
    defaultProvider: "global-provider",
    defaultModel: "global-model",
    defaultThinkingLevel: "high",
    retry: { enabled: true, maxRetries: 7, baseDelayMs: 2000 },
    compaction: { enabled: true, reserveTokens: 12000 },
  });
  const projectText = JSON.stringify({
    defaultModel: "project-model",
    retry: { enabled: true, maxRetries: 4, baseDelayMs: 3000, provider: { maxRetries: 2 } },
    compaction: { keepRecentTokens: 9000 },
  });
  writeFileSync(globalPath, globalText);
  writeFileSync(projectPath, projectText);
  return { root, cwd, agentDir, globalPath, projectPath, globalText, projectText };
}

test("bot model and retry changes remain isolated while project settings keep their precedence", async () => {
  const f = fixture();
  try {
    const settings = createFeishuSessionSettings(f.cwd, f.agentDir, true);
    assert.equal(settings.getDefaultModel(), "project-model");
    assert.deepEqual(settings.getCompactionSettings(), {
      enabled: true, reserveTokens: 12000, keepRecentTokens: 9000,
    });
    assert.deepEqual(settings.getRetrySettings(), { enabled: false, maxRetries: 1, baseDelayMs: 500 });
    assert.equal(settings.getProviderRetrySettings().maxRetries, 2);

    settings.setDefaultModelAndProvider("fallback-provider", "fallback-model");
    settings.setDefaultThinkingLevel("low");
    await settings.flush();
    assert.equal(settings.getRetryEnabled(), false);
    settings.setRetryEnabled(true);
    await settings.flush();
    assert.equal(settings.getRetryEnabled(), true);
    settings.setRetryEnabled(false);
    await settings.flush();
    await settings.reload();
    assert.equal(settings.getRetryEnabled(), false);
    assert.equal(settings.getDefaultProvider(), "fallback-provider");
    assert.equal(settings.getDefaultModel(), "project-model");
    assert.equal(readFileSync(f.globalPath, "utf8"), f.globalText);
    assert.equal(readFileSync(f.projectPath, "utf8"), f.projectText);

    const independent = createFeishuSessionSettings(f.cwd, f.agentDir, true);
    assert.equal(independent.getDefaultProvider(), "global-provider");
    assert.equal(independent.getDefaultThinkingLevel(), "high");
  } finally {
    rmSync(f.root, { recursive: true, force: true });
  }
});

test("disabled routing preserves the configured retry policy and project trust", async () => {
  const f = fixture();
  try {
    const settings = createFeishuSessionSettings(f.cwd, f.agentDir, false);
    assert.deepEqual(settings.getRetrySettings(), { enabled: true, maxRetries: 4, baseDelayMs: 3000 });
    const untrusted = createFeishuSessionSettings(f.cwd, f.agentDir, true, { projectTrusted: false });
    assert.equal(untrusted.isProjectTrusted(), false);
    assert.equal(untrusted.getDefaultModel(), "global-model");
    assert.deepEqual(untrusted.getProjectSettings(), {});
    await untrusted.reload();
    assert.equal(untrusted.isProjectTrusted(), false);
    assert.equal(untrusted.getDefaultModel(), "global-model");
  } finally {
    rmSync(f.root, { recursive: true, force: true });
  }
});
