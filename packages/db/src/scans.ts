import type { SQL } from "bun";
import { createHash } from "node:crypto";

export type ScanCompletenessReason = "complete" | "pagination_incomplete" | "schema_invalid" | "suspicious_empty" | "blocked" | "transport_failure" | "limit_exceeded";

export interface ScanLease {
  id: string;
  leaseToken: string;
  leaseGeneration: number;
}

export interface ListingObservationInput {
  sourceJobId: string;
  canonicalSourceUrl: string;
  applyUrl: string;
  artifactId: string;
  semanticFingerprint: string;
  rawFingerprint: string;
  parsedSource: Record<string, unknown>;
  normalizedCandidate: Record<string, unknown>;
  parserVersion: string;
  normalizerVersion: string;
  taxonomyVersion: string;
  assertions: readonly {
    fieldPath: string;
    value: unknown;
    origin: "source_field" | "source_text" | "deterministic_rule" | "model_derived" | "human_review";
    artifactId: string;
    locator: { kind: "json_pointer"; pointer: string } | { kind: "text_span"; span: { start: number; end: number; quoteHash: string } };
    extractorId: string;
    extractorVersion: string;
    confidence: number;
  }[];
  promptVersion?: string;
  sourcePostedAt?: Date;
  sourceUpdatedAt?: Date;
  validThrough?: Date;
}

export interface CompleteScanInput {
  lease: ScanLease;
  workerId: string;
  sourceId: string;
  startedAt: Date;
  endedAt: Date;
  connectorId: string;
  connectorVersion: string;
  safeFetchPolicyVersion: string;
  policyId: string;
  fetchMetadata: Record<string, unknown>;
  completenessReason: ScanCompletenessReason;
  responseArtifactIds: readonly string[];
  observations: readonly ListingObservationInput[];
  byteCount: number;
  boardHash?: string;
}

export interface ScanCommitResult {
  scanId: string;
  observationCount: number;
  versionCount: number;
  replayed: boolean;
}

export interface FailedScanInput {
  lease: ScanLease;
  workerId: string;
  sourceId: string;
  startedAt: Date;
  endedAt: Date;
  connectorId: string;
  connectorVersion: string;
  safeFetchPolicyVersion: string;
  policyId: string;
  fetchMetadata: Record<string, unknown>;
  reason: "blocked" | "transport_failure" | "schema_invalid" | "limit_exceeded";
  errorCode: string;
  responseArtifactIds?: readonly string[];
  byteCount?: number;
  retryable: boolean;
}

export class ScanLedgerError extends Error {
  constructor(readonly code: string) {
    super(code);
    this.name = "ScanLedgerError";
  }
}

function boundedObject(value: Record<string, unknown>, label: string): string {
  const serialized = JSON.stringify(value);
  if (serialized.length > 1_000_000) throw new ScanLedgerError(`${label}_too_large`);
  return serialized;
}

function deliveryHash(value: unknown): string {
  return createHash("sha256").update(JSON.stringify(value)).digest("hex");
}

function validate(input: CompleteScanInput): void {
  if (!input.workerId.trim() || input.workerId.length > 200) throw new ScanLedgerError("invalid_worker_id");
  if (input.endedAt < input.startedAt) throw new ScanLedgerError("invalid_scan_time_order");
  if (!Number.isSafeInteger(input.byteCount) || input.byteCount < 0) throw new ScanLedgerError("invalid_byte_count");
  if (input.responseArtifactIds.length < 1 || input.responseArtifactIds.length > 100) {
    throw new ScanLedgerError("invalid_response_artifacts");
  }
  if (input.observations.length > 100_000 || new Set(input.observations.map((item) => item.sourceJobId)).size !== input.observations.length) {
    throw new ScanLedgerError("invalid_observations");
  }
  const artifacts = new Set(input.responseArtifactIds);
  if (input.observations.some((item) => !artifacts.has(item.artifactId))) throw new ScanLedgerError("observation_artifact_outside_response");
  boundedObject(input.fetchMetadata, "fetch_metadata");
}

function healthFor(reason: CompleteScanInput["completenessReason"]): "healthy" | "degraded" | "blocked" {
  if (reason === "complete") return "healthy";
  return reason === "blocked" ? "blocked" : "degraded";
}

export class PostgresScanLedger {
  constructor(
    private readonly sql: SQL,
    private readonly clock: { random(): number } = { random: () => Math.random() },
  ) {}

