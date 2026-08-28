import { describe, expect, test } from "bun:test";
import type { EvidenceValue, ParsedListing } from "../packages/connector-sdk/src/index.ts";
import { canonicalizeJobUrl, normalizeParsedListing, normalizeTitle } from "../packages/normalization/src/index.ts";

const artifactId = "artifact-1";
function evidence<T>(value: T, pointer: string): EvidenceValue<T> {
  return { value, origin: "source_field", artifactId, locator: { kind: "json_pointer", pointer }, extractorId: "fixture", extractorVersion: "1.0.0", confidence: 1 };
}

function listing(overrides: Partial<ParsedListing> = {}): ParsedListing {
  return {
    sourceJobId: "job-1",
    title: evidence("  Sénior　Platform—Engineer  ", "/title"),
    descriptionHtml: evidence("<p>Hello</p><script>alert(1)</script><img src=x onerror=alert(2)>", "/description"),
    descriptionText: evidence("Hello", "/description"),
    locations: evidence([{ label: "Télétravail — Montréal", countryCode: "CA", locality: "Montréal" }], "/locations"),
    employmentType: evidence("Temps plein", "/employment"),
    compensation: evidence({ rawText: "€80 000 – €100 000 / an", minimum: 80_000, maximum: 100_000, currency: "EUR", period: "year" }, "/salary"),
    applyUrl: evidence("https://EXAMPLE.com/jobs/1/?utm_source=mail&b=2&a=1#apply", "/apply"),
    canonicalSourceUrl: evidence("https://example.com//jobs/1/?ref=board", "/url"),
    ...overrides,
  };
}

describe("deterministic normalization", () => {
  test.each([
    ["Sénior Platform—Engineer", "senior platform engineer"],
    ["ソフトウェア・エンジニア", "ソフトウェア エンジニア"],
    ["مهندس برمجيات", "مهندس برمجيات"],
    ["Ｆｕｌｌ　Ｓｔａｃｋ", "full stack"],
    ["Senior\u202eexe.Engineer\u2066", "seniorexe engineer"],
  ])("normalizes multilingual and compatibility-form titles", (raw, expected) => {
    expect(normalizeTitle(raw).search).toBe(expected);
  });

  test("canonicalizes HTTPS job URLs without marketing parameters or fragments", () => {
    expect(canonicalizeJobUrl("https://EXAMPLE.com//jobs/1/?utm_source=x&token=secret&client_secret=secret&auth=secret&session=secret&X-Amz-Signature=secret&b=2&a=1#private")).toBe("https://example.com/jobs/1?a=1&b=2");
    expect(() => canonicalizeJobUrl("http://example.com/job")).toThrow("normalized_url_invalid");
    expect(() => canonicalizeJobUrl("https://user:secret@example.com/job")).toThrow("normalized_url_invalid");
  });

  test("normalizes fields, preserves raw parsed input separately, and emits evidence for every displayed field", () => {
    const parsed = listing();
    const result = normalizeParsedListing(parsed);
    expect(result.candidate).toMatchObject({ normalizedTitle: "senior platform engineer", workplaceType: "remote", employmentType: "full_time", applyUrl: "https://example.com/jobs/1?a=1&b=2", canonicalSourceUrl: "https://example.com/jobs/1" });
    expect(result.candidate.descriptionHtml).not.toContain("script");
    expect(result.candidate.descriptionHtml).not.toContain("onerror");
    expect(result.candidate.compensation).toMatchObject({ minimum: 80_000, maximum: 100_000, currency: "EUR", period: "year" });
    expect(new Set(result.assertions.map((item) => item.fieldPath))).toEqual(new Set(Object.keys(result.candidate).filter((key) => key !== "sourceJobId").map((key) => `/${key}`)));
    expect(result.assertions.find((item) => item.fieldPath === "/normalizedTitle")).toMatchObject({ origin: "deterministic_rule", extractorId: "career-os-normalizer", extractorVersion: "1.0.0", artifactId });
    expect(parsed.descriptionHtml?.value).toContain("<script>");
  });

  test.each([
    ["Full-time", "full_time"], ["Temps partiel", "part_time"], ["Freelance", "contract"], ["Praktikum", "internship"],
  ])("maps multilingual employment labels deterministically", (raw, expected) => {
    expect(normalizeParsedListing(listing({ employmentType: evidence(raw, "/employment") })).candidate.employmentType).toBe(expected);
  });

  test("deduplicates normalized locations while explicit workplace evidence takes precedence", () => {
    const result = normalizeParsedListing(listing({
      locations: evidence([{ label: "Remote — Paris", countryCode: "FR" }, { label: "Remote — Paris", countryCode: "FR" }], "/locations"),
      workplaceType: evidence("hybrid", "/workplace"),
    }));
    expect(result.candidate.locations).toHaveLength(1);
    expect(result.candidate.locations[0]).toMatchObject({ countryCode: "FR", remoteEligible: true });
    expect(result.candidate.workplaceType).toBe("hybrid");
  });

  test("is byte-for-byte reproducible and changes its semantic fingerprint only with normalized meaning", () => {
    const first = normalizeParsedListing(listing());
    const second = normalizeParsedListing(listing());
    expect(JSON.stringify(first)).toBe(JSON.stringify(second));
    expect(normalizeParsedListing(listing({ title: evidence("  Sénior　Platform—Engineer ", "/title") })).semanticFingerprint).toBe(first.semanticFingerprint);
    expect(normalizeParsedListing(listing({ title: evidence("Principal Platform Engineer", "/title") })).semanticFingerprint).not.toBe(first.semanticFingerprint);
  });
});
