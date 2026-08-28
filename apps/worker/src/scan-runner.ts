import { createHash } from "node:crypto";
import type { ArtifactStore, StoredArtifact } from "@career-os/artifact-store";
import type { ArtifactView, ParsedListing, SourceConnector, SourceDescriptor } from "@career-os/connector-sdk";
import { validateParsedListingEvidence } from "@career-os/connector-sdk";
import type { SafeFetchPolicy, SafeFetchPort, SafeFetchResult } from "@career-os/safe-fetch";
import type { CompleteScanInput, FailedScanInput, ListingObservationInput, ScanCommitResult, ScanLease } from "@career-os/db";

// Kept local to the worker: only this composition root may combine network, artifact, parser, and database capabilities.
export interface ScanArtifactCatalog {
  record(input: {
    stored: StoredArtifact;
    metadata: { canonicalSourceUrl: string; responseHeaders?: Record<string, string> };
    retrievedAt: Date;
    statusCode?: number;
    policyId?: string;
    retentionClass: string;
  }): Promise<{ id: string }>;
}

export interface ScanLedgerPort {
  commit(input: CompleteScanInput): Promise<ScanCommitResult>;
  fail(input: FailedScanInput): Promise<ScanCommitResult>;
}

export interface ScanRunnerHooks {
  afterFetch?(): void | Promise<void>;
  afterArtifacts?(): void | Promise<void>;
  beforeCommit?(): void | Promise<void>;
}

export interface RunSourceScanInput {
  lease: ScanLease;
  workerId: string;
  source: SourceDescriptor;
  connector: SourceConnector;
  policy: SafeFetchPolicy;
  safeFetchPolicyVersion: string;
  retentionClass: string;
  normalizerVersion: string;
  taxonomyVersion: string;
}

export class SimulatedWorkerCrash extends Error {}

class ScanExecutionError extends Error {
  constructor(readonly code: string) { super(code); }
}

const MAX_SCAN_RESPONSES = 100;

function hash(value: Uint8Array | string): string {
  return createHash("sha256").update(value).digest("hex");
}

function evidenceValues(parsed: ParsedListing): Record<string, unknown> {
  const output: Record<string, unknown> = {};
  for (const [name, evidence] of Object.entries(parsed)) {
    output[name] = evidence && typeof evidence === "object" && "value" in evidence ? evidence.value : evidence;
  }
  return output;
}

function classifiedFailure(error: unknown): Pick<FailedScanInput, "reason" | "errorCode" | "retryable"> {
  const code = typeof error === "object" && error !== null && "code" in error
    ? String((error as { code: unknown }).code).toLowerCase()
    : error instanceof Error ? error.message.toLowerCase() : "unknown_failure";
  const blocked = code.includes("blocked") || code.includes("forbidden") || code.includes("policy");
  const schema = code.includes("schema") || code.includes("parse") || code.includes("identity");
  const limit = code.includes("limit") || code.includes("too_large");
  const timeout = code.includes("timeout") || code.includes("timed_out");
  const normalized = blocked ? "source_blocked" : schema ? "source_schema_invalid"
    : limit ? "resource_limit_exceeded" : timeout ? "upstream_timeout" : "scan_failed";
  return {
    reason: blocked ? "blocked" : schema ? "schema_invalid" : limit ? "limit_exceeded" : "transport_failure",
    errorCode: normalized,
    retryable: !blocked && !schema,
  };
}

export class SourceScanRunner {
  constructor(
    private readonly fetcher: SafeFetchPort,
    private readonly artifacts: ArtifactStore,
    private readonly catalog: ScanArtifactCatalog,
    private readonly ledger: ScanLedgerPort,
    private readonly hooks: ScanRunnerHooks = {},
    private readonly now: () => Date = () => new Date(),
  ) {}

