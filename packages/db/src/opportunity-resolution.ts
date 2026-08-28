import { createHash } from "node:crypto";
import { SQL } from "bun";
import {
  OPPORTUNITY_RESOLVER_VERSION,
  projectOpportunity,
  type OpportunityFieldAssertion,
  type OpportunityProjection,
  type OpportunityResolution,
} from "@career-os/opportunity-resolver";

export interface OpportunityDecisionContext {
  actorId: string;
  actorType: "system" | "operator";
  idempotencyKey: string;
}

interface FixtureCommand {
  fixtureKey: string;
  fixtureInput: Record<string, unknown>;
  reason: string;
}

export interface CreateOpportunityCommand extends FixtureCommand {
  companyId: string;
  sourceListingId: string;
  assertionIds: string[];
  firstSeenAt: string;
}

export interface AttachOpportunityCommand extends FixtureCommand {
  sourceListingId: string;
  opportunityId: string;
  resolution: Extract<OpportunityResolution, { action: "automatic_match" | "review" }>;
  reviewId?: string;
}

export interface SplitOpportunityCommand extends FixtureCommand {
  sourceListingId: string;
  opportunityId: string;
}

export interface RebuildOpportunityCommand extends FixtureCommand {
  opportunityId: string;
}

export class OpportunityResolutionError extends Error {
  constructor(public readonly code: string) {
    super(code);
    this.name = "OpportunityResolutionError";
  }
}

type AssertionRow = {
  id: string; source_listing_id: string; listing_version_id: string; field_path: OpportunityFieldAssertion["fieldPath"];
  value_json: unknown; origin: OpportunityFieldAssertion["origin"]; confidence: number; review_state: OpportunityFieldAssertion["reviewState"];
  artifact_id: string | null;
};

function uuid(): string { return Bun.randomUUIDv7(); }
function digest(value: unknown): string { return createHash("sha256").update(JSON.stringify(value)).digest("hex"); }
function jsonObject(value: unknown): Record<string, unknown> {
  return (typeof value === "string" ? JSON.parse(value) : value) as Record<string, unknown>;
}
function validUuid(value: string): boolean {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu.test(value);
}
function uuidArrayLiteral(values: string[]): string {
  if (!values.length || values.some((value) => !validUuid(value))) throw new OpportunityResolutionError("invalid_provenance_assertions");
  return `{${values.join(",")}}`;
}
function validateFixture(command: FixtureCommand): void {
  if (!/^[a-z0-9][a-z0-9._:-]{7,127}$/u.test(command.fixtureKey)) throw new OpportunityResolutionError("invalid_fixture_key");
  if (command.reason.trim().length < 8 || command.reason.length > 1_000) throw new OpportunityResolutionError("decision_reason_invalid");
  const fixture = JSON.stringify(command.fixtureInput);
  if (fixture.length > 262_144 || /"(?:authorization|cookie|password|passwd|secret|access[_-]?token|api[_-]?key)"\s*:/iu.test(fixture)
    || /\b(?:bearer|basic)\s+[A-Za-z0-9+/_.=-]{8,}/iu.test(fixture)) throw new OpportunityResolutionError("unsafe_fixture_input");
}
function safeUrl(value: unknown, field: string): string {
  if (typeof value !== "string" || value.length > 8_192) throw new OpportunityResolutionError(`invalid_projection_${field}`);
  const parsed = new URL(value);
  const sensitive = [...parsed.searchParams.keys()].some((name) => /(?:token|secret|signature|credential|password|passwd|api[-_]?key|authorization)/iu.test(name));
  if (parsed.protocol !== "https:" || parsed.username || parsed.password || parsed.hash || sensitive) {
    throw new OpportunityResolutionError(`invalid_projection_${field}`);
  }
  return parsed.toString();
}
function textField(value: unknown, field: string): string {
  if (typeof value !== "string" || !value.trim()) throw new OpportunityResolutionError(`invalid_projection_${field}`);
  return value;
}
function workplace(value: unknown): "remote" | "hybrid" | "onsite" | "unspecified" {
  if (value !== "remote" && value !== "hybrid" && value !== "onsite" && value !== "unspecified") {
    throw new OpportunityResolutionError("invalid_projection_workplaceType");
  }
  return value;
}

