import { createHash } from "node:crypto";
import type { SQL } from "bun";
import { CLOSURE_CONFIRMATION_MS, EMPTY_REVIEW_VALID_MS, qualifiesHistoricalEmptyPair } from "@career-os/lifecycle";

export class EmptyBoardError extends Error {
  constructor(readonly code: string) { super(code); this.name = "EmptyBoardError"; }
}

export interface EmptyBoardContext { actorId: string; idempotencyKey: string }
export interface ConfirmEmptyBoardInput {
  firstScanId: string;
  secondScanId: string;
  ownershipEvidenceId: string;
  employerCareersUrl: string;
  attestsExactBoardLink: true;
  reason: string;
}
export interface CloseEmptyBoardInput {
  confirmationId: string;
  expectedListingCount: number;
  reason: string;
}

function uuid(): string { return Bun.randomUUIDv7(); }
function reviewUrl(value: string): string | null {
  try {
    const url = new URL(value);
    if (url.protocol !== "https:") return null;
    url.username = ""; url.password = ""; url.search = ""; url.hash = "";
    return url.href;
  } catch { return null; }
}
function parseJson(value: unknown): Record<string, unknown> {
  const parsed = typeof value === "string" ? JSON.parse(value) : value;
  return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed as Record<string, unknown> : {};
}
function validContext(context: EmptyBoardContext, reason: string): void {
  if (!context.actorId.trim() || context.actorId.length > 200
    || !/^[A-Za-z0-9._:-]{8,128}$/u.test(context.idempotencyKey)) throw new EmptyBoardError("invalid_decision_context");
  if (reason.trim().length < 8 || reason.length > 1_000) throw new EmptyBoardError("invalid_decision_reason");
}
async function idempotent<T extends Record<string, unknown>>(sql: SQL, context: EmptyBoardContext,
  operation: string, request: unknown, mutate: (tx: SQL) => Promise<T>): Promise<T> {
  const requestHash = createHash("sha256").update(JSON.stringify(request)).digest("hex");
  return sql.begin(async (tx) => {
    const inserted = await tx<{ id: string }[]>`INSERT INTO idempotency_records
      (id, actor_id, operation, idempotency_key, request_hash)
      VALUES (${uuid()}, ${context.actorId}, ${operation}, ${context.idempotencyKey}, ${requestHash})
      ON CONFLICT (actor_id, operation, idempotency_key) DO NOTHING RETURNING id`;
    if (!inserted.length) {
      const prior = (await tx<{ request_hash: string; response_json: unknown }[]>`SELECT request_hash, response_json
        FROM idempotency_records WHERE actor_id = ${context.actorId} AND operation = ${operation}
          AND idempotency_key = ${context.idempotencyKey} FOR UPDATE`)[0];
      if (!prior || prior.request_hash !== requestHash || prior.response_json === null) throw new EmptyBoardError("idempotency_replay_mismatch");
      return parseJson(prior.response_json) as T;
    }
    const response = await mutate(tx);
    await tx`UPDATE idempotency_records SET response_json = ${JSON.stringify(response)}::text::jsonb,
      completed_at = clock_timestamp() WHERE actor_id = ${context.actorId} AND operation = ${operation}
      AND idempotency_key = ${context.idempotencyKey}`;
    return response;
  });
}

async function audit(tx: SQL, context: EmptyBoardContext, action: string, sourceId: string,
  reason: string, metadata: Record<string, unknown>): Promise<void> {
  await tx`INSERT INTO audit_events (id, actor_type, actor_id, action, target_type, target_id, reason, correlation_id, metadata)
    VALUES (${uuid()}, ${"operator"}, ${context.actorId}, ${action}, ${"source"}, ${sourceId}, ${reason}, ${uuid()},
      ${JSON.stringify({ ...metadata, idempotencyKey: context.idempotencyKey })}::text::jsonb)`;
}

async function lifecycleEvent(tx: SQL, type: "source_listing" | "opportunity", id: string,
  event: string, scanId: string, listingId: string | null, actorId: string, reason: string): Promise<void> {
  const sequence = (await tx<{ next: number }[]>`SELECT coalesce(max(sequence), 0)::int + 1 AS next
    FROM lifecycle_events WHERE aggregate_type = ${type} AND aggregate_id = ${id}`)[0]!.next;
  await tx`INSERT INTO lifecycle_events (id, aggregate_type, aggregate_id, sequence, event_type, occurred_at,
    source_scan_id, source_listing_id, reason_code, actor_type, actor_id)
    VALUES (${uuid()}, ${type}, ${id}, ${sequence}, ${event}, clock_timestamp(), ${scanId}, ${listingId},
      ${reason}, ${"operator"}, ${actorId})`;
}

