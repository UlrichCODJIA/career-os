import { createHash } from "node:crypto";
import { parse as parseDomain } from "tldts";
import { z } from "zod";

const DAY_MS = 86_400_000;
export const PILOT_FRESHNESS_LIMITS = Object.freeze({
  datasetAgeMs: 7 * DAY_MS,
  observationAgeMs: 7 * DAY_MS,
  policyReviewAgeMs: 30 * DAY_MS,
  policyValidityMs: 90 * DAY_MS,
});

const Domain = z.string().trim().toLowerCase().min(3).max(253)
  .regex(/^(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/);
const HttpsUrl = z.url().refine((value) => {
  const url = new URL(value);
  return url.protocol === "https:" && !url.username && !url.password && (!url.port || url.port === "443")
    && Domain.safeParse(url.hostname).success;
}, "must be a credential-free HTTPS URL on a domain host");
const EvidenceUrl = HttpsUrl.refine((value) => {
  const url = new URL(value);
  return !url.search && !url.hash;
}, "evidence URLs must not contain a query or fragment");
const Timestamp = z.iso.datetime();
const Reason = z.string().trim().min(8).max(1_000);
const ConnectorId = z.enum(["greenhouse", "lever", "ashby"]);

export const PilotPolicySchema = z.object({
  sourceFamily: ConnectorId,
  hostPattern: z.enum(["*.greenhouse.io", "*.lever.co", "*.ashbyhq.com"]),
  accessClass: z.literal("documented_public_feed"),
  robotsReviewUrl: HttpsUrl.optional(),
  termsReviewUrl: HttpsUrl.optional(),
  reviewedAt: Timestamp,
  expiresAt: Timestamp,
  retentionClass: z.string().trim().min(1).max(100),
  attributionRequirements: z.string().trim().min(1).max(2_000),
  maxRequestsPerMinute: z.number().int().min(1).max(60),
  maxConcurrency: z.number().int().min(1).max(4),
  contactEmail: z.email(),
  userAgent: z.string().trim().min(8).max(500),
}).strict();

const PilotSourceSchema = z.object({
  connectorId: ConnectorId,
  tenantKey: z.string().trim().min(1).max(200),
  boardUrl: HttpsUrl,
  apiBaseUrl: HttpsUrl,
  region: z.enum(["global", "eu"]),
  connectorVersion: z.string().trim().min(1).max(100).regex(/^[A-Za-z0-9._:-]+$/),
  cadenceSeconds: z.literal(43_200),
}).strict();

export const VerifiedPilotEntrySchema = z.object({
  company: z.object({
    legalName: z.string().trim().min(1).max(200).optional(),
    displayName: z.string().trim().min(1).max(200),
    primaryDomain: Domain,
    careersUrl: EvidenceUrl,
  }).strict(),
  source: PilotSourceSchema,
  evidence: z.object({
    type: z.literal("employer_domain_link"),
    evidenceUrl: EvidenceUrl,
    statement: z.string().trim().min(8).max(2_000),
    confidence: z.number().min(0.9).max(1),
  }).strict(),
  discoveryReference: z.string().trim().min(1).max(500),
  observedAt: Timestamp,
  reviewReason: Reason,
}).strict();

export const QuarantinedPilotEntrySchema = z.object({
  companyName: z.string().trim().min(1).max(200),
  primaryDomain: Domain.optional(),
  careersUrl: HttpsUrl.optional(),
  atsUrl: HttpsUrl.optional(),
  discoveryReference: z.string().trim().min(1).max(500),
  observedAt: Timestamp,
  reason: Reason,
}).strict().refine((entry) => entry.primaryDomain || entry.careersUrl || entry.atsUrl, "quarantine entry needs an identity locator");

export const PilotRegistryManifestSchema = z.object({
  schemaVersion: z.literal(1),
  classification: z.enum(["production", "synthetic"]),
  pilotId: z.string().trim().regex(/^[a-z0-9][a-z0-9._-]{7,127}$/),
  dataset: z.object({
    name: z.string().trim().min(1).max(200),
    sourceUrl: HttpsUrl,
    license: z.string().trim().min(1).max(100),
    generatedAt: Timestamp,
    reviewedAt: Timestamp,
    reviewedBy: z.string().trim().min(1).max(200),
  }).strict(),
  policies: PilotPolicySchema.array().min(1).max(3),
  entries: VerifiedPilotEntrySchema.array().min(1).max(1_000),
  quarantine: QuarantinedPilotEntrySchema.array().max(1_000).default([]),
}).strict();

export type PilotRegistryManifest = z.infer<typeof PilotRegistryManifestSchema>;
export type VerifiedPilotEntry = z.infer<typeof VerifiedPilotEntrySchema>;

export interface PilotRegistryReport {
  schemaVersion: 1;
  pilotId: string;
  classification: "production" | "synthetic";
  manifestSha256: string;
  verifiedEntries: number;
  quarantinedEntries: number;
  connectorCounts: Record<"greenhouse" | "lever" | "ashby", number>;
  uniqueDomains: number;
  uniqueTenants: number;
  policies: number;
  generatedAt: string;
}

export class PilotRegistryError extends Error {
  constructor(public readonly code: string) {
    super(code);
    this.name = "PilotRegistryError";
  }
}

function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (value && typeof value === "object") {
    const object = value as Record<string, unknown>;
    return `{${Object.keys(object).sort().map((key) => `${JSON.stringify(key)}:${canonical(object[key])}`).join(",")}}`;
  }
  return JSON.stringify(value);
}

