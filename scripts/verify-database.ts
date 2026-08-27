import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { SQL } from "bun";
import { loadMigrationFiles, migrate, PostgresRegistryStore } from "../packages/db/src/index.ts";
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

try {
  await admin.unsafe(`CREATE DATABASE ${quotedDatabase} TEMPLATE template0`);

  const concurrent = await Promise.all([migrate({ databaseUrl: testUrl }), migrate({ databaseUrl: testUrl })]);
  assert(concurrent.flatMap((result) => result.applied).length === 2, "concurrent migration runners must apply each file once");
  assert(concurrent.flatMap((result) => result.alreadyApplied).length === 2, "waiting migration runner must verify every applied file");

  const replay = await migrate({ databaseUrl: testUrl });
  assert(replay.applied.length === 0 && replay.alreadyApplied.length === 2, "migration replay must be a verified no-op");

  const productionDirectory = resolve(import.meta.dir, "../db/migrations");
  const productionMigrations = await loadMigrationFiles(productionDirectory);
  assert(productionMigrations.length === 2, "both production migrations must exist");
  upgradeDirectory = await mkdtemp(join(tmpdir(), "career-os-migrations-"));
  for (const migration of productionMigrations) {
    await writeFile(join(upgradeDirectory, migration.name), migration.content, "utf8");
  }
  await writeFile(
    join(upgradeDirectory, "0003_forward_upgrade_probe.sql"),
    "CREATE TABLE migration_forward_probe (id integer PRIMARY KEY);\n",
    "utf8",
  );
  const upgrade = await migrate({ databaseUrl: testUrl, directory: upgradeDirectory });
  assert(upgrade.applied.join() === "0003_forward_upgrade_probe.sql", "forward upgrade must apply only the next migration");

  await writeFile(
    join(upgradeDirectory, "0004_atomic_failure_probe.sql"),
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
      (SELECT count(*)::int FROM schema_migrations WHERE name = '0004_atomic_failure_probe.sql') AS "ledgerRows"
  `;
  assert(!atomicFailure[0]?.tableExists && atomicFailure[0]?.ledgerRows === 0, "failed migration and ledger write must roll back together");

  const originalUpgradeChecksum = (await database<{ checksum: string }[]>`
    SELECT checksum FROM schema_migrations WHERE name = '0003_forward_upgrade_probe.sql'
  `)[0]?.checksum;
  assert(originalUpgradeChecksum !== undefined, "forward migration checksum must be recorded");
  await database`UPDATE schema_migrations SET checksum = ${"0".repeat(64)} WHERE name = '0003_forward_upgrade_probe.sql'`;
  await expectRejected(migrate({ databaseUrl: testUrl, directory: upgradeDirectory }), "checksum drift must reject migration startup");
  await database`UPDATE schema_migrations SET checksum = ${originalUpgradeChecksum} WHERE name = '0003_forward_upgrade_probe.sql'`;

  const expectedTables = [
    "artifacts",
    "audit_events",
    "companies",
    "company_aliases",
    "field_assertions",
    "idempotency_records",
    "lifecycle_events",
    "listing_versions",
    "opportunities",
    "opportunity_compensation",
    "opportunity_languages",
    "opportunity_locations",
    "opportunity_members",
    "opportunity_skills",
    "ownership_evidence",
    "resolution_reviews",
    "schema_migrations",
    "source_candidates",
    "source_listings",
    "source_policies",
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
    "companies_normalized_name_trgm_idx",
    "companies_verified_primary_domain_uq",
    "lifecycle_events_history_idx",
    "opportunities_search_idx",
    "opportunities_title_trgm_idx",
    "opportunity_compensation_filter_idx",
    "opportunity_languages_filter_idx",
    "opportunity_locations_country_idx",
    "opportunity_skills_filter_idx",
    "source_scans_history_idx",
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
  ) as { sourceId: string };
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

  console.log("Database verification passed: migrations, registry idempotency, ownership, policy interlocks, and immutable audit.");
} finally {
  if (database) await database.close();
  if (upgradeDirectory) await rm(upgradeDirectory, { recursive: true, force: true });
  await admin.unsafe(`DROP DATABASE IF EXISTS ${quotedDatabase} WITH (FORCE)`);
  await admin.close();
}
