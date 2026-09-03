import { SQL } from "bun";
import { migrate } from "../packages/db/src/index.ts";
import { validatePilotRegistryManifest, type PilotRegistryManifest, type VerifiedPilotEntry } from "../packages/pilot-registry/src/index.ts";
import { applyPilotRegistry } from "./pilot-registry.ts";

const VERIFIED_COUNT = 1_000;
const QUARANTINE_COUNT = 2;

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

function databaseUrlFor(baseUrl: string, databaseName: string): string {
  const url = new URL(baseUrl);
  url.pathname = `/${databaseName}`;
  return url.toString();
}

function quoteIdentifier(value: string): string {
  if (!/^[a-z][a-z0-9_]+$/.test(value)) throw new Error("unsafe database identifier");
  return `"${value}"`;
}

function source(index: number): VerifiedPilotEntry["source"] {
  const connectorId = ["greenhouse", "lever", "ashby"][index % 3] as "greenhouse" | "lever" | "ashby";
  const tenantKey = `pilot-${index.toString().padStart(4, "0")}`;
  const region = connectorId === "lever" && index % 2 === 1 ? "eu" : "global";
  if (connectorId === "greenhouse") return {
    connectorId, tenantKey, region: "global", connectorVersion: "1.0.0", cadenceSeconds: 43_200,
    boardUrl: `https://job-boards.greenhouse.io/${tenantKey}`,
    apiBaseUrl: `https://boards-api.greenhouse.io/v1/boards/${tenantKey}`,
  };
  if (connectorId === "lever") return {
    connectorId, tenantKey, region, connectorVersion: "1.0.0", cadenceSeconds: 43_200,
    boardUrl: `https://${region === "eu" ? "jobs.eu" : "jobs"}.lever.co/${tenantKey}`,
    apiBaseUrl: `https://${region === "eu" ? "api.eu" : "api"}.lever.co/v0/postings/${tenantKey}`,
  };
  return {
    connectorId, tenantKey, region: "global", connectorVersion: "1.0.0", cadenceSeconds: 43_200,
    boardUrl: `https://jobs.ashbyhq.com/${tenantKey}`,
    apiBaseUrl: `https://api.ashbyhq.com/posting-api/job-board/${tenantKey}`,
  };
}

function manifest(now: Date): PilotRegistryManifest {
  const reviewedAt = new Date(now.getTime() - 60_000).toISOString();
  const expiresAt = new Date(now.getTime() + 30 * 86_400_000).toISOString();
  const policy = (sourceFamily: "greenhouse" | "lever" | "ashby", hostPattern: "*.greenhouse.io" | "*.lever.co" | "*.ashbyhq.com") => ({
    sourceFamily, hostPattern, accessClass: "documented_public_feed" as const, reviewedAt, expiresAt,
    retentionClass: "standard", attributionRequirements: "Synthetic database verification only.",
    maxRequestsPerMinute: 30, maxConcurrency: 2, contactEmail: "database-verifier@example.com",
    userAgent: "Career OS pilot database verifier",
  });
  return {
    schemaVersion: 1,
    classification: "synthetic",
    pilotId: "synthetic-db-verification",
    dataset: {
      name: "Synthetic 1,000-source database verification", sourceUrl: "https://example.com/pilot-verification",
      license: "CC0-1.0", generatedAt: reviewedAt, reviewedAt, reviewedBy: "database-verifier",
    },
    policies: [policy("greenhouse", "*.greenhouse.io"), policy("lever", "*.lever.co"), policy("ashby", "*.ashbyhq.com")],
    entries: Array.from({ length: VERIFIED_COUNT }, (_, index) => {
      const primaryDomain = `company-${index.toString().padStart(4, "0")}.pilot.test`;
      return {
        company: { displayName: `Pilot Company ${index}`, primaryDomain, careersUrl: `https://${primaryDomain}/careers` },
        source: source(index),
        evidence: { type: "employer_domain_link", evidenceUrl: `https://${primaryDomain}/careers`, statement: "Synthetic employer page binds the exact synthetic ATS tenant.", confidence: 0.99 },
        discoveryReference: `synthetic:pilot:${index}`, observedAt: reviewedAt,
        reviewReason: "Synthetic ownership reviewed for database verification only.",
      };
    }),
    quarantine: Array.from({ length: QUARANTINE_COUNT }, (_, index) => ({
      companyName: `Ambiguous Pilot ${index}`, atsUrl: `https://jobs.ashbyhq.com/ambiguous-${index}`,
      discoveryReference: `synthetic:quarantine:${index}`, observedAt: reviewedAt,
      reason: "Synthetic ownership remains ambiguous and requires operator review.",
    })),
  };
}

const baseUrl = process.env.DATABASE_URL;
if (!baseUrl) throw new Error("DATABASE_URL is required for pilot registry verification");
const databaseName = `career_os_pilot_${Date.now()}_${crypto.randomUUID().slice(0, 8).replaceAll("-", "")}`;
const quotedName = quoteIdentifier(databaseName);
const testUrl = databaseUrlFor(baseUrl, databaseName);
const admin = new SQL(baseUrl, { max: 1 });
let database: SQL | undefined;

try {
  await admin.unsafe(`CREATE DATABASE ${quotedName} TEMPLATE template0`);
  await migrate({ databaseUrl: testUrl });
  database = new SQL(testUrl, { max: 8 });
  const validated = validatePilotRegistryManifest(manifest(new Date()), { expectedVerified: VERIFIED_COUNT });
  const first = await applyPilotRegistry(database, validated.manifest, validated.report, "pilot-database-verifier", VERIFIED_COUNT);
  const auditBeforeReplay = (await database<{ count: number }[]>`SELECT count(*)::int AS count FROM audit_events WHERE action LIKE 'registry.%'`)[0]?.count;
  const replay = await applyPilotRegistry(database, validated.manifest, validated.report, "pilot-database-verifier", VERIFIED_COUNT);
  const final = (await database<{ pending: number; schedulable: number; audits: number }[]>`
    SELECT
      (SELECT count(*)::int FROM source_candidates WHERE review_state = 'pending') AS pending,
      (SELECT count(*)::int FROM schedulable_sources) AS schedulable,
      (SELECT count(*)::int FROM audit_events WHERE action LIKE 'registry.%') AS audits
  `)[0];
  assert(JSON.stringify(first) === JSON.stringify(replay), "pilot apply replay must return identical aggregate evidence");
  assert(final?.pending === QUARANTINE_COUNT, "ambiguous pilot rows must remain pending for review");
  assert(final.schedulable === VERIFIED_COUNT, "every verified source must be schedulable twice daily");
  assert(final.audits === auditBeforeReplay && final.audits === 2_005, "replay must not duplicate pilot audit events");
  console.log(JSON.stringify({
    status: "passed", verifiedEntries: VERIFIED_COUNT, quarantinedEntries: QUARANTINE_COUNT,
    schedulableSources: final.schedulable, auditEvents: final.audits, replayedWithoutNewAudits: true,
  }));
} finally {
  if (database) await database.close();
  await admin.unsafe(`DROP DATABASE IF EXISTS ${quotedName} WITH (FORCE)`);
  await admin.close();
}
