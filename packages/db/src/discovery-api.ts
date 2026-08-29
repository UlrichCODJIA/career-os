import { createHash } from "node:crypto";
import { SQL } from "bun";
import {
  DiscoveryApiError, decodeCompanyCursor, decodeCursor, encodeCompanyCursor, encodeCursor,
  type CompanyPage, type DiscoveryReadService, type OpportunityFilters, type OpportunityPage,
  type ProblemReportInput, type PublicOpportunityItem,
} from "@career-os/discovery-api";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;
type SearchRow = {
  id: string; company_id: string; company_name: string; company_domain: string | null; title: string;
  workplace_mode: string; locations: unknown; compensation: unknown; source_posted_at: Date | string | null;
  first_seen_at: Date | string; last_verified_open_at: Date | string; apply_url: string; source_count: number;
  provenance_coverage: number; status: string; relevance: number; compensation_sort: number | null;
};
function iso(value: Date | string): string { return new Date(value).toISOString(); }
function jsonArray(value: unknown): unknown[] { const parsed = typeof value === "string" ? JSON.parse(value) : value; return Array.isArray(parsed) ? parsed : []; }
function jsonValue(value: unknown): unknown { return typeof value === "string" ? JSON.parse(value) : value; }
function idempotencyHash(value: unknown): string { return createHash("sha256").update(JSON.stringify(value)).digest("hex"); }
function uuid(): string { return Bun.randomUUIDv7(); }
function requireUuid(value: string, code = "not_found"): void { if (!UUID.test(value)) throw new DiscoveryApiError(code, code === "not_found" ? 404 : 400); }
function like(value: string | undefined): string | null { return value ? `%${value.replaceAll("\\", "\\\\").replaceAll("%", "\\%").replaceAll("_", "\\_")}%` : null; }

export class PostgresDiscoveryApi implements DiscoveryReadService {
  constructor(private readonly sql: SQL) {}

