import { describe, expect, test } from "bun:test";
import { PilotRegistryError, validatePilotRegistryManifest, type PilotRegistryManifest } from "../packages/pilot-registry/src/index.ts";

const now = new Date("2026-09-03T12:00:00.000Z");

function entry(index: number, connectorId: "greenhouse" | "lever" | "ashby") {
  const tenantKey = `tenant-${index}`;
  const region = connectorId === "lever" && index % 2 ? "eu" as const : "global" as const;
  const boardUrl = connectorId === "greenhouse" ? `https://job-boards.greenhouse.io/${tenantKey}`
    : connectorId === "lever" ? `https://${region === "eu" ? "jobs.eu" : "jobs"}.lever.co/${tenantKey}`
      : `https://jobs.ashbyhq.com/${tenantKey}`;
  const apiBaseUrl = connectorId === "greenhouse" ? `https://boards-api.greenhouse.io/v1/boards/${tenantKey}`
    : connectorId === "lever" ? `https://${region === "eu" ? "api.eu" : "api"}.lever.co/v0/postings/${tenantKey}`
      : `https://api.ashbyhq.com/posting-api/job-board/${tenantKey}`;
  const domain = `company-${index}.com`;
  return {
    company: { displayName: `Company ${index}`, primaryDomain: domain, careersUrl: `https://${domain}/careers` },
    source: { connectorId, tenantKey, boardUrl, apiBaseUrl, region, connectorVersion: "1.0.0", cadenceSeconds: 43_200 as const },
    evidence: { type: "employer_domain_link" as const, evidenceUrl: `https://${domain}/careers`, statement: "Employer careers page links to this exact public ATS tenant.", confidence: 0.99 },
    discoveryReference: `common-crawl:fixture-${index}`,
    observedAt: "2026-09-02T12:00:00.000Z",
    reviewReason: "Reviewed employer-domain ownership and active ATS identity.",
  };
}

function manifest(): PilotRegistryManifest {
  return {
    schemaVersion: 1 as const,
    classification: "production",
    pilotId: "pilot-2026-09",
    dataset: { name: "Reviewed test corpus", sourceUrl: "https://dataset.example.com/pilot", license: "MIT", generatedAt: "2026-09-02T10:00:00.000Z", reviewedAt: "2026-09-03T10:00:00.000Z", reviewedBy: "test-operator" },
    policies: [
      { sourceFamily: "greenhouse", hostPattern: "*.greenhouse.io", accessClass: "documented_public_feed", reviewedAt: "2026-09-01T00:00:00.000Z", expiresAt: "2026-11-30T00:00:00.000Z", retentionClass: "standard", attributionRequirements: "Link to the employer posting.", maxRequestsPerMinute: 30, maxConcurrency: 2, contactEmail: "operator@example.com", userAgent: "Career OS pilot verifier" },
      { sourceFamily: "lever", hostPattern: "*.lever.co", accessClass: "documented_public_feed", reviewedAt: "2026-09-01T00:00:00.000Z", expiresAt: "2026-11-30T00:00:00.000Z", retentionClass: "standard", attributionRequirements: "Link to the employer posting.", maxRequestsPerMinute: 30, maxConcurrency: 2, contactEmail: "operator@example.com", userAgent: "Career OS pilot verifier" },
      { sourceFamily: "ashby", hostPattern: "*.ashbyhq.com", accessClass: "documented_public_feed", reviewedAt: "2026-09-01T00:00:00.000Z", expiresAt: "2026-11-30T00:00:00.000Z", retentionClass: "standard", attributionRequirements: "Link to the employer posting.", maxRequestsPerMinute: 30, maxConcurrency: 2, contactEmail: "operator@example.com", userAgent: "Career OS pilot verifier" },
    ],
    entries: [entry(0, "greenhouse"), entry(1, "lever"), entry(2, "ashby")],
    quarantine: [],
  };
}

