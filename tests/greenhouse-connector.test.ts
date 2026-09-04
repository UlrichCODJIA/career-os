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
  GREENHOUSE_CONNECTOR_VERSION,
  GreenhouseConnectorError,
  createGreenhouseConnector,
  greenhouseConnector,
  validateGreenhouseSource,
} from "../packages/connectors/src/index.ts";
import {
  SafeFetchClient,
  type SafeFetchDecision,
  type SafeFetchPolicy,
  type SafeFetchTransport,
  type TransportRequest,
  type TransportResponse,
} from "../packages/safe-fetch/src/index.ts";

const fixtureRoot = join(import.meta.dir, "fixtures", "greenhouse");

const source: SourceDescriptor = {
  sourceId: "source-acme",
  connectorId: "greenhouse",
  tenantKey: "acme",
  boardUrl: "https://job-boards.greenhouse.io/acme",
  apiBaseUrl: "https://boards-api.greenhouse.io/v1/boards/acme",
  region: "global",
  policyId: "greenhouse-public",
};

async function artifact(path: string, artifactId: string, sourceUrl: string): Promise<ArtifactView> {
  const bytes = new Uint8Array(await readFile(join(fixtureRoot, path)));
  return {
    artifactId,
    digest: createHash("sha256").update(bytes).digest("hex"),
    contentType: "application/json",
    sourceUrl,
    fetchedAt: "2026-08-28T00:00:00.000Z",
    bytes,
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
    const artifacts = await Promise.all(fixture.artifacts.map((descriptor) => artifact(descriptor.path, descriptor.artifactId, descriptor.sourceUrl)));
    cases.push(fixture.operation === "listing"
      ? { ...fixture, item: fixture.item as EnumeratedListing, artifacts }
      : { ...fixture, artifacts });
  }
  return { manifest, cases };
}

describe("Greenhouse detection and plans", () => {
  test("detects current, legacy, and API board-token URLs without accepting arbitrary career pages", () => {
    for (const url of [
      "https://job-boards.greenhouse.io/acme/jobs/101",
      "https://boards.greenhouse.io/acme",
      "https://boards-api.greenhouse.io/v1/boards/acme/jobs",
    ]) {
      expect(greenhouseConnector.detect(new URL(url))).toMatchObject({ detected: true, connectorId: "greenhouse", tenantKey: "acme", confidence: 1 });
    }
    expect(greenhouseConnector.detect(new URL("https://careers.acme.example/jobs"))).toEqual({ detected: false, connectorId: "greenhouse", confidence: 0, reason: "not_recognized" });
    expect(greenhouseConnector.detect(new URL("https://boards-api.greenhouse.io/v1/boards/acme/offices"))).toEqual({ detected: false, connectorId: "greenhouse", confidence: 0, reason: "not_recognized" });
    for (const url of ["http://boards.greenhouse.io/acme", "https://boards.greenhouse.io:8443/acme", "https://user:pass@boards.greenhouse.io/acme", "https://boards.greenhouse.io/%2fescape"]) {
      expect(greenhouseConnector.detect(new URL(url))).toMatchObject({ detected: false, reason: "invalid_candidate" });
    }
  });

  test("binds source identity to the fixed public API host and omits applicant questions", () => {
    expect(validateGreenhouseSource(source).tenantKey).toBe("acme");
    expect(() => validateGreenhouseSource({ ...source, apiBaseUrl: "https://evil.example/v1/boards/acme" })).toThrow(GreenhouseConnectorError);
    expect(() => validateGreenhouseSource({ ...source, boardUrl: "https://job-boards.greenhouse.io/other" })).toThrow(GreenhouseConnectorError);
    expect(() => validateGreenhouseSource({ ...source, boardUrl: "https://user:pass@job-boards.greenhouse.io/acme" })).toThrow(GreenhouseConnectorError);
    expect(greenhouseConnector.planEnumeration(source)).toEqual({ requests: [{ url: "https://boards-api.greenhouse.io/v1/boards/acme/jobs", method: "GET", accept: "application/json" }] });
    const item = { sourceJobId: "101", canonicalSourceUrl: "https://job-boards.greenhouse.io/acme/jobs/101" } as EnumeratedListing;
    const detail = greenhouseConnector.planDetails(source, item);
    expect(detail).toEqual({ requests: [{ url: "https://boards-api.greenhouse.io/v1/boards/acme/jobs/101?pay_transparency=true", method: "GET", accept: "application/json" }] });
    expect(JSON.stringify(detail)).not.toContain("questions");
    expect(() => greenhouseConnector.planEnumeration(source, "unexpected-page")).toThrow("greenhouse_cursor_unsupported");
  });
});

