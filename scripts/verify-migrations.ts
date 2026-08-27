import { resolve } from "node:path";
import {
  migrationName,
  readMigrationCandidates,
  validateMigrationCandidates,
} from "../packages/db/src/migration-files.ts";

export { validateMigrationCandidates } from "../packages/db/src/migration-files.ts";
export type { MigrationCandidate } from "../packages/db/src/migration-files.ts";

export async function verifyMigrations(directory = resolve(import.meta.dir, "..", "db", "migrations")): Promise<void> {
  const candidates = await readMigrationCandidates(directory);
  const failures = validateMigrationCandidates(candidates);
  if (failures.length > 0) throw new Error(`Migration validation failed:\n- ${failures.join("\n- ")}`);

  const count = candidates.filter((candidate) => migrationName.test(candidate.name)).length;
  console.log(count === 0 ? "Migration baseline valid: no production migrations yet." : `Validated ${count} forward migrations.`);
}

if (import.meta.main) await verifyMigrations(process.argv[2]);
