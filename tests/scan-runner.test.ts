import { describe, expect, test } from "bun:test";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { sha256, type ArtifactStore, type StoredArtifact, type StoredArtifactObject } from "../packages/artifact-store/src/index.ts";
import { greenhouseConnector } from "../packages/connectors/src/index.ts";
import type { CompleteScanInput, FailedScanInput, ScanCommitResult } from "../packages/db/src/index.ts";
import type { SafeFetchPort, SafeFetchRequest, SafeFetchResult } from "../packages/safe-fetch/src/index.ts";
import { SimulatedWorkerCrash, SourceScanRunner, type ScanArtifactCatalog, type ScanLedgerPort } from "../apps/worker/src/scan-runner.ts";

class MemoryArtifacts implements ArtifactStore {
  readonly objects = new Map<string, Uint8Array>();
  async put(bytes: Uint8Array, contentType: string): Promise<StoredArtifact> {
    const digest = sha256(bytes);
    const created = !this.objects.has(digest);
    this.objects.set(digest, new Uint8Array(bytes));
    return { digest, byteLength: bytes.byteLength, contentType, storageKey: `sha256/${digest.slice(0, 2)}/${digest}`, created };
  }
  async get(digest: string): Promise<Uint8Array | null> { return this.objects.get(digest) ?? null; }
  async has(digest: string): Promise<boolean> { return this.objects.has(digest); }
  async delete(digest: string): Promise<"deleted" | "absent"> { return this.objects.delete(digest) ? "deleted" : "absent"; }
  async list(): Promise<StoredArtifactObject[]> { return [...this.objects].map(([digest, bytes]) => ({ digest, byteLength: bytes.byteLength, modifiedAt: new Date(0) })); }
}

class MemoryCatalog implements ScanArtifactCatalog {
  readonly ids = new Map<string, string>();
  async record(input: Parameters<ScanArtifactCatalog["record"]>[0]): Promise<{ id: string }> {
    let id = this.ids.get(input.stored.digest);
    if (!id) { id = `artifact-${this.ids.size + 1}`; this.ids.set(input.stored.digest, id); }
    return { id };
  }
}

class MemoryLedger implements ScanLedgerPort {
  commitInput?: CompleteScanInput;
  failInput?: FailedScanInput;
  async commit(input: CompleteScanInput): Promise<ScanCommitResult> {
    if (this.commitInput) return { scanId: "scan-1", observationCount: 1, versionCount: 1, replayed: true };
    this.commitInput = input;
    return { scanId: "scan-1", observationCount: input.observations.length, versionCount: input.observations.length, replayed: false };
  }
  async fail(input: FailedScanInput): Promise<ScanCommitResult> {
    this.failInput = input;
    return { scanId: "failed-scan-1", observationCount: 0, versionCount: 0, replayed: false };
  }
}

async function fixture(name: string): Promise<Uint8Array> {
  return new Uint8Array(await readFile(join(import.meta.dir, "fixtures", "greenhouse", name)));
}

