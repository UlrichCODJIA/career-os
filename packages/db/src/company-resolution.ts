import { createHash } from "node:crypto";
import { SQL } from "bun";
import {
  normalizeCompanyIdentityKey,
  type CompanyIdentityKeyType,
} from "@career-os/company-resolver";

export interface CompanyDecisionContext {
  actorId: string;
  idempotencyKey: string;
}

export interface CompanyMergeCommand {
  sourceCompanyId: string;
  canonicalCompanyId: string;
  reviewId: string;
  resolverVersion: string;
  confidence: number;
  reason: string;
  fixtureKey: string;
  fixtureInput: Record<string, unknown>;
  fixtureExpected: Record<string, unknown>;
}

export interface CompanySplitCommand {
  sourceCompanyId: string;
  canonicalCompanyId: string;
  resolverVersion: string;
  reason: string;
  fixtureKey: string;
  fixtureInput: Record<string, unknown>;
  fixtureExpected: Record<string, unknown>;
}

export interface CompanyIdentityClaimCommand {
  companyId: string;
  type: CompanyIdentityKeyType;
  value: string;
  evidenceType: string;
  artifactId?: string;
  evidenceUrl?: string;
  confidence: number;
  reason: string;
}

export interface CompanyIdentityReviewCandidate {
  action: "review";
  reason: string;
  resolverVersion: string;
  candidates: Array<{ companyId: string; [key: string]: unknown }>;
}

export class CompanyResolutionError extends Error {
  constructor(public readonly code: string) {
    super(code);
    this.name = "CompanyResolutionError";
  }
}

function uuid(): string {
  return Bun.randomUUIDv7();
}

function digest(value: unknown): string {
  return createHash("sha256").update(JSON.stringify(value)).digest("hex");
}

function jsonObject(value: unknown): Record<string, unknown> {
  return (typeof value === "string" ? JSON.parse(value) : value) as Record<string, unknown>;
}

function validateCommand(command: CompanyMergeCommand | CompanySplitCommand): void {
  if (command.sourceCompanyId === command.canonicalCompanyId) throw new CompanyResolutionError("company_identity_self_mapping");
  if (!/^[a-z0-9][a-z0-9._:-]{7,127}$/u.test(command.fixtureKey)) throw new CompanyResolutionError("invalid_fixture_key");
  if (command.reason.trim().length < 8) throw new CompanyResolutionError("decision_reason_too_short");
  if ("confidence" in command && (!Number.isFinite(command.confidence) || command.confidence < 0.9 || command.confidence > 1)) {
    throw new CompanyResolutionError("merge_confidence_too_low");
  }
  const expectedCompanyId = "confidence" in command ? command.canonicalCompanyId : command.sourceCompanyId;
  const expectedAction = "confidence" in command ? "automatic_match" : "create_new";
  if (command.fixtureExpected.action !== expectedAction || command.fixtureExpected.companyId !== expectedCompanyId) {
    throw new CompanyResolutionError("fixture_expected_decision_mismatch");
  }
}

async function idempotent<T extends Record<string, unknown>>(
  sql: SQL,
  context: CompanyDecisionContext,
  operation: string,
  command: unknown,
  mutate: (tx: SQL) => Promise<T>,
): Promise<T> {
  if (!/^[A-Za-z0-9._:-]{8,128}$/u.test(context.idempotencyKey)) throw new CompanyResolutionError("invalid_idempotency_key");
  const requestHash = digest(command);
  return sql.begin(async (tx) => {
    const inserted = await tx<{ id: string }[]>`INSERT INTO idempotency_records (
      id, actor_id, operation, idempotency_key, request_hash
    ) VALUES (${uuid()}, ${context.actorId}, ${operation}, ${context.idempotencyKey}, ${requestHash})
    ON CONFLICT (actor_id, operation, idempotency_key) DO NOTHING RETURNING id`;
    if (inserted.length === 0) {
      const rows = await tx<{ request_hash: string; response_json: unknown }[]>`SELECT request_hash, response_json
        FROM idempotency_records
        WHERE actor_id = ${context.actorId} AND operation = ${operation} AND idempotency_key = ${context.idempotencyKey}
        FOR UPDATE`;
      const row = rows[0];
      if (!row || row.request_hash !== requestHash) throw new CompanyResolutionError("idempotency_key_reused");
      if (row.response_json === null) throw new CompanyResolutionError("idempotency_incomplete");
      return jsonObject(row.response_json) as T;
    }
    const response = await mutate(tx);
    await tx`UPDATE idempotency_records SET response_json = ${JSON.stringify(response)}::text::jsonb,
      completed_at = clock_timestamp()
      WHERE actor_id = ${context.actorId} AND operation = ${operation} AND idempotency_key = ${context.idempotencyKey}`;
    return response;
  });
}

