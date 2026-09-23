import { readFileSync } from "node:fs";
import { join } from "node:path";
import { getAgentDir } from "@earendil-works/pi-coding-agent";
import type { RuntimeModel } from "../../feishu/runtime.ts";
import type { ModelSelection } from "../../feishu/types.ts";

export const FLASH_MODEL = { provider: "kaon", id: "aliyunus/deepseek-v4.1-flash" };
export const LUNA_MODEL = { provider: "cliproxyapi", id: "gpt-6-luna" };
export const SOL_MODEL = { provider: "cliproxyapi", id: "gpt-6-sol" };
export const ASTRA_MODEL = { provider: "cliproxyapi", id: "gpt-6-astra" };
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

export function isManualSelection(selected: ModelSelection | undefined) {
  return Boolean(selected && (selected.routingMode === "manual"
    || (selected.routingMode !== "auto" && !modelMatches(selected, FLASH_MODEL))));
}

export function isPriorityRequest(workspace: string, prompt: string) {
  return /(?:^|[\\/])kdh(?:[\\/]|$)/i.test(workspace)
    || /\bkdh\b/i.test(prompt)
    || /(?:codex[\s_-]*review|review[\s_-]*codex|代码审查|代码评审|审查\s*(?:pr|pull request)|review\s*(?:pr|pull request)|(?:pr|pull request)\s*review)/i.test(prompt);
}

export function modelForDifficulty(answer: unknown): typeof LUNA_MODEL | typeof SOL_MODEL | typeof ASTRA_MODEL | undefined {
  if (!answer || typeof answer !== "object") return;
  const value = answer as { score?: unknown; confidence?: unknown };
  if (typeof value.score !== "number" || !Number.isFinite(value.score)
    || value.score < 0 || value.score > 3
    || typeof value.confidence !== "number" || !Number.isFinite(value.confidence)
    || value.confidence < 0.6 || value.confidence > 1) return;
  const level = value.score;
  if (level <= 0.5) return LUNA_MODEL;
  if (level >= 2.5) return ASTRA_MODEL;
  return SOL_MODEL;
}

export async function askJevDifficulty(
  input: { prompt: string; currentRequest: string; history: string; apiKey: string },
  fetcher: typeof fetch = fetch,
) {
  const signal = AbortSignal.timeout(8_000);
  const response = await fetcher(JEV_URL, {
    method: "POST",
    headers: { authorization: `Bearer ${input.apiKey}`, "content-type": "application/json" },
    body: JSON.stringify({
      model: JEV_MODEL,
      state: {
        context: "Route a Feishu coding assistant turn by difficulty. Classify current_request; use request_context and recent_history only to understand it. If current_request is empty, classify the attached or quoted request_context. For follow-ups such as 'continue', preserve the difficulty of the ongoing task.",
        current_request: input.currentRequest.length > 8000
          ? `${input.currentRequest.slice(0, 6000)}\n[omitted]\n${input.currentRequest.slice(-2000)}`
          : input.currentRequest,
        recent_history: input.history.slice(-6000),
        request_context: input.prompt.slice(-8000),
      },
      questions: {
        difficulty: {
          type: "score",
          instructions: "Rate the current request: trivial for greetings, simple lookup or mechanical edits; moderate for ordinary coding tasks; complex for multi-file debugging or architecture; extreme for difficult multi-system architecture, security-sensitive work or subtle concurrency.",
          criteria: ["trivial", "moderate", "complex", "extreme"],
        },
      },
    }),
    signal,
  });
  if (!response.ok) throw new Error(`Jev returned HTTP ${response.status}`);
  const result = await response.json() as { answers?: { difficulty?: unknown } };
  const answer = result?.answers?.difficulty;
  const model = modelForDifficulty(answer);
  const values = answer && typeof answer === "object" ? answer as { score?: unknown; confidence?: unknown } : {};
  return {
    model,
    score: typeof values.score === "number" && Number.isFinite(values.score) ? values.score : undefined,
    confidence: typeof values.confidence === "number" && Number.isFinite(values.confidence) ? values.confidence : undefined,
    reason: model ? "jev" : "jev_low_confidence_or_invalid",
  };
}