export async function projectSourceOpportunities(tx: SQL, sourceId: string, scanId: string,
  actorId: string, reason: string): Promise<void> {
  const opportunities = await tx<{ id: string; status: string }[]>`SELECT opportunity.id, opportunity.status
    FROM opportunities opportunity WHERE opportunity.id IN (
      SELECT member.opportunity_id FROM opportunity_members member JOIN source_listings listing
        ON listing.id = member.source_listing_id WHERE listing.source_id = ${sourceId} AND member.state <> 'human_rejected')
    ORDER BY opportunity.id FOR UPDATE`;
  for (const opportunity of opportunities) {
    const members = await tx<{ lifecycle_state: string }[]>`SELECT listing.lifecycle_state
      FROM opportunity_members member JOIN source_listings listing ON listing.id = member.source_listing_id
      WHERE member.opportunity_id = ${opportunity.id} AND member.state <> 'human_rejected'`;
    const desired = members.some((item) => item.lifecycle_state === "active") ? "active"
      : members.some((item) => item.lifecycle_state === "possibly_closed") ? "possibly_closed" : "closed";
    if (desired === opportunity.status) continue;
    await tx`UPDATE opportunities SET status = ${desired},
      possibly_closed_at = ${desired === "possibly_closed" ? new Date() : null},
      closed_at = ${desired === "closed" ? new Date() : null} WHERE id = ${opportunity.id}`;
    await lifecycleEvent(tx, "opportunity", opportunity.id,
      desired === "active" ? "reopened" : desired, scanId, null, actorId, reason);
  }
}

type PairScan = { id: string; source_id: string; completeness_reason: string; completeness_state: string;
  http_outcome: string; observed_job_count: number; board_hash: string | null; ended_at: Date | string;
  connector_id: string; connector_version: string; policy_id: string; policy_row_version: number | null;
  safe_fetch_policy_version: string; response_count: number };

export class PostgresEmptyBoards {
  constructor(private readonly sql: SQL) {}

  async reviews(): Promise<Record<string, unknown>> {
    const rows = await this.sql<(Record<string, unknown> & { boardUrl: string })[]>`SELECT review.id, review.source_id AS "sourceId",
      review.first_scan_id AS "firstScanId", review.second_scan_id AS "secondScanId",
      review.connector_id AS "connectorId", review.connector_version AS "connectorVersion",
      review.historical_listing_count AS "historicalListingCount", review.created_at AS "createdAt",
      source.health_state AS "healthState", source.inventory_state AS "inventoryState",
      source.board_url AS "boardUrl",
      (SELECT count(*)::int FROM source_listings listing WHERE listing.source_id = source.id
        AND listing.lifecycle_state <> 'closed') AS "activeListingCount"
      FROM source_empty_reviews review JOIN sources source ON source.id = review.source_id
      WHERE review.state = 'pending' ORDER BY review.created_at, review.id LIMIT 200`;
    const confirmations = await this.sql<(Record<string, unknown> & { boardUrl: string })[]>`
      SELECT confirmation.id AS "confirmationId", confirmation.source_id AS "sourceId",
        confirmation.valid_until AS "validUntil", source.health_state AS "healthState",
        source.inventory_state AS "inventoryState", source.board_url AS "boardUrl",
        (SELECT count(*)::int FROM source_listings listing WHERE listing.source_id = source.id
          AND listing.closure_hold_confirmation_id = confirmation.id) AS "heldListingCount"
      FROM source_empty_confirmations confirmation JOIN sources source ON source.id = confirmation.source_id
      WHERE confirmation.valid_until > clock_timestamp() AND NOT EXISTS (
        SELECT 1 FROM source_empty_confirmation_events event WHERE event.confirmation_id = confirmation.id
          AND event.event_type = 'invalidated')
      ORDER BY confirmation.confirmed_at DESC LIMIT 200`;
    return { reviews: rows.map(({ boardUrl, ...row }) => ({ ...row, boardUrl: reviewUrl(boardUrl) })),
      confirmations: confirmations.map(({ boardUrl, ...row }) => ({ ...row, boardUrl: reviewUrl(boardUrl) })) };
  }