  async commit(input: CompleteScanInput): Promise<ScanCommitResult> {
    validate(input);
    const inputHash = deliveryHash(input);
    return this.sql.begin(async (tx) => {
      const existing = (await tx<{ id: string; delivery_hash: string }[]>`
        SELECT id, delivery_hash FROM source_scans
        WHERE work_job_id = ${input.lease.id} AND lease_generation = ${input.lease.leaseGeneration}
      `)[0];
      if (existing) {
        if (existing.delivery_hash !== inputHash) throw new ScanLedgerError("scan_replay_mismatch");
        const counts = (await tx<{ observations: number; versions: number }[]>`
          SELECT count(*)::int AS observations, count(DISTINCT listing_version_id)::int AS versions
          FROM source_observations WHERE source_scan_id = ${existing.id}
        `)[0];
        return { scanId: existing.id, observationCount: counts?.observations ?? 0, versionCount: counts?.versions ?? 0, replayed: true };
      }

      const fenced = (await tx<{ id: string }[]>`
        SELECT id FROM work_jobs WHERE id = ${input.lease.id} AND status = 'leased'
          AND lease_owner = ${input.workerId} AND lease_token = ${input.lease.leaseToken}
          AND lease_generation = ${input.lease.leaseGeneration} AND lease_expires_at > clock_timestamp()
        FOR UPDATE
      `)[0];
      if (!fenced) throw new ScanLedgerError("stale_lease");
      const source = (await tx<{ connector_id: string; connector_version: string; policy_id: string }[]>`
        SELECT connector_id, connector_version, policy_id FROM sources WHERE id = ${input.sourceId} FOR UPDATE
      `)[0];
      if (!source) throw new ScanLedgerError("source_not_found");
      if (source.connector_id !== input.connectorId || source.connector_version !== input.connectorVersion || source.policy_id !== input.policyId) {
        throw new ScanLedgerError("source_snapshot_mismatch");
      }

      const scanId = Bun.randomUUIDv7();
      const complete = input.completenessReason === "complete";
      await tx`INSERT INTO source_scans (
        id, source_id, work_job_id, lease_generation, started_at, ended_at, http_outcome,
        response_count, byte_count, duration_ms, connector_id, connector_version,
        safe_fetch_policy_version, policy_id, delivery_hash, fetch_metadata, completeness_state,
        completeness_reason, observed_job_count, board_hash, added_count, changed_count,
        successful_for_absence_inference
      ) VALUES (
        ${scanId}, ${input.sourceId}, ${input.lease.id}, ${input.lease.leaseGeneration}, ${input.startedAt}, ${null},
        ${null}, ${input.responseArtifactIds.length}, ${input.byteCount}, ${null},
        ${input.connectorId}, ${input.connectorVersion}, ${input.safeFetchPolicyVersion}, ${input.policyId},
        ${inputHash}, ${boundedObject(input.fetchMetadata, "fetch_metadata")}::text::jsonb, ${"in_progress"},
        ${null}, ${input.observations.length}, ${input.boardHash ?? null}, ${0}, ${0}, ${false}
      )`;
      for (const [order, artifactId] of input.responseArtifactIds.entries()) {
        await tx`INSERT INTO source_scan_artifacts (source_scan_id, artifact_id, response_order)
          VALUES (${scanId}, ${artifactId}, ${order})`;
      }

      let versionCount = 0;
      let addedCount = 0;
      let changedCount = 0;
      for (const observation of input.observations) {
        const listingId = Bun.randomUUIDv7();
        const listing = (await tx<{ id: string; current_version_id: string | null }[]>`
          INSERT INTO source_listings (
            id, source_id, source_job_id, canonical_source_url, apply_url, first_seen_at, last_seen_open_at
          ) VALUES (
            ${listingId}, ${input.sourceId}, ${observation.sourceJobId}, ${observation.canonicalSourceUrl}, ${observation.applyUrl},
            ${input.endedAt}, ${input.endedAt}
          ) ON CONFLICT (source_id, source_job_id) DO UPDATE SET
            canonical_source_url = EXCLUDED.canonical_source_url, apply_url = EXCLUDED.apply_url,
            last_seen_open_at = EXCLUDED.last_seen_open_at, lifecycle_state = 'active', closed_at = NULL,
            consecutive_complete_misses = 0
          RETURNING id, current_version_id
        `)[0]!;
        if (listing.id === listingId) addedCount += 1;

        const newVersionId = Bun.randomUUIDv7();
        const inserted = await tx<{ id: string }[]>`INSERT INTO listing_versions (
          id, source_listing_id, source_scan_id, artifact_id, semantic_fingerprint, raw_fingerprint,
          parsed_source_json, normalized_candidate_json, parser_version, normalizer_version,
          taxonomy_version, prompt_version, source_posted_at, source_updated_at, valid_through
        ) VALUES (
          ${newVersionId}, ${listing.id}, ${scanId}, ${observation.artifactId}, ${observation.semanticFingerprint}, ${observation.rawFingerprint},
          ${boundedObject(observation.parsedSource, "parsed_source")}::text::jsonb,
          ${boundedObject(observation.normalizedCandidate, "normalized_candidate")}::text::jsonb,
          ${observation.parserVersion}, ${observation.normalizerVersion}, ${observation.taxonomyVersion}, ${observation.promptVersion ?? null},
          ${observation.sourcePostedAt ?? null}, ${observation.sourceUpdatedAt ?? null}, ${observation.validThrough ?? null}
        ) ON CONFLICT (source_listing_id, semantic_fingerprint) DO NOTHING RETURNING id`;
        const versionId = inserted[0]?.id ?? (await tx<{ id: string }[]>`
          SELECT id FROM listing_versions WHERE source_listing_id = ${listing.id} AND semantic_fingerprint = ${observation.semanticFingerprint}
        `)[0]!.id;
        if (inserted.length) versionCount += 1;
        if (listing.current_version_id && listing.current_version_id !== versionId) changedCount += 1;
        await tx`UPDATE source_listings SET current_version_id = ${versionId} WHERE id = ${listing.id}`;
        await tx`INSERT INTO source_observations (
          id, source_scan_id, source_listing_id, listing_version_id, artifact_id, observed_at
        ) VALUES (${Bun.randomUUIDv7()}, ${scanId}, ${listing.id}, ${versionId}, ${observation.artifactId}, ${input.endedAt})`;
        if (inserted.length) {
          for (const assertion of observation.assertions) {
            if (!input.responseArtifactIds.includes(assertion.artifactId)) throw new ScanLedgerError("assertion_artifact_outside_response");
            const pointer = assertion.locator.kind === "json_pointer" ? assertion.locator.pointer : null;
            const span = assertion.locator.kind === "text_span" ? assertion.locator.span : null;
            await tx`INSERT INTO field_assertions (
              id, target_type, target_id, field_path, value_json, origin, artifact_id, json_pointer,
              text_span_start, text_span_end, quote_hash, extractor_id, extractor_version, confidence, selected
            ) VALUES (
              ${Bun.randomUUIDv7()}, ${"listing_version"}, ${versionId}, ${assertion.fieldPath},
              ${JSON.stringify(assertion.value)}::text::jsonb, ${assertion.origin}, ${assertion.artifactId}, ${pointer},
              ${span?.start ?? null}, ${span?.end ?? null}, ${span?.quoteHash ?? null},
              ${assertion.extractorId}, ${assertion.extractorVersion}, ${assertion.confidence}, ${true}
            )`;
          }
        }
      }

      await tx`UPDATE source_scans SET ended_at = ${input.endedAt}, http_outcome = ${"succeeded"},
        duration_ms = ${input.endedAt.getTime() - input.startedAt.getTime()},
        completeness_state = ${complete ? "complete" : "incomplete"}, completeness_reason = ${input.completenessReason},
        added_count = ${addedCount}, changed_count = ${changedCount}, successful_for_absence_inference = ${complete}
        WHERE id = ${scanId}`;
      await tx`UPDATE sources SET
        health_state = ${healthFor(input.completenessReason)}, last_attempt_at = ${input.endedAt},
        last_success_at = ${input.endedAt},
        last_complete_at = CASE WHEN ${complete} THEN ${input.endedAt} ELSE last_complete_at END,
        last_nonempty_at = CASE WHEN ${input.observations.length > 0} THEN ${input.endedAt} ELSE last_nonempty_at END,
        last_job_count = ${input.observations.length},
        consecutive_failures = CASE WHEN ${complete} THEN 0 ELSE consecutive_failures + 1 END,
        consecutive_complete_empty_scans = CASE
          WHEN ${complete} AND ${input.observations.length === 0} THEN consecutive_complete_empty_scans + 1
          WHEN ${complete} THEN 0 ELSE consecutive_complete_empty_scans END,
        last_board_hash = ${input.boardHash ?? null}
      WHERE id = ${input.sourceId}`;
      await tx`UPDATE work_jobs SET status = 'succeeded', completed_at = ${input.endedAt},
        leased_at = NULL, lease_expires_at = NULL, lease_owner = NULL, lease_token = NULL
        WHERE id = ${input.lease.id}`;
      return { scanId, observationCount: input.observations.length, versionCount, replayed: false };
    });
  }

