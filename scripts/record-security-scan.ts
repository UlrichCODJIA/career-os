import { createHash } from "node:crypto";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { basename, join, resolve } from "node:path";
import { SecurityReceiptSchema } from "../packages/release-gates/src/index.ts";

const releaseCommit = process.env.RELEASE_COMMIT?.trim();
const scanDirectoryValue = process.env.CODEX_SECURITY_SCAN_DIR?.trim();
if (!releaseCommit) throw new Error("RELEASE_COMMIT is required");
if (!scanDirectoryValue) throw new Error("CODEX_SECURITY_SCAN_DIR is required");
const scanDirectory = resolve(scanDirectoryValue);
const manifestBytes = await readFile(join(scanDirectory, "scan-manifest.json"));
const manifest = JSON.parse(new TextDecoder().decode(manifestBytes)) as {
  documentType?: string;
  scan?: { id?: string; status?: string; completedAt?: string; findingsRef?: string; coverageRef?: string;
    target?: { revision?: string }; artifacts?: Array<{ path?: string; sha256?: string }> };
};
if (manifest.documentType !== "codex-security.scan-manifest" || manifest.scan?.status !== "completed") {
  throw new Error("Codex Security scan is not a completed canonical scan");
}
if (manifest.scan.target?.revision !== releaseCommit) throw new Error("Codex Security scan revision does not match RELEASE_COMMIT");
if (manifest.scan.findingsRef !== "findings.json" || manifest.scan.coverageRef !== "coverage.json") {
  throw new Error("Codex Security scan uses unexpected artifact references");
}

async function verifiedArtifact(name: "findings.json" | "coverage.json"): Promise<unknown> {
  if (basename(name) !== name) throw new Error("invalid scan artifact path");
  const expected = manifest.scan?.artifacts?.find((artifact) => artifact.path === name)?.sha256;
  if (!expected || !/^[a-f0-9]{64}$/u.test(expected)) throw new Error(`missing digest for ${name}`);
  const bytes = await readFile(join(scanDirectory, name));
  const actual = createHash("sha256").update(bytes).digest("hex");
  if (actual !== expected) throw new Error(`digest mismatch for ${name}`);
  return JSON.parse(new TextDecoder().decode(bytes));
}

const findingsDocument = await verifiedArtifact("findings.json") as { documentType?: string; findings?: Array<{ severity?: { level?: string } }> };
const coverageDocument = await verifiedArtifact("coverage.json") as { documentType?: string; completeness?: string };
if (findingsDocument.documentType !== "codex-security.findings" || !Array.isArray(findingsDocument.findings)) {
  throw new Error("invalid Codex Security findings artifact");
}
if (coverageDocument.documentType !== "codex-security.coverage" || coverageDocument.completeness !== "complete") {
  throw new Error("Codex Security coverage is not complete");
}
await readFile(join(scanDirectory, "report.md"));
const unresolvedCritical = findingsDocument.findings.filter((finding) => finding.severity?.level === "critical").length;
const unresolvedHigh = findingsDocument.findings.filter((finding) => finding.severity?.level === "high").length;
const receipt = SecurityReceiptSchema.parse({
  schemaVersion: 1,
  completedAt: manifest.scan.completedAt,
  releaseCommit,
  scanner: "codex-security-standard",
  unresolvedCritical,
  unresolvedHigh,
  reportReference: `codex-security:${manifest.scan.id}`,
});
if (unresolvedCritical !== 0 || unresolvedHigh !== 0) throw new Error("security release gate failed");

const outputDirectory = resolve(process.env.RELEASE_EVIDENCE_DIR?.trim() || "private/release");
await mkdir(outputDirectory, { recursive: true });
const target = join(outputDirectory, "security-receipt.json");
const temporary = `${target}.${crypto.randomUUID()}.tmp`;
await writeFile(temporary, `${JSON.stringify(receipt, null, 2)}\n`, { encoding: "utf8", flag: "wx", mode: 0o600 });
await rename(temporary, target);
console.log(JSON.stringify({ passed: true, scanId: manifest.scan.id, unresolvedCritical, unresolvedHigh }));
