import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { SQL } from "bun";
import {
  loadMigrationFiles,
  migrate,
  PostgresRegistryStore,
  PostgresArtifactMetadata,
  PostgresCompanyResolutionStore,
  PostgresOpportunityResolutionStore,
  PostgresLifecycleStore,
  PostgresOperatorConsole,
  PostgresDiscoveryApi,
  PostgresScanLedger,
  PostgresWorkQueue,
  WORK_QUEUE_SCHEDULER_LOCK_KEY,
} from "../packages/db/src/index.ts";
import { parseOpportunityFilters } from "../packages/discovery-api/src/index.ts";
import { ArtifactRetentionService, LocalArtifactStore } from "../packages/artifact-store/src/index.ts";
import { RegistryService } from "../packages/discovery-domain/src/index.ts";

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

function databaseUrlFor(baseUrl: string, databaseName: string): string {
  const url = new URL(baseUrl);
  url.pathname = `/${databaseName}`;
  return url.toString();
}

function quoteControlledIdentifier(identifier: string): string {
  if (!/^[a-z][a-z0-9_]+$/.test(identifier)) throw new Error("Refusing unsafe database identifier");
  return `"${identifier}"`;
}

async function expectRejected(operation: Promise<unknown>, message: string): Promise<void> {
  const result = await Promise.allSettled([operation]);
  assert(result[0]?.status === "rejected", message);
}

function asObjectForVerification(value: unknown): Record<string, unknown> {
  if (typeof value === "string") return JSON.parse(value) as Record<string, unknown>;
  assert(typeof value === "object" && value !== null, "expected a JSON object");
  return value as Record<string, unknown>;
}

const baseUrl = process.env.DATABASE_URL;
if (!baseUrl) throw new Error("DATABASE_URL is required for database verification");

const databaseName = `career_os_test_${Date.now()}_${crypto.randomUUID().slice(0, 8).replaceAll("-", "")}`;
const quotedDatabase = quoteControlledIdentifier(databaseName);
const testUrl = databaseUrlFor(baseUrl, databaseName);
const admin = new SQL(baseUrl, { max: 1 });
let database: SQL | undefined;
let upgradeDirectory: string | undefined;
let artifactDirectory: string | undefined;

