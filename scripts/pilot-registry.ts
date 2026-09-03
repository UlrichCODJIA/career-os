import { readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { SQL } from "bun";
import { RegistryService } from "../packages/discovery-domain/src/index.ts";
import { PostgresRegistryStore } from "../packages/db/src/index.ts";
import { validatePilotRegistryManifest, type PilotRegistryManifest, type VerifiedPilotEntry } from "../packages/pilot-registry/src/index.ts";

const MAX_MANIFEST_BYTES = 8 * 1024 * 1024;

function fail(message: string): never {
  throw new Error(message);
}

function option(name: string): string | undefined {
  const index = Bun.argv.indexOf(name);
  return index >= 0 ? Bun.argv[index + 1] : undefined;
}

function positiveInteger(value: string | undefined, fallback: number): number {
  if (value === undefined) return fallback;
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < 1 || parsed > 1_000) fail(`${value} is not a valid count`);
  return parsed;
}

function stableKey(digest: string, operation: string, index?: number): string {
  return `pilot-${digest.slice(0, 16)}-${operation}${index === undefined ? "" : `-${index}`}`;
}

type JsonObject = Record<string, unknown>;

function object(value: unknown): JsonObject {
  if (!value || typeof value !== "object") fail("registry operation returned an invalid object");
  return value as JsonObject;
}

function stringValue(value: unknown, name: string): string {
  if (typeof value !== "string" || !value) fail(`registry operation omitted ${name}`);
  return value;
}

function timestamp(value: unknown): string {
  if (value instanceof Date) return value.toISOString();
  return new Date(String(value)).toISOString();
}

async function loadManifest(path: string, expectedVerified: number) {
  const absolute = resolve(path);
  const bytes = await readFile(absolute);
  if (bytes.byteLength > MAX_MANIFEST_BYTES) fail("pilot manifest exceeds 8 MiB");
  let input: unknown;
  try { input = JSON.parse(bytes.toString("utf8")); } catch { fail("pilot manifest is not valid JSON"); }
  return validatePilotRegistryManifest(input, { expectedVerified });
}

function policyShapeMatches(row: JsonObject, manifest: PilotRegistryManifest, family: string): boolean {
  const expected = manifest.policies.find((policy) => policy.sourceFamily === family);
  if (!expected) return false;
  return row.source_family === expected.sourceFamily
    && row.host_pattern === expected.hostPattern
    && row.access_class === expected.accessClass
    && (row.robots_review_url ?? undefined) === expected.robotsReviewUrl
    && (row.terms_review_url ?? undefined) === expected.termsReviewUrl
    && row.retention_class === expected.retentionClass
    && row.attribution_requirements === expected.attributionRequirements
    && Number(row.max_requests_per_minute) === expected.maxRequestsPerMinute
    && Number(row.max_concurrency) === expected.maxConcurrency
    && row.contact_email === expected.contactEmail
    && row.user_agent === expected.userAgent
    && row.state === "approved"
    && timestamp(row.reviewed_at) === expected.reviewedAt
    && timestamp(row.expires_at) === expected.expiresAt
    && new Date(timestamp(row.expires_at)) > new Date();
}

async function resolvePolicies(
  sql: SQL,
  service: RegistryService,
  manifest: PilotRegistryManifest,
  actorId: string,
  digest: string,
): Promise<Map<string, string>> {
  const ids = new Map<string, string>();
  for (const [index, policy] of manifest.policies.entries()) {
    const existing = (await sql<JsonObject[]>`
      SELECT * FROM source_policies
      WHERE source_family = ${policy.sourceFamily} AND host_pattern = ${policy.hostPattern}
    `)[0];
    if (existing) {
      if (!policyShapeMatches(existing, manifest, policy.sourceFamily)) fail(`existing ${policy.sourceFamily} policy differs from reviewed manifest`);
      ids.set(policy.sourceFamily, stringValue(existing.id, "policy id"));
      continue;
    }
    const response = object(await service.createPolicy(
      { actorId, idempotencyKey: stableKey(digest, "policy", index) },
      { ...policy, state: "approved", reason: "Approve reviewed controlled pilot policy" },
    ));
    const created = object(response.policy);
    ids.set(policy.sourceFamily, stringValue(created.id, "policy id"));
  }
  return ids;
}

