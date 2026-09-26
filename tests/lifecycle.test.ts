import { describe, expect, test } from "bun:test";
import { CLOSURE_CONFIRMATION_MS, confirmsNeverPopulatedEmptySource, decideListingLifecycle, evaluateClosureCircuitBreaker } from "../packages/lifecycle/src/index.ts";

describe("listing lifecycle", () => {
  const t0 = "2026-01-01T00:00:00.000Z";
  test("ignores every nonqualifying absence", () => {
    expect(decideListingLifecycle({ state: "active", consecutiveCompleteMisses: 0 }, "nonqualifying_absence", t0))
      .toMatchObject({ state: "active", consecutiveCompleteMisses: 0, transition: "none" });
  });
  test("requires two separated complete absences", () => {
    const first = decideListingLifecycle({ state: "active", consecutiveCompleteMisses: 0 }, "qualifying_absence", t0);
    expect(first).toMatchObject({ state: "possibly_closed", consecutiveCompleteMisses: 1, transition: "possibly_closed" });
    const early = decideListingLifecycle(first, "qualifying_absence", new Date(Date.parse(t0) + CLOSURE_CONFIRMATION_MS - 1).toISOString());
    expect(early).toMatchObject({ state: "possibly_closed", transition: "none" });
    expect(decideListingLifecycle(early, "qualifying_absence", new Date(Date.parse(t0) + CLOSURE_CONFIRMATION_MS).toISOString()))
      .toMatchObject({ state: "closed", consecutiveCompleteMisses: 3, transition: "closed" });
  });
  test("reopens the same durable listing identity", () => {
    expect(decideListingLifecycle({ state: "closed", consecutiveCompleteMisses: 2, firstMissingAt: t0 }, "seen", "2026-01-02T00:00:00Z"))
      .toMatchObject({ state: "active", consecutiveCompleteMisses: 0, transition: "reopened" });
  });
});

describe("closure circuit breakers", () => {
  test("quarantines empty, 90% collapse, and large closure spikes", () => {
    expect(evaluateClosureCircuitBreaker({ previousJobCount: 10, observedJobCount: 0, activeListingCount: 10 })).toMatchObject({ tripped: true, reason: "suspicious_empty" });
    expect(evaluateClosureCircuitBreaker({ previousJobCount: 100, observedJobCount: 10, activeListingCount: 100 })).toMatchObject({ tripped: true, reason: "count_collapse" });
    expect(evaluateClosureCircuitBreaker({ previousJobCount: 200, observedJobCount: 100, activeListingCount: 200 })).toMatchObject({ tripped: true, reason: "closure_spike" });
    expect(evaluateClosureCircuitBreaker({ previousJobCount: 20, observedJobCount: 18, activeListingCount: 20 })).toEqual({ tripped: false });
  });
});

describe("never-populated empty source confirmation", () => {
  const candidate = {
    connectorReason: "suspicious_empty",
    observedJobCount: 0,
    activeListingCount: 0,
    historicalListingCount: 0,
    boardHash: "a".repeat(64),
    previousBoardHash: "a".repeat(64),
    previousEmptyAt: "2026-09-04T00:00:00.000Z",
    observedAt: "2026-09-04T00:30:00.000Z",
  };

  test("requires two matching, separated empties and no listing history", () => {
    expect(confirmsNeverPopulatedEmptySource(candidate)).toBe(true);
    expect(confirmsNeverPopulatedEmptySource({ ...candidate, observedAt: "2026-09-04T00:29:59.999Z" })).toBe(false);
    expect(confirmsNeverPopulatedEmptySource({ ...candidate, observedAt: "2026-09-05T00:00:00.001Z" })).toBe(false);
    expect(confirmsNeverPopulatedEmptySource({ ...candidate, previousBoardHash: "b".repeat(64) })).toBe(false);
    expect(confirmsNeverPopulatedEmptySource({ ...candidate, historicalListingCount: 1 })).toBe(false);
    expect(confirmsNeverPopulatedEmptySource({ ...candidate, activeListingCount: 1 })).toBe(false);
    expect(confirmsNeverPopulatedEmptySource({ ...candidate, connectorReason: "complete" })).toBe(false);
  });
});