  async fail(input: FailedScanInput): Promise<ScanCommitResult> {
    if (!/^[a-z0-9_.:-]{1,100}$/.test(input.errorCode)) {
      throw new ScanLedgerError("invalid_failure_metadata");
    }
    const redactedMessage = `Scan failed with classified error: ${input.errorCode}`;
    const artifacts = input.responseArtifactIds ?? [];
    if (artifacts.length > 100) throw new ScanLedgerError("invalid_response_artifacts");
    if (input.endedAt < input.startedAt || !input.workerId.trim()) throw new ScanLedgerError("invalid_failed_scan");
    const byteCount = input.byteCount ?? 0;
    if (!Number.isSafeInteger(byteCount) || byteCount < 0) throw new ScanLedgerError("invalid_byte_count");
    const inputHash = deliveryHash(input);
    return this.sql.begin(async (tx) => {
      const existing = (await tx<{ id: string; delivery_hash: string }[]>`SELECT id, delivery_hash FROM source_scans
        WHERE work_job_id = ${input.lease.id} AND lease_generation = ${input.lease.leaseGeneration}`)[0];
      if (existing) {
        if (existing.delivery_hash !== inputHash) throw new ScanLedgerError("scan_replay_mismatch");
        return { scanId: existing.id, observationCount: 0, versionCount: 0, replayed: true };
      }
      const job = (await tx<{ attempt: number; max_attempts: number }[]>`SELECT attempt, max_attempts FROM work_jobs
        WHERE id = ${input.lease.id} AND status = 'leased' AND lease_owner = ${input.workerId}
          AND lease_token = ${input.lease.leaseToken} AND lease_generation = ${input.lease.leaseGeneration}
          AND lease_expires_at > clock_timestamp() FOR UPDATE`)[0];
      if (!job) throw new ScanLedgerError("stale_lease");
      const source = (await tx<{ connector_id: string; connector_version: string; policy_id: string }[]>`
        SELECT connector_id, connector_version, policy_id FROM sources WHERE id = ${input.sourceId} FOR UPDATE`)[0];
      if (!source) throw new ScanLedgerError("source_not_found");
      if (source.connector_id !== input.connectorId || source.connector_version !== input.connectorVersion || source.policy_id !== input.policyId) {
        throw new ScanLedgerError("source_snapshot_mismatch");
      }
      const scanId = Bun.randomUUIDv7();
      await tx`INSERT INTO source_scans (
        id, source_id, work_job_id, lease_generation, started_at, ended_at, http_outcome,
        response_count, byte_count, duration_ms, connector_id, connector_version,
        safe_fetch_policy_version, policy_id, delivery_hash, fetch_metadata, completeness_state,
        completeness_reason, observed_job_count, error_code, error_message
      ) VALUES (
        ${scanId}, ${input.sourceId}, ${input.lease.id}, ${input.lease.leaseGeneration}, ${input.startedAt}, ${input.endedAt},
        ${"failed"}, ${artifacts.length}, ${byteCount}, ${input.endedAt.getTime() - input.startedAt.getTime()},
        ${input.connectorId}, ${input.connectorVersion}, ${input.safeFetchPolicyVersion}, ${input.policyId}, ${inputHash},
        ${boundedObject(input.fetchMetadata, "fetch_metadata")}::text::jsonb, ${"failed"}, ${input.reason}, ${0},
        ${input.errorCode}, ${redactedMessage}
      )`;
      for (const [order, artifactId] of artifacts.entries()) {
        await tx`INSERT INTO source_scan_artifacts (source_scan_id, artifact_id, response_order)
          VALUES (${scanId}, ${artifactId}, ${order})`;
      }
      const canRetry = input.retryable && job.attempt < job.max_attempts;
      const status = canRetry ? "retryable_failed" : "terminal_failed";
      const capMs = Math.min(3_600_000, 5_000 * 2 ** Math.max(0, job.attempt - 1));
      const scheduledAt = new Date(input.endedAt.getTime() + Math.floor(capMs * Math.min(0.999999, Math.max(0, this.clock.random()))));
      await tx`UPDATE work_jobs SET status = ${status}, scheduled_at = ${canRetry ? scheduledAt : input.endedAt},
        completed_at = ${canRetry ? null : input.endedAt}, last_error_code = ${input.errorCode},
        last_error_message = ${redactedMessage}, leased_at = NULL, lease_expires_at = NULL,
        lease_owner = NULL, lease_token = NULL WHERE id = ${input.lease.id}`;
      await tx`UPDATE sources SET health_state = ${input.reason === "blocked" ? "blocked" : "degraded"},
        last_attempt_at = ${input.endedAt}, consecutive_failures = consecutive_failures + 1 WHERE id = ${input.sourceId}`;
      return { scanId, observationCount: 0, versionCount: 0, replayed: false };
    });
  }
}