function importRow(entry: VerifiedPilotEntry) {
  return {
    companyName: entry.company.displayName,
    primaryDomain: entry.company.primaryDomain,
    careersUrl: entry.company.careersUrl,
    atsUrl: entry.source.boardUrl,
    discoveryReference: entry.discoveryReference,
  };
}

async function applyVerifiedEntries(
  sql: SQL,
  service: RegistryService,
  manifest: PilotRegistryManifest,
  policyIds: Map<string, string>,
  actorId: string,
  digest: string,
): Promise<void> {
  const imported = object(await service.importCandidates(
    { actorId, idempotencyKey: stableKey(digest, "import") },
    { rows: manifest.entries.map(importRow), reason: "Import reviewed controlled pilot registry" },
  ));
  if (!Array.isArray(imported.candidateIds) || imported.candidateIds.length !== manifest.entries.length) {
    fail("candidate import did not return one identity per reviewed row");
  }

  for (const [index, entry] of manifest.entries.entries()) {
    const candidateId = stringValue(imported.candidateIds[index], "candidate id");
    const candidate = (await sql<{ review_state: string; verified_source_id: string | null }[]>`
      SELECT review_state, verified_source_id FROM source_candidates WHERE id = ${candidateId}
    `)[0];
    if (!candidate) fail("imported candidate disappeared");
    let sourceId = candidate.verified_source_id;
    if (candidate.review_state === "pending") {
      const policyId = policyIds.get(entry.source.connectorId);
      if (!policyId) fail(`policy missing for ${entry.source.connectorId}`);
      const verified = object(await service.verifyCandidate(
        { actorId, idempotencyKey: stableKey(digest, "verify", index) },
        candidateId,
        {
          company: {
            legalName: entry.company.legalName,
            displayName: entry.company.displayName,
            primaryDomain: entry.company.primaryDomain,
          },
          source: entry.source,
          policyId,
          evidence: entry.evidence,
          reason: entry.reviewReason,
        },
      ));
      sourceId = stringValue(verified.sourceId, "verified source id");
    } else if (candidate.review_state !== "verified" || !sourceId) {
      fail(`candidate ${index + 1} is already ${candidate.review_state}; refusing silent replacement`);
    }

    const stored = (await sql<{ connector_id: string; region: string; tenant_key: string; primary_domain: string; enabled: boolean }[]>`
      SELECT source.connector_id, source.region, source.tenant_key, company.primary_domain, source.enabled
      FROM sources source JOIN companies company ON company.id = source.company_id
      WHERE source.id = ${sourceId}
    `)[0];
    if (!stored || stored.connector_id !== entry.source.connectorId || stored.region !== entry.source.region
      || stored.tenant_key !== entry.source.tenantKey || stored.primary_domain !== entry.company.primaryDomain) {
      fail(`stored identity mismatch at reviewed row ${index + 1}`);
    }
    if (!stored.enabled) {
      await service.updateSource(
        { actorId, idempotencyKey: stableKey(digest, "enable", index) },
        sourceId,
        { enabled: true, cadenceSeconds: 43_200, reason: "Activate verified controlled pilot source" },
      );
    }
  }
}

async function applyQuarantine(
  sql: SQL,
  service: RegistryService,
  manifest: PilotRegistryManifest,
  actorId: string,
  digest: string,
): Promise<void> {
  if (manifest.quarantine.length === 0) return;
  const result = object(await service.importCandidates(
    { actorId, idempotencyKey: stableKey(digest, "quarantine-import") },
    {
      rows: manifest.quarantine.map((entry) => ({
        companyName: entry.companyName,
        primaryDomain: entry.primaryDomain,
        careersUrl: entry.careersUrl,
        atsUrl: entry.atsUrl,
        discoveryReference: entry.discoveryReference,
      })),
      reason: "Import ambiguous pilot rows for quarantine review",
    },
  ));
  if (!Array.isArray(result.candidateIds)) fail("quarantine import omitted candidate identities");
  for (const [index] of manifest.quarantine.entries()) {
    const candidateId = stringValue(result.candidateIds[index], "quarantine candidate id");
    const state = (await sql<{ review_state: string }[]>`SELECT review_state FROM source_candidates WHERE id = ${candidateId}`)[0]?.review_state;
    if (state !== "pending") fail(`quarantine row ${index + 1} is ${state ?? "missing"}; it must remain pending for review`);
  }
}