async function lockCompanies(tx: SQL, sourceCompanyId: string, canonicalCompanyId: string): Promise<Array<Record<string, unknown>>> {
  const ids = [sourceCompanyId, canonicalCompanyId].sort();
  const rows = await tx<Record<string, unknown>[]>`SELECT * FROM companies WHERE id IN ${tx(ids)} ORDER BY id FOR UPDATE`;
  if (rows.length !== 2) throw new CompanyResolutionError("company_not_found");
  return rows;
}

async function approveReview(
  tx: SQL,
  reviewId: string,
  sourceCompanyId: string,
  canonicalCompanyId: string,
  context: CompanyDecisionContext,
  reason: string,
): Promise<void> {
  const rows = await tx<{ state: string; review_type: string; target_type: string; target_id: string; candidate_json: unknown }[]>`
    SELECT state, review_type, target_type, target_id, candidate_json FROM resolution_reviews WHERE id = ${reviewId} FOR UPDATE`;
  const review = rows[0];
  if (!review || review.review_type !== "company_identity") throw new CompanyResolutionError("company_review_not_found");
  if (review.target_type !== "company" || review.target_id !== sourceCompanyId) {
    throw new CompanyResolutionError("company_review_target_mismatch");
  }
  const candidate = jsonObject(review.candidate_json) as unknown as CompanyIdentityReviewCandidate;
  if (candidate.action !== "review" || !Array.isArray(candidate.candidates)
    || !candidate.candidates.some((entry) => entry?.companyId === canonicalCompanyId)) {
    throw new CompanyResolutionError("company_review_candidate_mismatch");
  }
  if (review.state !== "pending") throw new CompanyResolutionError("company_review_already_decided");
  await tx`UPDATE resolution_reviews SET state = ${"approved"}, decision_reason = ${reason}, decided_by = ${context.actorId},
    decided_at = clock_timestamp() WHERE id = ${reviewId}`;
}

async function auditDecision(
  tx: SQL,
  context: CompanyDecisionContext,
  action: string,
  targetId: string,
  reason: string,
  before: unknown,
  after: unknown,
): Promise<void> {
  await tx`INSERT INTO audit_events (
    id, actor_type, actor_id, action, target_type, target_id, reason, correlation_id, metadata
  ) VALUES (
    ${uuid()}, ${"operator"}, ${context.actorId}, ${action}, ${"company"}, ${targetId}, ${reason}, ${uuid()},
    ${JSON.stringify({ before, after, idempotencyKey: context.idempotencyKey })}::text::jsonb
  )`;
}

export class PostgresCompanyResolutionStore {
  constructor(private readonly sql: SQL) {}

  async listCompanyIdentities(): Promise<Array<Record<string, unknown>>> {
    const rows = await this.sql<Array<Record<string, unknown>>[number][]>`SELECT
      company.id,
      company.display_name AS "displayName",
      company.legal_name AS "legalName",
      coalesce(jsonb_agg(jsonb_build_object(
        'type', CASE
          WHEN claim.claim_type IN ('legal_name', 'trade_name', 'alias') THEN 'verified_alias'
          ELSE claim.claim_type
        END,
        'value', claim.claim_value,
        'evidenceId', claim.id,
        'confidence', claim.confidence
      ) ORDER BY claim.claim_type, claim.normalized_value, claim.id) FILTER (WHERE claim.id IS NOT NULL), '[]'::jsonb) AS keys
    FROM companies company
    LEFT JOIN company_identity_claims claim ON claim.company_id = company.id
      AND claim.claim_type IN ('verified_domain', 'ats_tenant', 'alias')
      AND claim.confidence >= 0.9
    WHERE company.resolution_status <> 'merged'
    GROUP BY company.id
    ORDER BY company.id`;
    return rows.map((row) => ({ ...row, keys: typeof row.keys === "string" ? JSON.parse(row.keys) : row.keys }));
  }