function exactUrl(value: string, host: string, path: string): boolean {
  const url = new URL(value);
  return url.hostname === host && url.pathname.replace(/\/$/, "") === path && !url.search && !url.hash;
}

function validateSource(entry: VerifiedPilotEntry): void {
  const { connectorId, tenantKey, boardUrl, apiBaseUrl, region } = entry.source;
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,199}$/.test(tenantKey)) throw new PilotRegistryError("invalid_tenant_key");
  const path = `/${tenantKey}`;
  if (connectorId === "greenhouse") {
    const board = new URL(boardUrl);
    const boardOk = ["boards.greenhouse.io", "job-boards.greenhouse.io"].includes(board.hostname)
      && board.pathname.replace(/\/$/, "") === path && !board.search && !board.hash;
    if (region !== "global" || !boardOk || !exactUrl(apiBaseUrl, "boards-api.greenhouse.io", `/v1/boards/${tenantKey}`)) {
      throw new PilotRegistryError("greenhouse_identity_mismatch");
    }
  } else if (connectorId === "lever") {
    const boardHost = region === "eu" ? "jobs.eu.lever.co" : "jobs.lever.co";
    const apiHost = region === "eu" ? "api.eu.lever.co" : "api.lever.co";
    if (!exactUrl(boardUrl, boardHost, path) || !exactUrl(apiBaseUrl, apiHost, `/v0/postings/${tenantKey}`)) {
      throw new PilotRegistryError("lever_identity_mismatch");
    }
  } else if (region !== "global"
    || !exactUrl(boardUrl, "jobs.ashbyhq.com", path)
    || !exactUrl(apiBaseUrl, "api.ashbyhq.com", `/posting-api/job-board/${tenantKey}`)) {
    throw new PilotRegistryError("ashby_identity_mismatch");
  }
}

function hostBelongsToDomain(urlValue: string, domain: string): boolean {
  const host = new URL(urlValue).hostname.toLowerCase();
  return host === domain || host.endsWith(`.${domain}`);
}

const SHARED_ATS_DOMAINS = ["greenhouse.io", "lever.co", "ashbyhq.com"];

function isRegistrableEmployerDomain(domain: string, classification: PilotRegistryManifest["classification"]): boolean {
  if (classification === "synthetic" && domain.endsWith(".test")) return true;
  const parsed = parseDomain(domain, { allowPrivateDomains: false });
  return parsed.isIcann === true && parsed.domain === domain;
}

function ageMs(now: Date, value: string): number {
  return now.getTime() - new Date(value).getTime();
}

