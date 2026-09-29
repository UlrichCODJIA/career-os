export function preflightCountsReady(counts: { enabled: number; [key: string]: number }): boolean {
  return counts.enabled === 1_000 && Object.entries(counts).every(([key, value]) => key === "enabled" || value === 0);
}