  async confirm(context: EmptyBoardContext, reviewId: string, input: ConfirmEmptyBoardInput): Promise<Record<string, unknown>> {
    validContext(context, input.reason);
    if (input.attestsExactBoardLink !== true) throw new EmptyBoardError("board_link_attestation_required");
    let checkedUrl: URL;
    try { checkedUrl = new URL(input.employerCareersUrl); } catch { throw new EmptyBoardError("invalid_employer_evidence_url"); }
    if (checkedUrl.protocol !== "https:" || checkedUrl.username || checkedUrl.password || checkedUrl.port || checkedUrl.hash) {
      throw new EmptyBoardError("invalid_employer_evidence_url");
    }
    return idempotent(this.sql, context, "empty_board.confirm", { reviewId, input }, async (tx) => {
      const review = (await tx<{ id: string; source_id: string; first_scan_id: string; second_scan_id: string;
        board_hash: string; connector_id: string; connector_version: string; tenant_key: string;
        board_url: string; api_base_url: string; region: string; policy_id: string;
        policy_row_version: number; safe_fetch_policy_version: string;
        historical_listing_count: number; state: string }[]>`SELECT * FROM source_empty_reviews WHERE id = ${reviewId} FOR UPDATE`)[0];
      if (!review || review.state !== "pending") throw new EmptyBoardError("pending_empty_review_not_found");
      const source = (await tx<{ id: string; company_id: string; connector_id: string; connector_version: string;
        tenant_key: string; board_url: string; api_base_url: string; region: string; policy_id: string;
        policy_row_version: number; enabled: boolean; health_state: string; inventory_state: string;
        last_job_count: number | null; policy_review_due_at: Date | string; primary_domain: string;
        policy_state: string; policy_expires_at: Date | string }[]>`SELECT source.id, source.company_id, source.connector_id,
        source.connector_version, source.tenant_key, source.board_url, source.api_base_url, source.region,
        source.policy_id, policy.row_version AS policy_row_version, source.enabled, source.health_state,
        source.inventory_state, source.last_job_count, source.policy_review_due_at,
        company.primary_domain, policy.state AS policy_state, policy.expires_at AS policy_expires_at
        FROM sources source JOIN companies company ON company.id = source.company_id
        JOIN source_policies policy ON policy.id = source.policy_id WHERE source.id = ${review.source_id} FOR UPDATE OF source`)[0];
      if (!source || !source.enabled || source.health_state !== "degraded" || source.inventory_state !== "suspected_empty"
        || source.last_job_count !== 0 || source.policy_state !== "approved"
        || new Date(source.policy_review_due_at).getTime() <= Date.now()
        || new Date(source.policy_expires_at).getTime() <= Date.now()) throw new EmptyBoardError("source_not_reviewable");
      if (source.connector_id !== review.connector_id || source.connector_version !== review.connector_version
        || source.tenant_key !== review.tenant_key || source.policy_id !== review.policy_id
        || source.board_url !== review.board_url || source.api_base_url !== review.api_base_url
        || source.region !== review.region || source.policy_row_version !== review.policy_row_version
        || review.first_scan_id !== input.firstScanId || review.second_scan_id !== input.secondScanId) {
        throw new EmptyBoardError("empty_review_snapshot_mismatch");
      }
      const domain = source.primary_domain.toLowerCase();
      const host = checkedUrl.hostname.toLowerCase();
      if (host !== domain && !host.endsWith(`.${domain}`)) throw new EmptyBoardError("employer_domain_mismatch");
      const evidence = (await tx<{ id: string }[]>`SELECT id FROM ownership_evidence WHERE id = ${input.ownershipEvidenceId}
        AND source_id = ${source.id} AND company_id = ${source.company_id} AND confidence >= 0.9`)[0];
      if (!evidence) throw new EmptyBoardError("ownership_evidence_not_found");
      const scans = await tx<PairScan[]>`SELECT id, source_id, completeness_reason, completeness_state, http_outcome,
        observed_job_count, board_hash, ended_at, connector_id, connector_version, policy_id,
        policy_row_version, safe_fetch_policy_version, response_count
        FROM source_scans WHERE id IN (${input.firstScanId}, ${input.secondScanId}) ORDER BY ended_at, id`;
      if (scans.length !== 2 || scans[0]!.id !== input.firstScanId || scans[1]!.id !== input.secondScanId
        || scans.some((scan) => scan.source_id !== source.id || scan.connector_id !== source.connector_id
          || scan.connector_version !== source.connector_version || scan.policy_id !== source.policy_id
          || scan.policy_row_version !== source.policy_row_version
          || scan.safe_fetch_policy_version !== review.safe_fetch_policy_version
          || scan.completeness_state !== "incomplete" || scan.http_outcome !== "succeeded" || scan.response_count < 1)
        || !qualifiesHistoricalEmptyPair({ firstReason: scans[0]!.completeness_reason,
          secondReason: scans[1]!.completeness_reason, firstJobCount: scans[0]!.observed_job_count,
          secondJobCount: scans[1]!.observed_job_count, firstBoardHash: scans[0]!.board_hash,
          secondBoardHash: scans[1]!.board_hash, firstEndedAt: new Date(scans[0]!.ended_at).toISOString(),
          secondEndedAt: new Date(scans[1]!.ended_at).toISOString() })
        || scans[1]!.board_hash !== review.board_hash || Date.now() - new Date(scans[1]!.ended_at).getTime() > 24 * 60 * 60_000) {
        throw new EmptyBoardError("empty_scan_pair_invalid");
      }
      const later = (await tx<{ count: number }[]>`SELECT count(*)::int AS count FROM source_scans
        WHERE source_id = ${source.id} AND ended_at > ${scans[0]!.ended_at}
          AND (completeness_reason <> 'suspicious_empty' OR board_hash IS DISTINCT FROM ${review.board_hash}
            OR observed_job_count <> 0 OR http_outcome <> 'succeeded')`)[0]?.count ?? 0;
      const breaker = (await tx<{ count: number }[]>`SELECT count(*)::int AS count FROM lifecycle_circuit_breakers
        WHERE state = 'tripped' AND ((scope_type = 'source' AND source_id = ${source.id})
          OR (scope_type = 'connector_version' AND connector_id = ${source.connector_id}
            AND connector_version = ${source.connector_version}))`)[0]?.count ?? 0;
      if (later || breaker) throw new EmptyBoardError("empty_evidence_superseded");
      const confirmationId = uuid();
      const validUntil = new Date(Date.now() + EMPTY_REVIEW_VALID_MS);
      await tx`INSERT INTO source_empty_confirmations (id, review_id, source_id, first_scan_id, second_scan_id,
        board_hash, connector_id, connector_version, tenant_key, board_url, api_base_url, region,
        policy_id, policy_row_version, safe_fetch_policy_version, ownership_evidence_id,
        employer_careers_url, confirmed_by, reason, valid_until)
        VALUES (${confirmationId}, ${reviewId}, ${source.id}, ${input.firstScanId}, ${input.secondScanId},
          ${review.board_hash}, ${source.connector_id}, ${source.connector_version}, ${source.tenant_key},
          ${source.board_url}, ${source.api_base_url}, ${source.region}, ${source.policy_id},
          ${source.policy_row_version}, ${review.safe_fetch_policy_version}, ${input.ownershipEvidenceId},
          ${checkedUrl.href}, ${context.actorId},
          ${input.reason}, ${validUntil})`;
      const listings = await tx<{ id: string; lifecycle_state: string }[]>`SELECT id, lifecycle_state FROM source_listings
        WHERE source_id = ${source.id} AND lifecycle_state <> 'closed' ORDER BY id FOR UPDATE`;
      for (const listing of listings) {
        await tx`UPDATE source_listings SET lifecycle_state = 'possibly_closed',
          first_missing_at = coalesce(first_missing_at, ${scans[1]!.ended_at}),
          consecutive_complete_misses = greatest(consecutive_complete_misses, 1),
          closure_hold_confirmation_id = ${confirmationId} WHERE id = ${listing.id}`;
        if (listing.lifecycle_state === "active") await lifecycleEvent(tx, "source_listing", listing.id,
          "possibly_closed", input.secondScanId, listing.id, context.actorId, "operator_verified_empty_hold");
      }
      await projectSourceOpportunities(tx, source.id, input.secondScanId, context.actorId, "source_empty_review_projection");
      await tx`UPDATE source_empty_reviews SET state = 'approved', decided_by = ${context.actorId},
        decision_reason = ${input.reason}, decided_at = clock_timestamp() WHERE id = ${reviewId}`;
      const jobId = uuid();
      const payload = JSON.stringify({ sourceId: source.id, connectorId: source.connector_id,
        connectorVersion: source.connector_version, tenantKey: source.tenant_key, emptyConfirmationId: confirmationId });
      await tx`INSERT INTO work_jobs (id, type, dedupe_key, payload_json, priority, scheduled_at)
        VALUES (${jobId}, ${"scan_source"}, ${`scan_source:${source.id}:empty-confirmation:${confirmationId}`},
          ${payload}::text::jsonb, ${10}, clock_timestamp())`;
      await audit(tx, context, "empty_board.confirmed", source.id, input.reason,
        { reviewId, confirmationId, firstScanId: input.firstScanId, secondScanId: input.secondScanId,
          heldListings: listings.length, canaryJobId: jobId });
      return { confirmationId, sourceId: source.id, heldListings: listings.length, canaryJobId: jobId };
    });
  }

