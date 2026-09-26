import { mkdir, mkdtemp, rename, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, join, resolve } from "node:path";
import { RestoreDrillReceiptSchema } from "../packages/release-gates/src/index.ts";

type CommandResult = { stdout: Uint8Array; stderr: string };

const processEnv = { ...process.env, POSTHOG_API_KEY: "" };

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

function controlledName(prefix: string): string {
  const suffix = `${Date.now()}_${crypto.randomUUID().slice(0, 8).replaceAll("-", "")}`;
  const value = `${prefix}_${suffix}`.toLowerCase();
  assert(/^[a-z][a-z0-9_]+$/.test(value), "generated identifier was not safe");
  return value;
}

function quotedIdentifier(value: string): string {
  assert(/^[a-z][a-z0-9_]+$/.test(value), "refusing unsafe SQL identifier");
  return `"${value}"`;
}

async function command(args: string[], options: { stdin?: Uint8Array } = {}): Promise<CommandResult> {
  const child = Bun.spawn(args, {
    stdin: options.stdin,
    stdout: "pipe",
    stderr: "pipe",
    env: processEnv,
  });
  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(child.stdout).bytes(),
    new Response(child.stderr).text(),
    child.exited,
  ]);
  if (exitCode !== 0) {
    throw new Error(`${args[0]} ${args[1] ?? ""} failed (${exitCode}): ${stderr.trim().slice(0, 2_000)}`);
  }
  return { stdout, stderr };
}

function text(result: CommandResult): string {
  return new TextDecoder().decode(result.stdout).trim();
}

async function compose(...args: string[]): Promise<CommandResult> {
  return command(["docker", "compose", ...args]);
}

async function psql(database: string, sql: string): Promise<string> {
  return text(await compose("exec", "-T", "postgres", "psql", "-X", "-v", "ON_ERROR_STOP=1", "-U", "career_os",
    "-d", database, "-At", "-F", "\t", "-c", sql));
}

async function databaseManifest(database: string): Promise<{ tables: Record<string, number>; migrations: string[] }> {
  const names = (await psql(database,
    "SELECT tablename FROM pg_tables WHERE schemaname = 'public' ORDER BY tablename",
  )).split("\n").filter(Boolean);
  const tables: Record<string, number> = {};
  for (const name of names) {
    assert(/^[a-z][a-z0-9_]+$/.test(name), "database exposed an unsafe table name");
    const count = Number(await psql(database, `SELECT count(*) FROM ${quotedIdentifier(name)}`));
    assert(Number.isSafeInteger(count) && count >= 0, `invalid row count for ${name}`);
    tables[name] = count;
  }
  const migrations = (await psql(database,
    "SELECT name || ':' || checksum FROM schema_migrations ORDER BY name",
  )).split("\n").filter(Boolean);
  return { tables, migrations };
}

const artifactManifestProgram = String.raw`
const root = "/data";
const entries = [];
for await (const relative of new Bun.Glob("**/*").scan({ cwd: root, onlyFiles: true, dot: true })) {
  const bytes = new Uint8Array(await Bun.file(root + "/" + relative).arrayBuffer());
  entries.push({ relative: relative.replaceAll("\\\\", "/"), bytes: bytes.byteLength,
    digest: new Bun.CryptoHasher("sha256").update(bytes).digest("hex") });
}
entries.sort((left, right) => left.relative.localeCompare(right.relative));
const canonical = entries.map((entry) => entry.relative + "\\t" + entry.bytes + "\\t" + entry.digest).join("\\n");
console.log(JSON.stringify({ fileCount: entries.length, bytes: entries.reduce((sum, entry) => sum + entry.bytes, 0),
  treeDigest: new Bun.CryptoHasher("sha256").update(canonical).digest("hex") }));
`;

