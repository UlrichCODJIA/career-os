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
      (SELECT count(*)::int FROM selected job WHERE status = 'succeeded' AND EXISTS (
        SELECT 1 FROM source_scans scan WHERE scan.work_job_id = job.id AND scan.completeness_reason = 'complete'
      )) AS succeeded,
      (SELECT count(*)::int FROM selected job WHERE status = 'terminal_failed' OR (status = 'succeeded' AND NOT EXISTS (
        SELECT 1 FROM source_scans scan WHERE scan.work_job_id = job.id AND scan.completeness_reason = 'complete'
      ))) AS terminal,
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
  const [inventory] = await database<{ confirmed: number; healthy_empty: number; unresolved: number; unconfirmed: number;
    pending: number; held: number; held_visible: number }[]>`
    SELECT
      (SELECT count(*)::int FROM sources WHERE inventory_state = 'confirmed_empty') AS confirmed,
      (SELECT count(*)::int FROM sources WHERE enabled AND health_state = 'healthy'
        AND inventory_state = 'confirmed_empty') AS healthy_empty,
      (SELECT count(*)::int FROM sources WHERE enabled AND health_state = 'healthy'
        AND last_job_count = 0 AND inventory_state <> 'confirmed_empty') AS unresolved,
      (SELECT count(*)::int FROM sources source JOIN source_policies policy ON policy.id = source.policy_id
        WHERE source.enabled AND source.health_state = 'healthy'
        AND source.last_job_count = 0
        AND EXISTS (SELECT 1 FROM source_listings listing WHERE listing.source_id = source.id)
        AND (source.inventory_state <> 'confirmed_empty' OR policy.state <> 'approved' OR policy.expires_at <= ${capturedAt}
          OR source.policy_review_due_at <= ${capturedAt} OR NOT EXISTS (SELECT 1 FROM source_empty_confirmations confirmation
          WHERE confirmation.source_id = source.id AND confirmation.connector_id = source.connector_id
            AND confirmation.connector_version = source.connector_version AND confirmation.tenant_key = source.tenant_key
            AND confirmation.board_url = source.board_url AND confirmation.api_base_url = source.api_base_url
            AND confirmation.region = source.region AND confirmation.policy_id = source.policy_id
            AND confirmation.policy_row_version = policy.row_version
            AND confirmation.board_hash = source.last_board_hash
            AND confirmation.valid_until > ${capturedAt}
            AND NOT EXISTS (SELECT 1 FROM source_empty_confirmation_events event
              WHERE event.confirmation_id = confirmation.id AND event.event_type = 'invalidated')))) AS unconfirmed,
      (SELECT count(*)::int FROM source_empty_reviews WHERE state = 'pending') AS pending,
      (SELECT count(*)::int FROM source_listings WHERE closure_hold_confirmation_id IS NOT NULL) AS held,
      (SELECT count(DISTINCT listing.id)::int FROM source_listings listing
        JOIN opportunity_members member ON member.source_listing_id = listing.id AND member.state <> 'human_rejected'
        JOIN opportunities opportunity ON opportunity.id = member.opportunity_id AND opportunity.status = 'active'
        WHERE listing.closure_hold_confirmation_id IS NOT NULL
          AND NOT EXISTS (SELECT 1 FROM opportunity_members other_member
            JOIN source_listings other_listing ON other_listing.id = other_member.source_listing_id
            WHERE other_member.opportunity_id = opportunity.id AND other_member.state <> 'human_rejected'
              AND other_listing.lifecycle_state = 'active')) AS held_visible
  `;
  const [identity] = await database<Record<string, unknown>[]>`
    SELECT
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
    schemaVersion: 2,
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
    freshness: { enabledSources: count(registry?.enabled), healthySources: count(freshness?.healthy), twiceEnumerated24h: count(freshness?.twice) },
    publication: {
      sampleSize: count(publication?.samples),
      medianHours: publication?.median === null ? null : metric(publication?.median),
      p95Hours: publication?.p95 === null ? null : metric(publication?.p95),
    },
    lifecycle: { closures: count(lifecycle?.closures), massFalseClosures: count(lifecycle?.mass_false) },
    inventory: { confirmedEmptySources: count(inventory?.confirmed), healthyEmptySources: count(inventory?.healthy_empty),
      healthyEmptyUnresolved: count(inventory?.unresolved),
      healthyEmptyWithoutCurrentConfirmation: count(inventory?.unconfirmed), pendingEmptyReviews: count(inventory?.pending),
      heldListings: count(inventory?.held), heldListingsInActiveSearch: count(inventory?.held_visible) },
    identity: {
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