async function databaseEvidence(sql: SQL, manifest: PilotRegistryManifest): Promise<JsonObject> {
  const domains = manifest.entries.map((entry) => entry.company.primaryDomain);
  const rows = await sql<{ verifiedCompanies: number; activeSources: number; currentPolicies: number; ownershipRecords: number; duplicateTenants: number; wrongCadence: number }[]>`
    WITH pilot_companies AS (
      SELECT id FROM companies WHERE resolution_status = 'verified' AND primary_domain IN ${sql(domains)}
    ), pilot_sources AS (
      SELECT source.* FROM sources source JOIN pilot_companies company ON company.id = source.company_id
    )
    SELECT
      (SELECT count(*)::int FROM pilot_companies) AS "verifiedCompanies",
      (SELECT count(*)::int FROM pilot_sources WHERE enabled) AS "activeSources",
      (SELECT count(DISTINCT policy_id)::int FROM pilot_sources source JOIN source_policies policy ON policy.id = source.policy_id WHERE policy.state = 'approved' AND policy.expires_at > clock_timestamp()) AS "currentPolicies",
      (SELECT count(*)::int FROM ownership_evidence evidence JOIN pilot_sources source ON source.id = evidence.source_id WHERE evidence.confidence >= 0.9) AS "ownershipRecords",
      (SELECT count(*)::int FROM (SELECT connector_id, region, tenant_key FROM pilot_sources GROUP BY 1,2,3 HAVING count(*) > 1) duplicate) AS "duplicateTenants",
      (SELECT count(*)::int FROM pilot_sources WHERE cadence_seconds <> 43200) AS "wrongCadence"
  `;
  return object(rows[0]);
}

export async function applyPilotRegistry(
  sql: SQL,
  manifest: PilotRegistryManifest,
  report: { manifestSha256: string },
  actorId: string,
  expectedVerified: number,
): Promise<JsonObject> {
  const service = new RegistryService(new PostgresRegistryStore(sql));
  const policyIds = await resolvePolicies(sql, service, manifest, actorId, report.manifestSha256);
  await applyVerifiedEntries(sql, service, manifest, policyIds, actorId, report.manifestSha256);
  await applyQuarantine(sql, service, manifest, actorId, report.manifestSha256);
  const evidence = await databaseEvidence(sql, manifest);
  const usedPolicies = new Set(manifest.entries.map((entry) => entry.source.connectorId)).size;
  if (evidence.verifiedCompanies !== expectedVerified || evidence.activeSources !== expectedVerified
    || evidence.currentPolicies !== usedPolicies || evidence.ownershipRecords !== expectedVerified
    || evidence.duplicateTenants !== 0 || evidence.wrongCadence !== 0) {
    fail("post-import database evidence failed the pilot invariants");
  }
  return evidence;
}

async function main(): Promise<void> {
  const command = Bun.argv[2];
  if (command !== "verify" && command !== "apply") fail("usage: pilot-registry.ts verify|apply --manifest <path> --expected <count>");
  const manifestPath = option("--manifest") ?? fail("--manifest is required");
  const expectedVerified = positiveInteger(option("--expected"), 1_000);
  const { manifest, report } = await loadManifest(manifestPath, expectedVerified);
  if (command === "verify") {
    console.log(JSON.stringify({ status: "verified", ...report }, null, 2));
    return;
  }
  if (manifest.classification !== "production") fail("synthetic pilot manifests cannot be applied with the operator CLI");
  if (process.env.PILOT_REGISTRY_CONFIRM_SHA256 !== report.manifestSha256) fail(`set PILOT_REGISTRY_CONFIRM_SHA256=${report.manifestSha256} after reviewing the dry-run report`);
  const databaseUrl = process.env.DATABASE_URL ?? fail("DATABASE_URL is required");
  const actorId = process.env.PILOT_REGISTRY_ACTOR?.trim() ?? fail("PILOT_REGISTRY_ACTOR is required");
  const sql = new SQL(databaseUrl, { max: 4 });
  try {
    const evidence = await applyPilotRegistry(sql, manifest, report, actorId, expectedVerified);
    const output = { status: "applied", ...report, database: evidence };
    const reportPath = option("--report");
    if (reportPath) await writeFile(resolve(reportPath), `${JSON.stringify(output, null, 2)}\n`, { encoding: "utf8", flag: "wx" });
    console.log(JSON.stringify(output, null, 2));
  } finally {
    await sql.close();
  }
}

if (import.meta.main) await main();