  async reject(context: EmptyBoardContext, reviewId: string, reason: string): Promise<Record<string, unknown>> {
    validContext(context, reason);
    return idempotent(this.sql, context, "empty_board.reject", { reviewId, reason }, async (tx) => {
      const review = (await tx<{ source_id: string; state: string }[]>`SELECT source_id, state
        FROM source_empty_reviews WHERE id = ${reviewId} FOR UPDATE`)[0];
      if (!review || review.state !== "pending") throw new EmptyBoardError("pending_empty_review_not_found");
      await tx`UPDATE source_empty_reviews SET state = 'rejected', decided_by = ${context.actorId},
        decision_reason = ${reason}, decided_at = clock_timestamp() WHERE id = ${reviewId}`;
      await audit(tx, context, "empty_board.rejected", review.source_id, reason, { reviewId });
      return { reviewId, sourceId: review.source_id, state: "rejected" };
    });
  }

  async close(context: EmptyBoardContext, sourceId: string, input: CloseEmptyBoardInput): Promise<Record<string, unknown>> {
    validContext(context, input.reason);
    if (!Number.isSafeInteger(input.expectedListingCount) || input.expectedListingCount < 1) throw new EmptyBoardError("invalid_expected_listing_count");
    return idempotent(this.sql, context, "empty_board.bulk_close", { sourceId, input }, async (tx) => {
      const source = (await tx<{ health_state: string; inventory_state: string; policy_review_due_at: Date | string;
        policy_id: string; connector_id: string; connector_version: string; tenant_key: string;
        board_url: string; api_base_url: string; region: string; policy_row_version: number;
        policy_state: string; policy_expires_at: Date | string }[]>`SELECT source.health_state,
        source.inventory_state, source.policy_review_due_at, source.policy_id, source.connector_id,
        source.connector_version, source.tenant_key, source.board_url, source.api_base_url, source.region,
        policy.row_version AS policy_row_version, policy.state AS policy_state,
        policy.expires_at AS policy_expires_at FROM sources source JOIN source_policies policy
        ON policy.id = source.policy_id WHERE source.id = ${sourceId} FOR UPDATE OF source`)[0];
      if (!source || source.health_state !== "healthy" || source.inventory_state !== "confirmed_empty"
        || source.policy_state !== "approved" || new Date(source.policy_review_due_at).getTime() <= Date.now()
        || new Date(source.policy_expires_at).getTime() <= Date.now()) throw new EmptyBoardError("source_not_closable");
      const confirmation = (await tx<{ id: string; board_hash: string; confirmed_at: Date | string }[]>`SELECT id, board_hash,
        confirmed_at FROM source_empty_confirmations confirmation WHERE id = ${input.confirmationId}
        AND source_id = ${sourceId} AND connector_id = ${source.connector_id}
        AND connector_version = ${source.connector_version} AND tenant_key = ${source.tenant_key}
        AND board_url = ${source.board_url} AND api_base_url = ${source.api_base_url} AND region = ${source.region}
        AND policy_id = ${source.policy_id} AND policy_row_version = ${source.policy_row_version}
        AND valid_until > clock_timestamp()
        AND NOT EXISTS (SELECT 1 FROM source_empty_confirmation_events event
          WHERE event.confirmation_id = confirmation.id AND event.event_type = 'invalidated')`)[0];
      if (!confirmation) throw new EmptyBoardError("active_empty_confirmation_not_found");
      const breaker = (await tx<{ count: number }[]>`SELECT count(*)::int AS count FROM lifecycle_circuit_breakers
        WHERE state = 'tripped' AND ((scope_type = 'source' AND source_id = ${sourceId})
          OR (scope_type = 'connector_version' AND connector_id = ${source.connector_id}
            AND connector_version = ${source.connector_version}))`)[0]?.count ?? 0;
      if (breaker) throw new EmptyBoardError("source_breaker_active");
      const scans = await tx<{ id: string; ended_at: Date | string }[]>`SELECT id, ended_at FROM source_scans
        WHERE source_id = ${sourceId} AND ended_at > ${confirmation.confirmed_at}
          AND completeness_reason = 'complete' AND observed_job_count = 0 AND board_hash = ${confirmation.board_hash}
          AND fetch_metadata->>'emptyConfirmationId' = ${confirmation.id}
        ORDER BY ended_at DESC, id DESC LIMIT 2`;
      if (scans.length !== 2 || new Date(scans[0]!.ended_at).getTime() - new Date(scans[1]!.ended_at).getTime() < CLOSURE_CONFIRMATION_MS
        || Date.now() - new Date(scans[0]!.ended_at).getTime() > 24 * 60 * 60_000) throw new EmptyBoardError("insufficient_post_review_scans");
      const latest = (await tx<{ id: string }[]>`SELECT id FROM source_scans WHERE source_id = ${sourceId}
        ORDER BY ended_at DESC, id DESC LIMIT 1`)[0];
      if (latest?.id !== scans[0]!.id) throw new EmptyBoardError("latest_scan_not_verified_empty");
      const intervening = (await tx<{ count: number }[]>`SELECT count(*)::int AS count FROM source_scans
        WHERE source_id = ${sourceId} AND ended_at > ${scans[1]!.ended_at} AND ended_at < ${scans[0]!.ended_at}
          AND (completeness_reason <> 'complete' OR observed_job_count <> 0
            OR board_hash IS DISTINCT FROM ${confirmation.board_hash} OR http_outcome <> 'succeeded')`)[0]?.count ?? 0;
      if (intervening) throw new EmptyBoardError("intervening_scan_disqualified_closure");
      const listings = await tx<{ id: string }[]>`SELECT id FROM source_listings
        WHERE source_id = ${sourceId} AND closure_hold_confirmation_id = ${confirmation.id}
          AND lifecycle_state = 'possibly_closed' ORDER BY id FOR UPDATE`;
      if (listings.length !== input.expectedListingCount) throw new EmptyBoardError("held_listing_count_mismatch");
      const decisionId = uuid();
      await tx`INSERT INTO source_empty_closure_decisions (id, confirmation_id, source_id, first_scan_id,
        second_scan_id, expected_listing_count, closed_listing_count, decided_by, reason)
        VALUES (${decisionId}, ${confirmation.id}, ${sourceId}, ${scans[1]!.id}, ${scans[0]!.id},
          ${input.expectedListingCount}, ${listings.length}, ${context.actorId}, ${input.reason})`;
      for (const listing of listings) {
        await tx`UPDATE source_listings SET lifecycle_state = 'closed', closed_at = clock_timestamp(),
          closure_hold_confirmation_id = NULL WHERE id = ${listing.id}`;
        await lifecycleEvent(tx, "source_listing", listing.id, "closed", scans[0]!.id, listing.id,
          context.actorId, "operator_verified_empty_closure");
      }
      await projectSourceOpportunities(tx, sourceId, scans[0]!.id, context.actorId, "source_empty_closure_projection");
      await tx`INSERT INTO source_empty_confirmation_events (id, confirmation_id, event_type, source_scan_id,
        actor_type, actor_id, reason) VALUES (${uuid()}, ${confirmation.id}, ${"bulk_closed"}, ${scans[0]!.id},
          ${"operator"}, ${context.actorId}, ${input.reason})`;
      await audit(tx, context, "empty_board.bulk_closed", sourceId, input.reason,
        { decisionId, confirmationId: confirmation.id, closedListings: listings.length });
      return { decisionId, sourceId, closedListings: listings.length };
    });
  }
}