describe("Greenhouse frozen contract corpus", () => {
  test("passes every versioned expected output and remains idempotent", async () => {
    const { manifest, cases } = await loadFixtures();
    expect(manifest.connectorVersion).toBe(GREENHOUSE_CONNECTOR_VERSION);
    expect(manifest.provenance.licenseReviewed).toBe(true);
    const first = await Promise.all(cases.map((fixture) => runFrozenFixture(greenhouseConnector, fixture)));
    const second = await Promise.all(cases.map((fixture) => runFrozenFixture(greenhouseConnector, fixture)));
    expect(first.map((result) => [result.caseId, result.passed, result.differences])).toEqual(cases.map((fixture) => [fixture.caseId, true, []]));
    expect(second).toEqual(first);
  });

  test("keeps future release diffs path-specific and non-mutating", async () => {
    const { cases } = await loadFixtures();
    const selected = cases.filter((fixture) => fixture.caseId === "greenhouse-valid-hostile-detail");
    const diffs = await runShadowDiff(createGreenhouseConnector("1.0.0"), createGreenhouseConnector("1.1.0"), selected);
    expect(diffs[0]!.changed).toBe(true);
    expect(diffs[0]!.differences.map((difference) => difference.path)).toContain("$.value.title.extractorVersion");
  });

  test("rejects cross-artifact identity and ambiguous artifact sets", async () => {
    const listArtifact = await artifact("list-valid.json", "gh-list", "https://boards-api.greenhouse.io/v1/boards/acme/jobs");
    const enumeration = await greenhouseConnector.parseEnumeration([listArtifact]);
    const detailArtifact = await artifact("detail-valid-hostile.json", "gh-detail", "https://boards-api.greenhouse.io/v1/boards/acme/jobs/101?pay_transparency=true");
    expect(() => greenhouseConnector.parseListing([detailArtifact], { ...enumeration.listings[0]!, canonicalSourceUrl: "https://job-boards.greenhouse.io/acme/jobs/999" })).toThrow("greenhouse_identity_mismatch");
    expect(() => greenhouseConnector.parseEnumeration([listArtifact, listArtifact])).toThrow("greenhouse_artifact_count");
    expect(await greenhouseConnector.parseEnumeration([{ ...listArtifact, sourceUrl: "https://boards-api.greenhouse.io/v1/boards/other/jobs" }])).toMatchObject({ listings: [], complete: false, completenessReason: "schema_invalid" });
    expect(() => greenhouseConnector.parseEnumeration([{ ...listArtifact, sourceUrl: "https://boards-api.greenhouse.io/v1/boards/acme/offices" }])).toThrow("greenhouse_source_invalid");
  });

  test("treats duplicate source IDs as an incomplete scan", async () => {
    const duplicateBody = new TextEncoder().encode(JSON.stringify({
      jobs: [
        { id: 101, internal_job_id: 5001, title: "Engineer", updated_at: "2026-08-28T08:00:00Z", location: { name: "Remote" }, absolute_url: "https://job-boards.greenhouse.io/acme/jobs/101" },
        { id: 101, internal_job_id: 5001, title: "Engineer copy", updated_at: "2026-08-28T08:00:00Z", location: { name: "Remote" }, absolute_url: "https://job-boards.greenhouse.io/acme/jobs/101" },
      ],
      meta: { total: 2 },
    }));
    const duplicateArtifact: ArtifactView = {
      artifactId: "gh-duplicate",
      digest: createHash("sha256").update(duplicateBody).digest("hex"),
      contentType: "application/json",
      sourceUrl: "https://boards-api.greenhouse.io/v1/boards/acme/jobs",
      fetchedAt: "2026-08-28T00:00:00.000Z",
      bytes: duplicateBody,
    };
    expect(await greenhouseConnector.parseEnumeration([duplicateArtifact])).toMatchObject({
      listings: [{ sourceJobId: "101" }],
      complete: false,
      completenessReason: "schema_invalid",
    });
  });

  test("rejects off-tenant and wrong-job application URLs", async () => {
    const listArtifact = await artifact("list-valid.json", "gh-list", "https://boards-api.greenhouse.io/v1/boards/acme/jobs");
    const body = JSON.parse(new TextDecoder().decode(listArtifact.bytes));
    for (const absoluteUrl of [
      "https://phishing.example/apply/101",
      "https://job-boards.greenhouse.io/other/jobs/101",
      "https://job-boards.greenhouse.io/acme/jobs/999",
      "https://job-boards.greenhouse.io/acme/jobs/101?gh_src=attacker",
    ]) {
      const bytes = new TextEncoder().encode(JSON.stringify({ ...body, jobs: [{ ...body.jobs[0], absolute_url: absoluteUrl }] }));
      const parsed = await greenhouseConnector.parseEnumeration([{ ...listArtifact, digest: createHash("sha256").update(bytes).digest("hex"), bytes }]);
      expect(parsed).toMatchObject({ complete: false, completenessReason: "schema_invalid" });
    }
  });
});