  async searchOpportunities(filters: OpportunityFilters): Promise<OpportunityPage> {
    const after = decodeCursor("opportunities", filters);
    const timeSort = filters.sort === "first_seen_desc" || filters.sort === "source_posted_desc";
    if (after && ((timeSort && typeof after.primary !== "string") || (!timeSort && typeof after.primary !== "number"))) throw new DiscoveryApiError("invalid_cursor");
    const afterTime = after && timeSort ? new Date(after.primary as string) : null;
    if (afterTime && !Number.isFinite(afterTime.getTime())) throw new DiscoveryApiError("invalid_cursor");
    const afterNumber = after && !timeSort ? after.primary as number : null;
    const rows = await this.sql<SearchRow[]>`
      WITH result AS (
        SELECT opportunity.id, canonical.id AS company_id, canonical.display_name AS company_name,
          canonical.primary_domain AS company_domain, opportunity.display_title AS title,
          opportunity.workplace_type AS workplace_mode, opportunity.source_posted_at, opportunity.first_seen_at,
          opportunity.apply_url, opportunity.status,
          coalesce(member.last_verified_open_at, opportunity.first_seen_at) AS last_verified_open_at,
          coalesce(member.source_count, 0)::int AS source_count,
          least(1.0, coalesce(provenance.field_count, 0)::numeric / 6)::float8 AS provenance_coverage,
          coalesce(ts_rank(opportunity.search_document, websearch_to_tsquery('simple', coalesce(${filters.q ?? null}, ''))), 0)::float8 AS relevance,
          compensation.compensation_sort::float8,
          coalesce(locations.items, '[]'::jsonb) AS locations,
          compensation.item AS compensation
        FROM opportunities opportunity
        JOIN canonical_company_resolution resolution ON resolution.source_company_id = opportunity.company_id
        JOIN companies canonical ON canonical.id = resolution.canonical_company_id
        LEFT JOIN LATERAL (
          SELECT max(listing.last_seen_open_at) AS last_verified_open_at, count(*) AS source_count
          FROM opportunity_members membership JOIN source_listings listing ON listing.id = membership.source_listing_id
          WHERE membership.opportunity_id = opportunity.id AND membership.state <> 'human_rejected'
        ) member ON true
        LEFT JOIN LATERAL (
          SELECT jsonb_agg(jsonb_build_object('countryCode', location.country_code, 'region', location.region,
            'locality', location.locality, 'remoteEligible', location.remote_eligible) ORDER BY location.country_code, location.region, location.locality) AS items
          FROM opportunity_locations location WHERE location.opportunity_id = opportunity.id
        ) locations ON true
        LEFT JOIN LATERAL (
          SELECT greatest(coalesce(maximum, minimum), coalesce(minimum, maximum)) AS compensation_sort,
            jsonb_build_object('currency', currency, 'period', period, 'minimum', minimum, 'maximum', maximum) AS item
          FROM opportunity_compensation value WHERE value.opportunity_id = opportunity.id
          ORDER BY greatest(coalesce(maximum, minimum), coalesce(minimum, maximum)) DESC NULLS LAST LIMIT 1
        ) compensation ON true
        LEFT JOIN LATERAL (
          SELECT count(DISTINCT field_path) AS field_count FROM opportunity_field_provenance value
          WHERE value.opportunity_id = opportunity.id
        ) provenance ON true
        WHERE (${filters.status} = 'all' OR opportunity.status = ${filters.status})
          AND (${filters.companyId ?? null}::uuid IS NULL OR canonical.id = ${filters.companyId ?? null}::uuid)
          AND (${filters.q ?? null}::text IS NULL OR opportunity.search_document @@ websearch_to_tsquery('simple', ${filters.q ?? null})
            OR opportunity.normalized_title % lower(${filters.q ?? null}) OR canonical.normalized_name % lower(${filters.q ?? null}))
          AND (${like(filters.title)}::text IS NULL OR opportunity.display_title ILIKE ${like(filters.title)} ESCAPE '\\')
          AND (${filters.workplaceMode ?? null}::text IS NULL OR opportunity.workplace_type = ${filters.workplaceMode ?? null})
          AND (${filters.employmentType ?? null}::text IS NULL OR opportunity.employment_type = ${filters.employmentType ?? null})
          AND (${filters.seniority ?? null}::text IS NULL OR opportunity.seniority = ${filters.seniority ?? null})
          AND (${filters.firstSeenAfter ? new Date(filters.firstSeenAfter) : null}::timestamptz IS NULL OR opportunity.first_seen_at >= ${filters.firstSeenAfter ? new Date(filters.firstSeenAfter) : null})
          AND (${filters.sourcePostedAfter ? new Date(filters.sourcePostedAfter) : null}::timestamptz IS NULL OR opportunity.source_posted_at >= ${filters.sourcePostedAfter ? new Date(filters.sourcePostedAfter) : null})
          AND (${filters.country ?? null}::text IS NULL OR EXISTS (SELECT 1 FROM opportunity_locations value WHERE value.opportunity_id = opportunity.id AND value.country_code = ${filters.country ?? null}))
          AND (${filters.eligibleCountry ?? null}::text IS NULL OR EXISTS (SELECT 1 FROM opportunity_locations value WHERE value.opportunity_id = opportunity.id AND value.remote_eligible AND value.country_code = ${filters.eligibleCountry ?? null}))
          AND (${filters.region ?? null}::text IS NULL OR EXISTS (SELECT 1 FROM opportunity_locations value WHERE value.opportunity_id = opportunity.id AND lower(value.region) = lower(${filters.region ?? null})))
          AND (${filters.skill ?? null}::text IS NULL OR EXISTS (SELECT 1 FROM opportunity_skills value WHERE value.opportunity_id = opportunity.id AND lower(value.skill) = lower(${filters.skill ?? null})))
          AND (${filters.language ?? null}::text IS NULL OR EXISTS (SELECT 1 FROM opportunity_languages value WHERE value.opportunity_id = opportunity.id AND lower(value.language_code) = lower(${filters.language ?? null})))
          AND (${filters.visa ?? null}::boolean IS NULL OR EXISTS (SELECT 1 FROM field_assertions value WHERE value.target_type = 'opportunity'
            AND value.target_id = opportunity.id AND value.field_path = '/visa_sponsorship' AND value.value_json = to_jsonb(${filters.visa ?? null}::boolean)))
          AND (${filters.minCompensation ?? null}::numeric IS NULL OR EXISTS (SELECT 1 FROM opportunity_compensation value WHERE value.opportunity_id = opportunity.id
            AND greatest(coalesce(value.maximum, value.minimum), coalesce(value.minimum, value.maximum)) >= ${filters.minCompensation ?? null}
            AND (${filters.currency ?? null}::text IS NULL OR value.currency = ${filters.currency ?? null})
            AND (${filters.compensationPeriod ?? null}::text IS NULL OR value.period = ${filters.compensationPeriod ?? null})))
          AND (${filters.minCompensation ?? null}::numeric IS NOT NULL OR (${filters.currency ?? null}::text IS NULL AND ${filters.compensationPeriod ?? null}::text IS NULL)
            OR EXISTS (SELECT 1 FROM opportunity_compensation value WHERE value.opportunity_id = opportunity.id
              AND (${filters.currency ?? null}::text IS NULL OR value.currency = ${filters.currency ?? null})
              AND (${filters.compensationPeriod ?? null}::text IS NULL OR value.period = ${filters.compensationPeriod ?? null})))
      )
      SELECT * FROM result WHERE
        (${after?.id ?? null}::uuid IS NULL)
        OR (${filters.sort} = 'first_seen_desc' AND (first_seen_at, id) < (${afterTime}, ${after?.id ?? null}::uuid))
        OR (${filters.sort} = 'source_posted_desc' AND (coalesce(source_posted_at, 'epoch'::timestamptz), id) < (${afterTime}, ${after?.id ?? null}::uuid))
        OR (${filters.sort} = 'relevance' AND (relevance, id) < (${afterNumber}, ${after?.id ?? null}::uuid))
        OR (${filters.sort} = 'compensation_desc' AND (coalesce(compensation_sort, -1), id) < (${afterNumber}, ${after?.id ?? null}::uuid))
      ORDER BY
        CASE WHEN ${filters.sort} = 'relevance' THEN relevance END DESC,
        CASE WHEN ${filters.sort} = 'compensation_desc' THEN compensation_sort END DESC NULLS LAST,
        CASE WHEN ${filters.sort} = 'source_posted_desc' THEN source_posted_at END DESC NULLS LAST,
        CASE WHEN ${filters.sort} = 'first_seen_desc' THEN first_seen_at END DESC,
        id DESC LIMIT ${filters.limit + 1}`;
    const hasMore = rows.length > filters.limit;
    const pageRows = rows.slice(0, filters.limit);
    const items: PublicOpportunityItem[] = pageRows.map((row) => { const locations = jsonArray(row.locations); return ({ id: row.id,
      company: { id: row.company_id, name: row.company_name, domain: row.company_domain }, title: row.title,
      workplaceMode: row.workplace_mode, remoteScope: { kind: row.workplace_mode !== "remote" ? "unspecified" : locations.some((value) => (value as { countryCode?: unknown }).countryCode) ? "countries" : "worldwide",
        countryCodes: [...new Set(locations.map((value) => (value as { countryCode?: string }).countryCode).filter((value): value is string => Boolean(value)))].sort() },
      locations, compensation: row.compensation === null ? null : jsonValue(row.compensation),
      sourcePostedAt: row.source_posted_at ? iso(row.source_posted_at) : null, firstSeenAt: iso(row.first_seen_at),
      lastVerifiedOpenAt: iso(row.last_verified_open_at), primaryApplyUrl: row.apply_url, sourceCount: Number(row.source_count),
      provenanceCoverage: Number(row.provenance_coverage), status: row.status }); });
    const last = pageRows.at(-1);
    const primary = last ? filters.sort === "first_seen_desc" ? iso(last.first_seen_at)
      : filters.sort === "source_posted_desc" ? (last.source_posted_at ? iso(last.source_posted_at) : new Date(0).toISOString())
      : filters.sort === "relevance" ? Number(last.relevance) : Number(last.compensation_sort ?? -1) : undefined;
    return { items, nextCursor: hasMore && last && primary !== undefined ? encodeCursor("opportunities", filters, { primary, id: last.id }) : null };
  }