  recordIdentityClaim(
    context: CompanyDecisionContext,
    command: CompanyIdentityClaimCommand,
  ): Promise<Record<string, unknown>> {
    if (!Number.isFinite(command.confidence) || command.confidence < 0.9 || command.confidence > 1) {
      throw new CompanyResolutionError("identity_claim_confidence_too_low");
    }
    if (!command.artifactId && !command.evidenceUrl) throw new CompanyResolutionError("identity_claim_evidence_required");
    if (command.evidenceUrl) {
      const url = new URL(command.evidenceUrl);
      if (url.protocol !== "https:" || url.username || url.password || url.port || url.search || url.hash) {
        throw new CompanyResolutionError("identity_claim_evidence_url_invalid");
      }
    }
    const normalizedValue = normalizeCompanyIdentityKey(command.type, command.value);
    return idempotent(this.sql, context, "company_resolution.record_claim", command, async (tx) => {
      const companies = await tx<Record<string, unknown>[]>`SELECT * FROM companies WHERE id = ${command.companyId} FOR UPDATE`;
      const company = companies[0];
      if (!company) throw new CompanyResolutionError("company_not_found");
      if (company.resolution_status !== "verified") throw new CompanyResolutionError("identity_claim_company_not_verified");
      const claimId = uuid();
      const claimType = command.type === "verified_alias" ? "alias" : command.type;
      const rows = await tx<Record<string, unknown>[]>`INSERT INTO company_identity_claims (
        id, company_id, claim_type, claim_value, normalized_value, evidence_type, artifact_id,
        evidence_url, confidence, recorded_by
      ) VALUES (${claimId}, ${command.companyId}, ${claimType}, ${command.value}, ${normalizedValue},
        ${command.evidenceType}, ${command.artifactId ?? null}, ${command.evidenceUrl ?? null},
        ${command.confidence}, ${context.actorId}) RETURNING *`;
      const response = { claim: rows[0] };
      await auditDecision(tx, context, "company_resolution.claim_recorded", command.companyId, command.reason, null, response);
      return response;
    });
  }

  async queueReview(
    targetId: string,
    candidate: CompanyIdentityReviewCandidate,
    priority = 0,
    targetType: "company" | "source_candidate" = "company",
  ): Promise<{ reviewId: string }> {
    if (candidate.action !== "review" || candidate.reason.trim().length === 0
      || candidate.resolverVersion.trim().length === 0 || candidate.candidates.length === 0
      || candidate.candidates.length > 10
      || new Set(candidate.candidates.map((entry) => entry.companyId)).size !== candidate.candidates.length
      || candidate.candidates.some((entry) => !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu.test(entry.companyId))) {
      throw new CompanyResolutionError("invalid_company_review_candidate");
    }
    const reviewId = uuid();
    const rows = await this.sql<{ id: string }[]>`INSERT INTO resolution_reviews (
      id, review_type, target_type, target_id, candidate_json, priority
    ) VALUES (${reviewId}, ${"company_identity"}, ${targetType}, ${targetId},
      ${JSON.stringify(candidate)}::text::jsonb, ${priority})
    ON CONFLICT (review_type, target_type, target_id) WHERE state = 'pending'
    DO UPDATE SET priority = greatest(resolution_reviews.priority, EXCLUDED.priority)
    RETURNING id`;
    return { reviewId: rows[0]!.id };
  }

