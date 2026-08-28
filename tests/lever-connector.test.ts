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
  LEVER_CONNECTOR_VERSION,
  LEVER_PAGE_SIZE,
  LeverConnectorError,
  createLeverConnector,
  leverConnector,
  validateLeverSource,
} from "../packages/connectors/src/index.ts";
import { SafeFetchClient, type SafeFetchDecision, type SafeFetchPolicy, type SafeFetchTransport, type TransportRequest, type TransportResponse } from "../packages/safe-fetch/src/index.ts";

const fixtureRoot = join(import.meta.dir, "fixtures", "lever");
const postingId = "11111111-2222-4333-8444-555555555555";

const globalSource: SourceDescriptor = {
  sourceId: "source-lever-global",
  connectorId: "lever",
  tenantKey: "acme",
  boardUrl: "https://jobs.lever.co/acme",
  apiBaseUrl: "https://api.lever.co/v0/postings/acme",
  region: "global",
  policyId: "lever-global-public",
};

const euSource: SourceDescriptor = {
  ...globalSource,
  sourceId: "source-lever-eu",
  boardUrl: "https://jobs.eu.lever.co/acme",
  apiBaseUrl: "https://api.eu.lever.co/v0/postings/acme",
  region: "eu",
  policyId: "lever-eu-public",
};

async function artifact(path: string, artifactId: string, sourceUrl: string): Promise<ArtifactView> {
  const bytes = new Uint8Array(await readFile(join(fixtureRoot, path)));
  return { artifactId, digest: createHash("sha256").update(bytes).digest("hex"), contentType: "application/json", sourceUrl, fetchedAt: "2026-08-28T00:00:00.000Z", bytes };
}

