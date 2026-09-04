import { z } from "zod";

const Timestamp = z.iso.datetime({ offset: true });
const Digest = z.string().regex(/^[a-f0-9]{64}$/);
const Commit = z.string().regex(/^[a-f0-9]{40}$/);
const Count = z.number().int().nonnegative();
const Hours = z.number().finite().nonnegative();

export const SoakSnapshotSchema = z.object({
  schemaVersion: z.literal(1),
  capturedAt: Timestamp,
  soakStartedAt: Timestamp,
  releaseCommit: Commit,
  registryDigest: Digest,
  registry: z.object({ verifiedSources: Count, enabledSources: Count }).strict(),
  scheduling: z.object({
    dueJobs: Count, succeededJobs: Count, terminalJobs: Count, inFlightJobs: Count,
    p95QueueLagSeconds: z.number().finite().nonnegative(),
  }).strict(),
  freshness: z.object({ healthySources: Count, twiceEnumerated24h: Count }).strict(),
  publication: z.object({ sampleSize: Count, medianHours: Hours.nullable(), p95Hours: Hours.nullable() }).strict(),
  lifecycle: z.object({ closures: Count, massFalseClosures: Count }).strict(),
  identity: z.object({
    reprocessChecks: Count, idempotentReprocesses: Count, sourceListings: Count, duplicateSourceListings: Count,
  }).strict(),
  provenance: z.object({ displayedFacts: Count, factsWithEvidence: Count }).strict(),
}).strict();

export const QualityAuditSchema = z.object({
  schemaVersion: z.literal(1),
  reviewedAt: Timestamp,
  reviewer: z.string().trim().min(1).max(200),
  releaseCommit: Commit,
  registryDigest: Digest,
  stratifiedSampleSize: z.number().int().min(100),
  workplaceReviewed: Count,
  workplaceCorrect: Count,
  eligibleCountryReviewed: Count,
  eligibleCountryCorrect: Count,
  displayedCompensationReviewed: Count,
  compensationCurrencyAndPeriodCorrect: Count,
  closureReviewed: Count,
  falseClosures: Count,
  linkReviewed: Count,
  brokenEmployerOrApplyLinks: Count,
  notes: z.string().trim().min(8).max(4_000),
}).strict();

export const DrillReceiptSchema = z.object({
  schemaVersion: z.literal(1),
  completedAt: Timestamp,
  releaseCommit: Commit,
  databaseRestorePassed: z.boolean(),
  artifactRestorePassed: z.boolean(),
  restoredCountsMatched: z.boolean(),
  restoredDigestsMatched: z.boolean(),
  connectorOutageCreatedClosures: Count,
  workerCrashHistoryPreserved: z.boolean(),
  connectorRollbackHistoryPreserved: z.boolean(),
  browserE2ePassed: z.boolean(),
}).strict();

export const SecurityReceiptSchema = z.object({
  schemaVersion: z.literal(1),
  completedAt: Timestamp,
  releaseCommit: Commit,
  scanner: z.literal("codex-security-standard"),
  unresolvedCritical: Count,
  unresolvedHigh: Count,
  reportReference: z.string().trim().min(8).max(2_000),
}).strict();

export const ReleaseEvidenceBundleSchema = z.object({
  schemaVersion: z.literal(1),
  releaseCommit: Commit,
  registryDigest: Digest,
  snapshots: z.array(SoakSnapshotSchema).min(1),
  qualityAudit: QualityAuditSchema,
  drills: DrillReceiptSchema,
  security: SecurityReceiptSchema,
}).strict();

export type ReleaseEvidenceBundle = z.infer<typeof ReleaseEvidenceBundleSchema>;
export interface GateResult { id: string; passed: boolean; observed: string; required: string }

function ratio(numerator: number, denominator: number): number {
  return denominator === 0 ? 0 : numerator / denominator;
}

function percentile(values: readonly number[], percentileValue: number): number {
  if (values.length === 0) return Number.POSITIVE_INFINITY;
  const sorted = [...values].sort((left, right) => left - right);
  return sorted[Math.ceil(percentileValue * sorted.length) - 1]!;
}