class FakeTransport implements SafeFetchTransport {
  readonly requests: TransportRequest[] = [];
  constructor(private readonly responses: readonly TransportResponse[]) {}
  async request(request: TransportRequest): Promise<TransportResponse> {
    this.requests.push(request);
    return this.responses[this.requests.length - 1]!;
  }
}

describe("Greenhouse safe-fetch integration", () => {
  test("executes only the planned API request and retains redirect decisions", async () => {
    const body = new Uint8Array(await readFile(join(fixtureRoot, "list-valid.json")));
    const transport = new FakeTransport([
      { status: 302, headers: { location: "/v1/boards/acme/jobs" }, body: new Uint8Array(), remoteAddress: "93.184.216.34" },
      { status: 200, headers: { "content-type": "application/json" }, body, remoteAddress: "93.184.216.34" },
    ]);
    const decisions: SafeFetchDecision[] = [];
    const policy: SafeFetchPolicy = {
      id: "greenhouse-public",
      allowedHosts: ["boards-api.greenhouse.io"],
      allowedContentTypes: ["application/json"],
      maxRequestsPerMinute: 10,
      maxConcurrency: 1,
      maxRedirects: 1,
      timeoutMs: 1_000,
      maxWireBytes: 1_000_000,
      maxResponseBytes: 1_000_000,
      userAgent: "CareerOS-Connector-Test/1.0",
    };
    const fetcher = new SafeFetchClient({ transport, resolve: async () => [{ address: "93.184.216.34", family: 4 }], onDecision: (decision) => decisions.push(decision) });
    const request = greenhouseConnector.planEnumeration(source).requests[0]!;
    const fetched = await fetcher.fetch({ url: new URL(request.url), accept: request.accept, policy });
    const parsed = await greenhouseConnector.parseEnumeration([{
      artifactId: "integration-list",
      digest: createHash("sha256").update(fetched.bytes).digest("hex"),
      contentType: fetched.contentType,
      sourceUrl: fetched.finalUrl.href,
      fetchedAt: "2026-08-28T00:00:00.000Z",
      bytes: new Uint8Array(fetched.bytes),
    }]);
    expect(parsed.complete).toBe(true);
    expect(transport.requests).toHaveLength(2);
    expect(transport.requests.every((sent) => sent.url.hostname === "boards-api.greenhouse.io")).toBe(true);
    expect(decisions.map((decision) => decision.outcome)).toEqual(["allowed", "redirected", "allowed", "succeeded"]);
  });
});