function memoryArtifact(value: unknown, artifactId: string, sourceUrl: string): ArtifactView {
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

describe("Lever detection, region identity, and plans", () => {
  test("detects global and EU hosted/API URLs and rejects mixed or malformed candidates", () => {
    for (const [url, site] of [
      ["https://jobs.lever.co/acme", "acme"],
      [`https://jobs.eu.lever.co/acme/${postingId}`, "acme"],
      ["https://api.lever.co/v0/postings/acme?mode=json", "acme"],
      [`https://api.eu.lever.co/v0/postings/acme/${postingId}`, "acme"],
    ] as const) expect(leverConnector.detect(new URL(url))).toMatchObject({ detected: true, connectorId: "lever", tenantKey: site, confidence: 1 });
    for (const url of ["http://jobs.lever.co/acme", "https://jobs.lever.co:8443/acme", "https://user:pass@jobs.lever.co/acme", "https://api.lever.co/v1/postings/acme", "https://api.lever.co/v0/postings/acme/not-a-uuid", "https://jobs.lever.co/acme/not-a-uuid", "https://jobs.lever.co/%2fescape"]) {
      expect(leverConnector.detect(new URL(url))).toMatchObject({ detected: false });
    }
  });

  test("binds tenant and region and emits exact JSON pagination/detail plans", () => {
    expect(validateLeverSource(globalSource).region).toBe("global");
    expect(validateLeverSource(euSource).region).toBe("eu");
    expect(() => validateLeverSource({ ...globalSource, boardUrl: euSource.boardUrl })).toThrow(LeverConnectorError);
    expect(() => validateLeverSource({ ...globalSource, boardUrl: `https://jobs.lever.co/acme/${postingId}` })).toThrow(LeverConnectorError);
    expect(() => validateLeverSource({ ...euSource, apiBaseUrl: globalSource.apiBaseUrl })).toThrow(LeverConnectorError);
    expect(leverConnector.planEnumeration(globalSource)).toEqual({ requests: [{ url: "https://api.lever.co/v0/postings/acme?mode=json&skip=0&limit=100", method: "GET", accept: "application/json" }] });
    expect(leverConnector.planEnumeration(euSource, "100")).toEqual({ requests: [{ url: "https://api.eu.lever.co/v0/postings/acme?mode=json&skip=100&limit=100", method: "GET", accept: "application/json", pageToken: "100" }] });
    expect(() => leverConnector.planEnumeration(globalSource, "1")).toThrow("lever_cursor_invalid");
    const item = { sourceJobId: postingId } as EnumeratedListing;
    expect(leverConnector.planDetails(euSource, item)).toEqual({ requests: [{ url: `https://api.eu.lever.co/v0/postings/acme/${postingId}`, method: "GET", accept: "application/json" }] });
  });
});

describe("Lever frozen contract and pagination corpus", () => {
  test("passes exact expected outputs twice and keeps shadow output path-specific", async () => {
    const { manifest, cases } = await loadFixtures();
    expect(manifest.connectorVersion).toBe(LEVER_CONNECTOR_VERSION);
    expect(manifest.provenance.licenseReviewed).toBe(true);
    const first = await Promise.all(cases.map((fixture) => runFrozenFixture(leverConnector, fixture)));
    const second = await Promise.all(cases.map((fixture) => runFrozenFixture(leverConnector, fixture)));
    expect(first.map((result) => [result.caseId, result.passed, result.differences])).toEqual(cases.map((fixture) => [fixture.caseId, true, []]));
    expect(second).toEqual(first);
    const diffs = await runShadowDiff(createLeverConnector("1.0.0"), createLeverConnector("1.1.0"), cases.filter((fixture) => fixture.operation === "listing"));
    expect(diffs[0]!.differences.map((difference) => difference.path)).toContain("$.value.title.extractorVersion");
  });

  test("marks full pages incomplete, advances exact cursors, and completes the terminal empty page", async () => {
    const postings = Array.from({ length: LEVER_PAGE_SIZE }, (_, index) => {
      const id = `00000000-0000-4000-8000-${String(index).padStart(12, "0")}`;
      return { id, text: `Role ${index}`, categories: { location: "Remote" }, description: "Work", hostedUrl: `https://jobs.lever.co/acme/${id}`, applyUrl: `https://jobs.lever.co/acme/${id}/apply` };
    });
    const firstArtifact = memoryArtifact(postings, "lever-page-0", "https://api.lever.co/v0/postings/acme?mode=json&skip=0&limit=100");
    const first = await leverConnector.parseEnumeration([firstArtifact]);
    expect(first).toMatchObject({ complete: false, completenessReason: "pagination_incomplete", nextPageToken: "100" });
    expect(first.listings).toHaveLength(100);
    const lastArtifact = memoryArtifact([], "lever-page-100", "https://api.lever.co/v0/postings/acme?mode=json&skip=100&limit=100");
    expect(() => leverConnector.parseEnumeration([lastArtifact])).toThrow("lever_source_invalid");
    const complete = await leverConnector.parseEnumeration([firstArtifact, lastArtifact]);
    expect(complete).toMatchObject({ complete: true, completenessReason: "complete" });
    expect(complete.listings).toHaveLength(100);
    expect(complete.responseArtifacts).toEqual(["lever-page-0", "lever-page-100"]);
  });

  test("fails closed on duplicate, cross-region, and endpoint identity drift", async () => {
    const valid = JSON.parse(await readFile(join(fixtureRoot, "list-valid.json"), "utf8")) as unknown[];
    const duplicate = await leverConnector.parseEnumeration([memoryArtifact([valid[0], valid[0]], "lever-duplicate", "https://api.lever.co/v0/postings/acme?mode=json&skip=0&limit=100")]);
    expect(duplicate).toMatchObject({ complete: false, completenessReason: "schema_invalid" });
    const crossRegion = await leverConnector.parseEnumeration([memoryArtifact(valid, "lever-cross-region", "https://api.eu.lever.co/v0/postings/acme?mode=json&skip=0&limit=100")]);
    expect(crossRegion).toMatchObject({ listings: [], complete: false, completenessReason: "schema_invalid" });
    const listArtifact = await artifact("list-valid.json", "lever-list", "https://api.lever.co/v0/postings/acme?mode=json&skip=0&limit=100");
    expect(() => leverConnector.parseEnumeration([{ ...listArtifact, sourceUrl: "https://api.lever.co/v0/postings/acme?mode=json&skip=0&limit=10" }])).toThrow("lever_source_invalid");
    expect(() => leverConnector.parseEnumeration([listArtifact, listArtifact])).toThrow("lever_artifact_count");
  });
});

class FakeTransport implements SafeFetchTransport {
  readonly requests: TransportRequest[] = [];
  constructor(private readonly responses: readonly TransportResponse[]) {}
  async request(request: TransportRequest): Promise<TransportResponse> { this.requests.push(request); return this.responses[this.requests.length - 1]!; }
}

describe("Lever safe-fetch integration", () => {
  test("executes only the planned regional host and retains redirect decisions", async () => {
    const body = new Uint8Array(await readFile(join(fixtureRoot, "list-valid.json")));
    const transport = new FakeTransport([
      { status: 302, headers: { location: "/v0/postings/acme?mode=json&skip=0&limit=100" }, body: new Uint8Array(), remoteAddress: "93.184.216.34" },
      { status: 200, headers: { "content-type": "application/json" }, body, remoteAddress: "93.184.216.34" },
    ]);
    const decisions: SafeFetchDecision[] = [];
    const policy: SafeFetchPolicy = { id: "lever-global-public", allowedHosts: ["api.lever.co"], allowedContentTypes: ["application/json"], maxRequestsPerMinute: 10, maxConcurrency: 1, maxRedirects: 1, timeoutMs: 1_000, maxWireBytes: 1_000_000, maxResponseBytes: 1_000_000, userAgent: "CareerOS-Connector-Test/1.0" };
    const fetcher = new SafeFetchClient({ transport, resolve: async () => [{ address: "93.184.216.34", family: 4 }], onDecision: (decision) => decisions.push(decision) });
    const request = leverConnector.planEnumeration(globalSource).requests[0]!;
    const fetched = await fetcher.fetch({ url: new URL(request.url), accept: request.accept, policy });
    const parsed = await leverConnector.parseEnumeration([{ artifactId: "lever-integration", digest: createHash("sha256").update(fetched.bytes).digest("hex"), contentType: fetched.contentType, sourceUrl: fetched.finalUrl.href, fetchedAt: "2026-08-28T00:00:00.000Z", bytes: new Uint8Array(fetched.bytes) }]);
    expect(parsed.complete).toBe(true);
    expect(transport.requests).toHaveLength(2);
    expect(transport.requests.every((sent) => sent.url.hostname === "api.lever.co")).toBe(true);
    expect(decisions.map((decision) => decision.outcome)).toEqual(["allowed", "redirected", "allowed", "succeeded"]);
  });
});
