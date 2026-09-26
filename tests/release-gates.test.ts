import { describe, expect, test } from "bun:test";
import {
  evaluateReleaseEvidence,
  FaultInjectionReceiptSchema,
  ReleaseEvidenceBundleSchema,
  RestoreDrillReceiptSchema,
} from "../packages/release-gates/src/index.ts";

const releaseCommit = "a".repeat(40);
const registryDigest = "b".repeat(64);
const startedAt = Date.parse("2026-09-04T00:00:00.000Z");

function bundle(): Record<string, unknown> {
  const snapshots = Array.from({ length: 15 }, (_, index) => ({
    schemaVersion: 1,
    capturedAt: new Date(startedAt + index * 12 * 3_600_000).toISOString(),
    soakStartedAt: new Date(startedAt).toISOString(),
    releaseCommit,
    registryDigest,
    registry: { verifiedSources: 1_000, enabledSources: 1_000 },
    scheduling: { dueJobs: 14_000, succeededJobs: 13_900, terminalJobs: 100, inFlightJobs: 0, p95QueueLagSeconds: 900 },
    freshness: { enabledSources: 1_000, healthySources: 1_000, twiceEnumerated24h: index < 2 ? 0 : 970 },
    publication: { sampleSize: 8_000, medianHours: 4, p95Hours: 12 },
    lifecycle: { closures: 500, massFalseClosures: 0 },
    identity: { sourceListings: 50_000, duplicateSourceListings: 0 },
    provenance: { displayedFacts: 200_000, factsWithEvidence: 200_000 },
  }));
  return {
    schemaVersion: 1,
    releaseCommit,
    registryDigest,
    snapshots,
    qualityAudit: {
      schemaVersion: 1, reviewedAt: "2026-09-11T01:00:00.000Z", reviewer: "release-reviewer",
      releaseCommit, registryDigest, stratifiedSampleSize: 100,
      workplaceReviewed: 100, workplaceCorrect: 98,
      eligibleCountryReviewed: 100, eligibleCountryCorrect: 97,
      displayedCompensationReviewed: 50, compensationCurrencyAndPeriodCorrect: 49,
      closureReviewed: 500, falseClosures: 0, linkReviewed: 200, brokenEmployerOrApplyLinks: 2,
      notes: "Stratified evidence reviewed against retained source artifacts.",
    },
    drills: {
      schemaVersion: 1, completedAt: "2026-09-11T01:00:00.000Z", releaseCommit,
      databaseRestorePassed: true, artifactRestorePassed: true, restoredCountsMatched: true, restoredDigestsMatched: true,
      connectorOutageCreatedClosures: 0, workerCrashHistoryPreserved: true,
      connectorRollbackHistoryPreserved: true, idempotentReprocessingPassed: true, browserE2ePassed: true,
    },
    security: {
      schemaVersion: 1, completedAt: "2026-09-11T01:00:00.000Z", releaseCommit,
      scanner: "codex-security-standard", unresolvedCritical: 0, unresolvedHigh: 0,
      reportReference: "Codex Security report attached to the release review.",
    },
  };
}

describe("release evidence gates", () => {
  test("passes one internally consistent seven-day evidence bundle at every exact threshold", () => {
    const result = evaluateReleaseEvidence(bundle());
    expect(result.ready).toBe(true);
    expect(result.gates.length).toBe(21);
    expect(result.gates.every((gate) => gate.passed)).toBe(true);
  });

  test("fails closed on insufficient soak, stale freshness, quality drift, failed restore, or security findings", () => {
    const evidence = bundle() as any;
    evidence.snapshots = evidence.snapshots.slice(0, 13);
    evidence.snapshots.at(-1).freshness.healthySources = 990;
    evidence.snapshots.at(-1).freshness.twiceEnumerated24h = 900;
    evidence.qualityAudit.workplaceCorrect = 90;
    evidence.drills.restoredDigestsMatched = false;
    evidence.security.unresolvedHigh = 1;
    const result = evaluateReleaseEvidence(evidence);
    expect(result.ready).toBe(false);
    for (const id of ["soak-coverage", "fleet-health", "freshness", "workplace-quality", "restore", "security"]) {
      expect(result.gates.find((gate) => gate.id === id)?.passed).toBe(false);
    }
  });

  test("rejects unknown evidence fields and mixed release subjects", () => {
    expect(() => ReleaseEvidenceBundleSchema.parse({ ...bundle(), unexpected: true })).toThrow();
    const evidence = bundle() as any;
    evidence.snapshots[4].registryDigest = "c".repeat(64);
    const result = evaluateReleaseEvidence(evidence);
    expect(result.gates.find((gate) => gate.id === "evidence-subject")?.passed).toBe(false);
  });

  test("accepts only aggregate, isolated restore evidence", () => {
    const receipt = {
      schemaVersion: 1,
      completedAt: "2026-09-11T01:00:00.000Z",
      releaseCommit,
      sourceSnapshotAt: "2026-09-11T00:58:00.000Z",
      isolation: { outboundNetworkDisabled: true, workerPausedDuringSnapshot: true },
      database: {
        passed: true, tableCount: 36, sourceRowCount: 80_000, restoredRowCount: 80_000,
        migrationCount: 9, countsMatched: true, migrationsMatched: true,
      },
      artifacts: {
        passed: true, sourceFileCount: 2_000, restoredFileCount: 2_000,
        sourceBytes: 42_000_000, restoredBytes: 42_000_000,
        sourceTreeDigest: "c".repeat(64), restoredTreeDigest: "c".repeat(64), digestsMatched: true,
      },
      recoveryTimeSeconds: 91.5,
      cleanupPassed: true,
    };
    expect(RestoreDrillReceiptSchema.parse(receipt).cleanupPassed).toBe(true);
    expect(() => RestoreDrillReceiptSchema.parse({ ...receipt,
      isolation: { ...receipt.isolation, outboundNetworkDisabled: false } })).toThrow();
    expect(() => RestoreDrillReceiptSchema.parse({ ...receipt, rawRows: [] })).toThrow();
  });

  test("requires all named fault points and an upgrade-rollback sequence", () => {
    const receipt = {
      schemaVersion: 1,
      completedAt: "2026-09-11T01:00:00.000Z",
      releaseCommit,
      connectorOutage: { failedAttempts: 2, closureEventsCreated: 0, lifecycleStatePreserved: true },
      workerCrash: {
        points: ["afterFetch", "afterArtifacts", "beforeCommit"], partialCommitsCreated: 0,
        artifactsDeduplicated: true, retryCommittedOnce: true,
      },
      duplicateDelivery: { replayedExistingScan: true, canonicalRowsChanged: 0 },
      connectorRollback: { executedVersions: ["1.0.0", "1.1.0", "1.0.0"], finalizedHistoryPreserved: true },
    };
    expect(FaultInjectionReceiptSchema.parse(receipt).connectorOutage.closureEventsCreated).toBe(0);
    expect(() => FaultInjectionReceiptSchema.parse({ ...receipt,
      workerCrash: { ...receipt.workerCrash, points: ["afterFetch", "beforeCommit"] } })).toThrow();
    expect(() => FaultInjectionReceiptSchema.parse({ ...receipt,
      connectorOutage: { ...receipt.connectorOutage, closureEventsCreated: 1 } })).toThrow();
  });
});
