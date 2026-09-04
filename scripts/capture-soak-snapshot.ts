import { mkdir, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { createDatabase } from "../packages/db/src/index.ts";
import { SoakSnapshotSchema } from "../packages/release-gates/src/index.ts";

function required(name: string): string {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`${name} is required`);
  return value;
}

function count(value: unknown): number {
  const parsed = Number(value ?? 0);
  if (!Number.isSafeInteger(parsed) || parsed < 0) throw new Error("database returned an invalid count");
  return parsed;
}

function metric(value: unknown): number {
  const parsed = Number(value ?? 0);
  if (!Number.isFinite(parsed) || parsed < 0) throw new Error("database returned an invalid metric");
  return parsed;
}

const soakStartedAt = new Date(required("SOAK_STARTED_AT"));
if (!Number.isFinite(soakStartedAt.getTime()) || soakStartedAt > new Date()) throw new Error("SOAK_STARTED_AT must be a past ISO timestamp");
const releaseCommit = required("RELEASE_COMMIT");
const registryDigest = required("REGISTRY_DIGEST");
const capturedAt = new Date();
const database = createDatabase(required("DATABASE_URL"));

try {
  const [registry] = await database<{ verified: number; enabled: number }[]>`
    SELECT
      count(*) FILTER (WHERE EXISTS (SELECT 1 FROM ownership_evidence evidence WHERE evidence.source_id = source.id AND evidence.confidence >= 0.9))::int AS verified,
      count(*) FILTER (WHERE source.enabled)::int AS enabled
    FROM sources source
  `;
  const [scheduling] = await database<Record<string, unknown>[]>`
    WITH selected AS (
      SELECT job.* FROM work_jobs job
      WHERE job.type = 'scan_source' AND job.created_at >= ${soakStartedAt} AND job.created_at <= ${capturedAt}
    ), lag AS (
      SELECT greatest(0, extract(epoch FROM (coalesce(
        (SELECT min(scan.started_at) FROM source_scans scan WHERE scan.work_job_id = job.id),
        ${capturedAt}::timestamptz
      ) - job.scheduled_at))) AS seconds
      FROM selected job WHERE job.scheduled_at <= ${capturedAt}
    )
    SELECT
      (SELECT count(*)::int FROM selected) AS due,
      (SELECT count(*)::int FROM selected WHERE status = 'succeeded') AS succeeded,
      (SELECT count(*)::int FROM selected WHERE status = 'terminal_failed') AS terminal,
      (SELECT count(*)::int FROM selected WHERE status IN ('queued', 'leased', 'retryable_failed')) AS inflight,
      coalesce((SELECT percentile_cont(0.95) WITHIN GROUP (ORDER BY seconds) FROM lag), 0) AS p95
  `;
  const [freshness] = await database<{ healthy: number; twice: number }[]>`
    SELECT
      count(*) FILTER (WHERE source.enabled AND source.health_state = 'healthy')::int AS healthy,
      count(*) FILTER (WHERE source.enabled AND source.health_state = 'healthy' AND (
        SELECT count(*) FROM source_scans scan WHERE scan.source_id = source.id
          AND scan.completeness_reason = 'complete' AND scan.ended_at > ${new Date(capturedAt.getTime() - 86_400_000)}
      ) >= 2)::int AS twice
    FROM sources source
  `;
  const [publication] = await database<Record<string, unknown>[]>`
    WITH lag AS (
      SELECT extract(epoch FROM (version.created_at - version.source_posted_at)) / 3600 AS hours
      FROM listing_versions version
      WHERE version.created_at >= ${soakStartedAt} AND version.created_at <= ${capturedAt}
        AND version.source_posted_at IS NOT NULL AND version.created_at >= version.source_posted_at
    )
    SELECT count(*)::int AS samples,
      percentile_cont(0.5) WITHIN GROUP (ORDER BY hours) AS median,
      percentile_cont(0.95) WITHIN GROUP (ORDER BY hours) AS p95
    FROM lag
  `;
  const [lifecycle] = await database<{ closures: number; mass_false: number }[]>`
    SELECT
      count(*) FILTER (WHERE event_type = 'closed')::int AS closures,
      (SELECT count(*)::int FROM audit_events WHERE action = 'release.mass_false_closure_confirmed'
        AND occurred_at >= ${soakStartedAt} AND occurred_at <= ${capturedAt}) AS mass_false
    FROM lifecycle_events WHERE occurred_at >= ${soakStartedAt} AND occurred_at <= ${capturedAt}
  `;
  const [identity] = await database<Record<string, unknown>[]>`
    SELECT
      (SELECT count(*)::int FROM source_scans WHERE created_at >= ${soakStartedAt} AND created_at <= ${capturedAt}) AS reprocess_checks,
      (SELECT count(*)::int FROM source_scans WHERE created_at >= ${soakStartedAt} AND created_at <= ${capturedAt})
        - (SELECT coalesce(sum(extra), 0)::int FROM (
          SELECT count(*) - 1 AS extra FROM source_scans WHERE created_at >= ${soakStartedAt} AND created_at <= ${capturedAt}
          GROUP BY work_job_id, lease_generation HAVING count(*) > 1
        ) duplicate_scans) AS idempotent,
      (SELECT count(*)::int FROM source_listings) AS listings,
      (SELECT coalesce(sum(extra), 0)::int FROM (
        SELECT count(*) - 1 AS extra FROM source_listings GROUP BY source_id, source_job_id HAVING count(*) > 1
      ) duplicate_listings) AS duplicates
  `;
  const [provenance] = await database<{ displayed: number; evidenced: number }[]>`
    SELECT count(*) FILTER (WHERE selected)::int AS displayed,
      count(*) FILTER (WHERE selected AND (artifact_id IS NOT NULL OR origin IN ('deterministic_rule', 'human_review')))::int AS evidenced
    FROM field_assertions
  `;

  const snapshot = SoakSnapshotSchema.parse({
    schemaVersion: 1,
    capturedAt: capturedAt.toISOString(),
    soakStartedAt: soakStartedAt.toISOString(),
    releaseCommit,
    registryDigest,
    registry: { verifiedSources: count(registry?.verified), enabledSources: count(registry?.enabled) },
    scheduling: {
      dueJobs: count(scheduling?.due), succeededJobs: count(scheduling?.succeeded),
      terminalJobs: count(scheduling?.terminal), inFlightJobs: count(scheduling?.inflight),
      p95QueueLagSeconds: metric(scheduling?.p95),
    },
    freshness: { healthySources: count(freshness?.healthy), twiceEnumerated24h: count(freshness?.twice) },
    publication: {
      sampleSize: count(publication?.samples),
      medianHours: publication?.median === null ? null : metric(publication?.median),
      p95Hours: publication?.p95 === null ? null : metric(publication?.p95),
    },
    lifecycle: { closures: count(lifecycle?.closures), massFalseClosures: count(lifecycle?.mass_false) },
    identity: {
      reprocessChecks: count(identity?.reprocess_checks), idempotentReprocesses: count(identity?.idempotent),
      sourceListings: count(identity?.listings), duplicateSourceListings: count(identity?.duplicates),
    },
    provenance: { displayedFacts: count(provenance?.displayed), factsWithEvidence: count(provenance?.evidenced) },
  });
  const directory = resolve(process.env.SOAK_EVIDENCE_DIR?.trim() || "private/release/soak");
  await mkdir(directory, { recursive: true, mode: 0o700 });
  const filename = `${snapshot.capturedAt.replaceAll(":", "-")}.json`;
  await writeFile(resolve(directory, filename), `${JSON.stringify(snapshot, null, 2)}\n`, { encoding: "utf8", flag: "wx", mode: 0o600 });
  console.log(JSON.stringify({ ok: true, capturedAt: snapshot.capturedAt, file: filename,
    verifiedSources: snapshot.registry.verifiedSources, dueJobs: snapshot.scheduling.dueJobs,
    succeededJobs: snapshot.scheduling.succeededJobs, terminalJobs: snapshot.scheduling.terminalJobs,
    inFlightJobs: snapshot.scheduling.inFlightJobs }));
} finally {
  await database.close();
}