async function idempotent<T extends Record<string, unknown>>(
  sql: SQL, context: OpportunityDecisionContext, operation: string, command: unknown, mutate: (tx: SQL) => Promise<T>,
): Promise<T> {
  if (!/^[A-Za-z0-9._:-]{8,128}$/u.test(context.idempotencyKey) || !context.actorId.trim() || context.actorId.length > 200) {
    throw new OpportunityResolutionError("invalid_decision_context");
  }
  const requestHash = digest(command);
  return sql.begin(async (tx) => {
    const inserted = await tx<{ id: string }[]>`INSERT INTO idempotency_records
      (id, actor_id, operation, idempotency_key, request_hash)
      VALUES (${uuid()}, ${context.actorId}, ${operation}, ${context.idempotencyKey}, ${requestHash})
      ON CONFLICT (actor_id, operation, idempotency_key) DO NOTHING RETURNING id`;
    if (!inserted.length) {
      const row = (await tx<{ request_hash: string; response_json: unknown }[]>`SELECT request_hash, response_json
        FROM idempotency_records WHERE actor_id = ${context.actorId} AND operation = ${operation}
          AND idempotency_key = ${context.idempotencyKey} FOR UPDATE`)[0];
      if (!row || row.request_hash !== requestHash) throw new OpportunityResolutionError("idempotency_key_reused");
      if (row.response_json === null) throw new OpportunityResolutionError("idempotency_incomplete");
      return jsonObject(row.response_json) as T;
    }
    const response = await mutate(tx);
    await tx`UPDATE idempotency_records SET response_json = ${JSON.stringify(response)}::text::jsonb,
      completed_at = clock_timestamp() WHERE actor_id = ${context.actorId} AND operation = ${operation}
      AND idempotency_key = ${context.idempotencyKey}`;
    return response;
  });
}

function mapAssertions(rows: AssertionRow[]): OpportunityFieldAssertion[] {
  return rows.map((row) => ({ assertionId: row.id, sourceListingId: row.source_listing_id,
    listingVersionId: row.listing_version_id, fieldPath: row.field_path, value: row.value_json,
    origin: row.origin, confidence: Number(row.confidence), reviewState: row.review_state,
    artifactId: row.artifact_id ?? undefined }));
}

async function loadAssertions(tx: SQL, opportunityId: string, explicitIds?: string[]): Promise<AssertionRow[]> {
  if (explicitIds && (explicitIds.length < 6 || explicitIds.length > 100 || explicitIds.some((id) => !validUuid(id)))) {
    throw new OpportunityResolutionError("invalid_assertion_selection");
  }
  const rows = explicitIds
    ? await tx<AssertionRow[]>`SELECT assertion.id, version.source_listing_id, version.id AS listing_version_id,
        assertion.field_path, assertion.value_json, assertion.origin, assertion.confidence, assertion.review_state, assertion.artifact_id
      FROM field_assertions assertion JOIN listing_versions version ON version.id = assertion.target_id
      WHERE assertion.target_type = 'listing_version' AND assertion.id IN ${tx([...new Set(explicitIds)])}
      ORDER BY assertion.id`
    : await tx<AssertionRow[]>`SELECT assertion.id, version.source_listing_id, version.id AS listing_version_id,
        assertion.field_path, assertion.value_json, assertion.origin, assertion.confidence, assertion.review_state, assertion.artifact_id
      FROM opportunity_members member JOIN listing_versions version ON version.source_listing_id = member.source_listing_id
      JOIN field_assertions assertion ON assertion.target_type = 'listing_version' AND assertion.target_id = version.id
      WHERE member.opportunity_id = ${opportunityId} AND member.state <> 'human_rejected'
      ORDER BY assertion.id`;
  if (explicitIds && rows.length !== new Set(explicitIds).size) throw new OpportunityResolutionError("assertion_not_found");
  return rows;
}

