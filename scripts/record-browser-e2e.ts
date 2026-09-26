import { mkdir, rename, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { BrowserE2EReceiptSchema } from "../packages/release-gates/src/index.ts";

function option(name: string): string {
  const index = Bun.argv.indexOf(`--${name}`);
  const value = index >= 0 ? Bun.argv[index + 1]?.trim() : undefined;
  if (!value) throw new Error(`--${name} is required`);
  return value;
}

function count(name: string): number {
  const value = Number(option(name));
  if (!Number.isSafeInteger(value) || value < 0) throw new Error(`--${name} must be a non-negative integer`);
  return value;
}

for (const flag of ["discovery-request-passed", "operator-control-plane-passed", "redacted-evidence-passed"] as const) {
  if (!Bun.argv.includes(`--${flag}`)) throw new Error(`--${flag} is required after visible verification`);
}
const releaseCommit = (await Bun.$`git rev-parse HEAD`.text()).trim();
const receipt = BrowserE2EReceiptSchema.parse({
  schemaVersion: 1,
  completedAt: new Date().toISOString(),
  releaseCommit,
  browser: option("browser"),
  discovery: {
    requestPassed: true,
    renderedState: option("discovery-state"),
    consoleErrorCount: count("discovery-console-errors"),
  },
  operator: {
    controlPlanePassed: true,
    totalSources: count("operator-total-sources"),
    healthySources: count("operator-healthy-sources"),
    attentionSources: count("operator-attention-sources"),
    displayedSourceCards: count("operator-source-cards"),
    redactedEvidencePassed: true,
    consoleErrorCount: count("operator-console-errors"),
  },
});
const outputDirectory = resolve(process.env.RELEASE_EVIDENCE_DIR?.trim() || "private/release");
await mkdir(outputDirectory, { recursive: true, mode: 0o700 });
const target = join(outputDirectory, "browser-e2e-receipt.json");
const temporary = `${target}.${crypto.randomUUID()}.tmp`;
await writeFile(temporary, `${JSON.stringify(receipt, null, 2)}\n`, { encoding: "utf8", flag: "wx", mode: 0o600 });
await rename(temporary, target);
console.log(JSON.stringify({ passed: true, browser: receipt.browser, discoveryState: receipt.discovery.renderedState,
  operatorSources: receipt.operator.totalSources, consoleErrors: 0 }));
