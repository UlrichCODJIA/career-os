import { createHash } from "node:crypto";
import type { ArtifactStore, StoredArtifact } from "@career-os/artifact-store";
import type { ArtifactView, ParsedListing, SourceConnector, SourceDescriptor } from "@career-os/connector-sdk";
import { validateParsedListingEvidence } from "@career-os/connector-sdk";
import type { SafeFetchPolicy, SafeFetchPort, SafeFetchResult } from "@career-os/safe-fetch";
import type { CompleteScanInput, FailedScanInput, ListingObservationInput, ScanCommitResult, ScanLease } from "@career-os/db";
import { normalizeParsedListing } from "@career-os/normalization";
import {
  childCorrelation,
  createCorrelationContext,
  durationBucket,
  type CorrelationContext,
  type ProductEventSink,
  type StructuredLogger,
} from "@career-os/observability";

// Kept local to the worker: only this composition root may combine network, artifact, parser, and database capabilities.
export interface ScanArtifactCatalog {
  record(input: {
    stored: StoredArtifact;
    metadata: { canonicalSourceUrl: string; responseHeaders?: Record<string, string> };
    retrievedAt: Date;
    statusCode?: number;
    policyId?: string;
    retentionClass: string;
    deletionDueAt: Date;
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

export interface ScanTelemetry {
  logger: StructuredLogger;
  productEvents: ProductEventSink;
}

export interface RunSourceScanInput {
  lease: ScanLease;
  workerId: string;
  source: SourceDescriptor;
  connector: SourceConnector;
  policy: SafeFetchPolicy;
  safeFetchPolicyVersion: string;
  retentionClass: string;
}

export class SimulatedWorkerCrash extends Error {}

class ScanExecutionError extends Error {
  constructor(readonly code: string) { super(code); }
}

const MAX_SCAN_RESPONSES = 100;
const RETENTION_MILLISECONDS: Readonly<Record<string, number>> = Object.freeze({
  standard: 30 * 24 * 60 * 60_000,
  "licensed-ephemeral": 24 * 60 * 60_000,
  verification: 60 * 60_000,
});

function deletionDeadline(retentionClass: string, retrievedAt: Date): Date {
  const duration = RETENTION_MILLISECONDS[retentionClass];
  if (!duration) throw new ScanExecutionError("unsupported_retention_policy");
  return new Date(retrievedAt.getTime() + duration);
}

function requirePlannedResponse(requestedUrl: string, result: SafeFetchResult): void {
  if (result.finalUrl.href !== new URL(requestedUrl).href) {
    throw new ScanExecutionError("source_identity_redirect");
  }
}

function hash(value: Uint8Array | string): string {
  return createHash("sha256").update(value).digest("hex");
}

function rawErrorCode(error: unknown): string {
  return typeof error === "object" && error !== null && "code" in error
    ? String((error as { code: unknown }).code).toLowerCase()
    : error instanceof Error ? error.message.toLowerCase() : "unknown_failure";
}

function classifiedFailure(error: unknown): Pick<FailedScanInput, "reason" | "errorCode" | "retryable"> {
  const code = rawErrorCode(error);
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

const SSRF_REJECTION_CODES = new Set([
  "credentials_forbidden", "dns_non_public_answer", "fragment_forbidden", "host_not_allowed",
  "https_required", "literal_ip_forbidden", "port_not_allowed",
]);

export class SourceScanRunner {
  constructor(
    private readonly fetcher: SafeFetchPort,
    private readonly artifacts: ArtifactStore,
    private readonly catalog: ScanArtifactCatalog,
    private readonly ledger: ScanLedgerPort,
    private readonly hooks: ScanRunnerHooks = {},
    private readonly now: () => Date = () => new Date(),
    private readonly telemetry?: ScanTelemetry,
  ) {}

  async run(input: RunSourceScanInput): Promise<ScanCommitResult> {
    const startedAt = this.now();
    const correlation = createCorrelationContext({
      workJobId: input.lease.id,
      sourceId: input.source.sourceId,
      connectorId: input.connector.id,
      connectorVersion: input.connector.version,
    });
    this.telemetry?.logger.record("scan_started", { attempt: input.lease.leaseGeneration }, correlation);
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
          requirePlannedResponse(request.url, fetched);
          await this.hooks.afterFetch?.();
          views.push(await this.persist(fetched, request.url, input, correlation));
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
            requirePlannedResponse(request.url, fetched);
            await this.hooks.afterFetch?.();
            const view = await this.persist(fetched, request.url, input, correlation);
            byteCount += fetched.bytes.byteLength;
            views.push(view);
            evidenceArtifacts.push(view);
            await this.hooks.afterArtifacts?.();
          }
        }
        const parsed = await input.connector.parseListing(evidenceArtifacts, item);
        validateParsedListingEvidence(parsed, evidenceArtifacts);
        const normalized = normalizeParsedListing(parsed);
        const rawDigest = evidenceArtifacts.find((artifact) => artifact.artifactId === parsed.canonicalSourceUrl.artifactId)?.digest
          ?? evidenceArtifacts[0]?.digest;
        if (!rawDigest) throw new Error("listing_artifact_missing");
        observations.push({
          sourceJobId: parsed.sourceJobId,
          canonicalSourceUrl: parsed.canonicalSourceUrl.value,
          applyUrl: parsed.applyUrl.value,
          artifactId: parsed.canonicalSourceUrl.artifactId,
          semanticFingerprint: normalized.semanticFingerprint,
          rawFingerprint: rawDigest,
          parsedSource: parsed as unknown as Record<string, unknown>,
          normalizedCandidate: normalized.candidate as unknown as Record<string, unknown>,
          parserVersion: input.connector.version,
          normalizerVersion: normalized.normalizerVersion,
          taxonomyVersion: normalized.taxonomyVersion,
          assertions: normalized.assertions,
          sourcePostedAt: parsed.sourcePostedAt ? new Date(parsed.sourcePostedAt) : undefined,
          sourceUpdatedAt: parsed.sourceUpdatedAt ? new Date(parsed.sourceUpdatedAt) : undefined,
          validThrough: parsed.validThrough ? new Date(parsed.validThrough) : undefined,
        });
      }
      await this.hooks.beforeCommit?.();
      const result = await this.ledger.commit({
        lease: input.lease, workerId: input.workerId, sourceId: input.source.sourceId,
        startedAt, endedAt: this.now(), connectorId: input.connector.id, connectorVersion: input.connector.version,
        safeFetchPolicyVersion: input.safeFetchPolicyVersion, policyId: input.source.policyId,
        fetchMetadata: { requestCount: views.length, status: "parsed" },
        completenessReason: enumeration.completenessReason, responseArtifactIds: views.map((view) => view.artifactId),
        observations, byteCount, boardHash: hash(JSON.stringify({
          sourceId: input.source.sourceId,
          tenantKey: input.source.tenantKey,
          artifacts: views.map((view) => view.digest),
          observations: observations.map((item) => item.semanticFingerprint).sort(),
        })),
      });
      const completed = childCorrelation(correlation, { scanId: result.scanId });
      const duration = this.now().getTime() - startedAt.getTime();
      this.telemetry?.logger.record("scan_completed", {
        completenessReason: enumeration.completenessReason,
        observationCount: result.observationCount,
        responseCount: views.length,
        byteCount,
        replayed: result.replayed,
        durationMs: duration,
      }, completed);
      await this.captureProductEvent("source scan completed", {
        connector_id: input.connector.id,
        outcome: "completed",
        completeness_reason: enumeration.completenessReason,
        observation_count: result.observationCount,
        duration_bucket: durationBucket(duration),
        replayed: result.replayed,
      });
      return result;
    } catch (error) {
      if (error instanceof SimulatedWorkerCrash) throw error;
      const failure = classifiedFailure(error);
      const rejectedCode = rawErrorCode(error);
      if (SSRF_REJECTION_CODES.has(rejectedCode)) {
        this.telemetry?.logger.record("ssrf_request_rejected", { reasonCode: rejectedCode }, correlation, "warn");
      }
      const result = await this.ledger.fail({
        lease: input.lease, workerId: input.workerId, sourceId: input.source.sourceId,
        startedAt, endedAt: this.now(), connectorId: input.connector.id, connectorVersion: input.connector.version,
        safeFetchPolicyVersion: input.safeFetchPolicyVersion, policyId: input.source.policyId,
        fetchMetadata: { requestCount: views.length, status: "failed" }, responseArtifactIds: views.map((view) => view.artifactId),
        byteCount, ...failure,
      });
      const failed = childCorrelation(correlation, { scanId: result.scanId });
      const duration = this.now().getTime() - startedAt.getTime();
      this.telemetry?.logger.record("scan_failed", {
        errorCode: failure.errorCode,
        retryable: failure.retryable,
        responseCount: views.length,
        byteCount,
        durationMs: duration,
      }, failed, "error");
      await this.captureProductEvent("source scan failed", {
        connector_id: input.connector.id,
        outcome: "failed",
        error_code: failure.errorCode,
        retryable: failure.retryable,
        duration_bucket: durationBucket(duration),
      });
      return result;
    }
  }