async function writeProjection(tx: SQL, opportunityId: string, decisionId: string, rows: AssertionRow[]): Promise<OpportunityProjection> {
  const projection = projectOpportunity(mapAssertions(rows));
  const fields = projection.fields;
  const displayTitle = textField(fields.displayTitle, "displayTitle");
  const normalizedTitle = textField(fields.normalizedTitle, "normalizedTitle");
  const descriptionText = textField(fields.descriptionText, "descriptionText");
  const workplaceType = workplace(fields.workplaceType);
  const canonicalSourceUrl = safeUrl(fields.canonicalSourceUrl, "canonicalSourceUrl");
  const applyUrl = safeUrl(fields.applyUrl, "applyUrl");
  const employmentType = fields.employmentType === undefined ? null : textField(fields.employmentType, "employmentType");
  await tx`UPDATE opportunities SET display_title = ${displayTitle}, normalized_title = ${normalizedTitle},
    description_text = ${descriptionText}, workplace_type = ${workplaceType}, employment_type = ${employmentType},
    canonical_source_url = ${canonicalSourceUrl}, apply_url = ${applyUrl}, canonicalization_version = ${projection.resolverVersion},
    status = ${"active"}, possibly_closed_at = NULL, closed_at = NULL
    WHERE id = ${opportunityId}`;
  await tx`UPDATE field_assertions SET selected = false WHERE target_type = 'opportunity' AND target_id = ${opportunityId} AND selected`;
  for (const [fieldPath, evidence] of Object.entries(projection.provenance)) {
    const value = fields[fieldPath.slice(1)];
    const provenanceId = uuid();
    await tx`INSERT INTO opportunity_field_provenance
      (id, opportunity_id, decision_id, field_path, selected_source_assertion_id, alternative_source_assertion_ids, projected_value_json)
      VALUES (${provenanceId}, ${opportunityId}, ${decisionId}, ${fieldPath}, ${evidence.selectedAssertionId},
        ${uuidArrayLiteral(evidence.assertionIds)}::text::uuid[], ${JSON.stringify(value)}::text::jsonb)`;
    for (const assertionId of evidence.assertionIds) {
      await tx`INSERT INTO opportunity_field_provenance_alternatives (provenance_id, source_assertion_id)
        VALUES (${provenanceId}, ${assertionId})`;
    }
    await tx`INSERT INTO field_assertions (id, target_type, target_id, field_path, value_json, origin,
      extractor_id, extractor_version, confidence, review_state, selected)
      VALUES (${uuid()}, ${"opportunity"}, ${opportunityId}, ${fieldPath}, ${JSON.stringify(value)}::text::jsonb,
        ${"deterministic_rule"}, ${"opportunity_projection"}, ${projection.resolverVersion}, ${1}, ${"unreviewed"}, ${true})`;
  }
  return projection;
}

async function insertFixture(tx: SQL, command: FixtureCommand, expected: unknown, decisionId: string): Promise<void> {
  await tx`INSERT INTO opportunity_resolution_fixtures (id, fixture_key, input_json, expected_json, decision_id)
    VALUES (${uuid()}, ${command.fixtureKey}, ${JSON.stringify(command.fixtureInput)}::text::jsonb,
      ${JSON.stringify(expected)}::text::jsonb, ${decisionId})`;
}