  async searchCompanies(input: { q?: string; limit: number; cursor?: string }): Promise<CompanyPage> {
    const after = decodeCompanyCursor(input);
    const pattern = like(input.q);
    const rows = await this.sql<Array<{ id: string; name: string; domain: string | null; careers_url: string | null; headquarters_country: string | null }>>`
      SELECT canonical.id, canonical.display_name AS name, canonical.primary_domain AS domain,
        canonical.careers_url, canonical.headquarters_country
      FROM companies canonical WHERE canonical.resolution_status = 'verified'
        AND (${pattern}::text IS NULL OR canonical.display_name ILIKE ${pattern} ESCAPE '\\' OR canonical.primary_domain ILIKE ${pattern} ESCAPE '\\')
        AND (${after?.id ?? null}::uuid IS NULL OR (lower(canonical.display_name), canonical.id) > (lower(${after?.primary as string ?? null}), ${after?.id ?? null}::uuid))
      ORDER BY lower(canonical.display_name), canonical.id LIMIT ${input.limit + 1}`;
    const hasMore = rows.length > input.limit;
    const page = rows.slice(0, input.limit);
    const last = page.at(-1);
    return { items: page.map((row) => ({ id: row.id, name: row.name, domain: row.domain, careersUrl: row.careers_url, headquartersCountry: row.headquarters_country })),
      nextCursor: hasMore && last ? encodeCompanyCursor(input, { primary: last.name.toLowerCase(), id: last.id }) : null };
  }

