import { askJevDifficulty } from "./feishu-model-routing.ts";

export type JevDecisionInput = Parameters<typeof askJevDifficulty>[0];
type JevDecision = Awaited<ReturnType<typeof askJevDifficulty>>;
export type JevDecisionResult = JevDecision & {
  retryAfterMs?: number;
  error?: string;
};

const MAX_IN_FLIGHT = 2;
const FAILURE_THRESHOLD = 2;
const INITIAL_COOLDOWN_MS = 30_000;
const MAX_COOLDOWN_MS = 120_000;

class InvalidDecisionError extends Error {}

/** Protect one runtime from repeated Jev outages without retaining request data. */
export class JevDecisionClient {
  private readonly ask: (input: JevDecisionInput) => Promise<JevDecision>;
  private readonly now: () => number;
  private inFlight = 0;
  private consecutiveFailures = 0;
  private cooldownUntil = 0;
  private cooldownMs = INITIAL_COOLDOWN_MS;
  private probeInFlight = false;
  private generation = 0;

  constructor(options: {
    ask?: (input: JevDecisionInput) => Promise<JevDecision>;
    now?: () => number;
  } = {}) {
    this.ask = options.ask ?? askJevDifficulty;
    this.now = options.now ?? Date.now;
  }

  async decide(input: JevDecisionInput): Promise<JevDecisionResult> {
    if (this.cooldownUntil > this.now()) return this.skipped("jev_cooldown");
    if (this.probeInFlight || this.inFlight >= MAX_IN_FLIGHT) return this.skipped("jev_busy");

    const isProbe = this.cooldownUntil !== 0;
    if (isProbe) {
      this.probeInFlight = true;
      this.generation += 1;
    }
    const generation = this.generation;
    this.inFlight += 1;
    try {
      const decision = await this.ask(input);
      if (!validDifficulty(decision)) throw new InvalidDecisionError();
      // A request started before an outage must not close a newer circuit.
      if (generation === this.generation) {
        this.consecutiveFailures = 0;
        this.cooldownUntil = 0;
        this.cooldownMs = INITIAL_COOLDOWN_MS;
        if (isProbe) {
          this.probeInFlight = false;
          this.generation += 1;
        }
      }
      return decision;
    } catch (error) {
      if (generation === this.generation) {
        this.consecutiveFailures += 1;
        if (isProbe || this.consecutiveFailures >= FAILURE_THRESHOLD) {
          if (isProbe) this.cooldownMs = Math.min(this.cooldownMs * 2, MAX_COOLDOWN_MS);
          this.cooldownUntil = this.now() + this.cooldownMs;
          this.probeInFlight = false;
          this.generation += 1;
        }
      }
      return { ...this.skipped("jev_error"), error: errorCategory(error) };
    } finally {
      this.inFlight -= 1;
    }
  }

  private skipped(reason: string): JevDecisionResult {
    const retryAfterMs = Math.max(0, this.cooldownUntil - this.now());
    return {
      model: undefined,
      score: undefined,
      confidence: undefined,
      reason,
      ...(retryAfterMs > 0 ? { retryAfterMs } : {}),
    };
  }
}

function validDifficulty(decision: JevDecision | undefined): boolean {
  return typeof decision?.score === "number" && Number.isFinite(decision.score)
    && decision.score >= 0 && decision.score <= 3
    && typeof decision?.confidence === "number" && Number.isFinite(decision.confidence)
    && decision.confidence >= 0 && decision.confidence <= 1;
}

function errorCategory(error: unknown): string {
  if (error instanceof InvalidDecisionError || error instanceof SyntaxError) return "invalid_response";
  if (error instanceof Error) {
    if (error.name === "TimeoutError" || error.name === "AbortError") return "timeout";
    const status = error.message.match(/^Jev returned HTTP ([1-5][0-9]{2})$/)?.[1];
    if (status) return `http_${status}`;
  }
  // Provider errors can contain request data, so only return a safe category.
  return "request_failed";
}
