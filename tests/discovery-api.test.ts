import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  DiscoveryApiError, decodeCursor, encodeCursor, parseOpportunityFilters, parseProblemReport,
  projectLegacyJob, resolveLegacyExportPath, writeLegacyExport, type DiscoveryReadService, type PublicOpportunityItem,
} from "../packages/discovery-api/src/index.ts";
import { createApiServer } from "../apps/api/src/server.ts";
import type { RuntimeConfig } from "../packages/contracts/src/index.ts";

const opportunityId = "01900000-0000-7000-8000-000000000001";
const companyId = "01900000-0000-7000-8000-000000000002";
const item: PublicOpportunityItem = {
  id: opportunityId, company: { id: companyId, name: "Example", domain: "example.com" }, title: "Engineer",
  workplaceMode: "remote", remoteScope: { kind: "countries", countryCodes: ["DE"] }, locations: [{ countryCode: "DE", remoteEligible: true }], compensation: null,
  sourcePostedAt: null, firstSeenAt: "2026-08-01T00:00:00.000Z", lastVerifiedOpenAt: "2026-08-02T00:00:00.000Z",
  primaryApplyUrl: "https://jobs.example.com/1", sourceCount: 1, provenanceCoverage: 1, status: "active",
};
const config: RuntimeConfig = { profile: "test", host: "127.0.0.1", port: 0, artifactRoot: "./artifacts",
  security: { networkBoundary: "loopback", localOnly: true, publicBaseUrl: "http://127.0.0.1:4100",
    allowedOrigins: ["http://127.0.0.1:4100"], authenticationMode: "local", transportSecurity: "none", trustedProxyIps: [] } };
const servers: Array<{ stop(close?: boolean): void }> = [];
afterEach(() => { for (const server of servers.splice(0)) server.stop(true); });

describe("canonical discovery API contracts", () => {
  test("bounds filters and rejects ambiguous or unsupported query input", () => {
    expect(parseOpportunityFilters(new URLSearchParams("limit=100&country=de&visa=true"))).toMatchObject({ limit: 100, country: "DE", visa: true });
    for (const query of ["limit=101", "limit=0", "q=a&q=b", "offset=2", "sort=relevance", `q=${"x".repeat(201)}`]) {
      expect(() => parseOpportunityFilters(new URLSearchParams(query))).toThrow(DiscoveryApiError);
    }
  });

  test("uses versioned cursors bound to the normalized filter set", () => {
    const filters = parseOpportunityFilters(new URLSearchParams("q=engineer&sort=relevance&limit=2"));
    const cursor = encodeCursor("opportunities", filters, { primary: 0.75, id: opportunityId });
    expect(decodeCursor("opportunities", { ...filters, cursor })).toEqual({ primary: 0.75, id: opportunityId });
    expect(() => decodeCursor("opportunities", { ...filters, q: "designer", cursor })).toThrow("invalid_cursor");
    expect(() => decodeCursor("companies", { ...filters, cursor })).toThrow("invalid_cursor");
  });

  test("validates structured reports without granting a canonical mutation", () => {
    expect(parseProblemReport({ kind: "closed", detail: "Posting now returns 404" })).toEqual({ kind: "closed", detail: "Posting now returns 404", duplicateOpportunityId: undefined });
    expect(() => parseProblemReport({ kind: "duplicate" })).toThrow("duplicate_target_required");
    expect(() => parseProblemReport({ kind: "closed", candidateResume: "secret" })).toThrow("invalid_request");
  });

  test("produces a fit-neutral compatibility shape with no candidate fields", () => {
    const legacy = projectLegacyJob(item);
    expect(legacy).toMatchObject({ canonical_opportunity_id: opportunityId, fit: "unranked", projection_version: "career-os.jobs.v1" });
    expect(JSON.stringify(legacy)).not.toMatch(/resume|candidate|email|phone/iu);
  });

  test("contains explicit legacy export beneath its fixed root", async () => {
    const root = await mkdtemp(join(tmpdir(), "career-os-export-"));
    try {
      expect(() => resolveLegacyExportPath(root, "../seen_jobs.json")).toThrow("legacy_export_path_rejected");
      expect(() => resolveLegacyExportPath(root, "job_scraper/other.json")).toThrow("legacy_export_path_rejected");
      const output = await writeLegacyExport(root, [projectLegacyJob(item)]);
      expect(output.startsWith(root)).toBe(true);
      expect(JSON.parse(await readFile(output, "utf8"))).toHaveLength(1);
    } finally { await rm(root, { recursive: true, force: true }); }
  });

  test("serves bounded pages, detail, reports, and the deprecated one-way projection", async () => {
    const reports: unknown[] = [];
    const service: DiscoveryReadService = {
      async searchOpportunities() { return { items: [item], nextCursor: null }; },
      async searchCompanies() { return { items: [{ id: companyId, name: "Example", domain: "example.com", careersUrl: null, headquartersCountry: null }], nextCursor: null }; },
      async getOpportunity() { return { ...item, provenance: [], changeHistory: [], memberships: [] }; },
      async getCompany() { return { id: companyId, name: "Example", provenance: [] }; },
      async reportOpportunity(context, id, input) { reports.push({ context, id, input }); return { reportId: "01900000-0000-7000-8000-000000000003", state: "pending" }; },
    };
    const server = createApiServer(config, { discoveryService: service }); servers.push(server);
    const base = `http://127.0.0.1:${server.port}`;
    const page = await fetch(`${base}/api/v1/opportunities?limit=1`);
    expect(page.status).toBe(200); expect(page.headers.get("x-request-id")).toBeTruthy();
    expect((await page.json() as { items: unknown[] }).items).toHaveLength(1);
    const report = await fetch(`${base}/api/v1/opportunities/${opportunityId}/report`, { method: "POST",
      headers: { "content-type": "application/json", "idempotency-key": "report-key-0001", origin: "http://127.0.0.1:4100" }, body: JSON.stringify({ kind: "closed", detail: "This role has closed" }) });
    expect(report.status).toBe(202); expect(reports).toHaveLength(1);
    const legacy = await fetch(`${base}/api/jobs`);
    expect(legacy.headers.get("deprecation")).toBe("true");
    expect(JSON.stringify(await legacy.json())).not.toMatch(/candidate|resume/iu);
  });
});