try {
  await admin.unsafe(`CREATE DATABASE ${quotedDatabase} TEMPLATE template0`);

  const concurrent = await Promise.all([migrate({ databaseUrl: testUrl }), migrate({ databaseUrl: testUrl })]);
  assert(concurrent.flatMap((result) => result.applied).length === 9, "concurrent migration runners must apply each file once");
  assert(concurrent.flatMap((result) => result.alreadyApplied).length === 9, "waiting migration runner must verify every applied file");

  const replay = await migrate({ databaseUrl: testUrl });
  assert(replay.applied.length === 0 && replay.alreadyApplied.length === 9, "migration replay must be a verified no-op");

  const productionDirectory = resolve(import.meta.dir, "../db/migrations");
  const productionMigrations = await loadMigrationFiles(productionDirectory);
  assert(productionMigrations.length === 9, "all production migrations must exist");
  upgradeDirectory = await mkdtemp(join(tmpdir(), "career-os-migrations-"));
  for (const migration of productionMigrations) {
    await writeFile(join(upgradeDirectory, migration.name), migration.content, "utf8");
  }
  await writeFile(
    join(upgradeDirectory, "0010_forward_upgrade_probe.sql"),
    "CREATE TABLE migration_forward_probe (id integer PRIMARY KEY);\n",
    "utf8",
  );
  const upgrade = await migrate({ databaseUrl: testUrl, directory: upgradeDirectory });
  assert(upgrade.applied.join() === "0010_forward_upgrade_probe.sql", "forward upgrade must apply only the next migration");

  await writeFile(
    join(upgradeDirectory, "0011_atomic_failure_probe.sql"),
    "CREATE TABLE migration_atomic_failure_probe (id integer PRIMARY KEY);\nSELECT missing_function_for_atomicity_test();\n",
    "utf8",
  );
  await expectRejected(
    migrate({ databaseUrl: testUrl, directory: upgradeDirectory }),
    "a failing forward migration must reject",
  );

  database = new SQL(testUrl, { max: 4 });
  const atomicFailure = await database<{ tableExists: boolean; ledgerRows: number }[]>`
    SELECT
      to_regclass('public.migration_atomic_failure_probe') IS NOT NULL AS "tableExists",
      (SELECT count(*)::int FROM schema_migrations WHERE name = '0011_atomic_failure_probe.sql') AS "ledgerRows"
  `;
  assert(!atomicFailure[0]?.tableExists && atomicFailure[0]?.ledgerRows === 0, "failed migration and ledger write must roll back together");

  const originalUpgradeChecksum = (await database<{ checksum: string }[]>`
    SELECT checksum FROM schema_migrations WHERE name = '0010_forward_upgrade_probe.sql'
  `)[0]?.checksum;
  assert(originalUpgradeChecksum !== undefined, "forward migration checksum must be recorded");
  await database`UPDATE schema_migrations SET checksum = ${"0".repeat(64)} WHERE name = '0010_forward_upgrade_probe.sql'`;
  await expectRejected(migrate({ databaseUrl: testUrl, directory: upgradeDirectory }), "checksum drift must reject migration startup");
  await database`UPDATE schema_migrations SET checksum = ${originalUpgradeChecksum} WHERE name = '0010_forward_upgrade_probe.sql'`;

  const expectedTables = [
    "artifacts",
    "audit_events",
    "companies",
    "company_aliases",
    "company_identity_claims",
    "company_merge_memberships",
    "company_resolution_decisions",
    "company_resolution_fixtures",
    "field_assertions",
    "idempotency_records",
    "lifecycle_circuit_breaker_events",
    "lifecycle_circuit_breakers",
    "lifecycle_events",
    "listing_versions",
    "opportunities",
    "opportunity_compensation",
    "opportunity_field_provenance",
    "opportunity_field_provenance_alternatives",
    "opportunity_languages",
    "opportunity_locations",
    "opportunity_members",
    "opportunity_problem_reports",
    "opportunity_resolution_decisions",
    "opportunity_resolution_fixtures",
    "opportunity_skills",
    "ownership_evidence",
    "resolution_reviews",
    "schema_migrations",
    "source_candidates",
    "source_listings",
    "source_observations",
    "source_policies",
    "source_scan_artifacts",
    "source_scans",
    "sources",
    "work_jobs",
  ];
  const tables = await database<{ tableName: string }[]>`
    SELECT table_name AS "tableName"
    FROM information_schema.tables
    WHERE table_schema = 'public' AND table_type = 'BASE TABLE' AND table_name <> 'migration_forward_probe'
    ORDER BY table_name
  `;
  assert(JSON.stringify(tables.map((row) => row.tableName)) === JSON.stringify(expectedTables), "core table set must match the specification");

  const requiredIndexes = [
    "artifacts_present_reconciliation_idx",
    "artifacts_retention_due_idx",
    "companies_normalized_name_trgm_idx",
    "companies_verified_primary_domain_uq",
    "company_identity_claims_exact_uq",
    "company_merge_memberships_active_source_uq",
    "company_resolution_decisions_history_idx",
    "lifecycle_events_history_idx",
    "lifecycle_circuit_breakers_active_source_uq",
    "lifecycle_circuit_breakers_active_connector_uq",
    "lifecycle_circuit_breakers_history_idx",
    "lifecycle_circuit_breaker_events_history_idx",
    "opportunities_search_idx",
    "opportunities_title_trgm_idx",
    "opportunity_compensation_filter_idx",
    "opportunity_field_provenance_history_idx",
    "opportunity_languages_filter_idx",
    "opportunity_locations_country_idx",
    "opportunity_problem_reports_opportunity_idx",
    "opportunity_problem_reports_queue_idx",
    "opportunity_resolution_decisions_history_idx",
    "opportunity_resolution_decisions_listing_idx",
    "opportunity_skills_filter_idx",
    "source_scans_history_idx",
    "source_observations_listing_history_idx",
    "source_scan_artifacts_artifact_idx",
    "sources_due_idx",
    "work_jobs_active_dedupe_uq",
    "work_jobs_queue_idx",
  ];
  const indexes = await database<{ indexname: string; definition: string }[]>`
    SELECT indexname, indexdef AS definition
    FROM pg_indexes
    WHERE schemaname = 'public' AND indexname IN ${database(requiredIndexes)}
  `;
  assert(indexes.length === requiredIndexes.length, "all specification-required indexes must exist");
  const dueIndex = indexes.find((index) => index.indexname === "sources_due_idx")?.definition;
  assert(dueIndex?.includes("(enabled, next_scan_at) WHERE enabled"), "due-source index must match the required key and predicate");
  const queueIndex = indexes.find((index) => index.indexname === "work_jobs_queue_idx")?.definition;
  assert(queueIndex?.includes("(status, scheduled_at, priority DESC)"), "work queue index must match the required claim order");

  const extension = await database<{ installed: boolean }[]>`
    SELECT EXISTS (SELECT 1 FROM pg_extension WHERE extname = 'pg_trgm') AS installed
  `;
  assert(extension[0]?.installed, "pg_trgm must be installed for assisted review indexes");

  const companyId = crypto.randomUUID();
  const injectedName = "O'Reilly; DROP TABLE companies; --";
  await database`
    INSERT INTO companies (id, display_name, normalized_name)
    VALUES (${companyId}, ${injectedName}, ${"o'reilly"})
  `;
  await database`UPDATE companies SET display_name = ${"O'Reilly Media"} WHERE id = ${companyId}`;
  const versioned = await database<{ displayName: string; rowVersion: number }[]>`
    SELECT display_name AS "displayName", row_version AS "rowVersion" FROM companies WHERE id = ${companyId}
  `;
  assert(versioned[0]?.displayName === "O'Reilly Media" && versioned[0].rowVersion === 2, "parameterized writes and row-version trigger must hold");

  const rollbackId = crypto.randomUUID();
  await expectRejected(
    database.begin(async (tx) => {
      await tx`INSERT INTO companies (id, display_name, normalized_name) VALUES (${rollbackId}, ${"Rollback"}, ${"rollback"})`;
      throw new Error("intentional rollback");
    }),
    "transaction helper must reject after an operation failure",
  );
  const rolledBack = await database<{ count: number }[]>`SELECT count(*)::int AS count FROM companies WHERE id = ${rollbackId}`;
  assert(rolledBack[0]?.count === 0, "failed transaction must leave no durable row");

  const competingDomain = `verified-${crypto.randomUUID()}.example`;
  const inserts = await Promise.allSettled([
    database`INSERT INTO companies (id, display_name, normalized_name, primary_domain, resolution_status, resolution_confidence)
      VALUES (${crypto.randomUUID()}, ${"First"}, ${"first"}, ${competingDomain}, ${"verified"}, ${1})`,
    database`INSERT INTO companies (id, display_name, normalized_name, primary_domain, resolution_status, resolution_confidence)
      VALUES (${crypto.randomUUID()}, ${"Second"}, ${"second"}, ${competingDomain.toUpperCase()}, ${"verified"}, ${1})`,
  ]);
  assert(inserts.filter((result) => result.status === "fulfilled").length === 1, "concurrent verified-domain collision must accept exactly one row");
  assert(inserts.filter((result) => result.status === "rejected").length === 1, "concurrent verified-domain collision must reject exactly one row");

  const auditId = crypto.randomUUID();
  await database`INSERT INTO audit_events (
    id, actor_type, actor_id, action, target_type, target_id, reason, correlation_id
  ) VALUES (
    ${auditId}, ${"operator"}, ${"database-verifier"}, ${"verify"}, ${"schema"}, ${null},
    ${"DSV-005 append-only assertion"}, ${crypto.randomUUID()}
  )`;
  await expectRejected(database`DELETE FROM audit_events WHERE id = ${auditId}`, "audit events must be append-only");

  const registry = new RegistryService(new PostgresRegistryStore(database));
  const actorId = "database-verifier";
  const importCommand = {
    rows: [{
      companyName: "Registry Example",
      primaryDomain: "registry-example.test",
      careersUrl: "https://registry-example.test/careers",
    }],
    reason: "Reviewed database verification import",
  };
  const imported = await registry.importCandidates(
    { actorId, idempotencyKey: "registry-import-0001" },
    importCommand,
  ) as { candidateIds: string[] };
  const replayed = await registry.importCandidates(
    { actorId, idempotencyKey: "registry-import-0001" },
    importCommand,
  );
  assert(JSON.stringify(imported) === JSON.stringify(replayed), "replayed registry mutation must return its stored response");
  await expectRejected(
    registry.importCandidates(
      { actorId, idempotencyKey: "registry-import-0001" },
      { ...importCommand, reason: "Different payload must not reuse the key" },
    ),
    "an idempotency key cannot be reused for a different request",
  );
  const candidateId = imported.candidateIds[0];
  assert(candidateId !== undefined, "registry import must return a candidate id");

  const policyResult = await registry.createPolicy(
    { actorId, idempotencyKey: "registry-policy-0001" },
    {
      sourceFamily: "greenhouse",
      hostPattern: "*.greenhouse.io",
      accessClass: "documented_public_feed",
      reviewedAt: new Date(Date.now() - 60_000).toISOString(),
      expiresAt: new Date(Date.now() + 86_400_000).toISOString(),
      retentionClass: "standard",
      maxRequestsPerMinute: 60,
      maxConcurrency: 2,
      contactEmail: "operator@example.test",
      userAgent: "Career OS database verifier",
      state: "approved",
      reason: "Reviewed policy for integration verification",
    },
  ) as { policy: { id: string } };
  const verificationCommand = {
    company: { displayName: "Registry Example", primaryDomain: "registry-example.test" },
    source: {
      connectorId: "greenhouse" as const,
      tenantKey: "registry-example",
      boardUrl: "https://boards.greenhouse.io/registry-example",
      apiBaseUrl: "https://boards-api.greenhouse.io/v1/boards/registry-example",
      region: "global" as const,
      connectorVersion: "1.0.0",
    },
    policyId: policyResult.policy.id,
    evidence: {
      type: "employer_domain_link" as const,
      evidenceUrl: "https://registry-example.test/careers",
      statement: "Employer career page links to this board",
      confidence: 0.99,
    },
    reason: "Verified employer ownership evidence",
  };
  await expectRejected(
    registry.verifyCandidate(
      { actorId, idempotencyKey: "registry-verify-scope-0001" },
      candidateId,
      { ...verificationCommand, source: { ...verificationCommand.source, apiBaseUrl: "https://unreviewed.example/api" } },
    ),
    "a reviewed policy must bind both source endpoints",
  );
  const verified = await registry.verifyCandidate(
    { actorId, idempotencyKey: "registry-verify-0001" },
    candidateId,
    verificationCommand,
  ) as { companyId: string; sourceId: string };
  await registry.updateSource(
    { actorId, idempotencyKey: "registry-source-0001" },
    verified.sourceId,
    { enabled: true, cadenceSeconds: 43_200, reason: "Enable verified source for discovery" },
  );
  const schedulableBeforePause = await database<{ count: number }[]>`
    SELECT count(*)::int AS count FROM schedulable_sources WHERE id = ${verified.sourceId}
  `;
  assert(schedulableBeforePause[0]?.count === 1, "verified source with a current policy must be schedulable");

  const secondImport = await registry.importCandidates(
    { actorId, idempotencyKey: "registry-import-0002" },
    {
      rows: [{ companyName: "Other Company", primaryDomain: "other-company.test" }],
      reason: "Import duplicate tenant verification candidate",
    },
  ) as { candidateIds: string[] };
  await expectRejected(
    registry.verifyCandidate(
      { actorId, idempotencyKey: "registry-verify-0002" },
      secondImport.candidateIds[0]!,
      {
        company: { displayName: "Other Company", primaryDomain: "other-company.test" },
        source: {
          connectorId: "greenhouse", tenantKey: "registry-example",
          boardUrl: "https://boards.greenhouse.io/registry-example",
          apiBaseUrl: "https://boards-api.greenhouse.io/v1/boards/registry-example",
          region: "global", connectorVersion: "1.0.0",
        },
        policyId: policyResult.policy.id,
        evidence: {
          type: "operator_confirmation", evidenceUrl: "https://other-company.test/careers",
          statement: "Operator reviewed the disputed tenant", confidence: 0.99,
        },
        reason: "Attempt duplicate ATS tenant association",
      },
    ),
    "duplicate connector tenants must be rejected",
  );

  await registry.updatePolicy(
    { actorId, idempotencyKey: "registry-policy-0002" },
    policyResult.policy.id,
    {
      state: "paused",
      reviewedAt: new Date().toISOString(),
      expiresAt: new Date(Date.now() + 86_400_000).toISOString(),
      reason: "Pause policy to verify scheduling interlock",
    },
  );
  const paused = await database<{ enabled: boolean; next_scan_at: Date | null }[]>`
    SELECT enabled, next_scan_at FROM sources WHERE id = ${verified.sourceId}
  `;
  assert(paused[0]?.enabled === false && paused[0].next_scan_at === null, "policy pause must unschedule sources without deleting history");
  const schedulableAfterPause = await database<{ count: number }[]>`
    SELECT count(*)::int AS count FROM schedulable_sources WHERE id = ${verified.sourceId}
  `;
  assert(schedulableAfterPause[0]?.count === 0, "paused source must disappear from the scheduling boundary");
  await expectRejected(
    registry.updateSource(
      { actorId, idempotencyKey: "registry-source-0002" },
      verified.sourceId,
      { enabled: true, reason: "Expired or paused policy cannot schedule" },
    ),
    "a source with a non-current policy must not be scheduled",
  );

  const registryAudits = await database<{ metadata: unknown }[]>`
    SELECT metadata FROM audit_events WHERE action LIKE 'registry.%' ORDER BY sequence
  `;
  assert(registryAudits.length >= 6, "every successful registry mutation must emit an audit event");
  for (const row of registryAudits) {
    const metadata = asObjectForVerification(row.metadata);
    assert("before" in metadata && "after" in metadata && "idempotencyKey" in metadata, "registry audit metadata must be complete");
  }
  const registryAuditId = (await database<{ id: string }[]>`
    SELECT id FROM audit_events WHERE action LIKE 'registry.%' ORDER BY sequence LIMIT 1
  `)[0]?.id;
  assert(registryAuditId !== undefined, "registry audit event must exist");
  await expectRejected(database`UPDATE audit_events SET reason = ${"tampered"} WHERE id = ${registryAuditId}`, "registry audit events must remain immutable");

  const resolution = new PostgresCompanyResolutionStore(database);
  await resolution.recordIdentityClaim(
    { actorId, idempotencyKey: "company-claim-0001" },
    {
      companyId: verified.companyId,
      type: "verified_alias",
      value: "Registry Example, Inc.",
      evidenceType: "operator_confirmed_alias",
      evidenceUrl: "https://registry-example.test/about",
      confidence: 1,
      reason: "Operator verified legal trade-name evidence",
    },
  );
  const identities = await resolution.listCompanyIdentities();
  const verifiedIdentity = identities.find((identity) => identity.id === verified.companyId);
  const verifiedKeys = verifiedIdentity?.keys as Array<{ type: string; value: string }> | undefined;
  assert(verifiedKeys?.some((key) => key.type === "verified_domain" && key.value === "registry-example.test"),
    "verified employer domains must become durable resolver claims");
  assert(verifiedKeys?.some((key) => key.type === "ats_tenant" && key.value === "greenhouse:global:registry-example"),
    "verified ATS tenants must become durable resolver claims");
  assert(verifiedKeys?.some((key) => key.type === "verified_alias" && key.value === "Registry Example, Inc."),
    "verified aliases must use the resolver contract rather than the database enum");
  const duplicateCompanyId = crypto.randomUUID();
  await database`INSERT INTO companies (
    id, display_name, normalized_name, primary_domain, resolution_status, resolution_confidence
  ) VALUES (${duplicateCompanyId}, ${"Registry Example Holdings"}, ${"registry example holdings"},
    ${`holdings-${crypto.randomUUID()}.test`}, ${"verified"}, ${0.95})`;
  const review = await resolution.queueReview(duplicateCompanyId, {
    action: "review",
    reason: "operator_confirmed_alias",
    resolverVersion: "1.0.0",
    candidates: [{ companyId: duplicateCompanyId }, { companyId: verified.companyId }],
  }, 100);
  const mergeCommand = {
    sourceCompanyId: duplicateCompanyId,
    canonicalCompanyId: verified.companyId,
    reviewId: review.reviewId,
    resolverVersion: "1.0.0",
    confidence: 1,
    reason: "Operator confirmed exact company ownership evidence",
    fixtureKey: `company-merge:${duplicateCompanyId}`,
    fixtureInput: { sourceCompanyId: duplicateCompanyId, canonicalCompanyId: verified.companyId },
    fixtureExpected: { action: "automatic_match", companyId: verified.companyId },
  };
  const merged = await resolution.mergeCompanies(
    { actorId, idempotencyKey: "company-merge-0001" }, mergeCommand,
  );
  const mergeReplay = await resolution.mergeCompanies(
    { actorId, idempotencyKey: "company-merge-0001" }, mergeCommand,
  );
  assert(JSON.stringify(merged) === JSON.stringify(mergeReplay), "reviewed company merge replay must return the original decision");
  const canonicalAfterMerge = (await database<{ canonicalId: string; isMerged: boolean }[]>`
    SELECT canonical_company_id AS "canonicalId", is_merged AS "isMerged"
    FROM canonical_company_resolution WHERE source_company_id = ${duplicateCompanyId}
  `)[0];
  assert(canonicalAfterMerge?.canonicalId === verified.companyId && canonicalAfterMerge.isMerged, "merge must preserve the source ID while projecting the canonical company");
  const split = await resolution.splitCompany(
    { actorId, idempotencyKey: "company-split-0001" },
    {
      sourceCompanyId: duplicateCompanyId,
      canonicalCompanyId: verified.companyId,
      resolverVersion: "1.0.0",
      reason: "Operator reversed the reviewed company merge",
      fixtureKey: `company-split:${duplicateCompanyId}`,
      fixtureInput: { sourceCompanyId: duplicateCompanyId, canonicalCompanyId: verified.companyId },
      fixtureExpected: { action: "create_new", companyId: duplicateCompanyId },
    },
  );
  assert(typeof split.decisionId === "string", "split must append a durable decision");
  const restored = (await database<{ canonicalId: string; status: string; decisions: number; fixtures: number }[]>`
    SELECT
      (SELECT canonical_company_id::text FROM canonical_company_resolution WHERE source_company_id = ${duplicateCompanyId}) AS "canonicalId",
      (SELECT resolution_status FROM companies WHERE id = ${duplicateCompanyId}) AS status,
      (SELECT count(*)::int FROM company_resolution_decisions WHERE subject_company_id = ${duplicateCompanyId}) AS decisions,
      (SELECT count(*)::int FROM company_resolution_fixtures WHERE decision_id IN (
        SELECT id FROM company_resolution_decisions WHERE subject_company_id = ${duplicateCompanyId}
      )) AS fixtures
  `)[0];
  assert(restored?.canonicalId === duplicateCompanyId && restored.status === "verified" && restored.decisions === 2 && restored.fixtures === 2,
    "split must restore the original company and retain both immutable decisions as regression fixtures");
  const firstDecisionId = String(merged.decisionId);
  await expectRejected(database`DELETE FROM company_resolution_decisions WHERE id = ${firstDecisionId}`, "company decisions must be append-only");
  await expectRejected(database`UPDATE company_resolution_fixtures SET expected_json = ${"{}"}::text::jsonb WHERE decision_id = ${firstDecisionId}`, "review fixtures must be immutable");

  const queueTime = { value: new Date() };
  const queueClock = { now: () => queueTime.value, random: () => 0 };
  await registry.updatePolicy(
    { actorId, idempotencyKey: "queue-policy-0001" },
    policyResult.policy.id,
    {
      state: "approved",
      reviewedAt: new Date(queueTime.value.getTime() - 1_000).toISOString(),
      expiresAt: new Date(queueTime.value.getTime() + 86_400_000).toISOString(),
      reason: "Renew policy for durable queue verification",
    },
  );
  await registry.updateSource(
    { actorId, idempotencyKey: "queue-source-0001" },
    verified.sourceId,
    { enabled: true, reason: "Enable source for scheduler verification" },
  );
  await database`UPDATE sources SET next_scan_at = ${queueTime.value.toISOString()} WHERE id = ${verified.sourceId}`;

  const firstQueue = new PostgresWorkQueue(database, queueClock);
  const secondQueue = new PostgresWorkQueue(database, queueClock);
  const electedLockHolder = new SQL(testUrl, { max: 1 });
  await electedLockHolder`SELECT pg_advisory_lock(${WORK_QUEUE_SCHEDULER_LOCK_KEY})`;
  const unelected = await firstQueue.scheduleDueSources();
  assert(!unelected.elected && unelected.enqueued === 0, "a second scheduler must fail election while the lock is held");
  await electedLockHolder`SELECT pg_advisory_unlock(${WORK_QUEUE_SCHEDULER_LOCK_KEY})`;
  await electedLockHolder.close();
  const schedulerResults = await Promise.all([firstQueue.scheduleDueSources(), secondQueue.scheduleDueSources()]);
  assert(schedulerResults.reduce((sum, result) => sum + result.enqueued, 0) === 1, "concurrent schedulers must enqueue one deterministic source job");
  const scheduledCadence = (await database<{ nextScanAt: Date | string }[]>`
    SELECT next_scan_at AS "nextScanAt" FROM sources WHERE id = ${verified.sourceId}
  `)[0]?.nextScanAt;
  assert(scheduledCadence !== undefined && new Date(scheduledCadence).getTime() <= queueTime.value.getTime() + 43_200_000,
    "deterministic load spreading must not lengthen a twice-daily source cadence");
  await database`UPDATE sources SET next_scan_at = ${queueTime.value.toISOString()} WHERE id = ${verified.sourceId}`;
  const duplicateSchedule = await firstQueue.scheduleDueSources();
  assert(duplicateSchedule.enqueued === 0, "the active dedupe key must prevent duplicate enqueue within a cadence bucket");

  const competingClaims = await Promise.all([firstQueue.claim("worker-a"), secondQueue.claim("worker-b")]);
  const leases = competingClaims.flat();
  assert(leases.length === 1, "SKIP LOCKED workers must claim a queued job exactly once");
  const originalLease = leases[0]!;
  const originalWorker = competingClaims[0]!.length === 1 ? "worker-a" : "worker-b";
  queueTime.value = new Date(originalLease.leaseExpiresAt.getTime() + 1);
  const reaped = await firstQueue.reapExpired();
  assert(reaped.retried === 1 && reaped.terminal === 0, "expired retryable lease must return to the retry queue");
  await expectRejected(firstQueue.succeed(originalLease, originalWorker), "a reaped stale worker must not commit");

  const replacement = (await firstQueue.claim("worker-c"))[0];
  assert(replacement !== undefined && replacement.leaseGeneration === originalLease.leaseGeneration + 1, "reclaimed jobs must receive a higher fencing generation");
  const heartbeat = await firstQueue.heartbeat(replacement, "worker-c", 60);
  assert(heartbeat > queueTime.value, "current lease owner must be able to extend its lease");
  const retry = await firstQueue.fail(replacement, "worker-c", "upstream_timeout", "Timed out before response headers", true);
  assert(retry.status === "retryable_failed" && retry.scheduledAt?.getTime() === queueTime.value.getTime(), "full-jitter retry must honor the injected clock and random source");
  const finalLease = (await firstQueue.claim("worker-d"))[0];
  assert(finalLease !== undefined && finalLease.leaseGeneration > replacement.leaseGeneration, "each claim must advance the fencing generation");
  await firstQueue.succeed(finalLease, "worker-d");

  const terminalJobId = crypto.randomUUID();
  await database`INSERT INTO work_jobs (
    id, type, dedupe_key, payload_json, status, scheduled_at, max_attempts
  ) VALUES (
    ${terminalJobId}, ${"verification"}, ${`terminal:${terminalJobId}`}, ${"{}"}::text::jsonb,
    ${"queued"}, ${queueTime.value.toISOString()}, ${1}
  )`;
  const terminalLease = (await firstQueue.claim("worker-e"))[0];
  assert(terminalLease?.id === terminalJobId, "attempt-budget fixture must be claimable");
  const terminal = await firstQueue.fail(terminalLease, "worker-e", "invalid_payload", "Validated payload was rejected", true);
  assert(terminal.status === "terminal_failed" && terminal.scheduledAt === null, "exhausted attempt budget must terminate the job");
  const queueHealth = await firstQueue.health();
  assert(queueHealth.terminalFailed === 1 && queueHealth.expiredLeases === 0, "queue health must expose terminal and expired-lease counts");

  artifactDirectory = await mkdtemp(join(tmpdir(), "career-os-artifacts-"));
  const artifactStore = new LocalArtifactStore({ root: artifactDirectory });
  const artifactMetadata = new PostgresArtifactMetadata(database);
  const artifactRetention = new ArtifactRetentionService(artifactStore, artifactMetadata);
  const artifactBytes = new TextEncoder().encode("database retention verification");
  const storedArtifact = await artifactStore.put(artifactBytes, "text/plain");
  const artifactNow = new Date();
  const catalogedArtifact = await artifactMetadata.record({
    stored: storedArtifact,
    metadata: {
      canonicalSourceUrl: "https://example.test/jobs?page=1&token=must-not-persist",
      responseHeaders: { "Content-Type": "text/plain", Authorization: "Bearer must-not-persist" },
    },
    retrievedAt: new Date(artifactNow.getTime() - 10_000),
    statusCode: 200,
    retentionClass: "verification",
    deletionDueAt: new Date(artifactNow.getTime() - 1),
  });
  const persistedMetadata = (await database<{ url: string; headers: unknown }[]>`
    SELECT canonical_source_url AS url, response_headers AS headers FROM artifacts WHERE id = ${catalogedArtifact.id}
  `)[0];
  assert(persistedMetadata !== undefined && !JSON.stringify(persistedMetadata).includes("must-not-persist"), "artifact metadata must not persist credential canaries");

  const scanJobId = crypto.randomUUID();
  await database`INSERT INTO work_jobs (id, type, dedupe_key, payload_json, status, scheduled_at)
    VALUES (${scanJobId}, ${"scan_source"}, ${`scan-verification:${scanJobId}`}, ${"{}"}::text::jsonb, ${"queued"}, ${queueTime.value})`;
  const scanLease = (await firstQueue.claim("scan-ledger-worker"))[0];
  assert(scanLease?.id === scanJobId, "scan ledger fixture must be leased");
  const scanLedger = new PostgresScanLedger(database, { random: () => 0 });
  const scanStarted = new Date(queueTime.value.getTime() - 200);
  const scanEnded = new Date(queueTime.value.getTime() - 100);
  const completeScanInput: Parameters<PostgresScanLedger["commit"]>[0] = {
    lease: scanLease,
    workerId: "scan-ledger-worker",
    sourceId: verified.sourceId,
    startedAt: scanStarted,
    endedAt: scanEnded,
    connectorId: "greenhouse",
    connectorVersion: "1.0.0",
    safeFetchPolicyVersion: "1.0.0",
    policyId: policyResult.policy.id,
    fetchMetadata: { requestCount: 1, decisionsRecorded: true },
    completenessReason: "complete",
    responseArtifactIds: [catalogedArtifact.id],
    observations: [{
      sourceJobId: "verification-job-1",
      canonicalSourceUrl: "https://job-boards.greenhouse.io/registry-example/jobs/1",
      applyUrl: "https://job-boards.greenhouse.io/registry-example/jobs/1",
      artifactId: catalogedArtifact.id,
      semanticFingerprint: "semantic-v1",
      rawFingerprint: storedArtifact.digest,
      parsedSource: { title: { value: "Verification Engineer", artifactId: catalogedArtifact.id } },
      normalizedCandidate: { title: "Verification Engineer" },
      parserVersion: "1.0.0",
      normalizerVersion: "1.0.0",
      taxonomyVersion: "1.0.0",
      assertions: [{
        fieldPath: "/displayTitle", value: "Verification Engineer", origin: "source_field",
        artifactId: catalogedArtifact.id, locator: { kind: "json_pointer", pointer: "/title" },
        extractorId: "database-verifier", extractorVersion: "1.0.0", confidence: 1,
      }, {
        fieldPath: "/normalizedTitle", value: "verification engineer", origin: "source_field",
        artifactId: catalogedArtifact.id, locator: { kind: "json_pointer", pointer: "/title" },
        extractorId: "database-verifier", extractorVersion: "1.0.0", confidence: 1,
      }, {
        fieldPath: "/descriptionText", value: "Verify durable systems", origin: "source_field",
        artifactId: catalogedArtifact.id, locator: { kind: "json_pointer", pointer: "/description" },
        extractorId: "database-verifier", extractorVersion: "1.0.0", confidence: 1,
      }, {
        fieldPath: "/workplaceType", value: "remote", origin: "source_field",
        artifactId: catalogedArtifact.id, locator: { kind: "json_pointer", pointer: "/workplace" },
        extractorId: "database-verifier", extractorVersion: "1.0.0", confidence: 1,
      }, {
        fieldPath: "/canonicalSourceUrl", value: "https://job-boards.greenhouse.io/registry-example/jobs/1", origin: "source_field",
        artifactId: catalogedArtifact.id, locator: { kind: "json_pointer", pointer: "/absolute_url" },
        extractorId: "database-verifier", extractorVersion: "1.0.0", confidence: 1,
      }, {
        fieldPath: "/applyUrl", value: "https://job-boards.greenhouse.io/registry-example/jobs/1", origin: "source_field",
        artifactId: catalogedArtifact.id, locator: { kind: "json_pointer", pointer: "/absolute_url" },
        extractorId: "database-verifier", extractorVersion: "1.0.0", confidence: 1,
      }],
    }],
    byteCount: storedArtifact.byteLength,
    boardHash: "board-v1",
  };
  const scanCommit = await scanLedger.commit(completeScanInput);
  assert(!scanCommit.replayed && scanCommit.observationCount === 1 && scanCommit.versionCount === 1, "first scan delivery must atomically persist one observation and version");
  const replayedScan = await scanLedger.commit(completeScanInput);
  assert(replayedScan.replayed && replayedScan.scanId === scanCommit.scanId && replayedScan.observationCount === 1, "duplicate delivery after commit must replay the durable attempt without requiring a live lease");
  await expectRejected(
    scanLedger.commit({ ...completeScanInput, boardHash: "tampered-replay" }),
    "a duplicate delivery with different content must be rejected",
  );
  const ledgerCounts = (await database<{ scans: number; artifacts: number; observations: number; versions: number; assertions: number }[]>`
    SELECT
      (SELECT count(*)::int FROM source_scans WHERE work_job_id = ${scanJobId}) AS scans,
      (SELECT count(*)::int FROM source_scan_artifacts WHERE source_scan_id = ${scanCommit.scanId}) AS artifacts,
      (SELECT count(*)::int FROM source_observations WHERE source_scan_id = ${scanCommit.scanId}) AS observations,
      (SELECT count(*)::int FROM listing_versions WHERE source_scan_id = ${scanCommit.scanId}) AS versions,
      (SELECT count(*)::int FROM field_assertions WHERE target_type = 'listing_version'
        AND target_id IN (SELECT id FROM listing_versions WHERE source_scan_id = ${scanCommit.scanId})) AS assertions
  `)[0];
  assert(ledgerCounts?.scans === 1 && ledgerCounts.artifacts === 1 && ledgerCounts.observations === 1 && ledgerCounts.versions === 1 && ledgerCounts.assertions === 6, "duplicate delivery must not duplicate scan or evidence rows");
  await expectRejected(database`DELETE FROM source_observations WHERE source_scan_id = ${scanCommit.scanId}`, "source observations must be append-only");
  await expectRejected(database`UPDATE source_scans SET board_hash = ${"tampered"} WHERE id = ${scanCommit.scanId}`, "completed source scans must be immutable");

  async function commitConnectorVersionProbe(connectorVersion: string, endedAt: Date) {
    await database!`UPDATE sources SET connector_version = ${connectorVersion} WHERE id = ${verified.sourceId}`;
    const jobId = crypto.randomUUID();
    const token = crypto.randomUUID();
    const workerId = `connector-version-verifier-${connectorVersion}`;
    await database!`INSERT INTO work_jobs (id, type, dedupe_key, payload_json, status, scheduled_at, attempt,
      leased_at, lease_expires_at, lease_owner, lease_token, lease_generation)
      VALUES (${jobId}, ${"scan_source"}, ${`connector-version:${jobId}`}, ${"{}"}::text::jsonb, ${"leased"}, ${endedAt}, ${1},
        ${new Date(endedAt.getTime() - 1_000)}, ${new Date(endedAt.getTime() + 60_000)}, ${workerId}, ${token}, ${1})`;
    return scanLedger.commit({ ...completeScanInput, lease: { id: jobId, leaseToken: token, leaseGeneration: 1 },
      workerId, startedAt: new Date(endedAt.getTime() - 500), endedAt, connectorVersion,
      boardHash: `connector-version-${connectorVersion}` });
  }
  const upgradedScan = await commitConnectorVersionProbe("1.1.0", new Date(scanEnded.getTime() + 5 * 60_000));
  const rolledBackScan = await commitConnectorVersionProbe("1.0.0", new Date(scanEnded.getTime() + 10 * 60_000));
  const connectorVersionHistory = await database<{ connectorVersion: string }[]>`
    SELECT connector_version AS "connectorVersion" FROM source_scans
    WHERE id IN ${database([scanCommit.scanId, upgradedScan.scanId, rolledBackScan.scanId])}
    ORDER BY started_at, id`;
  assert(connectorVersionHistory.map((row) => row.connectorVersion).join(",") === "1.0.0,1.1.0,1.0.0",
    "connector upgrade and rollback must retain immutable scan history for every executed version");

  const opportunityResolution = new PostgresOpportunityResolutionStore(database);
  const evidenceRows = await database<{ assertionId: string; listingId: string }[]>`SELECT assertion.id AS "assertionId",
      version.source_listing_id AS "listingId" FROM field_assertions assertion
    JOIN listing_versions version ON version.id = assertion.target_id
    WHERE assertion.target_type = 'listing_version' AND version.source_scan_id = ${scanCommit.scanId} ORDER BY assertion.id`;
  const opportunityCommand = {
    companyId: verified.companyId,
    sourceListingId: evidenceRows[0]!.listingId,
    assertionIds: evidenceRows.map((row) => row.assertionId),
    firstSeenAt: scanEnded.toISOString(),
    fixtureKey: `opportunity-create:${evidenceRows[0]!.listingId}`,
    fixtureInput: { sourceListingId: evidenceRows[0]!.listingId, assertionIds: evidenceRows.map((row) => row.assertionId).sort() },
    reason: "Deterministically project the verified source listing",
  };
  const createdOpportunity = await opportunityResolution.create(
    { actorId: "opportunity-verifier", actorType: "system", idempotencyKey: "opportunity-create-0001" }, opportunityCommand,
  ) as { opportunityId: string; decisionId: string };
  const replayedOpportunity = await opportunityResolution.create(
    { actorId: "opportunity-verifier", actorType: "system", idempotencyKey: "opportunity-create-0001" }, opportunityCommand,
  ) as { opportunityId: string; decisionId: string };
  assert(createdOpportunity.opportunityId === replayedOpportunity.opportunityId
    && createdOpportunity.decisionId === replayedOpportunity.decisionId, "opportunity creation must replay its stored response");
  const firstProjection = (await database<{ displayTitle: string; provenance: number; selected: number }[]>`SELECT
      opportunity.display_title AS "displayTitle",
      (SELECT count(*)::int FROM opportunity_field_provenance WHERE decision_id = ${createdOpportunity.decisionId}) AS provenance,
      (SELECT count(*)::int FROM field_assertions WHERE target_type = 'opportunity' AND target_id = opportunity.id AND selected) AS selected
    FROM opportunities opportunity WHERE opportunity.id = ${createdOpportunity.opportunityId}`)[0];
  assert(firstProjection?.displayTitle === "Verification Engineer" && firstProjection.provenance === 6 && firstProjection.selected === 6,
    "every required displayed opportunity field must retain selected source provenance");
  const rebuilt = await opportunityResolution.rebuild(
    { actorId: "opportunity-verifier", actorType: "system", idempotencyKey: "opportunity-rebuild-0001" },
    { opportunityId: createdOpportunity.opportunityId, fixtureKey: `opportunity-rebuild:${createdOpportunity.opportunityId}`,
      fixtureInput: { opportunityId: createdOpportunity.opportunityId }, reason: "Verify deterministic projection replay from assertions" },
  ) as { decisionId: string; projection: unknown };
  const rebuildProjection = (await database<{ provenance: number; selected: number; decisions: number; fixtures: number }[]>`SELECT
      (SELECT count(*)::int FROM opportunity_field_provenance WHERE decision_id = ${rebuilt.decisionId}) AS provenance,
      (SELECT count(*)::int FROM field_assertions WHERE target_type = 'opportunity' AND target_id = ${createdOpportunity.opportunityId} AND selected) AS selected,
      (SELECT count(*)::int FROM opportunity_resolution_decisions WHERE opportunity_id = ${createdOpportunity.opportunityId}) AS decisions,
      (SELECT count(*)::int FROM opportunity_resolution_fixtures WHERE decision_id IN
        (SELECT id FROM opportunity_resolution_decisions WHERE opportunity_id = ${createdOpportunity.opportunityId})) AS fixtures`)[0];
  assert(rebuildProjection?.provenance === 6 && rebuildProjection.selected === 6 && rebuildProjection.decisions === 2 && rebuildProjection.fixtures === 2,
    "rebuild must replace selected projections while retaining immutable provenance history and fixtures");
  await opportunityResolution.split(
    { actorId: "opportunity-operator", actorType: "operator", idempotencyKey: "opportunity-split-0001" },
    { opportunityId: createdOpportunity.opportunityId, sourceListingId: evidenceRows[0]!.listingId,
      fixtureKey: `opportunity-split:${evidenceRows[0]!.listingId}`, fixtureInput: { sourceListingId: evidenceRows[0]!.listingId },
      reason: "Operator reverses the opportunity membership fixture" },
  );
  const splitState = (await database<{ state: string; status: string; decisions: number }[]>`SELECT member.state,
      opportunity.status, (SELECT count(*)::int FROM opportunity_resolution_decisions
        WHERE opportunity_id = ${createdOpportunity.opportunityId}) AS decisions
    FROM opportunity_members member JOIN opportunities opportunity ON opportunity.id = member.opportunity_id
    WHERE member.opportunity_id = ${createdOpportunity.opportunityId} AND member.source_listing_id = ${evidenceRows[0]!.listingId}`)[0];
  assert(splitState?.state === "human_rejected" && splitState.status === "closed" && splitState.decisions === 3,
    "split must preserve the membership and opportunity while making the active projection reversible");
  await expectRejected(database`DELETE FROM opportunity_resolution_decisions WHERE id = ${createdOpportunity.decisionId}`,
    "opportunity decisions must be append-only");
  await expectRejected(database`UPDATE opportunity_field_provenance SET projected_value_json = ${"null"}::jsonb
    WHERE decision_id = ${createdOpportunity.decisionId}`, "opportunity provenance must be immutable");

  await database`UPDATE opportunity_members SET state = 'automatic', membership_reason = 'lifecycle verification'
    WHERE opportunity_id = ${createdOpportunity.opportunityId} AND source_listing_id = ${evidenceRows[0]!.listingId}`;
  await database`UPDATE opportunities SET status = 'active', closed_at = NULL WHERE id = ${createdOpportunity.opportunityId}`;
  const lifecycleWorker = "lifecycle-verifier";
  async function commitLifecycleScan(endedAt: Date, observations: typeof completeScanInput.observations) {
    const jobId = crypto.randomUUID();
    const token = crypto.randomUUID();
    await database!`INSERT INTO work_jobs (id, type, dedupe_key, payload_json, status, scheduled_at, attempt,
      leased_at, lease_expires_at, lease_owner, lease_token, lease_generation)
      VALUES (${jobId}, ${"scan_source"}, ${`lifecycle:${jobId}`}, ${"{}"}::text::jsonb, ${"leased"}, ${endedAt}, ${1},
        ${new Date(endedAt.getTime() - 1_000)}, ${new Date(endedAt.getTime() + 60_000)}, ${lifecycleWorker}, ${token}, ${1})`;
    return scanLedger.commit({ ...completeScanInput, lease: { id: jobId, leaseToken: token, leaseGeneration: 1 },
      workerId: lifecycleWorker, startedAt: new Date(endedAt.getTime() - 500), endedAt, observations,
      boardHash: `lifecycle-${endedAt.toISOString()}` });
  }
  const firstMissingAt = new Date(scanEnded.getTime() + 31 * 60_000);
  const firstMissingScan = await commitLifecycleScan(firstMissingAt, []);
  const possible = (await database<{ state: string; misses: number; opportunityStatus: string; absence: boolean }[]>`SELECT
      listing.lifecycle_state AS state, listing.consecutive_complete_misses AS misses,
      (SELECT status FROM opportunities WHERE id = ${createdOpportunity.opportunityId}) AS "opportunityStatus",
      (SELECT successful_for_absence_inference FROM source_scans WHERE id = ${firstMissingScan.scanId}) AS absence
    FROM source_listings listing WHERE listing.id = ${evidenceRows[0]!.listingId}`)[0];
  assert(possible?.state === "possibly_closed" && possible.misses === 1 && possible.opportunityStatus === "possibly_closed" && possible.absence,
    "first qualifying absence must project possibly-closed without confirming closure");
  const confirmedAt = new Date(firstMissingAt.getTime() + 31 * 60_000);
  await commitLifecycleScan(confirmedAt, []);
  const closedLifecycle = (await database<{ state: string; closedAt: Date | null; opportunityStatus: string }[]>`SELECT
      listing.lifecycle_state AS state, listing.closed_at AS "closedAt",
      (SELECT status FROM opportunities WHERE id = ${createdOpportunity.opportunityId}) AS "opportunityStatus"
    FROM source_listings listing WHERE listing.id = ${evidenceRows[0]!.listingId}`)[0];
  assert(closedLifecycle?.state === "closed" && closedLifecycle.closedAt !== null && closedLifecycle.opportunityStatus === "closed",
    "second separated complete absence must close listing and its last trusted opportunity member");
  const reopenedAt = new Date(confirmedAt.getTime() + 31 * 60_000);
  await commitLifecycleScan(reopenedAt, completeScanInput.observations);
  const reopenedLifecycle = (await database<{ state: string; reopenedAt: Date | null; opportunityStatus: string; events: number }[]>`SELECT
      listing.lifecycle_state AS state, listing.reopened_at AS "reopenedAt",
      (SELECT status FROM opportunities WHERE id = ${createdOpportunity.opportunityId}) AS "opportunityStatus",
      (SELECT count(*)::int FROM lifecycle_events WHERE aggregate_type = 'source_listing' AND aggregate_id = listing.id) AS events
    FROM source_listings listing WHERE listing.id = ${evidenceRows[0]!.listingId}`)[0];
  assert(reopenedLifecycle?.state === "active" && reopenedLifecycle.reopenedAt !== null
    && reopenedLifecycle.opportunityStatus === "active" && reopenedLifecycle.events >= 4,
    "same source identity must reopen durably and append listing/opportunity lifecycle events");

  await database`UPDATE sources SET last_job_count = 100 WHERE id = ${verified.sourceId}`;
  const collapseAt = new Date(reopenedAt.getTime() + 31 * 60_000);
  const collapseObservations = Array.from({ length: 10 }, (_, index) => ({ ...completeScanInput.observations[0]!,
    sourceJobId: `collapse-fixture-${index}`, semanticFingerprint: `collapse-semantic-${index}` }));
  const collapseScan = await commitLifecycleScan(collapseAt, collapseObservations);
  const quarantine = (await database<{ breakerId: string; health: string; absence: boolean; originalState: string }[]>`SELECT
      breaker.id AS "breakerId", source.health_state AS health, scan.successful_for_absence_inference AS absence,
      (SELECT lifecycle_state FROM source_listings WHERE id = ${evidenceRows[0]!.listingId}) AS "originalState"
    FROM lifecycle_circuit_breakers breaker JOIN sources source ON source.id = breaker.source_id
    JOIN source_scans scan ON scan.id = breaker.trigger_scan_id WHERE breaker.source_id = ${verified.sourceId} AND breaker.state = 'tripped'`)[0];
  assert(quarantine?.health === "quarantined" && !quarantine.absence && quarantine.originalState === "active",
    "90% count collapse must quarantine the source before any absence mutation");
  const lifecycleStore = new PostgresLifecycleStore(database);
  const cleared = await lifecycleStore.clearCircuitBreaker(
    { actorId: "lifecycle-operator", idempotencyKey: "lifecycle-clear-0001" },
    { circuitBreakerId: quarantine!.breakerId, reason: "Operator verified connector recovery evidence" },
  );
  const clearedReplay = await lifecycleStore.clearCircuitBreaker(
    { actorId: "lifecycle-operator", idempotencyKey: "lifecycle-clear-0001" },
    { circuitBreakerId: quarantine!.breakerId, reason: "Operator verified connector recovery evidence" },
  );
  assert(cleared.circuitBreakerId === clearedReplay.circuitBreakerId && collapseScan.observationCount === 10,
    "operator circuit-breaker clearance must be audited, reversible, and idempotent");
  const operatorConsole = new PostgresOperatorConsole(database);
  const operatorOverview = await operatorConsole.overview();
  const operatorEvidence = await operatorConsole.sourceEvidence(verified.sourceId);
  const operatorEvidenceJson = JSON.stringify(operatorEvidence);
  assert(Array.isArray(operatorOverview.sourceHealth) && operatorOverview.activeBreakers === 0,
    "operator overview must derive bounded health and active-breaker counts");
  assert(operatorEvidence?.rawArtifactAccess && asObjectForVerification(operatorEvidence.rawArtifactAccess).available === false,
    "operator evidence must make raw artifact access explicitly unavailable");
  assert(!/response_headers|storage_uri|canonical_source_url|authorization|cookie/iu.test(operatorEvidenceJson),
    "operator evidence must exclude stored URLs, headers, credentials, and raw artifact locators");
  const lifecycleAudit = (await database<{ count: number }[]>`SELECT count(*)::int AS count FROM audit_events
    WHERE action = 'lifecycle.breaker_cleared' AND actor_id = ${"lifecycle-operator"}
      AND reason = ${"Operator verified connector recovery evidence"}`)[0];
  assert(lifecycleAudit?.count === 1, "operator breaker clearance must append exactly one audit event across replay");

  const secondOpportunityId = crypto.randomUUID();
  await database`INSERT INTO opportunities (id, company_id, display_title, normalized_title, description_text, workplace_type,
    canonical_source_url, apply_url, status, first_seen_at, canonicalization_version)
    VALUES (${secondOpportunityId}, ${verified.companyId}, ${"Database Reliability Engineer"}, ${"database reliability engineer"},
      ${"Operate durable PostgreSQL systems"}, ${"remote"}, ${"https://example.test/jobs/database-reliability"},
      ${"https://example.test/jobs/database-reliability/apply"}, ${"active"}, ${new Date(reopenedAt.getTime() + 60_000)}, ${"verification"})`;
  const discoveryApi = new PostgresDiscoveryApi(database);
  const firstPage = await discoveryApi.searchOpportunities(parseOpportunityFilters(new URLSearchParams("q=engineer&sort=first_seen_desc&limit=1&status=active")));
  assert(firstPage.items.length === 1 && firstPage.nextCursor !== null, "canonical search must return a bounded first keyset page");
  const secondPage = await discoveryApi.searchOpportunities(parseOpportunityFilters(new URLSearchParams(
    `q=engineer&sort=first_seen_desc&limit=1&status=active&cursor=${encodeURIComponent(firstPage.nextCursor)}`,
  )));
  assert(secondPage.items.length === 1 && secondPage.items[0]!.id !== firstPage.items[0]!.id,
    "stable keyset pagination must not repeat an item across pages");
  const nullDateFirst = await discoveryApi.searchOpportunities(parseOpportunityFilters(new URLSearchParams("q=engineer&sort=source_posted_desc&limit=1&status=active")));
  const nullDateSecond = await discoveryApi.searchOpportunities(parseOpportunityFilters(new URLSearchParams(
    `q=engineer&sort=source_posted_desc&limit=1&status=active&cursor=${encodeURIComponent(nullDateFirst.nextCursor!)}`,
  )));
  assert(nullDateFirst.items.length === 1 && nullDateSecond.items.length === 1
    && nullDateFirst.items[0]!.id !== nullDateSecond.items[0]!.id,
    "null source-posted dates must share the cursor sentinel without repeating rows");
  const opportunityDetail = await discoveryApi.getOpportunity(createdOpportunity.opportunityId);
  assert(Array.isArray(opportunityDetail?.provenance) && Array.isArray(opportunityDetail?.changeHistory)
    && !JSON.stringify(opportunityDetail).match(/resume|candidate_email|phone_number/iu),
    "canonical detail must include evidence history without candidate-private data");
  const report = await discoveryApi.reportOpportunity(
    { actorId: "discovery-verifier", idempotencyKey: "problem-report-0001" }, createdOpportunity.opportunityId,
    { kind: "closed", detail: "Source link was independently observed closed" },
  );
  const replayedReport = await discoveryApi.reportOpportunity(
    { actorId: "discovery-verifier", idempotencyKey: "problem-report-0001" }, createdOpportunity.opportunityId,
    { kind: "closed", detail: "Source link was independently observed closed" },
  );
  assert(report.reportId === replayedReport.reportId, "problem-report replay must return the original immutable report");
  const unchanged = (await database<{ status: string; reports: number }[]>`SELECT status,
      (SELECT count(*)::int FROM opportunity_problem_reports WHERE opportunity_id = opportunity.id) AS reports
    FROM opportunities opportunity WHERE id = ${createdOpportunity.opportunityId}`)[0];
  assert(unchanged?.status === "active" && unchanged.reports === 1, "a user report must not directly mutate canonical lifecycle state");
  await expectRejected(database`DELETE FROM opportunity_problem_reports WHERE id = ${report.reportId}`,
    "problem reports must be append-only");

  queueTime.value = new Date(collapseAt.getTime() + 60 * 60_000);
  const beforeConnectorOutage = (await database<{ events: number; listingState: string; opportunityStatus: string }[]>`
    SELECT
      (SELECT count(*)::int FROM lifecycle_events WHERE aggregate_type = 'source_listing'
        AND aggregate_id = ${evidenceRows[0]!.listingId}) AS events,
      lifecycle_state AS "listingState",
      (SELECT status FROM opportunities WHERE id = ${createdOpportunity.opportunityId}) AS "opportunityStatus"
    FROM source_listings WHERE id = ${evidenceRows[0]!.listingId}`)[0];
  const failedJobId = crypto.randomUUID();
  const failedPayload = JSON.stringify({
    sourceId: verified.sourceId,
    connectorId: "greenhouse",
    connectorVersion: "1.0.0",
    tenantKey: "acme",
    cadenceBucket: 1,
  });
  await database`INSERT INTO work_jobs (id, type, dedupe_key, payload_json, status, scheduled_at, max_attempts)
    VALUES (${failedJobId}, ${"scan_source"}, ${`scan-failure:${failedJobId}`}, ${failedPayload}::text::jsonb, ${"queued"}, ${queueTime.value}, ${2})`;
  const failedLease = (await firstQueue.claim("scan-failure-worker"))[0];
  assert(failedLease?.id === failedJobId, "failed scan fixture must be leased");
  await scanLedger.fail({
    lease: failedLease, workerId: "scan-failure-worker", sourceId: verified.sourceId,
    startedAt: scanEnded, endedAt: queueTime.value, connectorId: "greenhouse", connectorVersion: "1.0.0",
    safeFetchPolicyVersion: "1.0.0", policyId: policyResult.policy.id, fetchMetadata: { requestCount: 0 },
    reason: "transport_failure", errorCode: "upstream_timeout", retryable: true,
  });
  const retryLease = (await firstQueue.claim("scan-retry-worker"))[0];
  assert(retryLease?.id === failedJobId && retryLease.leaseGeneration > failedLease.leaseGeneration, "retryable scan failures must create a newly fenced attempt");
  await scanLedger.fail({
    lease: retryLease, workerId: "scan-retry-worker", sourceId: verified.sourceId,
    startedAt: queueTime.value, endedAt: queueTime.value, connectorId: "greenhouse", connectorVersion: "1.0.0",
    safeFetchPolicyVersion: "1.0.0", policyId: policyResult.policy.id, fetchMetadata: { requestCount: 0 },
    reason: "transport_failure", errorCode: "upstream_timeout", retryable: true,
  });
  const retryOutcome = (await database<{ attempts: number; status: string; state: string; failures: number }[]>`
    SELECT
      (SELECT count(*)::int FROM source_scans WHERE work_job_id = ${failedJobId}) AS attempts,
      (SELECT status FROM work_jobs WHERE id = ${failedJobId}) AS status,
      health_state AS state, consecutive_failures AS failures
    FROM sources WHERE id = ${verified.sourceId}
  `)[0];
  assert(retryOutcome?.attempts === 2 && retryOutcome.status === "terminal_failed" && retryOutcome.state === "degraded" && retryOutcome.failures === 2, "scan retry outcomes and source health must derive from durable completed attempts");
  const afterConnectorOutage = (await database<{ events: number; listingState: string; opportunityStatus: string }[]>`
    SELECT
      (SELECT count(*)::int FROM lifecycle_events WHERE aggregate_type = 'source_listing'
        AND aggregate_id = ${evidenceRows[0]!.listingId}) AS events,
      lifecycle_state AS "listingState",
      (SELECT status FROM opportunities WHERE id = ${createdOpportunity.opportunityId}) AS "opportunityStatus"
    FROM source_listings WHERE id = ${evidenceRows[0]!.listingId}`)[0];
  assert(beforeConnectorOutage !== undefined && afterConnectorOutage !== undefined
    && afterConnectorOutage.events === beforeConnectorOutage.events
    && afterConnectorOutage.listingState === beforeConnectorOutage.listingState
    && afterConnectorOutage.opportunityStatus === beforeConnectorOutage.opportunityStatus,
    "a connector outage must create zero closure events and preserve listing and opportunity lifecycle state");

  const recoveryCommand = {
    actorId,
    idempotencyKey: "terminal-recovery-0001",
    reason: "Recover verified transient scan failures after transport remediation",
    failedAfter: new Date(queueTime.value.getTime() - 1_000),
    failedBefore: new Date(queueTime.value.getTime() + 1_000),
    errorCodes: ["upstream_timeout"] as const,
    limit: 10,
  };
  const recovery = await firstQueue.recoverTerminalSourceScans(recoveryCommand);
  const recoveryReplay = await firstQueue.recoverTerminalSourceScans(recoveryCommand);
  assert(recovery.recovered === 1 && recovery.selected === 1
    && recoveryReplay.recovered === recovery.recovered && recoveryReplay.selected === recovery.selected,
    `terminal scan recovery must append one replacement job and replay idempotently (${JSON.stringify({ recovery, recoveryReplay })})`);
  const recoveredLease = (await firstQueue.claim("recovery-verifier", 1, 300, "scan_source"))[0];
  assert(recoveredLease?.payload.recoveredFromJobId === failedJobId,
    "recovery must preserve an internal link to the terminal job without mutating it");
  await firstQueue.cancel(recoveredLease.id, "Verification cleanup preserves both queue records");
  const recoveryEvidence = (await database<{ terminal: number; recovered: number; audits: number }[]>`
    SELECT
      count(*) FILTER (WHERE id = ${failedJobId} AND status = 'terminal_failed')::int AS terminal,
      count(*) FILTER (WHERE payload_json->>'recoveredFromJobId' = ${failedJobId})::int AS recovered,
      (SELECT count(*)::int FROM audit_events WHERE action = 'queue.terminal_scans_recovered'
        AND actor_id = ${actorId}) AS audits
    FROM work_jobs
  `)[0];
  assert(recoveryEvidence?.terminal === 1 && recoveryEvidence.recovered === 1 && recoveryEvidence.audits === 1,
    "recovery must retain terminal history and append exactly one aggregate operator audit event");

  const concurrentRetentionClaims = await Promise.all([
    artifactMetadata.claimDue(artifactNow, 10),
    artifactMetadata.claimDue(artifactNow, 10),
  ]);
  assert(concurrentRetentionClaims.flat().length === 1, "competing retention workers must claim a due artifact once");
  await artifactMetadata.failDeletion(catalogedArtifact.id, "simulated first failure");
  const retentionResult = await artifactRetention.deleteExpired(artifactNow, 10);
  assert(retentionResult.deleted === 1 && retentionResult.failed === 0, "failed retention claims must retry to a durable tombstone");
  assert(!(await artifactStore.has(storedArtifact.digest)), "retention must remove due bytes");
  const deletedArtifact = (await database<{ state: string; deletedAt: Date | null }[]>`
    SELECT storage_state AS state, deleted_at AS "deletedAt" FROM artifacts WHERE id = ${catalogedArtifact.id}
  `)[0];
  assert(deletedArtifact?.state === "deleted" && deletedArtifact.deletedAt !== null, "retention must preserve deleted metadata as a tombstone");

  console.log("Database verification passed: migrations, registry governance, reversible canonical resolution, lifecycle closure/reopening and circuit breakers, zero-closure connector outage injection, connector upgrade/rollback history, redacted operator evidence and audit replay, bounded canonical APIs and immutable reports, queue fencing, idempotent terminal recovery with immutable history, scan ledger idempotency, and artifact retention reconciliation.");
} finally {
  if (database) await database.close();
  if (upgradeDirectory) await rm(upgradeDirectory, { recursive: true, force: true });
  if (artifactDirectory) await rm(artifactDirectory, { recursive: true, force: true });
  await admin.unsafe(`DROP DATABASE IF EXISTS ${quotedDatabase} WITH (FORCE)`);
  await admin.close();
}