async function validateAutomaticEvidence(
  tx: SQL, sourceListingId: string, opportunityId: string,
  resolution: Extract<OpportunityResolution, { action: "automatic_match" }>,
): Promise<void> {
  if (resolution.reason === "exact_requisition_key") {
    const rows = await tx<{ id: string; source_listing_id: string; field_path: string; value_json: unknown }[]>`SELECT assertion.id,
        version.source_listing_id, assertion.field_path, assertion.value_json FROM field_assertions assertion
      JOIN listing_versions version ON version.id = assertion.target_id
      WHERE assertion.target_type = 'listing_version' AND assertion.id IN ${tx(resolution.evidenceIds)}
        AND assertion.field_path IN ('/requisitionId', '/connectorMapping') AND assertion.review_state <> 'rejected'`;
    const incoming = rows.filter((row) => row.source_listing_id === sourceListingId);
    const existing = rows.filter((row) => row.source_listing_id !== sourceListingId);
    const existingIsMember = existing.length === 1 && (await tx<{ count: number }[]>`SELECT count(*)::int AS count
      FROM opportunity_members WHERE opportunity_id = ${opportunityId} AND source_listing_id = ${existing[0]?.source_listing_id ?? null}
        AND state <> 'human_rejected'`)[0]?.count === 1;
    if (rows.length !== 2 || incoming.length !== 1 || !existingIsMember || incoming[0]?.field_path !== existing[0]?.field_path
      || JSON.stringify(incoming[0]?.value_json).normalize("NFKC").toLocaleLowerCase("und")
        !== JSON.stringify(existing[0]?.value_json).normalize("NFKC").toLocaleLowerCase("und")) {
      throw new OpportunityResolutionError("requisition_evidence_mismatch");
    }
    return;
  }
  const paths = ["/normalizedTitle", "/descriptionText", "/workplaceType", "/locationSignature"];
  const rows = await tx<{ source_listing_id: string; field_path: string; value_json: unknown }[]>`SELECT version.source_listing_id,
      assertion.field_path, assertion.value_json FROM source_listings listing
    JOIN listing_versions version ON version.id = listing.current_version_id
    JOIN field_assertions assertion ON assertion.target_type = 'listing_version' AND assertion.target_id = version.id
    WHERE assertion.selected AND assertion.review_state <> 'rejected' AND assertion.field_path IN ${tx(paths)}
      AND (listing.id = ${sourceListingId} OR listing.id IN (SELECT source_listing_id FROM opportunity_members
        WHERE opportunity_id = ${opportunityId} AND state <> 'human_rejected'))`;
  const incoming = new Map(rows.filter((row) => row.source_listing_id === sourceListingId).map((row) => [row.field_path, row.value_json]));
  const memberIds = [...new Set(rows.filter((row) => row.source_listing_id !== sourceListingId).map((row) => row.source_listing_id))];
  const equivalent = memberIds.some((memberId) => paths.every((path) => {
    const candidate = rows.find((row) => row.source_listing_id === memberId && row.field_path === path)?.value_json;
    return incoming.has(path) && JSON.stringify(incoming.get(path)) === JSON.stringify(candidate);
  }));
  const interval = (await tx<{ overlaps: boolean }[]>`SELECT EXISTS (
      SELECT 1 FROM source_listings incoming JOIN opportunity_members member ON member.opportunity_id = ${opportunityId}
      JOIN source_listings existing ON existing.id = member.source_listing_id
      WHERE incoming.id = ${sourceListingId} AND member.state <> 'human_rejected'
        AND incoming.first_seen_at <= coalesce(existing.closed_at, 'infinity'::timestamptz)
        AND existing.first_seen_at <= coalesce(incoming.closed_at, 'infinity'::timestamptz)
    ) AS overlaps`)[0]?.overlaps;
  if (!equivalent || !interval) throw new OpportunityResolutionError("exact_content_evidence_mismatch");
}

async function audit(tx: SQL, context: OpportunityDecisionContext, action: string, opportunityId: string,
  reason: string, metadata: unknown): Promise<void> {
  await tx`INSERT INTO audit_events (id, actor_type, actor_id, action, target_type, target_id, reason, correlation_id, metadata)
    VALUES (${uuid()}, ${context.actorType}, ${context.actorId}, ${action}, ${"opportunity"}, ${opportunityId},
      ${reason}, ${uuid()}, ${JSON.stringify(metadata)}::text::jsonb)`;
}

export class PostgresOpportunityResolutionStore {
  constructor(private readonly sql: SQL) {}

  async queueReview(sourceListingId: string, resolution: Extract<OpportunityResolution, { action: "review" }>, priority = 0): Promise<{ reviewId: string }> {
    if (!validUuid(sourceListingId) || resolution.candidateOpportunityIds.length < 1 || resolution.candidateOpportunityIds.length > 10
      || resolution.candidateOpportunityIds.some((id) => !validUuid(id)) || new Set(resolution.candidateOpportunityIds).size !== resolution.candidateOpportunityIds.length) {
      throw new OpportunityResolutionError("invalid_opportunity_review");
    }
    const candidateJson = JSON.stringify({ ...resolution, sourceListingId });
    const rows = await this.sql<{ id: string }[]>`INSERT INTO resolution_reviews
      (id, review_type, target_type, target_id, candidate_json, priority)
      VALUES (${uuid()}, ${"opportunity_membership"}, ${"source_listing"}, ${sourceListingId}, ${candidateJson}::text::jsonb, ${priority})
      ON CONFLICT (review_type, target_type, target_id) WHERE state = 'pending'
      DO UPDATE SET priority = greatest(resolution_reviews.priority, EXCLUDED.priority) RETURNING id`;
    return { reviewId: rows[0]!.id };
  }