async function harness(hook?: "afterFetch" | "afterArtifacts" | "beforeCommit") {
  const list = await fixture("list-valid.json");
  const detail = await fixture("detail-valid-hostile.json");
  const fetcher: SafeFetchPort = {
    async fetch(request: SafeFetchRequest): Promise<SafeFetchResult> {
      const bytes = request.url.pathname.endsWith("/jobs") ? list : detail;
      return { bytes, contentType: "application/json", finalUrl: request.url, status: 200, headers: { "content-type": "application/json" }, decisions: [] };
    },
  };
  const artifacts = new MemoryArtifacts();
  const catalog = new MemoryCatalog();
  const ledger = new MemoryLedger();
  let crash = hook !== undefined;
  const crashOnce = () => { if (crash) { crash = false; throw new SimulatedWorkerCrash("simulated abrupt stop"); } };
  const runner = new SourceScanRunner(fetcher, artifacts, catalog, ledger, hook ? { [hook]: crashOnce } : {}, () => new Date("2026-08-28T12:00:00.000Z"));
  const input = {
    lease: { id: crypto.randomUUID(), leaseToken: crypto.randomUUID(), leaseGeneration: 1 }, workerId: "scan-test-worker",
    source: { sourceId: "source-1", connectorId: "greenhouse" as const, tenantKey: "acme", boardUrl: "https://job-boards.greenhouse.io/acme", apiBaseUrl: "https://boards-api.greenhouse.io/v1/boards/acme", region: "global" as const, policyId: "policy-1" },
    connector: greenhouseConnector,
    policy: { id: "policy-1", allowedHosts: ["boards-api.greenhouse.io"], allowedContentTypes: ["application/json"], maxRequestsPerMinute: 60, maxConcurrency: 2, maxRedirects: 2, timeoutMs: 5_000, maxWireBytes: 1_000_000, maxResponseBytes: 1_000_000, userAgent: "Career OS test" },
    safeFetchPolicyVersion: "1.0.0", retentionClass: "standard",
  };
  return { runner, input, artifacts, catalog, ledger };
}

describe("source scan orchestration", () => {
  test("persists artifact-backed observations and retains reproducibility metadata", async () => {
    const context = await harness();
    const result = await context.runner.run(context.input);
    expect(result).toMatchObject({ observationCount: 1, versionCount: 1, replayed: false });
    expect(context.ledger.commitInput).toMatchObject({ connectorId: "greenhouse", connectorVersion: "1.0.0", safeFetchPolicyVersion: "1.0.0", completenessReason: "complete" });
    expect(context.ledger.commitInput?.responseArtifactIds).toHaveLength(2);
    expect(context.ledger.commitInput?.observations[0]).toMatchObject({ sourceJobId: "101", parserVersion: "1.0.0", normalizerVersion: "1.0.0", taxonomyVersion: "1.0.0" });
    expect(context.ledger.failInput).toBeUndefined();
  });

  for (const point of ["afterFetch", "afterArtifacts", "beforeCommit"] as const) {
    test(`retries idempotently after an abrupt crash ${point}`, async () => {
      const context = await harness(point);
      await expect(context.runner.run(context.input)).rejects.toBeInstanceOf(SimulatedWorkerCrash);
      expect(context.ledger.commitInput).toBeUndefined();
      const result = await context.runner.run(context.input);
      expect(result).toMatchObject({ observationCount: 1, replayed: false });
      expect(context.catalog.ids.size).toBe(2);
      expect(context.artifacts.objects.size).toBe(2);
    });
  }

  test("classifies and redacts connector failures before persistence", async () => {
    const context = await harness();
    context.input.connector = { ...greenhouseConnector, parseListing() { throw new Error("greenhouse_schema_invalid?token=DO-NOT-PERSIST"); } };
    await context.runner.run(context.input);
    expect(context.ledger.failInput).toMatchObject({ reason: "schema_invalid", errorCode: "source_schema_invalid", retryable: false });
    expect(JSON.stringify(context.ledger.failInput)).not.toContain("DO-NOT-PERSIST");
  });

  test("bounds pagination before an untrusted source can amplify fetch work", async () => {
    const context = await harness();
    context.input.connector = {
      ...greenhouseConnector,
      planEnumeration(source) { return greenhouseConnector.planEnumeration(source); },
      parseEnumeration(artifacts) {
        return { listings: [], complete: false, completenessReason: "pagination_incomplete", nextPageToken: String(artifacts.length), responseArtifacts: [artifacts.at(-1)!.artifactId], connectorVersion: "1.0.0" };
      },
    };
    await context.runner.run(context.input);
    expect(context.ledger.failInput).toMatchObject({ reason: "limit_exceeded", errorCode: "resource_limit_exceeded", retryable: true });
    expect(context.ledger.failInput?.responseArtifactIds).toHaveLength(100);
    expect(new Set(context.ledger.failInput?.responseArtifactIds).size).toBe(1);
  });
});
