import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { SQL } from "bun";
import { loadMigrationFiles, migrate } from "../packages/db/src/index.ts";

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
  assert(concurrent.flatMap((result) => result.applied).length === 1, "concurrent migration runners must apply each file once");
  assert(concurrent.flatMap((result) => result.alreadyApplied).length === 1, "waiting migration runner must verify the applied file");

  const replay = await migrate({ databaseUrl: testUrl });
  assert(replay.applied.length === 0 && replay.alreadyApplied.length === 1, "migration replay must be a verified no-op");

  const productionDirectory = resolve(import.meta.dir, "../db/migrations");
  const [initial] = await loadMigrationFiles(productionDirectory);
  assert(initial !== undefined, "initial migration must exist");
  upgradeDirectory = await mkdtemp(join(tmpdir(), "career-os-migrations-"));
  await writeFile(join(upgradeDirectory, initial.name), initial.content, "utf8");
  await writeFile(
    join(upgradeDirectory, "0002_forward_upgrade_probe.sql"),
    "CREATE TABLE migration_forward_probe (id integer PRIMARY KEY);\n",
    "utf8",
  );
  const upgrade = await migrate({ databaseUrl: testUrl, directory: upgradeDirectory });
  assert(upgrade.applied.join() === "0002_forward_upgrade_probe.sql", "forward upgrade must apply only the next migration");

  await writeFile(
    join(upgradeDirectory, "0003_atomic_failure_probe.sql"),
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
      (SELECT count(*)::int FROM schema_migrations WHERE name = '0003_atomic_failure_probe.sql') AS "ledgerRows"
  `;
  assert(!atomicFailure[0]?.tableExists && atomicFailure[0]?.ledgerRows === 0, "failed migration and ledger write must roll back together");

  const originalUpgradeChecksum = (await database<{ checksum: string }[]>`
    SELECT checksum FROM schema_migrations WHERE name = '0002_forward_upgrade_probe.sql'
  `)[0]?.checksum;
  assert(originalUpgradeChecksum !== undefined, "forward migration checksum must be recorded");
  await database`UPDATE schema_migrations SET checksum = ${"0".repeat(64)} WHERE name = '0002_forward_upgrade_probe.sql'`;
  await expectRejected(migrate({ databaseUrl: testUrl, directory: upgradeDirectory }), "checksum drift must reject migration startup");
  await database`UPDATE schema_migrations SET checksum = ${originalUpgradeChecksum} WHERE name = '0002_forward_upgrade_probe.sql'`;

  const expectedTables = [
    "artifacts",
    "audit_events",
    "companies",
    "company_aliases",
    "field_assertions",
    "lifecycle_events",
    "listing_versions",
    "opportunities",
    "opportunity_compensation",
    "opportunity_languages",
    "opportunity_locations",
    "opportunity_members",
    "opportunity_skills",
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

  console.log("Database verification passed: clean create, concurrent apply, replay, forward upgrade, schema, transactions, and immutability.");
} finally {
  if (database) await database.close();
  if (upgradeDirectory) await rm(upgradeDirectory, { recursive: true, force: true });
  await admin.unsafe(`DROP DATABASE IF EXISTS ${quotedDatabase} WITH (FORCE)`);
  await admin.close();
}
