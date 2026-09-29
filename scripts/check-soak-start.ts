import { readFile } from "node:fs/promises";
import { createDatabase } from "../packages/db/src/index.ts";
import type { SQL } from "bun";
import { PilotRegistryManifestSchema, pilotRegistryDigest } from "../packages/pilot-registry/src/index.ts";
import { deployedReleaseCommit } from "./release-build-identity.ts";

function required(name: string): string {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`${name} is required`);
  return value;
}

export async function inspectSoakStartCounts(database: SQL) {
  const [counts] = await database<{ enabled: number; unhealthy: number; policy_short: number; unresolved_empty: number;
    unconfirmed_empty: number; pending_reviews: number; active_breakers: number;
    overdue_jobs: number; terminal_jobs: number; held_visible: number }[]>`
    SELECT
      (SELECT count(*)::int FROM sources WHERE enabled) AS enabled,
      (SELECT count(*)::int FROM sources WHERE enabled AND health_state <> 'healthy') AS unhealthy,
      (SELECT count(*)::int FROM sources source JOIN source_policies policy ON policy.id = source.policy_id
        WHERE source.enabled AND (policy.state <> 'approved' OR policy.expires_at < clock_timestamp() + interval '8 days'
          OR source.policy_review_due_at < clock_timestamp() + interval '8 days')) AS policy_short,
      (SELECT count(*)::int FROM sources WHERE enabled AND health_state = 'healthy'
        AND last_job_count = 0 AND inventory_state <> 'confirmed_empty') AS unresolved_empty,
      (SELECT count(*)::int FROM sources source WHERE source.enabled AND source.health_state = 'healthy'
        AND source.last_job_count = 0
        AND EXISTS (SELECT 1 FROM source_listings listing WHERE listing.source_id = source.id)
        AND (source.inventory_state <> 'confirmed_empty' OR NOT EXISTS (SELECT 1 FROM source_empty_confirmations confirmation
          JOIN source_policies policy ON policy.id = source.policy_id
          WHERE confirmation.source_id = source.id AND confirmation.connector_id = source.connector_id
            AND confirmation.connector_version = source.connector_version AND confirmation.tenant_key = source.tenant_key
            AND confirmation.board_url = source.board_url AND confirmation.api_base_url = source.api_base_url
            AND confirmation.region = source.region AND confirmation.policy_id = source.policy_id
            AND confirmation.policy_row_version = policy.row_version
            AND confirmation.board_hash = source.last_board_hash
            AND confirmation.valid_until >= clock_timestamp() + interval '8 days'
            AND NOT EXISTS (SELECT 1 FROM source_empty_confirmation_events event
              WHERE event.confirmation_id = confirmation.id AND event.event_type = 'invalidated')))) AS unconfirmed_empty,
      (SELECT count(*)::int FROM source_empty_reviews WHERE state = 'pending') AS pending_reviews,
      (SELECT count(*)::int FROM lifecycle_circuit_breakers WHERE state = 'tripped') AS active_breakers,
      (SELECT count(*)::int FROM work_jobs WHERE type = 'scan_source' AND status IN ('queued', 'retryable_failed')
        AND scheduled_at < clock_timestamp() - interval '30 minutes')
        + (SELECT count(*)::int FROM work_jobs WHERE type = 'scan_source' AND status = 'leased'
          AND lease_expires_at < clock_timestamp()) AS overdue_jobs,
      (SELECT count(*)::int FROM work_jobs WHERE type = 'scan_source' AND status = 'terminal_failed'
        AND created_at > clock_timestamp() - interval '24 hours') AS terminal_jobs,
      (SELECT count(DISTINCT listing.id)::int FROM source_listings listing
        JOIN opportunity_members member ON member.source_listing_id = listing.id AND member.state <> 'human_rejected'
        JOIN opportunities opportunity ON opportunity.id = member.opportunity_id AND opportunity.status = 'active'
        WHERE listing.closure_hold_confirmation_id IS NOT NULL
          AND NOT EXISTS (SELECT 1 FROM opportunity_members other_member
            JOIN source_listings other_listing ON other_listing.id = other_member.source_listing_id
            WHERE other_member.opportunity_id = opportunity.id AND other_member.state <> 'human_rejected'
              AND other_listing.lifecycle_state = 'active')) AS held_visible
  `;
  if (!counts) throw new Error("soak start counts unavailable");
  return counts;
}

if (import.meta.main) {
const releaseCommit = required("RELEASE_COMMIT");
const registryDigest = required("REGISTRY_DIGEST");
if (!/^[a-f0-9]{40}$/.test(releaseCommit) || !/^[a-f0-9]{64}$/.test(registryDigest)) {
  throw new Error("invalid release subject");
}
const deployedCommit = await deployedReleaseCommit(process.cwd());
if (deployedCommit !== releaseCommit) throw new Error("release commit does not match deployed checkout or image");
const manifest = JSON.parse(await readFile(process.env.REGISTRY_MANIFEST_PATH?.trim() || "private/pilot-registry.json", "utf8"));
const parsedManifest = PilotRegistryManifestSchema.parse(manifest);
if (parsedManifest.entries.length !== 1_000 || pilotRegistryDigest(parsedManifest) !== registryDigest) {
  throw new Error("registry archive digest does not match release subject");
}

const database = createDatabase(required("DATABASE_URL"));
try {
  const liveSources = await database<{ connector_id: string; region: string; tenant_key: string;
    board_url: string; api_base_url: string; connector_version: string }[]>`
    SELECT connector_id, region, tenant_key, board_url, api_base_url, connector_version
    FROM sources WHERE enabled ORDER BY connector_id, region, tenant_key`;
  const identity = (source: { connectorId: string; region: string; tenantKey: string;
    boardUrl: string; apiBaseUrl: string; connectorVersion: string }) => JSON.stringify([
      source.connectorId, source.region, source.tenantKey, source.boardUrl, source.apiBaseUrl, source.connectorVersion,
    ]);
  const archived = parsedManifest.entries.map((entry) => identity(entry.source)).sort();
  const deployed = liveSources.map((source) => identity({ connectorId: source.connector_id, region: source.region,
    tenantKey: source.tenant_key, boardUrl: source.board_url, apiBaseUrl: source.api_base_url,
    connectorVersion: source.connector_version })).sort();
  if (JSON.stringify(archived) !== JSON.stringify(deployed)) throw new Error("deployed source identities differ from approved registry archive");
  const counts = await inspectSoakStartCounts(database);
  const ready = counts?.enabled === 1_000 && Object.entries(counts).every(([key, value]) => key === "enabled" || value === 0);
  console.log(JSON.stringify({ ready, releaseCommit, registryDigest, counts }));
  if (!ready) process.exitCode = 1;
} finally {
  await database.close();
}
}
