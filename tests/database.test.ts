import { describe, expect, test } from "bun:test";
import { loadMigrationFiles, mapMutableRow, requirePostgresUrl, validateMigrationCandidates } from "../packages/db/src/index.ts";
import { join } from "node:path";

describe("database migration policy", () => {
  test("loads the reviewed migration with a reproducible SHA-256 checksum", async () => {
    const migrations = await loadMigrationFiles(join(import.meta.dir, "..", "db", "migrations"));
    expect(migrations.map((migration) => migration.name)).toEqual([
      "0001_discovery_core.sql",
      "0002_registry_governance.sql",
      "0003_durable_work_queue.sql",
      "0004_artifact_retention.sql",
      "0005_scan_ledger.sql",
    ]);
    expect(migrations[0]?.checksum).toMatch(/^[0-9a-f]{64}$/);
  });

  test("rejects embedded transaction control so the runner owns atomicity", () => {
    const failures = validateMigrationCandidates([
      {
        name: "0001_unsafe_transaction.sql",
        content: "CREATE TABLE example (id integer); COMMIT;",
        isFile: true,
        isSymbolicLink: false,
      },
    ]);
    expect(failures.some((failure) => failure.includes("prohibited SQL"))).toBe(true);
  });

  test("requires an explicit PostgreSQL URL", () => {
    expect(() => requirePostgresUrl(undefined)).toThrow("DATABASE_URL is required");
    expect(() => requirePostgresUrl("file:///tmp/career-os.db")).toThrow("postgresql protocol");
    expect(requirePostgresUrl("postgresql://career_os@example.test/career_os")).toBe(
      "postgresql://career_os@example.test/career_os",
    );
  });

  test("maps database naming and rejects malformed durable row metadata", () => {
    const id = crypto.randomUUID();
    const mapped = mapMutableRow({
      id,
      created_at: "2026-08-27T00:00:00.000Z",
      updated_at: new Date("2026-08-27T01:00:00.000Z"),
      row_version: 2,
    });
    expect(mapped).toEqual({
      id,
      createdAt: new Date("2026-08-27T00:00:00.000Z"),
      updatedAt: new Date("2026-08-27T01:00:00.000Z"),
      rowVersion: 2,
    });
    expect(() => mapMutableRow({ id: "not-a-uuid", created_at: "bad", updated_at: "bad", row_version: 0 })).toThrow(
      "id must be a UUID",
    );
  });
});