async function artifactManifest(image: string, volume: string): Promise<{ fileCount: number; bytes: number; treeDigest: string }> {
  const output = text(await command([
    "docker", "run", "--rm", "--network", "none", "--read-only", "--user", "0",
    "-v", `${volume}:/data:ro`, image, "bun", "-e", artifactManifestProgram,
  ]));
  const parsed = JSON.parse(output) as { fileCount: number; bytes: number; treeDigest: string };
  assert(Number.isSafeInteger(parsed.fileCount) && parsed.fileCount >= 0, "invalid artifact file count");
  assert(Number.isSafeInteger(parsed.bytes) && parsed.bytes >= 0, "invalid artifact byte count");
  assert(/^[a-f0-9]{64}$/.test(parsed.treeDigest), "invalid artifact tree digest");
  return parsed;
}

const outputDirectory = resolve(process.env.RELEASE_EVIDENCE_DIR?.trim() || "private/release");
const releaseCommit = text(await command(["git", "rev-parse", "HEAD"]));
assert(/^[a-f0-9]{40}$/.test(releaseCommit), "release commit must be a full Git SHA");
const restoreDatabase = controlledName("career_os_restore");
const restoreVolume = controlledName("career_os_restore_artifacts");
const databaseBackupPath = `/tmp/${restoreDatabase}.dump`;
const temporaryDirectory = await mkdtemp(join(tmpdir(), "career-os-restore-"));
const backupPath = join(temporaryDirectory, "artifacts.tar");
let workerWasRunning = false;
let databaseCreated = false;
let databaseBackupCreated = false;
let volumeCreated = false;
let cleanupPassed = false;
let receiptInput: Omit<Parameters<typeof RestoreDrillReceiptSchema.parse>[0], "cleanupPassed"> | undefined;
const startedAt = performance.now();