  mergeCompanies(context: CompanyDecisionContext, command: CompanyMergeCommand): Promise<Record<string, unknown>> {
    validateCommand(command);
    return idempotent(this.sql, context, "company_resolution.merge", command, async (tx) => {
      const companies = await lockCompanies(tx, command.sourceCompanyId, command.canonicalCompanyId);
      const source = companies.find((row) => row.id === command.sourceCompanyId)!;
      const canonical = companies.find((row) => row.id === command.canonicalCompanyId)!;
      if (source.resolution_status === "merged") throw new CompanyResolutionError("source_company_already_merged");
      if (source.resolution_status === "rejected") throw new CompanyResolutionError("source_company_not_active");
      if (canonical.resolution_status !== "verified") {
        throw new CompanyResolutionError("canonical_company_not_active");
      }
      const canonicalMapping = await tx<{ count: number }[]>`SELECT count(*)::int AS count FROM company_merge_memberships
        WHERE source_company_id = ${command.canonicalCompanyId} AND split_at IS NULL`;
      if ((canonicalMapping[0]?.count ?? 0) > 0) throw new CompanyResolutionError("canonical_company_is_noncanonical");
      const sourceMembers = await tx<{ count: number }[]>`SELECT count(*)::int AS count FROM company_merge_memberships
        WHERE canonical_company_id = ${command.sourceCompanyId} AND split_at IS NULL`;
      if ((sourceMembers[0]?.count ?? 0) > 0) throw new CompanyResolutionError("source_company_has_merged_members");
      await approveReview(tx, command.reviewId, command.sourceCompanyId, command.canonicalCompanyId, context, command.reason);
      const decisionId = uuid();
      const membershipId = uuid();
      await tx`INSERT INTO company_resolution_decisions (
        id, operation, subject_company_id, canonical_company_id, review_id, resolver_version,
        confidence, decision_json, actor_type, actor_id, reason
      ) VALUES (${decisionId}, ${"merge"}, ${command.sourceCompanyId}, ${command.canonicalCompanyId},
        ${command.reviewId}, ${command.resolverVersion}, ${command.confidence},
        ${JSON.stringify(command.fixtureExpected)}::text::jsonb, ${"operator"}, ${context.actorId}, ${command.reason})`;
      await tx`INSERT INTO company_merge_memberships (
        id, source_company_id, canonical_company_id, merge_decision_id, previous_status, previous_confidence
      ) VALUES (${membershipId}, ${command.sourceCompanyId}, ${command.canonicalCompanyId}, ${decisionId},
        ${String(source.resolution_status)}, ${Number(source.resolution_confidence)})`;
      await tx`UPDATE companies SET resolution_status = ${"merged"}, resolution_confidence = ${command.confidence}
        WHERE id = ${command.sourceCompanyId}`;
      await tx`INSERT INTO company_resolution_fixtures (id, fixture_key, input_json, expected_json, decision_id)
        VALUES (${uuid()}, ${command.fixtureKey}, ${JSON.stringify(command.fixtureInput)}::text::jsonb,
          ${JSON.stringify(command.fixtureExpected)}::text::jsonb, ${decisionId})`;
      const response = { decisionId, membershipId, sourceCompanyId: command.sourceCompanyId, canonicalCompanyId: command.canonicalCompanyId };
      await auditDecision(tx, context, "company_resolution.merged", command.sourceCompanyId, command.reason, source, response);
      return response;
    });
  }

  splitCompany(context: CompanyDecisionContext, command: CompanySplitCommand): Promise<Record<string, unknown>> {
    validateCommand(command);
    return idempotent(this.sql, context, "company_resolution.split", command, async (tx) => {
      await lockCompanies(tx, command.sourceCompanyId, command.canonicalCompanyId);
      const rows = await tx<Record<string, unknown>[]>`SELECT * FROM company_merge_memberships
        WHERE source_company_id = ${command.sourceCompanyId} AND canonical_company_id = ${command.canonicalCompanyId}
          AND split_at IS NULL FOR UPDATE`;
      const membership = rows[0];
      if (!membership) throw new CompanyResolutionError("active_company_merge_not_found");
      const decisionId = uuid();
      await tx`INSERT INTO company_resolution_decisions (
        id, operation, subject_company_id, canonical_company_id, resolver_version,
        confidence, decision_json, actor_type, actor_id, reason
      ) VALUES (${decisionId}, ${"split"}, ${command.sourceCompanyId}, ${command.canonicalCompanyId},
        ${command.resolverVersion}, ${1}, ${JSON.stringify(command.fixtureExpected)}::text::jsonb,
        ${"operator"}, ${context.actorId}, ${command.reason})`;
      await tx`UPDATE company_merge_memberships SET split_decision_id = ${decisionId}, split_at = clock_timestamp()
        WHERE id = ${String(membership.id)}`;
      await tx`UPDATE companies SET resolution_status = ${String(membership.previous_status)},
        resolution_confidence = ${Number(membership.previous_confidence)} WHERE id = ${command.sourceCompanyId}`;
      await tx`INSERT INTO company_resolution_fixtures (id, fixture_key, input_json, expected_json, decision_id)
        VALUES (${uuid()}, ${command.fixtureKey}, ${JSON.stringify(command.fixtureInput)}::text::jsonb,
          ${JSON.stringify(command.fixtureExpected)}::text::jsonb, ${decisionId})`;
      const response = { decisionId, membershipId: membership.id, sourceCompanyId: command.sourceCompanyId, canonicalCompanyId: command.sourceCompanyId };
      await auditDecision(tx, context, "company_resolution.split", command.sourceCompanyId, command.reason, membership, response);
      return response;
    });
  }
}