export function validatePilotRegistryManifest(
  input: unknown,
  options: { expectedVerified?: number; now?: Date } = {},
): { manifest: PilotRegistryManifest; report: PilotRegistryReport } {
  const parsed = PilotRegistryManifestSchema.safeParse(input);
  if (!parsed.success) throw new PilotRegistryError("manifest_schema_invalid");
  const manifest = parsed.data;
  const expected = options.expectedVerified ?? 1_000;
  const now = options.now ?? new Date();
  if (manifest.entries.length !== expected) throw new PilotRegistryError("verified_entry_count_mismatch");
  const generatedAt = new Date(manifest.dataset.generatedAt);
  const datasetReviewedAt = new Date(manifest.dataset.reviewedAt);
  if (generatedAt > now || datasetReviewedAt > now || generatedAt > datasetReviewedAt) {
    throw new PilotRegistryError("dataset_review_in_future");
  }
  if (ageMs(now, manifest.dataset.generatedAt) > PILOT_FRESHNESS_LIMITS.datasetAgeMs
    || ageMs(now, manifest.dataset.reviewedAt) > PILOT_FRESHNESS_LIMITS.datasetAgeMs) {
    throw new PilotRegistryError("dataset_review_stale");
  }

  const policyFamilies = new Set<string>();
  for (const policy of manifest.policies) {
    if (policyFamilies.has(policy.sourceFamily)) throw new PilotRegistryError("duplicate_policy_family");
    policyFamilies.add(policy.sourceFamily);
    const expectedHost = policy.sourceFamily === "greenhouse" ? "*.greenhouse.io"
      : policy.sourceFamily === "lever" ? "*.lever.co" : "*.ashbyhq.com";
    if (policy.hostPattern !== expectedHost) throw new PilotRegistryError("policy_host_mismatch");
    const reviewedAt = new Date(policy.reviewedAt);
    const expiresAt = new Date(policy.expiresAt);
    if (reviewedAt > now || expiresAt <= now || expiresAt <= reviewedAt) throw new PilotRegistryError("policy_not_current");
    if (reviewedAt > datasetReviewedAt || ageMs(now, policy.reviewedAt) > PILOT_FRESHNESS_LIMITS.policyReviewAgeMs
      || expiresAt.getTime() - reviewedAt.getTime() > PILOT_FRESHNESS_LIMITS.policyValidityMs) {
      throw new PilotRegistryError("policy_review_window_invalid");
    }
  }

  const domains = new Set<string>();
  const tenants = new Set<string>();
  const counts = { greenhouse: 0, lever: 0, ashby: 0 };
  for (const entry of manifest.entries) {
    validateSource(entry);
    if (!policyFamilies.has(entry.source.connectorId)) throw new PilotRegistryError("source_policy_missing");
    if (SHARED_ATS_DOMAINS.some((domain) => entry.company.primaryDomain === domain || entry.company.primaryDomain.endsWith(`.${domain}`))) {
      throw new PilotRegistryError("shared_ats_domain_is_not_employer_identity");
    }
    if (!isRegistrableEmployerDomain(entry.company.primaryDomain, manifest.classification)) {
      throw new PilotRegistryError("primary_domain_not_registrable");
    }
    if (!hostBelongsToDomain(entry.company.careersUrl, entry.company.primaryDomain)
      || !hostBelongsToDomain(entry.evidence.evidenceUrl, entry.company.primaryDomain)) {
      throw new PilotRegistryError("ownership_evidence_domain_mismatch");
    }
    const observedAt = new Date(entry.observedAt);
    if (observedAt > now || observedAt > datasetReviewedAt) throw new PilotRegistryError("observation_in_future");
    if (ageMs(now, entry.observedAt) > PILOT_FRESHNESS_LIMITS.observationAgeMs) {
      throw new PilotRegistryError("observation_stale");
    }
    const tenant = `${entry.source.connectorId}:${entry.source.region}:${entry.source.tenantKey.toLowerCase()}`;
    if (domains.has(entry.company.primaryDomain)) throw new PilotRegistryError("duplicate_verified_domain");
    if (tenants.has(tenant)) throw new PilotRegistryError("duplicate_active_tenant");
    domains.add(entry.company.primaryDomain);
    tenants.add(tenant);
    counts[entry.source.connectorId] += 1;
  }

  const quarantineLocators = new Set<string>();
  for (const entry of manifest.quarantine) {
    const observedAt = new Date(entry.observedAt);
    if (observedAt > now || observedAt > datasetReviewedAt) throw new PilotRegistryError("quarantine_observation_in_future");
    if (ageMs(now, entry.observedAt) > PILOT_FRESHNESS_LIMITS.observationAgeMs) {
      throw new PilotRegistryError("quarantine_observation_stale");
    }
    if (entry.primaryDomain && domains.has(entry.primaryDomain)) throw new PilotRegistryError("quarantine_conflicts_verified_domain");
    const locator = canonical({
      companyName: entry.companyName.toLowerCase(),
      primaryDomain: entry.primaryDomain ?? null,
      careersUrl: entry.careersUrl ?? null,
      atsUrl: entry.atsUrl ?? null,
    });
    if (quarantineLocators.has(locator)) throw new PilotRegistryError("duplicate_quarantine_entry");
    quarantineLocators.add(locator);
  }

  const digest = createHash("sha256").update(canonical(manifest)).digest("hex");
  return {
    manifest,
    report: {
      schemaVersion: 1,
      pilotId: manifest.pilotId,
      classification: manifest.classification,
      manifestSha256: digest,
      verifiedEntries: manifest.entries.length,
      quarantinedEntries: manifest.quarantine.length,
      connectorCounts: counts,
      uniqueDomains: domains.size,
      uniqueTenants: tenants.size,
      policies: manifest.policies.length,
      generatedAt: now.toISOString(),
    },
  };
}
