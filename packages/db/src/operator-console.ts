import type { SQL } from "bun";
import { createHash } from "node:crypto";
import { PostgresCompanyResolutionStore } from "./company-resolution.ts";
import { PostgresLifecycleStore } from "./lifecycle.ts";
import { PostgresOpportunityResolutionStore } from "./opportunity-resolution.ts";

export interface OperatorContext { actorId: string; idempotencyKey: string }
export interface CompanyReviewDecision { reviewId: string; sourceCompanyId: string; canonicalCompanyId: string; resolverVersion: string; confidence: number; reason: string }
export interface CompanySplitDecision { sourceCompanyId: string; canonicalCompanyId: string; resolverVersion: string; reason: string }
export interface OpportunityReviewDecision { reviewId: string; sourceListingId: string; opportunityId: string; resolverVersion: string; reason: string }
export interface OpportunitySplitDecision { sourceListingId: string; opportunityId: string; resolverVersion: string; reason: string }

export interface OperatorConsoleService {
  overview(): Promise<Record<string, unknown>>;
  reviews(state?: "pending" | "approved" | "rejected"): Promise<Record<string, unknown>>;
  review(reviewId: string): Promise<Record<string, unknown> | null>;
  sourceEvidence(sourceId: string): Promise<Record<string, unknown> | null>;
  clearBreaker(context: OperatorContext, breakerId: string, reason: string): Promise<unknown>;
  mergeCompanyReview(context: OperatorContext, input: CompanyReviewDecision): Promise<unknown>;
  splitCompany(context: OperatorContext, input: CompanySplitDecision): Promise<unknown>;
  attachOpportunityReview(context: OperatorContext, input: OpportunityReviewDecision): Promise<unknown>;
  splitOpportunity(context: OperatorContext, input: OpportunitySplitDecision): Promise<unknown>;
}

function object(value: unknown): Record<string, unknown> {
  try {
    const parsed = typeof value === "string" ? JSON.parse(value) : value;
    return typeof parsed === "object" && parsed !== null && !Array.isArray(parsed) ? parsed as Record<string, unknown> : {};
  } catch { return {}; }
}

function safeText(value: unknown, fallback: string, limit = 160): string {
  return (typeof value === "string" ? value.replace(/[\r\n\t]+/gu, " ").trim() : "").slice(0, limit) || fallback;
}

function safeUuid(value: unknown): string | undefined {
  const candidate = typeof value === "string" ? value : "";
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu.test(candidate) ? candidate : undefined;
}

function safeCandidate(type: string, value: unknown): Record<string, unknown> {
  const candidate = object(value);
  if (type === "company_identity") {
    const choices = Array.isArray(candidate.candidates) ? candidate.candidates.slice(0, 10).map((entry) => {
      const item = object(entry);
      return { companyId: safeUuid(item.companyId) };
    }).filter((entry) => entry.companyId) : [];
    return { action: "review", reason: safeText(candidate.reason, "manual review"), resolverVersion: safeText(candidate.resolverVersion, "unknown", 100), candidates: choices };
  }
  const ids = Array.isArray(candidate.candidateOpportunityIds) ? candidate.candidateOpportunityIds.slice(0, 10).map(safeUuid).filter((id): id is string => Boolean(id)) : [];
  return { action: "review", reason: safeText(candidate.reason, "manual review"), resolverVersion: safeText(candidate.resolverVersion, "unknown", 100), sourceListingId: safeUuid(candidate.sourceListingId), candidateOpportunityIds: ids };
}

function origin(value: string | null): string | null {
  if (!value) return null;
  try { const url = new URL(value); return `${url.protocol}//${url.host}`; } catch { return null; }
}

function fixtureKey(prefix: string, context: OperatorContext): string {
  const suffix = createHash("sha256").update(context.idempotencyKey).digest("hex").slice(0, 32);
  return `${prefix}:${suffix}`;
}

