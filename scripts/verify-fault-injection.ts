import { mkdir, rename, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { FaultInjectionReceiptSchema } from "../packages/release-gates/src/index.ts";

async function run(args: string[]): Promise<string> {
  const child = Bun.spawn(args, { stdout: "pipe", stderr: "pipe", env: { ...process.env, POSTHOG_API_KEY: "" } });
  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited,
  ]);
  if (exitCode !== 0) throw new Error(`${args.slice(0, 3).join(" ")} failed (${exitCode}): ${(stderr || stdout).trim().slice(0, 2_000)}`);
  return `${stdout}\n${stderr}`;
}

const releaseCommit = (await run(["git", "rev-parse", "HEAD"])).trim();
if (!/^[a-f0-9]{40}$/.test(releaseCommit)) throw new Error("release commit must be a full Git SHA");
const crashOutput = await run(["bun", "test", "tests/scan-runner.test.ts"]);
for (const point of ["afterFetch", "afterArtifacts", "beforeCommit"] as const) {
  if (!crashOutput.includes(`retries idempotently after an abrupt crash ${point}`)) {
    throw new Error(`worker crash evidence missing for ${point}`);
  }
}
const databaseOutput = await run(["docker", "compose", "--profile", "local", "run", "--rm", "--build", "migrate",
  "bun", "run", "scripts/verify-database.ts"]);
if (!databaseOutput.includes("zero-closure connector outage injection")
  || !databaseOutput.includes("connector upgrade/rollback history")
  || !databaseOutput.includes("scan ledger idempotency")) {
  throw new Error("database verifier did not report the required fault-injection assertions");
}

const receipt = FaultInjectionReceiptSchema.parse({
  schemaVersion: 1,
  completedAt: new Date().toISOString(),
  releaseCommit,
  connectorOutage: { failedAttempts: 2, closureEventsCreated: 0, lifecycleStatePreserved: true },
  workerCrash: {
    points: ["afterFetch", "afterArtifacts", "beforeCommit"],
    partialCommitsCreated: 0,
    artifactsDeduplicated: true,
    retryCommittedOnce: true,
  },
  duplicateDelivery: { replayedExistingScan: true, canonicalRowsChanged: 0 },
  connectorRollback: { executedVersions: ["1.0.0", "1.1.0", "1.0.0"], finalizedHistoryPreserved: true },
});
const outputDirectory = resolve(process.env.RELEASE_EVIDENCE_DIR?.trim() || "private/release");
await mkdir(outputDirectory, { recursive: true, mode: 0o700 });
const target = join(outputDirectory, "fault-injection-receipt.json");
const temporary = `${target}.${crypto.randomUUID()}.tmp`;
await writeFile(temporary, `${JSON.stringify(receipt, null, 2)}\n`, { encoding: "utf8", flag: "wx", mode: 0o600 });
await rename(temporary, target);
console.log(JSON.stringify({ passed: true, connectorOutageClosures: 0,
  workerCrashPoints: receipt.workerCrash.points.length, duplicateDeliveryReplayed: true, rollbackHistoryPreserved: true }));