  async run(input: RunSourceScanInput): Promise<ScanCommitResult> {
    const startedAt = this.now();
    const views: ArtifactView[] = [];
    let byteCount = 0;
    try {
      let cursor: string | undefined;
      let enumeration;
      do {
        const plan = input.connector.planEnumeration(input.source, cursor);
        for (const request of plan.requests) {
          if (views.length >= MAX_SCAN_RESPONSES) throw new ScanExecutionError("scan_response_limit_exceeded");
          const fetched = await this.fetcher.fetch({ url: new URL(request.url), policy: input.policy, accept: request.accept });
          await this.hooks.afterFetch?.();
          views.push(await this.persist(fetched, input, byteCount));
          byteCount += fetched.bytes.byteLength;
          await this.hooks.afterArtifacts?.();
        }
        enumeration = await input.connector.parseEnumeration(views);
        cursor = enumeration.nextPageToken;
      } while (cursor);

      const observations: ListingObservationInput[] = [];
      for (const item of enumeration.listings) {
        const detailPlan = input.connector.planDetails(input.source, item);
        const evidenceArtifacts = detailPlan ? [] as ArtifactView[] : views;
        if (detailPlan) {
          for (const request of detailPlan.requests) {
            if (views.length >= MAX_SCAN_RESPONSES) throw new ScanExecutionError("scan_response_limit_exceeded");
            const fetched = await this.fetcher.fetch({ url: new URL(request.url), policy: input.policy, accept: request.accept });
            await this.hooks.afterFetch?.();
            const view = await this.persist(fetched, input, byteCount);
            byteCount += fetched.bytes.byteLength;
            views.push(view);
            evidenceArtifacts.push(view);
            await this.hooks.afterArtifacts?.();
          }
        }
        const parsed = await input.connector.parseListing(evidenceArtifacts, item);
        validateParsedListingEvidence(parsed, evidenceArtifacts);
        const normalized = evidenceValues(parsed);
        const rawDigest = evidenceArtifacts.find((artifact) => artifact.artifactId === parsed.canonicalSourceUrl.artifactId)?.digest
          ?? evidenceArtifacts[0]?.digest;
        if (!rawDigest) throw new Error("listing_artifact_missing");
        observations.push({
          sourceJobId: parsed.sourceJobId,
          canonicalSourceUrl: parsed.canonicalSourceUrl.value,
          applyUrl: parsed.applyUrl.value,
          artifactId: parsed.canonicalSourceUrl.artifactId,
          semanticFingerprint: hash(JSON.stringify(normalized)),
          rawFingerprint: rawDigest,
          parsedSource: parsed as unknown as Record<string, unknown>,
          normalizedCandidate: normalized,
          parserVersion: input.connector.version,
          normalizerVersion: input.normalizerVersion,
          taxonomyVersion: input.taxonomyVersion,
          sourcePostedAt: parsed.sourcePostedAt ? new Date(parsed.sourcePostedAt) : undefined,
          sourceUpdatedAt: parsed.sourceUpdatedAt ? new Date(parsed.sourceUpdatedAt) : undefined,
          validThrough: parsed.validThrough ? new Date(parsed.validThrough) : undefined,
        });
      }
      await this.hooks.beforeCommit?.();
      return this.ledger.commit({
        lease: input.lease, workerId: input.workerId, sourceId: input.source.sourceId,
        startedAt, endedAt: this.now(), connectorId: input.connector.id, connectorVersion: input.connector.version,
        safeFetchPolicyVersion: input.safeFetchPolicyVersion, policyId: input.source.policyId,
        fetchMetadata: { requestCount: views.length, status: "parsed" },
        completenessReason: enumeration.completenessReason, responseArtifactIds: views.map((view) => view.artifactId),
        observations, byteCount, boardHash: hash(observations.map((item) => item.semanticFingerprint).sort().join("\n")),
      });
    } catch (error) {
      if (error instanceof SimulatedWorkerCrash) throw error;
      return this.ledger.fail({
        lease: input.lease, workerId: input.workerId, sourceId: input.source.sourceId,
        startedAt, endedAt: this.now(), connectorId: input.connector.id, connectorVersion: input.connector.version,
        safeFetchPolicyVersion: input.safeFetchPolicyVersion, policyId: input.source.policyId,
        fetchMetadata: { requestCount: views.length, status: "failed" }, responseArtifactIds: views.map((view) => view.artifactId),
        byteCount, ...classifiedFailure(error),
      });
    }
  }

  private async persist(result: SafeFetchResult, input: RunSourceScanInput, _priorBytes: number): Promise<ArtifactView> {
    const stored = await this.artifacts.put(result.bytes, result.contentType);
    const fetchedAt = this.now();
    const record = await this.catalog.record({
      stored, metadata: { canonicalSourceUrl: result.finalUrl.href, responseHeaders: { ...result.headers } },
      retrievedAt: fetchedAt, statusCode: result.status, policyId: input.source.policyId, retentionClass: input.retentionClass,
    });
    return {
      artifactId: record.id, digest: stored.digest, contentType: result.contentType,
      sourceUrl: result.finalUrl.href, fetchedAt: fetchedAt.toISOString(), bytes: new Uint8Array(result.bytes),
    };
  }
}
