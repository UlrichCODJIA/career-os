export const LIFECYCLE_VERSION = "1.0.0";
export const CLOSURE_CONFIRMATION_MS = 30 * 60 * 1_000;
export const EMPTY_SOURCE_CONFIRMATION_MAX_MS = 24 * 60 * 60 * 1_000;

export type ListingState = "active" | "possibly_closed" | "closed";
export interface ListingLifecycleInput {
  state: ListingState;
  consecutiveCompleteMisses: number;
  firstMissingAt?: string;
}
export type LifecycleSignal = "seen" | "qualifying_absence" | "nonqualifying_absence";
export interface ListingLifecycleDecision {
  state: ListingState;
  consecutiveCompleteMisses: number;
  firstMissingAt?: string;
  transition: "none" | "possibly_closed" | "closed" | "reopened";
  version: string;
}

function instant(value: string): number {
  const parsed = Date.parse(value);
  if (!Number.isFinite(parsed)) throw new Error("invalid_lifecycle_time");
  return parsed;
}

export function decideListingLifecycle(input: ListingLifecycleInput, signal: LifecycleSignal, observedAt: string): ListingLifecycleDecision {
  const now = instant(observedAt);
  if (!Number.isSafeInteger(input.consecutiveCompleteMisses) || input.consecutiveCompleteMisses < 0) throw new Error("invalid_miss_count");
  const first = input.firstMissingAt ? instant(input.firstMissingAt) : undefined;
  if (signal === "seen") return { state: "active", consecutiveCompleteMisses: 0, transition: input.state === "active" ? "none" : "reopened", version: LIFECYCLE_VERSION };
  if (signal === "nonqualifying_absence") return { ...input, transition: "none", version: LIFECYCLE_VERSION };
  if (input.state === "closed") return { ...input, transition: "none", version: LIFECYCLE_VERSION };
  if (input.state === "active" || first === undefined) return { state: "possibly_closed", consecutiveCompleteMisses: 1,
    firstMissingAt: observedAt, transition: "possibly_closed", version: LIFECYCLE_VERSION };
  const misses = input.consecutiveCompleteMisses + 1;
  if (now - first < CLOSURE_CONFIRMATION_MS) return { state: "possibly_closed", consecutiveCompleteMisses: misses,
    firstMissingAt: input.firstMissingAt, transition: "none", version: LIFECYCLE_VERSION };
  return { state: "closed", consecutiveCompleteMisses: misses, firstMissingAt: input.firstMissingAt,
    transition: "closed", version: LIFECYCLE_VERSION };
}

export interface CircuitBreakerInput { previousJobCount: number | null; observedJobCount: number; activeListingCount: number; }
export type CircuitBreakerDecision = { tripped: false } | { tripped: true; reason: "suspicious_empty" | "count_collapse" | "closure_spike"; ratio: number };
export function evaluateClosureCircuitBreaker(input: CircuitBreakerInput): CircuitBreakerDecision {
  for (const value of [input.observedJobCount, input.activeListingCount]) if (!Number.isSafeInteger(value) || value < 0) throw new Error("invalid_lifecycle_count");
  if (input.previousJobCount !== null && (!Number.isSafeInteger(input.previousJobCount) || input.previousJobCount < 0)) throw new Error("invalid_lifecycle_count");
  const baseline = Math.max(input.previousJobCount ?? 0, input.activeListingCount);
  if (baseline >= 10 && input.observedJobCount === 0) return { tripped: true, reason: "suspicious_empty", ratio: 1 };
  const ratio = baseline ? Number(((baseline - input.observedJobCount) / baseline).toFixed(4)) : 0;
  if (baseline >= 10 && ratio >= 0.9) return { tripped: true, reason: "count_collapse", ratio };
  const missing = Math.max(0, input.activeListingCount - input.observedJobCount);
  if (missing >= 50 && input.activeListingCount > 0 && missing / input.activeListingCount >= 0.5) {
    return { tripped: true, reason: "closure_spike", ratio: Number((missing / input.activeListingCount).toFixed(4)) };
  }
  return { tripped: false };
}

export interface EmptySourceConfirmationInput {
  connectorReason: string;
  observedJobCount: number;
  activeListingCount: number;
  historicalListingCount: number;
  boardHash?: string;
  previousBoardHash?: string | null;
  previousEmptyAt?: string;
  observedAt: string;
}

export function confirmsNeverPopulatedEmptySource(input: EmptySourceConfirmationInput): boolean {
  for (const count of [input.observedJobCount, input.activeListingCount, input.historicalListingCount]) {
    if (!Number.isSafeInteger(count) || count < 0) throw new Error("invalid_lifecycle_count");
  }
  if (input.connectorReason !== "suspicious_empty" || input.observedJobCount !== 0
    || input.activeListingCount !== 0 || input.historicalListingCount !== 0
    || !input.boardHash || !input.previousBoardHash || input.boardHash !== input.previousBoardHash
    || !input.previousEmptyAt) return false;
  const elapsed = instant(input.observedAt) - instant(input.previousEmptyAt);
  return elapsed >= CLOSURE_CONFIRMATION_MS && elapsed <= EMPTY_SOURCE_CONFIRMATION_MAX_MS;
}
