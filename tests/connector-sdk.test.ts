import { describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import {
  EnumerationResultSchema,
  FrozenFixtureManifestSchema,
  ParsedListingSchema,
  diffConnectorOutput,
  parseBoundedJson,
  runFrozenFixture,
  runShadowDiff,
  sanitizeUntrustedHtml,
  successfulForAbsenceInference,
  type ArtifactView,
  type EnumeratedListing,
  type FrozenFixtureCase,
  type FrozenFixtureManifest,
  type SourceConnector,
  type SourceDescriptor,
} from "../packages/connector-sdk/src/index.ts";

const fixtureRoot = join(import.meta.dir, "fixtures", "connector-sdk");
const digest = (value: string) => createHash("sha256").update(value).digest("hex");

function evidence<T>(value: T, artifactId: string, locator: { kind: "json_pointer"; pointer: string } | { kind: "text_span"; span: { start: number; end: number; quoteHash: string } }, origin: "source_field" | "source_text" | "deterministic_rule" = "source_text") {
  return { value, origin, artifactId, locator, extractorId: "fixture", extractorVersion: "1.0.0", confidence: origin === "source_field" ? 1 : 0.9 } as const;
}

function createConnector(version = "1.0.0", mutateFingerprint = false): SourceConnector {
  return {
    id: "greenhouse",
    version,
    detect(candidateUrl) {
      const detected = candidateUrl.hostname === "careers.example.com";
      return { detected, connectorId: "greenhouse", ...(detected ? { tenantKey: "example" } : {}), confidence: detected ? 1 : 0, reason: detected ? "recognized_host" : "not_recognized" };
    },
    planEnumeration(source: SourceDescriptor, cursor?: string) {
      return { requests: [{ url: source.apiBaseUrl, method: "GET", accept: "application/json", ...(cursor ? { pageToken: cursor } : {}) }] };
    },
    parseEnumeration(artifacts: readonly ArtifactView[]) {
      const artifact = artifacts[0]!;
      const parsed = parseBoundedJson(artifact.bytes, { maxBytes: 152, maxDepth: 10, maxNodes: 100, maxStringLength: 1_000 });
      if (parsed === null || typeof parsed !== "object" || !("jobs" in parsed) || !Array.isArray(parsed.jobs)) {
        return { listings: [], complete: false, completenessReason: "schema_invalid", responseArtifacts: [artifact.artifactId], connectorVersion: version };
      }
      const jobs = parsed.jobs as Array<{ id?: unknown; url?: unknown }>;
      const listings = jobs.map((job) => {
        if (typeof job.id !== "string" || typeof job.url !== "string") throw new TypeError("fixture_schema_invalid");
        return { sourceJobId: job.id, canonicalSourceUrl: job.url, lightweightFingerprint: mutateFingerprint ? digest(`${job.id}:changed`) : digest(job.id), artifactId: artifact.artifactId };
      });
      const next = "next" in parsed && typeof parsed.next === "string" ? parsed.next : undefined;
      return {
        listings,
        complete: listings.length > 0 && next === undefined,
        completenessReason: listings.length === 0 ? "suspicious_empty" : next ? "pagination_incomplete" : "complete",
        ...(next ? { nextPageToken: next } : {}),
        responseArtifacts: [artifact.artifactId],
        connectorVersion: version,
      };
    },
    planDetails(_source: SourceDescriptor, item: EnumeratedListing) {
      return { requests: [{ url: item.canonicalSourceUrl, method: "GET", accept: "text/html" }] };
    },
    parseListing(artifacts: readonly ArtifactView[], item: EnumeratedListing) {
      const artifact = artifacts[0]!;
      const sanitized = sanitizeUntrustedHtml(artifact.bytes, { maxBytes: 1_000, maxDepth: 10, maxNodes: 100, maxStringLength: 1_000 });
      const span = { kind: "text_span" as const, span: { start: 0, end: 11, quoteHash: digest("Safe text") } };
      return {
        sourceJobId: item.sourceJobId,
        title: evidence("Senior Engineer", artifact.artifactId, { kind: "text_span", span: { start: 0, end: 15, quoteHash: digest("Senior Engineer") } }),
        descriptionHtml: evidence(sanitized.html, artifact.artifactId, span, "deterministic_rule"),
        descriptionText: evidence(sanitized.text, artifact.artifactId, span),
        locations: evidence([], artifact.artifactId, span, "deterministic_rule"),
        applyUrl: evidence(item.applyUrl!, artifact.artifactId, { kind: "json_pointer", pointer: "/applyUrl" }, "source_field"),
        canonicalSourceUrl: evidence(item.canonicalSourceUrl, artifact.artifactId, { kind: "json_pointer", pointer: "/canonicalSourceUrl" }, "source_field"),
      };
    },
  };
}

async function loadFixtures(): Promise<{ manifest: FrozenFixtureManifest; cases: FrozenFixtureCase[] }> {
  const manifest = FrozenFixtureManifestSchema.parse(JSON.parse(await readFile(join(fixtureRoot, "manifest.json"), "utf8")));
  const cases: FrozenFixtureCase[] = [];
  for (const fixture of manifest.cases) {
    if (fixture.operation === "detect") {
      cases.push(fixture);
      continue;
    }
    const artifacts = await Promise.all(fixture.artifacts.map(async (artifact) => ({
      artifactId: artifact.artifactId,
      sourceUrl: artifact.sourceUrl,
      contentType: artifact.contentType,
      fetchedAt: artifact.fetchedAt,
      bytes: new Uint8Array(await readFile(join(fixtureRoot, artifact.path))),
    })));
    cases.push(fixture.operation === "listing"
      ? { ...fixture, item: fixture.item as EnumeratedListing, artifacts }
      : { ...fixture, artifacts });
  }
  return { manifest, cases };
}

describe("connector SDK frozen fixture contract", () => {
  test("validates provenance and passes every frozen adversarial case", async () => {
    const { manifest, cases } = await loadFixtures();
    expect(manifest.provenance.licenseReviewed).toBe(true);
    expect(manifest.provenance.sanitized).toBe(true);
    const results = await Promise.all(cases.map((fixture) => runFrozenFixture(createConnector(), fixture)));
    expect(results.map((result) => [result.caseId, result.passed])).toEqual(cases.map((fixture) => [fixture.caseId, true]));
  });

  test("rejects fixture traversal and unreviewed provenance", () => {
    const base = { formatVersion: 1, connectorId: "greenhouse", connectorVersion: "1.0.0", provenance: { source: "synthetic", capturedAt: "2026-08-28T00:00:00.000Z", licenseReviewed: true, sanitized: true } };
    expect(() => FrozenFixtureManifestSchema.parse({
      ...base,
      cases: [{
        formatVersion: 1,
        caseId: "bad",
        operation: "enumeration",
        artifacts: [{ artifactId: "a", path: "../secret", sourceUrl: "https://example.com", contentType: "application/json", fetchedAt: "2026-08-28T00:00:00.000Z" }],
        expected: { kind: "error", code: "no" },
      }],
    })).toThrow();
    for (const path of ["case/./artifact.json", "case//artifact.json"]) {
      expect(() => FrozenFixtureManifestSchema.parse({
        ...base,
        cases: [{ formatVersion: 1, caseId: path, operation: "enumeration", artifacts: [{ artifactId: "a", path, sourceUrl: "https://example.com", contentType: "application/json", fetchedAt: "2026-08-28T00:00:00.000Z" }], expected: { kind: "error", code: "no" } }],
      })).toThrow("fixture path must be relative and normalized");
    }
    expect(() => FrozenFixtureManifestSchema.parse({ ...base, provenance: { ...base.provenance, licenseReviewed: false }, cases: [] })).toThrow();
    const duplicateCase = { formatVersion: 1, caseId: "duplicate", operation: "detect", candidateUrl: "https://careers.example.com", expected: { kind: "result", value: {} } } as const;
    expect(() => FrozenFixtureManifestSchema.parse({ ...base, cases: [duplicateCase, duplicateCase] })).toThrow("fixture case IDs must be unique");
  });
});

describe("connector output invariants", () => {
  test("derives absence eligibility only from complete validated enumeration", () => {
    const complete = EnumerationResultSchema.parse({ listings: [], complete: true, completenessReason: "complete", responseArtifacts: ["artifact"], connectorVersion: "1.0.0" });
    expect(successfulForAbsenceInference(complete)).toBe(true);
    for (const reason of ["pagination_incomplete", "schema_invalid", "suspicious_empty", "blocked", "transport_failure", "limit_exceeded"] as const) {
      expect(successfulForAbsenceInference(EnumerationResultSchema.parse({ listings: [], complete: false, completenessReason: reason, responseArtifacts: ["artifact"], connectorVersion: "1.0.0" }))).toBe(false);
    }
    expect(() => EnumerationResultSchema.parse({ listings: [], complete: true, completenessReason: "complete", nextPageToken: "still-more", responseArtifacts: ["artifact"], connectorVersion: "1.0.0" })).toThrow();
    expect(() => EnumerationResultSchema.parse({ listings: [], complete: true, completenessReason: "schema_invalid", responseArtifacts: ["artifact"], connectorVersion: "1.0.0" })).toThrow("complete must agree");
    expect(successfulForAbsenceInference({ listings: [], complete: true, completenessReason: "complete", nextPageToken: "still-more", responseArtifacts: ["artifact"], connectorVersion: "1.0.0" })).toBe(false);
  });

  test("requires artifact-backed evidence on every required parsed field", () => {
    expect(() => ParsedListingSchema.parse({ sourceJobId: "job", title: { value: "No evidence" } })).toThrow();
  });

  test("rejects output identity drift and evidence from artifacts outside the invocation", async () => {
    const { cases } = await loadFixtures();
    const valid = cases.find((fixture) => fixture.caseId === "valid-enumeration")!;
    const versionMismatch = await runFrozenFixture({ ...createConnector("1.0.0"), version: "2.0.0" }, valid);
    expect(versionMismatch.actual).toEqual({ kind: "error", code: "TypeError" });

    const hostile = cases.find((fixture) => fixture.caseId === "hostile-html")!;
    const connector = createConnector();
    const parseListing = connector.parseListing.bind(connector);
    connector.parseListing = async (artifacts, item) => {
      const listing = await parseListing(artifacts, item);
      return { ...listing, title: { ...listing.title, artifactId: "artifact-from-another-run" } };
    };
    const evidenceMismatch = await runFrozenFixture(connector, hostile);
    expect(evidenceMismatch.actual).toEqual({ kind: "error", code: "TypeError" });
  });

  test("produces bounded, path-specific shadow diffs without changing canonical state", async () => {
    const { cases } = await loadFixtures();
    const valid = cases.filter((fixture) => fixture.caseId === "valid-enumeration");
    const results = await runShadowDiff(createConnector("1.0.0"), createConnector("1.1.0", true), valid);
    expect(results).toHaveLength(1);
    expect(results[0]!.changed).toBe(true);
    expect(results[0]!.differences.map((difference) => difference.path)).toContain("$.value.listings[0].lightweightFingerprint");
    expect(diffConnectorOutput({ secret: "same" }, { secret: "same" })).toEqual([]);
    const left: { self?: unknown } = {};
    const right: { self?: unknown } = {};
    left.self = left;
    right.self = right;
    expect(diffConnectorOutput(left, right)).toEqual([]);
  });
});

describe("bounded parsing and sanitization", () => {
  test("uses a fatal UTF-8 decoder and hard depth/node/string ceilings", () => {
    expect(() => parseBoundedJson(new Uint8Array([0xff]), { maxBytes: 10, maxDepth: 2, maxNodes: 10, maxStringLength: 10 })).toThrow("invalid_utf8");
    expect(() => parseBoundedJson(new TextEncoder().encode("[[[1]]]"), { maxBytes: 20, maxDepth: 2, maxNodes: 10, maxStringLength: 10 })).toThrow("depth_limit");
    expect(() => parseBoundedJson(new TextEncoder().encode("[1,2,3]"), { maxBytes: 20, maxDepth: 2, maxNodes: 3, maxStringLength: 10 })).toThrow("node_limit");
  });

  test("removes active markup and returns escaped display HTML", async () => {
    const bytes = new Uint8Array(await readFile(join(fixtureRoot, "hostile.html")));
    const sanitized = sanitizeUntrustedHtml(bytes);
    expect(sanitized.text).toBe("Safe & sound");
    expect(sanitized.html).toBe("Safe &amp; sound");
    expect(JSON.stringify(sanitized)).not.toMatch(/script|style|onerror|alert|<img/i);
    const nested = sanitizeUntrustedHtml(new TextEncoder().encode("<script>one<style>two</style>three</script><p>Visible</p>"));
    expect(nested.text).toBe("Visible");
  });
});