  async getOpportunity(id: string): Promise<Record<string, unknown> | null> {
    requireUuid(id);
    const rows = await this.sql<Array<{ record: unknown }>>`SELECT jsonb_build_object(
      'id', opportunity.id, 'title', opportunity.display_title, 'description', opportunity.description_text,
      'workplaceMode', opportunity.workplace_type, 'employmentType', opportunity.employment_type,
      'seniority', opportunity.seniority, 'status', opportunity.status, 'firstSeenAt', opportunity.first_seen_at,
      'sourcePostedAt', opportunity.source_posted_at, 'possiblyClosedAt', opportunity.possibly_closed_at,
      'closedAt', opportunity.closed_at, 'canonicalSourceUrl', opportunity.canonical_source_url,
      'primaryApplyUrl', opportunity.apply_url,
      'company', jsonb_build_object('id', company.id, 'name', company.display_name, 'domain', company.primary_domain),
      'locations', coalesce((SELECT jsonb_agg(jsonb_build_object('countryCode', value.country_code, 'region', value.region,
        'locality', value.locality, 'remoteEligible', value.remote_eligible) ORDER BY value.country_code, value.region, value.locality)
        FROM opportunity_locations value WHERE value.opportunity_id = opportunity.id), '[]'::jsonb),
      'compensation', coalesce((SELECT jsonb_agg(jsonb_build_object('currency', value.currency, 'period', value.period,
        'minimum', value.minimum, 'maximum', value.maximum) ORDER BY value.currency, value.period)
        FROM opportunity_compensation value WHERE value.opportunity_id = opportunity.id), '[]'::jsonb),
      'skills', coalesce((SELECT jsonb_agg(value.skill ORDER BY value.skill) FROM opportunity_skills value
        WHERE value.opportunity_id = opportunity.id), '[]'::jsonb),
      'languages', coalesce((SELECT jsonb_agg(jsonb_build_object('code', value.language_code, 'proficiency', value.proficiency)
        ORDER BY value.language_code) FROM opportunity_languages value WHERE value.opportunity_id = opportunity.id), '[]'::jsonb),
      'memberships', coalesce((SELECT jsonb_agg(jsonb_build_object('sourceListingId', listing.id, 'sourceId', listing.source_id,
        'sourceJobId', listing.source_job_id, 'sourceUrl', listing.canonical_source_url, 'applyUrl', listing.apply_url,
        'state', listing.lifecycle_state, 'lastSeenOpenAt', listing.last_seen_open_at) ORDER BY listing.id)
        FROM opportunity_members member JOIN source_listings listing ON listing.id = member.source_listing_id
        WHERE member.opportunity_id = opportunity.id AND member.state <> 'human_rejected'), '[]'::jsonb),
      'changeHistory', coalesce((SELECT jsonb_agg(jsonb_build_object('sequence', event.sequence, 'type', event.event_type,
        'occurredAt', event.occurred_at, 'reason', event.reason_code, 'metadata', event.metadata) ORDER BY event.sequence)
        FROM lifecycle_events event WHERE event.aggregate_type = 'opportunity' AND event.aggregate_id = opportunity.id), '[]'::jsonb),
      'provenance', coalesce((SELECT jsonb_agg(jsonb_build_object('fieldPath', provenance.field_path,
        'selectedAssertionId', provenance.selected_source_assertion_id, 'alternativeAssertionIds', provenance.alternative_source_assertion_ids,
        'value', provenance.projected_value_json, 'recordedAt', provenance.created_at) ORDER BY provenance.created_at, provenance.id)
        FROM opportunity_field_provenance provenance WHERE provenance.opportunity_id = opportunity.id), '[]'::jsonb)
      ) AS record FROM opportunities opportunity
      JOIN canonical_company_resolution resolution ON resolution.source_company_id = opportunity.company_id
      JOIN companies company ON company.id = resolution.canonical_company_id WHERE opportunity.id = ${id}`;
    return rows[0] ? jsonValue(rows[0].record) as Record<string, unknown> : null;
  }