export class PostgresOperatorConsole implements OperatorConsoleService {
  private readonly companies: PostgresCompanyResolutionStore;
  private readonly opportunities: PostgresOpportunityResolutionStore;
  private readonly lifecycle: PostgresLifecycleStore;

  constructor(private readonly sql: SQL) {
    this.companies = new PostgresCompanyResolutionStore(sql);
    this.opportunities = new PostgresOpportunityResolutionStore(sql);
    this.lifecycle = new PostgresLifecycleStore(sql);
  }

  async overview(): Promise<Record<string, unknown>> {
    const [sourceRows, reviewRows, breakerRows, scanRows] = await Promise.all([
      this.sql<Record<string, unknown>[]>`SELECT health_state AS state, count(*)::int AS count FROM sources GROUP BY health_state ORDER BY health_state`,
      this.sql<Record<string, unknown>[]>`SELECT review_type AS type, count(*)::int AS count FROM resolution_reviews WHERE state = 'pending' GROUP BY review_type ORDER BY review_type`,
      this.sql<Record<string, unknown>[]>`SELECT count(*)::int AS count FROM lifecycle_circuit_breakers WHERE state = 'tripped'`,
      this.sql<Record<string, unknown>[]>`SELECT completeness_reason AS reason, count(*)::int AS count FROM source_scans WHERE ended_at >= clock_timestamp() - interval '24 hours' GROUP BY completeness_reason ORDER BY completeness_reason`,
    ]);
    return { sourceHealth: sourceRows, pendingReviews: reviewRows, activeBreakers: Number(breakerRows[0]?.count ?? 0), scansLast24Hours: scanRows };
  }

  async reviews(state: "pending" | "approved" | "rejected" = "pending"): Promise<Record<string, unknown>> {
    const rows = await this.sql<Array<{ id: string; reviewType: string; targetType: string; targetId: string; candidate: unknown; priority: number; state: string; createdAt: Date | string }>[number][]>`
      SELECT id, review_type AS "reviewType", target_type AS "targetType", target_id AS "targetId",
        candidate_json AS candidate, priority, state, created_at AS "createdAt"
      FROM resolution_reviews WHERE state = ${state} ORDER BY priority DESC, created_at, id LIMIT 200`;
    return { reviews: rows.map((row) => ({ ...row, candidate: safeCandidate(row.reviewType, row.candidate) })) };
  }

  async review(reviewId: string): Promise<Record<string, unknown> | null> {
    const row = (await this.sql<Array<{ id: string; reviewType: string; targetType: string; targetId: string; candidate: unknown; priority: number; state: string; decisionReason: string | null; createdAt: Date | string }>[number][]>`
      SELECT id, review_type AS "reviewType", target_type AS "targetType", target_id AS "targetId", candidate_json AS candidate,
        priority, state, decision_reason AS "decisionReason", created_at AS "createdAt"
      FROM resolution_reviews WHERE id = ${reviewId}`)[0];
    return row ? { ...row, candidate: safeCandidate(row.reviewType, row.candidate) } : null;
  }

