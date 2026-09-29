export type ContinuationModel = { provider: string; id: string };

type CompletedTurn = {
  sessionId: string;
  workspace: string;
  model: ContinuationModel;
};

type ContinuationRequest = {
  sessionId: string;
  workspace: string;
  currentRequest: string;
};

type ContinuationRoutingOptions = {
  now?: () => number;
  ttlMs?: number;
  maxEntries?: number;
};

const CONTINUATION_PHRASES = new Set([
  "继续", "继续吧", "继续做", "接着做", "接着吧", "下一步",
  "continue", "go on", "proceed", "keep going", "carry on", "please continue",
]);

function isContinuationRequest(request: string): boolean {
  const text = request.trim();
  if (text.length > 32 || /[\r\n]/.test(text)) return false;
  const phrase = text.toLowerCase().replace(/[.!。！]$/, "").replace(/[ \t]+/g, " ").trim();
  return CONTINUATION_PHRASES.has(phrase);
}

/** Reuse a successfully completed turn's model for an explicit continuation only. */
export class ContinuationRouting {
  private readonly entries = new Map<string, CompletedTurn & { expiresAt: number }>();
  private readonly now: () => number;
  private readonly ttlMs: number;
  private readonly maxEntries: number;

  constructor(options: ContinuationRoutingOptions = {}) {
    this.now = options.now ?? Date.now;
    this.ttlMs = options.ttlMs ?? 30 * 60 * 1000;
    this.maxEntries = options.maxEntries ?? 256;
    if (!Number.isFinite(this.ttlMs) || this.ttlMs <= 0) {
      throw new RangeError("Continuation routing TTL must be positive and finite");
    }
    if (!Number.isInteger(this.maxEntries) || this.maxEntries <= 0) {
      throw new RangeError("Continuation routing capacity must be a positive integer");
    }
  }

  record(key: string, turn: CompletedTurn): void {
    const now = this.now();
    for (const [entryKey, entry] of this.entries) {
      if (now >= entry.expiresAt) this.entries.delete(entryKey);
    }
    // Insertion order tracks successful turns, never lookups.
    this.entries.delete(key);
    this.entries.set(key, { ...turn, model: { ...turn.model }, expiresAt: now + this.ttlMs });
    while (this.entries.size > this.maxEntries) {
      const oldest = this.entries.keys().next().value;
      if (oldest === undefined) break;
      this.entries.delete(oldest);
    }
  }

  get(key: string, request: ContinuationRequest): ContinuationModel | undefined {
    const entry = this.entries.get(key);
    if (!entry) return undefined;
    if (this.now() >= entry.expiresAt
      || request.sessionId !== entry.sessionId
      || request.workspace !== entry.workspace) {
      this.entries.delete(key);
      return undefined;
    }
    if (!isContinuationRequest(request.currentRequest)) return undefined;
    return { ...entry.model };
  }

  clear(key: string): void {
    this.entries.delete(key);
  }

  reset(): void {
    this.entries.clear();
  }
}