try {
  workerWasRunning = text(await compose("ps", "-q", "worker")).length > 0;
  assert(workerWasRunning, "the worker must be running before the drill so its pause can be verified");
  await compose("stop", "worker");
  assert(text(await compose("ps", "-q", "worker")) === "", "worker did not stop at the snapshot boundary");

  const activeJobs = Number(await psql("career_os",
    "SELECT count(*) FROM work_jobs WHERE status IN ('queued','leased','retryable_failed')"));
  assert(activeJobs === 0, "refusing a restore snapshot while jobs are active");
  const sourceSnapshotAt = new Date().toISOString();
  const sourceDatabase = await databaseManifest("career_os");
  await compose("exec", "-T", "postgres", "pg_dump", "-U", "career_os", "-d", "career_os",
    "-Fc", "--no-owner", "--no-acl", "-f", databaseBackupPath);
  databaseBackupCreated = true;

  await psql("career_os", `CREATE DATABASE ${quotedIdentifier(restoreDatabase)} TEMPLATE template0`);
  databaseCreated = true;
  await compose("exec", "-T", "postgres", "pg_restore", "-U", "career_os", "-d", restoreDatabase,
    "--no-owner", "--no-acl", "--exit-on-error", databaseBackupPath);
  const restoredDatabase = await databaseManifest(restoreDatabase);
  const countsMatched = JSON.stringify(restoredDatabase.tables) === JSON.stringify(sourceDatabase.tables);
  const migrationsMatched = JSON.stringify(restoredDatabase.migrations) === JSON.stringify(sourceDatabase.migrations);

  const image = text(await compose("images", "-q", "worker"));
  assert(image.length > 0 && !image.includes("\n"), "could not resolve one worker image");
  const sourceVolume = text(await command(["docker", "volume", "ls", "-q",
    "--filter", "label=com.docker.compose.project=career-os", "--filter", "label=com.docker.compose.volume=artifacts"]));
  assert(sourceVolume.length > 0 && !sourceVolume.includes("\n"), "could not resolve one artifact volume");
  const sourceArtifacts = await artifactManifest(image, sourceVolume);
  await command(["docker", "run", "--rm", "--network", "none", "--user", "0", "-v", `${sourceVolume}:/source:ro`,
    "-v", `${temporaryDirectory}:/backup`, image, "tar", "-C", "/source", "-cf", `/backup/${basename(backupPath)}`, "."]);
  await command(["docker", "volume", "create", restoreVolume]);
  volumeCreated = true;
  await command(["docker", "run", "--rm", "--network", "none", "--user", "0", "-v", `${restoreVolume}:/restore`,
    "-v", `${temporaryDirectory}:/backup:ro`, image, "tar", "-C", "/restore", "-xf", `/backup/${basename(backupPath)}`]);
  const restoredArtifacts = await artifactManifest(image, restoreVolume);
  const digestsMatched = sourceArtifacts.treeDigest === restoredArtifacts.treeDigest;

  receiptInput = {
    schemaVersion: 1,
    completedAt: new Date().toISOString(),
    releaseCommit,
    sourceSnapshotAt,
    isolation: { outboundNetworkDisabled: true, workerPausedDuringSnapshot: true },
    database: {
      passed: countsMatched && migrationsMatched,
      tableCount: Object.keys(sourceDatabase.tables).length,
      sourceRowCount: Object.values(sourceDatabase.tables).reduce((sum, count) => sum + count, 0),
      restoredRowCount: Object.values(restoredDatabase.tables).reduce((sum, count) => sum + count, 0),
      migrationCount: sourceDatabase.migrations.length,
      countsMatched,
      migrationsMatched,
    },
    artifacts: {
      passed: digestsMatched && sourceArtifacts.fileCount === restoredArtifacts.fileCount
        && sourceArtifacts.bytes === restoredArtifacts.bytes,
      sourceFileCount: sourceArtifacts.fileCount,
      restoredFileCount: restoredArtifacts.fileCount,
      sourceBytes: sourceArtifacts.bytes,
      restoredBytes: restoredArtifacts.bytes,
      sourceTreeDigest: sourceArtifacts.treeDigest,
      restoredTreeDigest: restoredArtifacts.treeDigest,
      digestsMatched,
    },
    recoveryTimeSeconds: (performance.now() - startedAt) / 1_000,
  };
} finally {
  let cleanupError: unknown;
  try {
    if (databaseCreated) await psql("career_os", `DROP DATABASE IF EXISTS ${quotedIdentifier(restoreDatabase)} WITH (FORCE)`);
    if (databaseBackupCreated) await compose("exec", "-T", "postgres", "rm", "-f", databaseBackupPath);
    if (volumeCreated) await command(["docker", "volume", "rm", restoreVolume]);
    await rm(temporaryDirectory, { recursive: true, force: true });
    cleanupPassed = true;
  } catch (error) {
    cleanupError = error;
  }
  if (workerWasRunning) await compose("start", "worker");
  if (!cleanupPassed) throw cleanupError;
}

assert(receiptInput, "restore drill did not produce evidence");
const receipt = RestoreDrillReceiptSchema.parse({ ...receiptInput, cleanupPassed: true });
assert(receipt.database.passed && receipt.artifacts.passed, "restored database or artifact evidence did not match the source");
await mkdir(outputDirectory, { recursive: true, mode: 0o700 });
const target = join(outputDirectory, "restore-drill-receipt.json");
const temporary = `${target}.${crypto.randomUUID()}.tmp`;
await writeFile(temporary, `${JSON.stringify(receipt, null, 2)}\n`, { encoding: "utf8", flag: "wx", mode: 0o600 });
await rename(temporary, target);
console.log(JSON.stringify({ passed: true, databaseTables: receipt.database.tableCount,
  databaseRows: receipt.database.sourceRowCount, artifactFiles: receipt.artifacts.sourceFileCount,
  artifactBytes: receipt.artifacts.sourceBytes, recoveryTimeSeconds: receipt.recoveryTimeSeconds.toFixed(1) }));