  create(context: OpportunityDecisionContext, command: CreateOpportunityCommand): Promise<Record<string, unknown>> {
    validateFixture(command);
    const seen = new Date(command.firstSeenAt);
    if (!Number.isFinite(seen.getTime()) || !validUuid(command.companyId) || !validUuid(command.sourceListingId)) {
      throw new OpportunityResolutionError("invalid_create_command");
    }
    return idempotent(this.sql, context, "opportunity_resolution.create", command, async (tx) => {
      const listing = (await tx<{ company_id: string | null }[]>`SELECT source.company_id FROM source_listings listing
        JOIN sources source ON source.id = listing.source_id WHERE listing.id = ${command.sourceListingId} FOR UPDATE OF listing`)[0];
      if (!listing || listing.company_id !== command.companyId) throw new OpportunityResolutionError("listing_company_mismatch");
      const company = (await tx<{ resolution_status: string }[]>`SELECT resolution_status FROM companies WHERE id = ${command.companyId}`)[0];
      if (company?.resolution_status !== "verified") throw new OpportunityResolutionError("company_not_verified");
      const rows = await loadAssertions(tx, "00000000-0000-0000-0000-000000000000", command.assertionIds);
      if (rows.some((row) => row.source_listing_id !== command.sourceListingId)) throw new OpportunityResolutionError("assertion_listing_mismatch");
      const preview = projectOpportunity(mapAssertions(rows));
      const opportunityId = uuid();
      await tx`INSERT INTO opportunities (id, company_id, display_title, normalized_title, description_text, workplace_type,
        canonical_source_url, apply_url, first_seen_at, canonicalization_version)
        VALUES (${opportunityId}, ${command.companyId}, ${"pending"}, ${"pending"}, ${"pending"}, ${"unspecified"},
          ${"https://invalid.example/"}, ${"https://invalid.example/"}, ${seen}, ${OPPORTUNITY_RESOLVER_VERSION})`;
      const membershipId = uuid();
      await tx`INSERT INTO opportunity_members (id, opportunity_id, source_listing_id, membership_reason, resolver_version, confidence, state)
        VALUES (${membershipId}, ${opportunityId}, ${command.sourceListingId}, ${"no_candidate"}, ${OPPORTUNITY_RESOLVER_VERSION}, ${1}, ${"automatic"})`;
      const decisionId = uuid();
      const expected = { action: "create_new", opportunityId, resolverVersion: OPPORTUNITY_RESOLVER_VERSION };
      await tx`INSERT INTO opportunity_resolution_decisions (id, operation, opportunity_id, source_listing_id, membership_id,
        resolver_version, confidence, decision_json, actor_type, actor_id, reason)
        VALUES (${decisionId}, ${"create"}, ${opportunityId}, ${command.sourceListingId}, ${membershipId},
          ${OPPORTUNITY_RESOLVER_VERSION}, ${1}, ${JSON.stringify(expected)}::text::jsonb,
          ${context.actorType}, ${context.actorId}, ${command.reason})`;
      await writeProjection(tx, opportunityId, decisionId, rows);
      await insertFixture(tx, command, { ...expected, projection: preview }, decisionId);
      const response = { opportunityId, membershipId, decisionId };
      await audit(tx, context, "opportunity_resolution.created", opportunityId, command.reason, response);
      return response;
    });
  }

