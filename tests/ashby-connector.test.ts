import { describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import {
  FrozenFixtureManifestSchema,
  runFrozenFixture,
  runShadowDiff,
  type ArtifactView,
  type EnumeratedListing,
  type FrozenFixtureCase,
  type FrozenFixtureManifest,
  type SourceDescriptor,
} from "../packages/connector-sdk/src/index.ts";
import {
  ASHBY_CONNECTOR_VERSION,
  AshbyConnectorError,
  ashbyConnector,
  createAshbyConnector,
  validateAshbySource,
} from "../packages/connectors/src/index.ts";
import { SafeFetchClient, type SafeFetchDecision, type SafeFetchPolicy, type SafeFetchTransport, type TransportRequest, type TransportResponse } from "../packages/safe-fetch/src/index.ts";

const fixtureRoot = join(import.meta.dir, "fixtures", "ashby");
const postingId = "11111111-2222-4333-8444-555555555555";
const endpoint = "https://api.ashbyhq.com/posting-api/job-board/acme?includeCompensation=true";

const source: SourceDescriptor = {
  sourceId: "source-ashby-global",
  connectorId: "ashby",
  tenantKey: "acme",
  boardUrl: "https://jobs.ashbyhq.com/acme",
  apiBaseUrl: "https://api.ashbyhq.com/posting-api/job-board/acme",
  region: "global",
  policyId: "ashby-public",
};

async function artifact(path: string, artifactId: string, sourceUrl = endpoint): Promise<ArtifactView> {
  const bytes = new Uint8Array(await readFile(join(fixtureRoot, path)));
  return { artifactId, digest: createHash("sha256").update(bytes).digest("hex"), contentType: "application/json", sourceUrl, fetchedAt: "2026-08-28T00:00:00.000Z", bytes };
}

function memoryArtifact(value: unknown, artifactId: string, sourceUrl = endpoint): ArtifactView {
  const bytes = new TextEncoder().encode(JSON.stringify(value));
  return { artifactId, digest: createHash("sha256").update(bytes).digest("hex"), contentType: "application/json", sourceUrl, fetchedAt: "2026-08-28T00:00:00.000Z", bytes };
}

async function loadFixtures(): Promise<{ manifest: FrozenFixtureManifest; cases: FrozenFixtureCase[] }> {
  const manifest = FrozenFixtureManifestSchema.parse(JSON.parse(await readFile(join(fixtureRoot, "manifest.json"), "utf8")));
  const cases: FrozenFixtureCase[] = [];
  for (const fixture of manifest.cases) {
    if (fixture.operation === "detect") { cases.push(fixture); continue; }
    const artifacts = await Promise.all(fixture.artifacts.map((descriptor) => artifact(descriptor.path, descriptor.artifactId, descriptor.sourceUrl)));
    cases.push(fixture.operation === "listing" ? { ...fixture, item: fixture.item as EnumeratedListing, artifacts } : { ...fixture, artifacts });
  }
  return { manifest, cases };
}

describe("Ashby detection, source identity, and plans", () => {
  test("detects exact hosted and public API URLs without executing the hosted application", () => {
    for (const url of [
      "https://jobs.ashbyhq.com/acme",
      `https://jobs.ashbyhq.com/acme/${postingId}`,
      `https://jobs.ashbyhq.com/acme/${postingId}/application`,
      "https://api.ashbyhq.com/posting-api/job-board/acme?includeCompensation=true",
    ]) expect(ashbyConnector.detect(new URL(url))).toMatchObject({ detected: true, connectorId: "ashby", tenantKey: "acme", confidence: 1 });
    for (const url of [
      "http://jobs.ashbyhq.com/acme",
      "https://jobs.ashbyhq.com:8443/acme",
      "https://user:pass@jobs.ashbyhq.com/acme",
      "https://jobs.ashbyhq.com/acme/not-a-uuid",
      "https://api.ashbyhq.com/posting-api/job-board/acme?unexpected=true",
      "https://jobs.ashbyhq.com/%2fescape",
    ]) expect(ashbyConnector.detect(new URL(url))).toMatchObject({ detected: false });
  });

  test("binds a global tenant and emits one exact compensated board request", () => {
    expect(validateAshbySource(source).tenantKey).toBe("acme");
    expect(validateAshbySource({ ...source, boardUrl: "https://careers.acme.example/jobs" }).tenantKey).toBe("acme");
    expect(() => validateAshbySource({ ...source, region: "eu" })).toThrow(AshbyConnectorError);
    expect(() => validateAshbySource({ ...source, boardUrl: "https://jobs.ashbyhq.com/other" })).toThrow(AshbyConnectorError);
    expect(() => validateAshbySource({ ...source, boardUrl: "https://jobs.ashbyhq.com/acme/not-a-uuid" })).toThrow(AshbyConnectorError);
    expect(() => validateAshbySource({ ...source, boardUrl: "https://api.ashbyhq.com/unrelated" })).toThrow(AshbyConnectorError);
    expect(() => validateAshbySource({ ...source, apiBaseUrl: "https://api.ashbyhq.com/posting-api/job-board/other" })).toThrow(AshbyConnectorError);
    expect(ashbyConnector.planEnumeration(source)).toEqual({ requests: [{ url: endpoint, method: "GET", accept: "application/json" }] });
    expect(() => ashbyConnector.planEnumeration(source, "next")).toThrow("ashby_cursor_unsupported");
    expect(ashbyConnector.planDetails(source, { sourceJobId: postingId } as EnumeratedListing)).toBeNull();
  });
});

describe("Ashby frozen contract and fail-closed completeness", () => {
  test("passes exact expected outputs twice and keeps shadow output path-specific", async () => {
    const { manifest, cases } = await loadFixtures();
    expect(manifest.connectorVersion).toBe(ASHBY_CONNECTOR_VERSION);
    expect(manifest.provenance.licenseReviewed).toBe(true);
    const first = await Promise.all(cases.map((fixture) => runFrozenFixture(ashbyConnector, fixture)));
    const second = await Promise.all(cases.map((fixture) => runFrozenFixture(ashbyConnector, fixture)));
    expect(first.map((result) => [result.caseId, result.passed, result.differences])).toEqual(cases.map((fixture) => [fixture.caseId, true, []]));
    expect(second).toEqual(first);
    const diffs = await runShadowDiff(createAshbyConnector("1.0.0"), createAshbyConnector("1.1.0"), cases.filter((fixture) => fixture.operation === "listing"));
    expect(diffs[0]!.differences.map((difference) => difference.path)).toContain("$.value.title.extractorVersion");
  });

  test("filters unlisted jobs but rejects duplicates, cross-tenant records, and endpoint drift", async () => {
    const payload = JSON.parse(await readFile(join(fixtureRoot, "list-valid-hostile.json"), "utf8")) as { jobs: Array<Record<string, unknown>> };
    const nullableSecondaryAddress = {
      ...payload.jobs[0]!,
      secondaryLocations: [{ location: "Remote", address: null }],
    };
    expect(await ashbyConnector.parseEnumeration([
      memoryArtifact({ apiVersion: "1", jobs: [nullableSecondaryAddress] }, "ashby-null-secondary-address"),
    ])).toMatchObject({ complete: true, completenessReason: "complete" });
    const unlisted = { ...payload.jobs[0]!, id: "22222222-2222-4333-8444-555555555555", isListed: false, jobUrl: "https://jobs.ashbyhq.com/acme/22222222-2222-4333-8444-555555555555", applyUrl: "https://jobs.ashbyhq.com/acme/22222222-2222-4333-8444-555555555555/application" };
    const filtered = await ashbyConnector.parseEnumeration([memoryArtifact({ apiVersion: "1", jobs: [payload.jobs[0], unlisted] }, "ashby-filtered")]);
    expect(filtered).toMatchObject({ complete: true, completenessReason: "complete" });
    expect(filtered.listings).toHaveLength(1);
    const duplicate = await ashbyConnector.parseEnumeration([memoryArtifact({ apiVersion: "1", jobs: [payload.jobs[0], payload.jobs[0]] }, "ashby-duplicate")]);
    expect(duplicate).toMatchObject({ complete: false, completenessReason: "schema_invalid" });
    const crossTenant = { ...payload.jobs[0]!, jobUrl: `https://jobs.ashbyhq.com/other/${postingId}`, applyUrl: `https://jobs.ashbyhq.com/other/${postingId}/application` };
    const poisoned = await ashbyConnector.parseEnumeration([memoryArtifact({ apiVersion: "1", jobs: [crossTenant] }, "ashby-cross-tenant")]);
    expect(poisoned).toMatchObject({ listings: [], complete: false, completenessReason: "schema_invalid" });
    const valid = await artifact("list-valid-hostile.json", "ashby-valid");
    expect(() => ashbyConnector.parseEnumeration([{ ...valid, sourceUrl: `${endpoint}&extra=true` }])).toThrow("ashby_source_invalid");
    expect(() => ashbyConnector.parseEnumeration([valid, valid])).toThrow("ashby_artifact_count");
  });

  test("requires exact listed identity when selecting full details from the board artifact", async () => {
    const enumeration = await ashbyConnector.parseEnumeration([await artifact("list-valid-hostile.json", "ashby-list")]);
    const item = enumeration.listings[0]!;
    const listing = await ashbyConnector.parseListing([await artifact("list-valid-hostile.json", "ashby-detail")], item);
    expect(listing.sourceJobId).toBe(postingId);
    expect(listing.descriptionHtml?.value).not.toContain("script");
    expect(listing.descriptionHtml?.value).not.toContain("javascript:");
    expect(listing.compensation?.value).toMatchObject({ minimum: 120000, maximum: 150000, currency: "USD", period: "year" });
    expect(() => ashbyConnector.parseListing([memoryArtifact({ apiVersion: "1", jobs: [] }, "ashby-missing")], item)).toThrow("ashby_identity_mismatch");
  });
});

class FakeTransport implements SafeFetchTransport {
  readonly requests: TransportRequest[] = [];
  constructor(private readonly responses: readonly TransportResponse[]) {}
  async request(request: TransportRequest): Promise<TransportResponse> { this.requests.push(request); return this.responses[this.requests.length - 1]!; }
}

describe("Ashby safe-fetch integration", () => {
  test("executes only the planned API host and retains redirect decisions", async () => {
    const body = new Uint8Array(await readFile(join(fixtureRoot, "list-valid-hostile.json")));
    const transport = new FakeTransport([
      { status: 302, headers: { location: "/posting-api/job-board/acme?includeCompensation=true" }, body: new Uint8Array(), remoteAddress: "93.184.216.34" },
      { status: 200, headers: { "content-type": "application/json" }, body, remoteAddress: "93.184.216.34" },
    ]);
    const decisions: SafeFetchDecision[] = [];
    const policy: SafeFetchPolicy = { id: "ashby-public", allowedHosts: ["api.ashbyhq.com"], allowedContentTypes: ["application/json"], maxRequestsPerMinute: 10, maxConcurrency: 1, maxRedirects: 1, timeoutMs: 1_000, maxWireBytes: 1_000_000, maxResponseBytes: 1_000_000, userAgent: "CareerOS-Connector-Test/1.0" };
    const fetcher = new SafeFetchClient({ transport, resolve: async () => [{ address: "93.184.216.34", family: 4 }], onDecision: (decision) => decisions.push(decision) });
    const request = ashbyConnector.planEnumeration(source).requests[0]!;
    const fetched = await fetcher.fetch({ url: new URL(request.url), accept: request.accept, policy });
    const parsed = await ashbyConnector.parseEnumeration([{ artifactId: "ashby-integration", digest: createHash("sha256").update(fetched.bytes).digest("hex"), contentType: fetched.contentType, sourceUrl: fetched.finalUrl.href, fetchedAt: "2026-08-28T00:00:00.000Z", bytes: new Uint8Array(fetched.bytes) }]);
    expect(parsed.complete).toBe(true);
    expect(transport.requests).toHaveLength(2);
    expect(transport.requests.every((sent) => sent.url.hostname === "api.ashbyhq.com")).toBe(true);
    expect(decisions.map((decision) => decision.outcome)).toEqual(["allowed", "redirected", "allowed", "succeeded"]);
  });
});