  private async persist(result: SafeFetchResult, requestedUrl: string, input: RunSourceScanInput, correlation: CorrelationContext): Promise<ArtifactView> {
    const stored = await this.artifacts.put(result.bytes, result.contentType);
    const fetchedAt = this.now();
    const record = await this.catalog.record({
      stored, metadata: { canonicalSourceUrl: result.finalUrl.href, responseHeaders: { ...result.headers } },
      retrievedAt: fetchedAt, statusCode: result.status, policyId: input.source.policyId, retentionClass: input.retentionClass,
      deletionDueAt: deletionDeadline(input.retentionClass, fetchedAt),
    });
    this.telemetry?.logger.record("scan_artifact_recorded", {
      digest: stored.digest,
      byteCount: stored.byteLength,
      mediaType: stored.contentType,
      statusCode: result.status,
    }, childCorrelation(correlation, { artifactId: record.id }));
    return {
      artifactId: record.id, digest: stored.digest, contentType: result.contentType,
      // Parsers validate against the reviewed request identity. A same-host
      // redirect is transport metadata, not authority to switch ATS tenants.
      sourceUrl: requestedUrl, fetchedAt: fetchedAt.toISOString(), bytes: new Uint8Array(result.bytes),
    };
  }

  private async captureProductEvent(name: Parameters<ProductEventSink["capture"]>[0], properties: Parameters<ProductEventSink["capture"]>[1]): Promise<void> {
    try { await this.telemetry?.productEvents.capture(name, properties); }
    catch {
      // Analytics is deliberately best-effort and must never change discovery truth or retry semantics.
    }
  }
}