  attach(context: OpportunityDecisionContext, command: AttachOpportunityCommand): Promise<Record<string, unknown>> {
    validateFixture(command);
    if (!validUuid(command.sourceListingId) || !validUuid(command.opportunityId)
      || (command.resolution.action === "automatic_match" && command.resolution.opportunityId !== command.opportunityId)
      || (command.resolution.action === "review" && !command.resolution.candidateOpportunityIds.includes(command.opportunityId))) {
      throw new OpportunityResolutionError("resolution_target_mismatch");
    }
    const reviewed = command.resolution.action === "review";
    const confidence = command.resolution.action === "automatic_match" ? command.resolution.confidence : 1;
    if (reviewed !== Boolean(command.reviewId) || (reviewed && context.actorType !== "operator")) {
      throw new OpportunityResolutionError("review_binding_required");
    }
    if (!reviewed && confidence < 0.97) throw new OpportunityResolutionError("automatic_confidence_too_low");
    if (command.resolution.action === "review" && (command.resolution.candidateOpportunityIds.length > 10
      || new Set(command.resolution.candidateOpportunityIds).size !== command.resolution.candidateOpportunityIds.length)) {
      throw new OpportunityResolutionError("invalid_resolution_contract");
    }
    const invalidAutomatic = command.resolution.action === "automatic_match"
      && (command.resolution.reason === "exact_requisition_key"
        ? confidence !== 1 || command.resolution.evidenceIds.length !== 2
          || new Set(command.resolution.evidenceIds).size !== 2 || command.resolution.evidenceIds.some((id) => !validUuid(id))
        : confidence !== 0.97 || command.resolution.evidenceIds.length !== 0);
    if (command.resolution.resolverVersion !== OPPORTUNITY_RESOLVER_VERSION || invalidAutomatic) {
      throw new OpportunityResolutionError("invalid_resolution_contract");
    }
    return idempotent(this.sql, context, "opportunity_resolution.attach", command, async (tx) => {
      const pair = (await tx<{ listing_company_id: string | null; opportunity_company_id: string }[]>`SELECT source.company_id AS listing_company_id,
          opportunity.company_id AS opportunity_company_id FROM source_listings listing JOIN sources source ON source.id = listing.source_id
          CROSS JOIN opportunities opportunity WHERE listing.id = ${command.sourceListingId} AND opportunity.id = ${command.opportunityId}
          FOR UPDATE OF listing, opportunity`)[0];
      if (!pair || pair.listing_company_id !== pair.opportunity_company_id) throw new OpportunityResolutionError("opportunity_company_mismatch");
      if (command.resolution.action === "automatic_match") {
        await validateAutomaticEvidence(tx, command.sourceListingId, command.opportunityId, command.resolution);
      }
      if (command.resolution.action === "review") {
        const review = (await tx<{ state: string; target_id: string; candidate_json: unknown }[]>`SELECT state, target_id, candidate_json
          FROM resolution_reviews WHERE id = ${command.reviewId!} AND review_type = 'opportunity_membership' FOR UPDATE`)[0];
        const candidate = review ? jsonObject(review.candidate_json) : undefined;
        const ids = candidate?.candidateOpportunityIds;
        if (!review || review.state !== "pending" || review.target_id !== command.sourceListingId || candidate?.sourceListingId !== command.sourceListingId
          || candidate?.action !== command.resolution.action || candidate?.reason !== command.resolution.reason
          || candidate?.resolverVersion !== command.resolution.resolverVersion || !Array.isArray(ids)
          || JSON.stringify([...ids].sort()) !== JSON.stringify([...command.resolution.candidateOpportunityIds].sort())) {
          throw new OpportunityResolutionError("opportunity_review_mismatch");
        }
        await tx`UPDATE resolution_reviews SET state = 'approved', decision_reason = ${command.reason}, decided_by = ${context.actorId},
          decided_at = clock_timestamp() WHERE id = ${command.reviewId!}`;
      }
      const proposedMembershipId = uuid();
      const membership = (await tx<{ id: string }[]>`INSERT INTO opportunity_members (id, opportunity_id, source_listing_id, membership_reason, resolver_version, confidence, state)
        VALUES (${proposedMembershipId}, ${command.opportunityId}, ${command.sourceListingId}, ${command.resolution.reason},
          ${command.resolution.resolverVersion}, ${confidence}, ${reviewed ? "human_confirmed" : "automatic"})
        ON CONFLICT (opportunity_id, source_listing_id) DO UPDATE SET membership_reason = EXCLUDED.membership_reason,
          resolver_version = EXCLUDED.resolver_version, confidence = EXCLUDED.confidence, state = EXCLUDED.state RETURNING id`)[0]!;
      const membershipId = membership.id;
      const decisionId = uuid();
      await tx`INSERT INTO opportunity_resolution_decisions (id, operation, opportunity_id, source_listing_id, membership_id, review_id,
        resolver_version, confidence, decision_json, actor_type, actor_id, reason)
        VALUES (${decisionId}, ${"attach"}, ${command.opportunityId}, ${command.sourceListingId}, ${membershipId}, ${command.reviewId ?? null},
          ${command.resolution.resolverVersion}, ${confidence},
          ${JSON.stringify(command.resolution)}::text::jsonb, ${context.actorType}, ${context.actorId}, ${command.reason})`;
      const rows = await loadAssertions(tx, command.opportunityId);
      await writeProjection(tx, command.opportunityId, decisionId, rows);
      await insertFixture(tx, command, command.resolution, decisionId);
      const response = { opportunityId: command.opportunityId, membershipId, decisionId };
      await audit(tx, context, "opportunity_resolution.attached", command.opportunityId, command.reason, response);
      return response;
    });
  }

