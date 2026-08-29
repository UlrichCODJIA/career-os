import { SQL } from "bun";
import { requirePostgresUrl } from "./migrations.ts";

export * from "./migration-files.ts";
export * from "./migrations.ts";
export * from "./rows.ts";
export * from "./registry.ts";
export * from "./queue.ts";
export * from "./artifacts.ts";
export * from "./scans.ts";
export * from "./company-resolution.ts";
export * from "./opportunity-resolution.ts";
export * from "./lifecycle.ts";
export * from "./discovery-api.ts";

export interface DatabaseHealth {
  check(): Promise<{ ok: true; latencyMs: number }>;
}

export interface TransactionContext {
  readonly transactionId: string;
}

export function createDatabase(databaseUrl: string): SQL {
  return new SQL(requirePostgresUrl(databaseUrl), {
    max: 10,
    idleTimeout: 30,
    connectionTimeout: 10,
    maxLifetime: 3_600,
  });
}

export async function checkDatabaseHealth(sql: SQL): Promise<{ ok: true; latencyMs: number }> {
  const startedAt = performance.now();
  await sql`SELECT 1 AS health`;
  return { ok: true, latencyMs: performance.now() - startedAt };
}

export async function withTransaction<T>(sql: SQL, operation: (transaction: SQL) => Promise<T>): Promise<T> {
  return sql.begin(operation);
}
