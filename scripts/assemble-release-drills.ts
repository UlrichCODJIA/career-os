import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import {
  BrowserE2EReceiptSchema,
  DrillReceiptSchema,
  FaultInjectionReceiptSchema,
  RestoreDrillReceiptSchema,
} from "../packages/release-gates/src/index.ts";

const root = resolve(process.env.RELEASE_EVIDENCE_DIR?.trim() || "private/release");
const releaseCommit = process.env.RELEASE_COMMIT?.trim();
if (!releaseCommit) throw new Error("RELEASE_COMMIT is required");
const json = async (name: string): Promise<unknown> => JSON.parse(await readFile(join(root, name), "utf8"));

const restore = RestoreDrillReceiptSchema.parse(await json("restore-drill-receipt.json"));
const faults = FaultInjectionReceiptSchema.parse(await json("fault-injection-receipt.json"));
const browser = BrowserE2EReceiptSchema.parse(await json("browser-e2e-receipt.json"));
if ([restore.releaseCommit, faults.releaseCommit, browser.releaseCommit].some((value) => value !== releaseCommit)) {
  throw new Error("drill receipts do not describe RELEASE_COMMIT");
}

const receipt = DrillReceiptSchema.parse({
  schemaVersion: 1,
  completedAt: new Date().toISOString(),
  releaseCommit,
  databaseRestorePassed: restore.database.passed,
  artifactRestorePassed: restore.artifacts.passed,
  restoredCountsMatched: restore.database.countsMatched && restore.database.migrationsMatched,
  restoredDigestsMatched: restore.artifacts.digestsMatched,
  connectorOutageCreatedClosures: faults.connectorOutage.closureEventsCreated,
  workerCrashHistoryPreserved: faults.workerCrash.partialCommitsCreated === 0
    && faults.workerCrash.artifactsDeduplicated && faults.workerCrash.retryCommittedOnce,
  connectorRollbackHistoryPreserved: faults.connectorRollback.finalizedHistoryPreserved,
  browserE2ePassed: browser.discovery.requestPassed && browser.operator.controlPlanePassed
    && browser.operator.redactedEvidencePassed,
});
if (!receipt.databaseRestorePassed || !receipt.artifactRestorePassed || !receipt.restoredCountsMatched
  || !receipt.restoredDigestsMatched || receipt.connectorOutageCreatedClosures !== 0
  || !receipt.workerCrashHistoryPreserved || !receipt.connectorRollbackHistoryPreserved || !receipt.browserE2ePassed) {
  throw new Error("one or more release drill inputs failed");
}

await mkdir(root, { recursive: true });
const target = join(root, "drill-receipt.json");
const temporary = `${target}.${crypto.randomUUID()}.tmp`;
await writeFile(temporary, `${JSON.stringify(receipt, null, 2)}\n`, { encoding: "utf8", flag: "wx", mode: 0o600 });
await rename(temporary, target);
console.log(JSON.stringify({ passed: true, releaseCommit, browser: browser.browser,
  databaseRows: restore.database.sourceRowCount, artifactFiles: restore.artifacts.sourceFileCount }));