  async sourceEvidence(sourceId: string): Promise<Record<string, unknown> | null> {
    const source = (await this.sql<Array<{ id: string; connectorId: string; connectorVersion: string; enabled: boolean; healthState: string; boardUrl: string | null; lastAttemptAt: Date | string | null; lastSuccessAt: Date | string | null }>[number][]>`
      SELECT id, connector_id AS "connectorId", connector_version AS "connectorVersion", enabled, health_state AS "healthState",
        board_url AS "boardUrl", last_attempt_at AS "lastAttemptAt", last_success_at AS "lastSuccessAt" FROM sources WHERE id = ${sourceId}`)[0];
    if (!source) return null;
    const [scans, breakers] = await Promise.all([
      this.sql<Record<string, unknown>[]>`SELECT scan.id, scan.completeness_state AS "state", scan.completeness_reason AS "reason",
          scan.observed_job_count AS "jobCount", scan.response_count AS "responseCount", scan.byte_count AS "byteCount", scan.ended_at AS "endedAt",
          coalesce(jsonb_agg(jsonb_build_object('id', artifact.id, 'sha256', artifact.sha256, 'byteLength', artifact.byte_length,
            'mediaType', artifact.media_type, 'statusCode', artifact.status_code, 'storageState', artifact.storage_state,
            'retrievedAt', artifact.retrieved_at, 'redactionVersion', artifact.metadata_redaction_version)
            ORDER BY link.response_order) FILTER (WHERE artifact.id IS NOT NULL), '[]'::jsonb) AS artifacts
        FROM source_scans scan LEFT JOIN source_scan_artifacts link ON link.source_scan_id = scan.id
        LEFT JOIN artifacts artifact ON artifact.id = link.artifact_id WHERE scan.source_id = ${sourceId}
        GROUP BY scan.id ORDER BY scan.started_at DESC, scan.id DESC LIMIT 20`,
      this.sql<Record<string, unknown>[]>`SELECT id, scope_type AS "scopeType", connector_id AS "connectorId", connector_version AS "connectorVersion",
          reason, baseline_count AS "baselineCount", observed_count AS "observedCount", anomaly_ratio AS "anomalyRatio", state, created_at AS "createdAt"
        FROM lifecycle_circuit_breakers WHERE source_id = ${sourceId} OR (source_id IS NULL AND connector_id = ${source.connectorId}
          AND connector_version = ${source.connectorVersion}) ORDER BY created_at DESC, id DESC LIMIT 20`,
    ]);
    return { source: { ...source, boardUrl: undefined, boardOrigin: origin(source.boardUrl) }, scans, breakers, rawArtifactAccess: { available: false, reason: "raw_artifacts_require_separate_privileged_viewer" } };
  }

  clearBreaker(context: OperatorContext, breakerId: string, reason: string): Promise<unknown> {
    return this.lifecycle.clearCircuitBreaker(context, { circuitBreakerId: breakerId, reason });
  }

  mergeCompanyReview(context: OperatorContext, input: CompanyReviewDecision): Promise<unknown> {
    return this.companies.mergeCompanies(context, { ...input, fixtureKey: fixtureKey("operator-company-merge", context),
      fixtureInput: { reviewId: input.reviewId, sourceCompanyId: input.sourceCompanyId, canonicalCompanyId: input.canonicalCompanyId },
      fixtureExpected: { action: "automatic_match", companyId: input.canonicalCompanyId } });
  }

  splitCompany(context: OperatorContext, input: CompanySplitDecision): Promise<unknown> {
    return this.companies.splitCompany(context, { ...input, fixtureKey: fixtureKey("operator-company-split", context),
      fixtureInput: { sourceCompanyId: input.sourceCompanyId, canonicalCompanyId: input.canonicalCompanyId },
      fixtureExpected: { action: "create_new", companyId: input.sourceCompanyId } });
  }

  attachOpportunityReview(context: OperatorContext, input: OpportunityReviewDecision): Promise<unknown> {
    return this.opportunities.attach({ ...context, actorType: "operator" }, { sourceListingId: input.sourceListingId,
      opportunityId: input.opportunityId, reviewId: input.reviewId, reason: input.reason,
      resolution: { action: "review", reason: "operator_confirmed_candidate", resolverVersion: input.resolverVersion,
        candidateOpportunityIds: [input.opportunityId] }, fixtureKey: fixtureKey("operator-opportunity-attach", context),
      fixtureInput: { reviewId: input.reviewId, sourceListingId: input.sourceListingId, opportunityId: input.opportunityId } });
  }

  splitOpportunity(context: OperatorContext, input: OpportunitySplitDecision): Promise<unknown> {
    return this.opportunities.split({ ...context, actorType: "operator" }, { ...input,
      fixtureKey: fixtureKey("operator-opportunity-split", context), fixtureInput: { sourceListingId: input.sourceListingId, opportunityId: input.opportunityId } });
  }
}
