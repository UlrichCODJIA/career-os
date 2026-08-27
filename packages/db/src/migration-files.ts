import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";

export interface MigrationCandidate {
  name: string;
  content: string;
  isFile: boolean;
  isSymbolicLink: boolean;
}

export interface MigrationFile {
  name: string;
  content: string;
  checksum: string;
}

export const migrationName = /^(\d{4})_[a-z0-9]+(?:_[a-z0-9]+)*\.sql$/;

const prohibitedSql = [
  /\bALTER\s+SYSTEM\b/i,
  /\bCREATE\s+DATABASE\b/i,
  /\bDROP\s+DATABASE\b/i,
  /\bCOPY\b[\s\S]*\bPROGRAM\b/i,
  /^\s*\\!/m,
  /\b(?:BEGIN|COMMIT|ROLLBACK)\s*;/i,
] as const;

export function validateMigrationCandidates(candidates: MigrationCandidate[]): string[] {
  const failures: string[] = [];
  const migrations = candidates.filter((candidate) => candidate.name !== "README.md");

  for (const candidate of migrations) {
    if (!candidate.isFile || candidate.isSymbolicLink) {
      failures.push(`${candidate.name} must be a regular, non-symlink file`);
      continue;
    }
    if (!migrationName.test(candidate.name)) {
      failures.push(`${candidate.name} must match NNNN_descriptive_name.sql`);
    }
    if (candidate.content.trim().length === 0) failures.push(`${candidate.name} must not be empty`);
    for (const pattern of prohibitedSql) {
      if (pattern.test(candidate.content)) failures.push(`${candidate.name} contains prohibited SQL: ${pattern.source}`);
    }
  }

  const ordered = migrations
    .map((candidate) => ({ candidate, match: migrationName.exec(candidate.name) }))
    .filter((entry): entry is { candidate: MigrationCandidate; match: RegExpExecArray } => entry.match !== null)
    .sort((left, right) => left.candidate.name.localeCompare(right.candidate.name));

  for (let index = 0; index < ordered.length; index += 1) {
    const expected = index + 1;
    const actual = Number(ordered[index]!.match[1]);
    if (actual !== expected) {
      failures.push(`${ordered[index]!.candidate.name} has sequence ${actual}; expected ${expected.toString().padStart(4, "0")}`);
    }
  }

  return failures;
}

export async function readMigrationCandidates(directory: string): Promise<MigrationCandidate[]> {
  const entries = await readdir(directory, { withFileTypes: true });
  return Promise.all(
    entries.map(async (entry): Promise<MigrationCandidate> => ({
      name: entry.name,
      content: entry.isFile() ? await readFile(join(directory, entry.name), "utf8") : "",
      isFile: entry.isFile(),
      isSymbolicLink: entry.isSymbolicLink(),
    })),
  );
}

export async function loadMigrationFiles(directory: string): Promise<MigrationFile[]> {
  const candidates = await readMigrationCandidates(directory);
  const failures = validateMigrationCandidates(candidates);
  if (failures.length > 0) throw new Error(`Migration validation failed:\n- ${failures.join("\n- ")}`);

  return candidates
    .filter((candidate) => migrationName.test(candidate.name))
    .sort((left, right) => left.name.localeCompare(right.name))
    .map((candidate) => ({
      name: candidate.name,
      content: candidate.content,
      checksum: new Bun.CryptoHasher("sha256").update(candidate.content).digest("hex"),
    }));
}