  split(context: OpportunityDecisionContext, command: SplitOpportunityCommand): Promise<Record<string, unknown>> {
    validateFixture(command);
    if (context.actorType !== "operator") throw new OpportunityResolutionError("operator_required");
    return idempotent(this.sql, context, "opportunity_resolution.split", command, async (tx) => {
      const member = (await tx<{ id: string }[]>`SELECT id FROM opportunity_members WHERE opportunity_id = ${command.opportunityId}
        AND source_listing_id = ${command.sourceListingId} AND state <> 'human_rejected' FOR UPDATE`)[0];
      if (!member) throw new OpportunityResolutionError("active_membership_not_found");
      await tx`UPDATE opportunity_members SET state = 'human_rejected', membership_reason = ${command.reason},
        resolver_version = ${OPPORTUNITY_RESOLVER_VERSION}, confidence = 1 WHERE id = ${member.id}`;
      const decisionId = uuid();
      const expected = { action: "split", opportunityId: command.opportunityId, sourceListingId: command.sourceListingId };
      await tx`INSERT INTO opportunity_resolution_decisions (id, operation, opportunity_id, source_listing_id, membership_id,
        resolver_version, confidence, decision_json, actor_type, actor_id, reason)
        VALUES (${decisionId}, ${"split"}, ${command.opportunityId}, ${command.sourceListingId}, ${member.id},
          ${OPPORTUNITY_RESOLVER_VERSION}, ${1}, ${JSON.stringify(expected)}::text::jsonb, ${"operator"}, ${context.actorId}, ${command.reason})`;
      const remaining = await loadAssertions(tx, command.opportunityId);
      if (remaining.length) await writeProjection(tx, command.opportunityId, decisionId, remaining);
      else await tx`UPDATE opportunities SET status = 'closed', closed_at = clock_timestamp() WHERE id = ${command.opportunityId}`;
      await insertFixture(tx, command, expected, decisionId);
      const response = { opportunityId: command.opportunityId, membershipId: member.id, decisionId };
      await audit(tx, context, "opportunity_resolution.split", command.opportunityId, command.reason, response);
      return response;
    });
  }

  rebuild(context: OpportunityDecisionContext, command: RebuildOpportunityCommand): Promise<Record<string, unknown>> {
    validateFixture(command);
    return idempotent(this.sql, context, "opportunity_resolution.rebuild", command, async (tx) => {
      const opportunity = (await tx<{ id: string }[]>`SELECT id FROM opportunities WHERE id = ${command.opportunityId} FOR UPDATE`)[0];
      if (!opportunity) throw new OpportunityResolutionError("opportunity_not_found");
      const rows = await loadAssertions(tx, command.opportunityId);
      const decisionId = uuid();
      const expected = { action: "rebuild", opportunityId: command.opportunityId, resolverVersion: OPPORTUNITY_RESOLVER_VERSION };
      await tx`INSERT INTO opportunity_resolution_decisions (id, operation, opportunity_id, resolver_version, confidence,
        decision_json, actor_type, actor_id, reason) VALUES (${decisionId}, ${"rebuild"}, ${command.opportunityId},
        ${OPPORTUNITY_RESOLVER_VERSION}, ${1}, ${JSON.stringify(expected)}::text::jsonb, ${context.actorType}, ${context.actorId}, ${command.reason})`;
      const projection = await writeProjection(tx, command.opportunityId, decisionId, rows);
      await insertFixture(tx, command, { ...expected, projection }, decisionId);
      const response = { opportunityId: command.opportunityId, decisionId, projection };
      await audit(tx, context, "opportunity_resolution.rebuilt", command.opportunityId, command.reason, { decisionId });
      return response;
    });
  }
}
