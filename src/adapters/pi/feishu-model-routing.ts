import { readFileSync } from "node:fs";
import { join } from "node:path";
import { getAgentDir } from "@earendil-works/pi-coding-agent";
import type { RuntimeModel } from "../../feishu/runtime.ts";

export const FLASH_MODEL = { provider: "kaon", id: "aliyunus/deepseek-v4.1-flash" };
export const SOL_MODEL = { provider: "cliproxyapi", id: "gpt-5.6-sol" };
export const TERRA_MODEL = { provider: "cliproxyapi", id: "gpt-5.6-terra" };
const JEV_URL = "https://kaon-router.kaonai.com/api/alpha/decisions";
const JEV_MODEL = "openrouter/~typesafe/jev-latest";

export function feishuRouterEnabled() {
  try {
    const config = JSON.parse(readFileSync(join(getAgentDir(), "feishu", "model-router.json"), "utf8"));
    return config?.enabled === true;
  } catch {
    return false;
  }
}

export function modelMatches(a: Pick<RuntimeModel, "provider" | "id"> | undefined, b: Pick<RuntimeModel, "provider" | "id">) {
  return a?.provider === b.provider && a?.id === b.id;
}

export function isPriorityRequest(workspace: string, prompt: string) {
  return /(?:^|[\\/])kdh(?:[\\/]|$)/i.test(workspace)
    || /\bkdh\b/i.test(prompt)
    || /(?:codex[\s_-]*review|review[\s_-]*codex|代码审查|代码评审|审查\s*(?:pr|pull request)|review\s*(?:pr|pull request)|(?:pr|pull request)\s*review)/i.test(prompt);
}

export function modelForDifficulty(answer: unknown): typeof FLASH_MODEL | typeof TERRA_MODEL | typeof SOL_MODEL | undefined {
  if (!answer || typeof answer !== "object") return;
  const value = answer as { score?: unknown; confidence?: unknown };
  if (typeof value.score !== "number" || !Number.isFinite(value.score)
    || typeof value.confidence !== "number" || value.confidence < 0.6) return;
  const level = value.score <= 1 ? value.score * 2 : value.score;
  if (level <= 0.5) return FLASH_MODEL;
  if (level >= 1.5) return SOL_MODEL;
  return TERRA_MODEL;
}

function kaonKey(): string | undefined {
  try {
    const models = JSON.parse(readFileSync(join(getAgentDir(), "models.json"), "utf8"));
    const key = models?.providers?.kaon?.apiKey;
    if (typeof key !== "string" || !key) return;
    if (key.startsWith("$")) return process.env[key.slice(1)];
    return key;
  } catch {
    return;
  }
}

export async function askJevDifficulty(prompt: string, history: string, fetcher: typeof fetch = fetch) {
  const key = kaonKey();
  if (!key) return;
  const signal = AbortSignal.timeout(8_000);
  const response = await fetcher(JEV_URL, {
    method: "POST",
    headers: { authorization: `Bearer ${key}`, "content-type": "application/json" },
    body: JSON.stringify({
      model: JEV_MODEL,
      state: {
        context: "Route a Feishu coding assistant turn by difficulty. Use the recent conversation only to understand the current request.",
        recent_history: history.slice(-6000),
        prompt: prompt.slice(0, 8000),
      },
      questions: {
        difficulty: {
          type: "score",
          instructions: "Rate the current request: trivial for greetings, simple lookup or mechanical edits; moderate for ordinary coding tasks; complex for subtle debugging, architecture or multi-file work.",
          criteria: ["trivial", "moderate", "complex"],
        },
      },
    }),
    signal,
  });
  if (!response.ok) throw new Error(`Jev returned HTTP ${response.status}`);
  const result = await response.json() as { answers?: { difficulty?: unknown } };
  return modelForDifficulty(result.answers?.difficulty);
}