export function evaluateReleaseEvidence(input: unknown): { ready: boolean; gates: GateResult[] } {
  const bundle = ReleaseEvidenceBundleSchema.parse(input);
  const snapshots = [...bundle.snapshots].sort((left, right) => Date.parse(left.capturedAt) - Date.parse(right.capturedAt));
  const first = snapshots[0]!;
  const final = snapshots.at(-1)!;
  const start = Date.parse(first.soakStartedAt);
  const coverageHours = (Date.parse(final.capturedAt) - start) / 3_600_000;
  const gaps = snapshots.slice(1).map((snapshot, index) => (Date.parse(snapshot.capturedAt) - Date.parse(snapshots[index]!.capturedAt)) / 3_600_000);
  const mature = snapshots.filter((snapshot) => Date.parse(snapshot.capturedAt) - start >= 24 * 3_600_000);
  const completedJobs = final.scheduling.succeededJobs + final.scheduling.terminalJobs;
  const quality = bundle.qualityAudit;
  const sameSubject = snapshots.every((snapshot) => snapshot.releaseCommit === bundle.releaseCommit
      && snapshot.registryDigest === bundle.registryDigest && snapshot.soakStartedAt === first.soakStartedAt)
    && quality.releaseCommit === bundle.releaseCommit && quality.registryDigest === bundle.registryDigest
    && bundle.drills.releaseCommit === bundle.releaseCommit && bundle.security.releaseCommit === bundle.releaseCommit;
  const gates: GateResult[] = [];
  const gate = (id: string, passed: boolean, observed: string, required: string) => gates.push({ id, passed, observed, required });
  gate("evidence-subject", sameSubject, sameSubject ? "consistent" : "mixed", "one release commit and registry digest");
  gate("pilot-registry", final.registry.verifiedSources === 1_000 && final.registry.enabledSources === 1_000,
    `${final.registry.verifiedSources}/${final.registry.enabledSources}`, "1,000 verified and enabled sources");
  gate("soak-coverage", snapshots.length >= 14 && coverageHours >= 168 && (gaps.length === 0 || Math.max(...gaps) <= 14),
    `${snapshots.length} snapshots, ${coverageHours.toFixed(1)}h, max gap ${gaps.length ? Math.max(...gaps).toFixed(1) : "n/a"}h`,
    ">=14 snapshots over >=168h with <=14h gaps");
  const successRate = ratio(final.scheduling.succeededJobs, completedJobs);
  gate("schedule-success", completedJobs > 0 && successRate >= 0.99, `${(successRate * 100).toFixed(3)}%`, ">=99%");
  const freshnessRates = mature.map((snapshot) => ratio(snapshot.freshness.twiceEnumerated24h, snapshot.freshness.healthySources));
  gate("freshness", mature.length > 0 && Math.min(...freshnessRates) >= 0.95,
    mature.length ? `${(Math.min(...freshnessRates) * 100).toFixed(3)}% minimum` : "no mature snapshots", ">=95% at every mature snapshot");
  const queueP95 = percentile(mature.map((snapshot) => snapshot.scheduling.p95QueueLagSeconds), 0.95);
  gate("queue-lag", queueP95 < 1_800, Number.isFinite(queueP95) ? `${queueP95.toFixed(1)}s` : "unavailable", "p95 <1,800s");
  gate("publication-lag", final.publication.sampleSize > 0 && final.publication.medianHours !== null
      && final.publication.p95Hours !== null && final.publication.medianHours < 12 && final.publication.p95Hours < 18,
    `${final.publication.sampleSize} samples; median ${final.publication.medianHours ?? "n/a"}h; p95 ${final.publication.p95Hours ?? "n/a"}h`,
    "median <12h and p95 <18h where timestamps exist");
  gate("mass-false-closures", final.lifecycle.massFalseClosures === 0,
    String(final.lifecycle.massFalseClosures), "zero");
  gate("sampled-false-close", quality.closureReviewed > 0 && ratio(quality.falseClosures, quality.closureReviewed) < 0.005,
    `${quality.falseClosures}/${quality.closureReviewed}`, "<0.5%");
  gate("idempotent-reprocessing", final.identity.reprocessChecks > 0
      && final.identity.idempotentReprocesses === final.identity.reprocessChecks,
    `${final.identity.idempotentReprocesses}/${final.identity.reprocessChecks}`, "100%");
  gate("source-local-duplicates", final.identity.sourceListings > 0
      && ratio(final.identity.duplicateSourceListings, final.identity.sourceListings) < 0.001,
    `${final.identity.duplicateSourceListings}/${final.identity.sourceListings}`, "<0.1%");
  gate("workplace-quality", quality.workplaceReviewed > 0 && ratio(quality.workplaceCorrect, quality.workplaceReviewed) >= 0.95,
    `${quality.workplaceCorrect}/${quality.workplaceReviewed}`, ">=95%");
  gate("country-quality", quality.eligibleCountryReviewed > 0 && ratio(quality.eligibleCountryCorrect, quality.eligibleCountryReviewed) >= 0.95,
    `${quality.eligibleCountryCorrect}/${quality.eligibleCountryReviewed}`, ">=95%");
  gate("compensation-quality", quality.displayedCompensationReviewed > 0
      && ratio(quality.compensationCurrencyAndPeriodCorrect, quality.displayedCompensationReviewed) >= 0.95,
    `${quality.compensationCurrencyAndPeriodCorrect}/${quality.displayedCompensationReviewed}`, ">=95% where displayed");
  gate("provenance", final.provenance.displayedFacts > 0
      && final.provenance.factsWithEvidence === final.provenance.displayedFacts,
    `${final.provenance.factsWithEvidence}/${final.provenance.displayedFacts}`, "100%");
  gate("link-quality", quality.linkReviewed > 0 && ratio(quality.brokenEmployerOrApplyLinks, quality.linkReviewed) < 0.02,
    `${quality.brokenEmployerOrApplyLinks}/${quality.linkReviewed}`, "<2%");
  gate("restore", bundle.drills.databaseRestorePassed && bundle.drills.artifactRestorePassed
      && bundle.drills.restoredCountsMatched && bundle.drills.restoredDigestsMatched,
    JSON.stringify({ database: bundle.drills.databaseRestorePassed, artifacts: bundle.drills.artifactRestorePassed,
      counts: bundle.drills.restoredCountsMatched, digests: bundle.drills.restoredDigestsMatched }), "all restore checks pass");
  gate("fault-injection", bundle.drills.connectorOutageCreatedClosures === 0 && bundle.drills.workerCrashHistoryPreserved
      && bundle.drills.connectorRollbackHistoryPreserved,
    JSON.stringify({ outageClosures: bundle.drills.connectorOutageCreatedClosures, crashHistory: bundle.drills.workerCrashHistoryPreserved,
      rollbackHistory: bundle.drills.connectorRollbackHistoryPreserved }), "zero outage closures and history preserved");
  gate("browser-e2e", bundle.drills.browserE2ePassed, String(bundle.drills.browserE2ePassed), "pass");
  gate("security", bundle.security.unresolvedCritical === 0 && bundle.security.unresolvedHigh === 0,
    `${bundle.security.unresolvedCritical} critical / ${bundle.security.unresolvedHigh} high`, "zero unresolved Critical or High findings");
  return { ready: gates.every((item) => item.passed), gates };
}
