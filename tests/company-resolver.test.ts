import { describe, expect, test } from "bun:test";
import {
  companyNameScore,
  normalizeCompanyIdentityKey,
  normalizeCompanyName,
  resolveCompanyIdentity,
  type CompanyIdentityCandidate,
} from "../packages/company-resolver/src/index.ts";

const acme: CompanyIdentityCandidate = {
  id: "00000000-0000-7000-8000-000000000001",
  displayName: "Acme Corporation",
  legalName: "Acme Corporation Ltd.",
  keys: [
    { type: "verified_domain", value: "acme.example", evidenceId: "existing-domain", confidence: 1 },
    { type: "ats_tenant", value: "greenhouse:global:acme", evidenceId: "existing-tenant", confidence: 0.99 },
    { type: "verified_alias", value: "ACME", evidenceId: "existing-alias", confidence: 0.98 },
  ],
};

describe("deterministic company identity resolver", () => {
  test("normalizes Unicode names and exact identity keys reproducibly", () => {
    expect(normalizeCompanyName("  Ａcmé\u202e  株式会社  ")).toBe("acme 株式会社");
    expect(normalizeCompanyIdentityKey("verified_domain", "ACME.Example.")).toBe("acme.example");
    expect(() => normalizeCompanyIdentityKey("verified_domain", "acme.example/path")).toThrow();
    expect(() => normalizeCompanyIdentityKey("verified_domain", "user@acme.example")).toThrow();
    expect(normalizeCompanyIdentityKey("ats_tenant", "GreenHouse:GLOBAL:Acme")).toBe("greenhouse:global:acme");
    expect(() => normalizeCompanyIdentityKey("ats_tenant", "greenhouse:acme")).toThrow();
  });

  test("preserves identity-bearing combining marks outside Latin script", () => {
    expect(normalizeCompanyName("شَرِكَة")).not.toBe(normalizeCompanyName("شركة"));
    expect(normalizeCompanyName("Café")).toBe("cafe");
  });

  test("matches a unique verified domain before weaker contradictory names", () => {
    const result = resolveCompanyIdentity({
      displayName: "Completely Different Trade Name",
      keys: [{ type: "verified_domain", value: "acme.example", evidenceId: "incoming-domain", confidence: 1 }],
    }, [acme]);
    expect(result).toMatchObject({ action: "automatic_match", companyId: acme.id, reason: "exact_verified_domain", confidence: 1 });
  });

  test("uses ATS tenant identity when no domain claim exists", () => {
    const result = resolveCompanyIdentity({
      displayName: "Acme Jobs",
      keys: [{ type: "ats_tenant", value: "greenhouse:global:acme", evidenceId: "incoming-tenant", confidence: 0.99 }],
    }, [acme]);
    expect(result).toMatchObject({ action: "automatic_match", companyId: acme.id, reason: "exact_ats_tenant" });
  });

  test("queues cross-key conflicts instead of trusting the strongest key silently", () => {
    const other: CompanyIdentityCandidate = {
      id: "00000000-0000-7000-8000-000000000004",
      displayName: "Acme Recruiting Partner",
      keys: [{ type: "ats_tenant", value: "greenhouse:global:partner", evidenceId: "partner-tenant", confidence: 1 }],
    };
    const result = resolveCompanyIdentity({
      displayName: "Acme",
      keys: [
        { type: "verified_domain", value: "acme.example", evidenceId: "incoming-domain", confidence: 1 },
        { type: "ats_tenant", value: "greenhouse:global:partner", evidenceId: "incoming-tenant", confidence: 1 },
      ],
    }, [acme, other]);
    expect(result).toMatchObject({ action: "review", reason: "conflicting_exact_evidence" });
  });

  test("never auto-merges ambiguous exact claims or near-name collisions", () => {
    const collision = { ...acme, id: "00000000-0000-7000-8000-000000000002", displayName: "Acme Consulting" };
    expect(resolveCompanyIdentity({
      displayName: "Acme",
      keys: [{ type: "verified_domain", value: "acme.example", evidenceId: "incoming", confidence: 1 }],
    }, [acme, collision])).toMatchObject({ action: "review", reason: "ambiguous_verified_domain" });

    const nameOnly = resolveCompanyIdentity({ displayName: "Acme Corp", keys: [] }, [acme]);
    expect(nameOnly).toMatchObject({ action: "review", reason: "name_similarity_requires_review" });
    expect(companyNameScore("Acme Corp", "Acme Corporation")).toBeGreaterThan(0.65);
  });

  test("creates only when strong exact identity is unclaimed", () => {
    expect(resolveCompanyIdentity({
      displayName: "新しい会社",
      keys: [{ type: "verified_domain", value: "new.example", evidenceId: "employer-link", confidence: 0.99 }],
    }, [acme])).toMatchObject({ action: "create_new", reason: "unclaimed_exact_identity" });
    expect(resolveCompanyIdentity({ displayName: "Unknown Holdings", keys: [] }, [acme])).toMatchObject({ action: "review", reason: "insufficient_exact_evidence" });
  });

  test("is reproducible regardless of candidate input order", () => {
    const other: CompanyIdentityCandidate = {
      id: "00000000-0000-7000-8000-000000000003",
      displayName: "Other Company",
      keys: [{ type: "verified_domain", value: "other.example", evidenceId: "other-domain", confidence: 1 }],
    };
    const incoming = { displayName: "Acme", keys: [{ type: "verified_alias" as const, value: "Acme", evidenceId: "incoming-alias", confidence: 0.98 }] };
    expect(resolveCompanyIdentity(incoming, [acme, other])).toEqual(resolveCompanyIdentity(incoming, [other, acme]));
  });
});
