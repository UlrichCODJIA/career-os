import { describe, expect, test } from "bun:test";
import { preflightCountsReady } from "../scripts/soak-preflight.ts";

const clearCounts = {
  enabled: 1_000,
  unhealthy: 0,
  policy_short: 0,
  unresolved_empty: 0,
  unconfirmed_empty: 0,
  pending_reviews: 0,
  active_breakers: 0,
  overdue_jobs: 0,
  terminal_jobs: 0,
  held_visible: 0,
};

describe("soak preflight monitor", () => {
  test("labels only a clean 1,000-source aggregate as ready", () => {
    expect(preflightCountsReady(clearCounts)).toBe(true);
    expect(preflightCountsReady({ ...clearCounts, enabled: 999 })).toBe(false);
    expect(preflightCountsReady({ ...clearCounts, pending_reviews: 1 })).toBe(false);
    expect(preflightCountsReady({ ...clearCounts, policy_short: 1 })).toBe(false);
    expect(preflightCountsReady({ ...clearCounts, held_visible: 1 })).toBe(false);
  });
});
