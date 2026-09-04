import { readFile, readdir, rename, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { evaluateReleaseEvidence, ReleaseEvidenceBundleSchema } from "../packages/release-gates/src/index.ts";

function required(name: string): string {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`${name} is required`);
  return value;
}

async function json(path: string): Promise<unknown> {
  return JSON.parse(await readFile(path, "utf8"));
}

const root = resolve(process.env.RELEASE_EVIDENCE_DIR?.trim() || "private/release");
const soakDirectory = join(root, "soak");
const snapshots = await Promise.all(
  (await readdir(soakDirectory)).filter((name) => name.endsWith(".json")).sort().map((name) => json(join(soakDirectory, name))),
);
const bundle = ReleaseEvidenceBundleSchema.parse({
  schemaVersion: 1,
  releaseCommit: required("RELEASE_COMMIT"),
  registryDigest: required("REGISTRY_DIGEST"),
  snapshots,
  qualityAudit: await json(join(root, "quality-audit.json")),
  drills: await json(join(root, "drill-receipt.json")),
  security: await json(join(root, "security-receipt.json")),
});
const result = evaluateReleaseEvidence(bundle);
const report = { schemaVersion: 1, evaluatedAt: new Date().toISOString(), ...result };
const target = join(root, "gate-report.json");
const temporary = `${target}.${crypto.randomUUID()}.tmp`;
await writeFile(temporary, `${JSON.stringify(report, null, 2)}\n`, { encoding: "utf8", flag: "wx", mode: 0o600 });
await rename(temporary, target);
console.log(JSON.stringify({ ready: result.ready, passed: result.gates.filter((gate) => gate.passed).length,
  failed: result.gates.filter((gate) => !gate.passed).map((gate) => gate.id) }));
if (!result.ready) process.exitCode = 1;