  async getCompany(id: string): Promise<Record<string, unknown> | null> {
    requireUuid(id);
    const rows = await this.sql<Array<{ record: unknown }>>`SELECT jsonb_build_object('id', company.id, 'name', company.display_name,
      'legalName', company.legal_name, 'domain', company.primary_domain, 'careersUrl', company.careers_url,
      'logoUrl', company.logo_url, 'industryCodes', company.industry_codes, 'sizeBand', company.size_band,
      'headquartersCountry', company.headquarters_country, 'resolutionStatus', company.resolution_status,
      'provenance', coalesce((SELECT jsonb_agg(jsonb_build_object('fieldPath', assertion.field_path, 'value', assertion.value_json,
        'origin', assertion.origin, 'confidence', assertion.confidence, 'reviewState', assertion.review_state, 'createdAt', assertion.created_at)
        ORDER BY assertion.created_at, assertion.id) FROM field_assertions assertion WHERE assertion.target_type = 'company' AND assertion.target_id = company.id), '[]'::jsonb),
      'resolutionHistory', coalesce((SELECT jsonb_agg(jsonb_build_object('operation', decision.operation, 'reason', decision.reason,
        'actorType', decision.actor_type, 'createdAt', decision.created_at) ORDER BY decision.created_at, decision.id)
        FROM company_resolution_decisions decision WHERE decision.subject_company_id = company.id OR decision.canonical_company_id = company.id), '[]'::jsonb)
      ) AS record FROM canonical_company_resolution resolution
      JOIN companies company ON company.id = resolution.canonical_company_id WHERE resolution.source_company_id = ${id}`;
    return rows[0] ? jsonValue(rows[0].record) as Record<string, unknown> : null;
  }

  async reportOpportunity(context: { actorId: string; idempotencyKey: string }, opportunityId: string, input: ProblemReportInput): Promise<{ reportId: string; state: "pending" }> {
    requireUuid(opportunityId);
    if (!context.actorId.trim() || context.actorId.length > 200 || !/^[A-Za-z0-9._:-]{8,128}$/u.test(context.idempotencyKey)) throw new DiscoveryApiError("invalid_report_context");
    const command = { opportunityId, input };
    const requestHash = idempotencyHash(command);
    return this.sql.begin(async (tx) => {
      const inserted = await tx<{ id: string }[]>`INSERT INTO idempotency_records (id, actor_id, operation, idempotency_key, request_hash)
        VALUES (${uuid()}, ${context.actorId}, ${"opportunity.report"}, ${context.idempotencyKey}, ${requestHash})
        ON CONFLICT (actor_id, operation, idempotency_key) DO NOTHING RETURNING id`;
      if (!inserted.length) {
        const existing = (await tx<{ request_hash: string; response_json: unknown }[]>`SELECT request_hash, response_json FROM idempotency_records
          WHERE actor_id = ${context.actorId} AND operation = ${"opportunity.report"} AND idempotency_key = ${context.idempotencyKey} FOR UPDATE`)[0];
        if (!existing || existing.request_hash !== requestHash) throw new DiscoveryApiError("idempotency_key_reused", 409);
        if (!existing.response_json) throw new DiscoveryApiError("idempotency_incomplete", 409);
        return jsonValue(existing.response_json) as { reportId: string; state: "pending" };
      }
      const exists = (await tx<{ id: string; duplicate_exists: boolean }[]>`SELECT opportunity.id,
          (${input.duplicateOpportunityId ?? null}::uuid IS NULL OR EXISTS (SELECT 1 FROM opportunities duplicate WHERE duplicate.id = ${input.duplicateOpportunityId ?? null}::uuid)) AS duplicate_exists
        FROM opportunities opportunity WHERE opportunity.id = ${opportunityId}`)[0];
      if (!exists) throw new DiscoveryApiError("not_found", 404);
      if (!exists.duplicate_exists || input.duplicateOpportunityId === opportunityId) throw new DiscoveryApiError("invalid_duplicate_target");
      const reportId = uuid();
      await tx`INSERT INTO opportunity_problem_reports (id, opportunity_id, reporter_actor_id, report_kind, detail, duplicate_opportunity_id)
        VALUES (${reportId}, ${opportunityId}, ${context.actorId}, ${input.kind}, ${input.detail ?? null}, ${input.duplicateOpportunityId ?? null})`;
      const response = { reportId, state: "pending" as const };
      await tx`UPDATE idempotency_records SET response_json = ${JSON.stringify(response)}::text::jsonb, completed_at = clock_timestamp()
        WHERE actor_id = ${context.actorId} AND operation = ${"opportunity.report"} AND idempotency_key = ${context.idempotencyKey}`;
      return response;
    });
  }
}
