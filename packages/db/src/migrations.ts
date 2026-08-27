import { resolve } from "node:path";
import { SQL } from "bun";
import { loadMigrationFiles } from "./migration-files.ts";

const MIGRATION_LOCK_NAMESPACE = 1_124_275_679;
const MIGRATION_LOCK_KEY = 1;

export interface AppliedMigration {
  name: string;
  checksum: string;
  appliedAt: Date;
}

export interface MigrationResult {
  applied: string[];
  alreadyApplied: string[];
}

export interface MigrationOptions {
  databaseUrl?: string;
  directory?: string;
  sql?: SQL;
}

export function requirePostgresUrl(databaseUrl: string | undefined): string {
  if (!databaseUrl) throw new Error("DATABASE_URL is required for database migrations");
  const parsed = new URL(databaseUrl);
  if (parsed.protocol !== "postgresql:" && parsed.protocol !== "postgres:") {
    throw new Error("DATABASE_URL must use the postgresql protocol");
  }
  return databaseUrl;
}

export async function migrate(options: MigrationOptions = {}): Promise<MigrationResult> {
  const directory = options.directory ?? resolve(import.meta.dir, "../../../db/migrations");
  const migrations = await loadMigrationFiles(directory);
  const ownsSql = options.sql === undefined;
  const sql = options.sql ?? new SQL(requirePostgresUrl(options.databaseUrl ?? process.env.DATABASE_URL));

  try {
    return await sql.begin(async (tx) => {
      await tx`SELECT pg_advisory_xact_lock(${MIGRATION_LOCK_NAMESPACE}, ${MIGRATION_LOCK_KEY})`;
      await tx.unsafe(`
        CREATE TABLE IF NOT EXISTS schema_migrations (
          name text PRIMARY KEY,
          checksum text NOT NULL CHECK (checksum ~ '^[0-9a-f]{64}$'),
          applied_at timestamptz NOT NULL DEFAULT clock_timestamp()
        )
      `);

      const recorded = await tx<AppliedMigration[]>`
        SELECT name, checksum, applied_at AS "appliedAt"
        FROM schema_migrations
        ORDER BY name
      `;
      const byName = new Map(recorded.map((migration) => [migration.name, migration]));
      const knownNames = new Set(migrations.map((migration) => migration.name));
      const unknown = recorded.filter((migration) => !knownNames.has(migration.name));
      if (unknown.length > 0) {
        throw new Error(`Database contains migrations absent from this build: ${unknown.map((item) => item.name).join(", ")}`);
      }

      const result: MigrationResult = { applied: [], alreadyApplied: [] };
      for (const migration of migrations) {
        const previous = byName.get(migration.name);
        if (previous) {
          if (previous.checksum !== migration.checksum) {
            throw new Error(`Checksum mismatch for applied migration ${migration.name}`);
          }
          result.alreadyApplied.push(migration.name);
          continue;
        }

        await tx.unsafe(migration.content);
        await tx`
          INSERT INTO schema_migrations (name, checksum)
          VALUES (${migration.name}, ${migration.checksum})
        `;
        result.applied.push(migration.name);
      }
      return result;
    });
  } finally {
    if (ownsSql) await sql.close();
  }
}