describe("controlled pilot registry", () => {
  test("validates the exact 1,000-source pilot envelope", () => {
    const large = manifest();
    large.entries = Array.from({ length: 1_000 }, (_, index) => entry(index, ["greenhouse", "lever", "ashby"][index % 3] as "greenhouse" | "lever" | "ashby"));
    const result = validatePilotRegistryManifest(large, { now });
    expect(result.report.verifiedEntries).toBe(1_000);
    expect(result.report.uniqueDomains).toBe(1_000);
    expect(result.report.uniqueTenants).toBe(1_000);
    expect(Object.values(result.report.connectorCounts).reduce((sum, value) => sum + value, 0)).toBe(1_000);
  });

  test("accepts reviewed unique connector identities and returns only aggregate evidence", () => {
    const result = validatePilotRegistryManifest(manifest(), { expectedVerified: 3, now });
    expect(result.report).toMatchObject({ classification: "production", verifiedEntries: 3, quarantinedEntries: 0, connectorCounts: { greenhouse: 1, lever: 1, ashby: 1 }, uniqueDomains: 3, uniqueTenants: 3, policies: 3 });
    expect(result.report.manifestSha256).toMatch(/^[0-9a-f]{64}$/);
    expect(JSON.stringify(result.report)).not.toContain("tenant-0");
  });

  test("rejects count drift, duplicate domains, and duplicate tenants", () => {
    expect(() => validatePilotRegistryManifest(manifest(), { expectedVerified: 1, now })).toThrow("verified_entry_count_mismatch");
    const duplicateDomain = manifest();
    duplicateDomain.entries[1]!.company.primaryDomain = duplicateDomain.entries[0]!.company.primaryDomain;
    duplicateDomain.entries[1]!.company.careersUrl = duplicateDomain.entries[0]!.company.careersUrl;
    duplicateDomain.entries[1]!.evidence.evidenceUrl = duplicateDomain.entries[0]!.evidence.evidenceUrl;
    expect(() => validatePilotRegistryManifest(duplicateDomain, { expectedVerified: 3, now })).toThrow("duplicate_verified_domain");
    const duplicateTenant = manifest();
    duplicateTenant.entries[1]!.source = { ...duplicateTenant.entries[0]!.source };
    expect(() => validatePilotRegistryManifest(duplicateTenant, { expectedVerified: 3, now })).toThrow("duplicate_active_tenant");
  });

  test("rejects cross-tenant URLs and evidence outside the employer domain", () => {
    const crossed = manifest();
    crossed.entries[0]!.source.apiBaseUrl = "https://boards-api.greenhouse.io/v1/boards/another-tenant";
    expect(() => validatePilotRegistryManifest(crossed, { expectedVerified: 3, now })).toThrow("greenhouse_identity_mismatch");
    const unrelatedEvidence = manifest();
    unrelatedEvidence.entries[2]!.evidence.evidenceUrl = "https://unrelated.example.net/careers";
    expect(() => validatePilotRegistryManifest(unrelatedEvidence, { expectedVerified: 3, now })).toThrow("ownership_evidence_domain_mismatch");
    const atsAsEmployer = manifest();
    atsAsEmployer.entries[0]!.company.primaryDomain = "job-boards.greenhouse.io";
    atsAsEmployer.entries[0]!.company.careersUrl = "https://job-boards.greenhouse.io/tenant-0";
    atsAsEmployer.entries[0]!.evidence.evidenceUrl = "https://job-boards.greenhouse.io/tenant-0";
    expect(() => validatePilotRegistryManifest(atsAsEmployer, { expectedVerified: 3, now })).toThrow("shared_ats_domain_is_not_employer_identity");
    const signedEvidence = manifest();
    signedEvidence.entries[0]!.evidence.evidenceUrl += "?token=secret";
    expect(() => validatePilotRegistryManifest(signedEvidence, { expectedVerified: 3, now })).toThrow("manifest_schema_invalid");
  });

  test("requires a registrable employer domain instead of a public suffix", () => {
    const publicSuffix = manifest();
    publicSuffix.entries[0]!.company.primaryDomain = "co.uk";
    publicSuffix.entries[0]!.company.careersUrl = "https://victim.co.uk/careers";
    publicSuffix.entries[0]!.evidence.evidenceUrl = "https://victim.co.uk/careers";
    expect(() => validatePilotRegistryManifest(publicSuffix, { expectedVerified: 3, now })).toThrow("primary_domain_not_registrable");

    const registrable = manifest();
    registrable.entries[0]!.company.primaryDomain = "employer.co.uk";
    registrable.entries[0]!.company.careersUrl = "https://jobs.employer.co.uk/careers";
    registrable.entries[0]!.evidence.evidenceUrl = "https://jobs.employer.co.uk/careers";
    expect(validatePilotRegistryManifest(registrable, { expectedVerified: 3, now }).report.uniqueDomains).toBe(3);
  });

  test("rejects stale policies, weak evidence, unknown fields, and future observations", () => {
    const stale = manifest();
    stale.policies[0]!.expiresAt = "2026-09-03T11:59:59.000Z";
    expect(() => validatePilotRegistryManifest(stale, { expectedVerified: 3, now })).toThrow(PilotRegistryError);
    const weak = manifest();
    weak.entries[0]!.evidence.confidence = 0.8;
    expect(() => validatePilotRegistryManifest(weak, { expectedVerified: 3, now })).toThrow("manifest_schema_invalid");
    const unknown = manifest() as ReturnType<typeof manifest> & { token?: string };
    unknown.token = "must-not-be-accepted";
    expect(() => validatePilotRegistryManifest(unknown, { expectedVerified: 3, now })).toThrow("manifest_schema_invalid");
    const future = manifest();
    future.entries[0]!.observedAt = "2026-09-04T00:00:00.000Z";
    expect(() => validatePilotRegistryManifest(future, { expectedVerified: 3, now })).toThrow("observation_in_future");

    const staleDataset = manifest();
    staleDataset.dataset.generatedAt = "2026-08-20T00:00:00.000Z";
    staleDataset.dataset.reviewedAt = "2026-08-21T00:00:00.000Z";
    expect(() => validatePilotRegistryManifest(staleDataset, { expectedVerified: 3, now })).toThrow("dataset_review_stale");

    const staleObservation = manifest();
    staleObservation.entries[0]!.observedAt = "2026-08-20T00:00:00.000Z";
    expect(() => validatePilotRegistryManifest(staleObservation, { expectedVerified: 3, now })).toThrow("observation_stale");

    const excessivePolicy = manifest();
    excessivePolicy.policies[0]!.expiresAt = "2026-12-01T00:00:00.001Z";
    expect(() => validatePilotRegistryManifest(excessivePolicy, { expectedVerified: 3, now })).toThrow("policy_review_window_invalid");
  });

  test("keeps quarantine distinct from verified identities and deduplicated", () => {
    const conflict = manifest();
    conflict.quarantine = [{ companyName: "Needs review", primaryDomain: "company-0.com", discoveryReference: "manual:1", observedAt: "2026-09-02T00:00:00.000Z", reason: "Ownership evidence remains ambiguous." }];
    expect(() => validatePilotRegistryManifest(conflict, { expectedVerified: 3, now })).toThrow("quarantine_conflicts_verified_domain");
    const duplicate = manifest();
    duplicate.quarantine = [
      { companyName: "Needs review", atsUrl: "https://jobs.ashbyhq.com/uncertain", discoveryReference: "manual:1", observedAt: "2026-09-02T00:00:00.000Z", reason: "Ownership evidence remains ambiguous." },
      { companyName: "Needs review", atsUrl: "https://jobs.ashbyhq.com/uncertain", discoveryReference: "manual:2", observedAt: "2026-09-02T00:00:00.000Z", reason: "A second review found the same ambiguous locator." },
    ];
    expect(() => validatePilotRegistryManifest(duplicate, { expectedVerified: 3, now })).toThrow("duplicate_quarantine_entry");
  });
});
