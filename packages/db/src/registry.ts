import { createHash } from "node:crypto";
import { SQL } from "bun";
import type {
  RejectSourceCandidate,
  SourceCandidateImport,
  SourcePatch,
  SourcePolicyCreate,
  SourcePolicyPatch,
  VerifySourceCandidate,
} from "@career-os/contracts";
import {
  RegistryRuleError,
  type RegistryMutationContext,
  type RegistryStore,
} from "@career-os/discovery-domain";

type JsonObject = Record<string, unknown>;

function id(): string {
  return Bun.randomUUIDv7();
}

function hash(value: unknown): string {
  return createHash("sha256").update(JSON.stringify(value)).digest("hex");
}

function normalizedName(value: string): string {
  return value.trim().toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
}

function hostMatches(host: string, pattern: string): boolean {
  const normalizedHost = host.toLowerCase();
  const normalizedPattern = pattern.toLowerCase();
  if (!normalizedPattern.startsWith("*.")) return normalizedHost === normalizedPattern;
  const suffix = normalizedPattern.slice(1);
  return normalizedHost.endsWith(suffix) && normalizedHost.length > suffix.length;
}

function asObject(value: unknown): JsonObject {
  if (typeof value === "string") return JSON.parse(value) as JsonObject;
  return value as JsonObject;
}

function databaseError(error: unknown): RegistryRuleError | undefined {
  const code = typeof error === "object" && error !== null && "code" in error ? String(error.code) : "";
  const constraint =
    typeof error === "object" && error !== null && "constraint" in error ? String(error.constraint) : "";
  if (constraint.includes("sources_connector_id_region_tenant_key_key")) {
    return new RegistryRuleError("duplicate_tenant", 409);
  }
  if (constraint.includes("companies_verified_primary_domain_uq")) {
    return new RegistryRuleError("company_domain_already_verified", 409);
  }
  if (code === "23503") return new RegistryRuleError("referenced_record_not_found", 404);
  if (code === "23514") return new RegistryRuleError("registry_invariant_rejected", 422);
  if (code === "23505") return new RegistryRuleError("registry_conflict", 409);
  return undefined;
}

async function audit(
  tx: SQL,
  context: RegistryMutationContext,
  action: string,
  targetType: string,
  targetId: string | null,
  reason: string,
  before: unknown,
  after: unknown,
): Promise<void> {
  const metadata = JSON.stringify({ before, after, idempotencyKey: context.idempotencyKey });
  await tx`INSERT INTO audit_events (
    id, actor_type, actor_id, action, target_type, target_id, reason, correlation_id, metadata
  ) VALUES (
    ${id()}, ${"operator"}, ${context.actorId}, ${action}, ${targetType}, ${targetId}, ${reason}, ${id()}, ${metadata}::text::jsonb
  )`;
}

async function idempotent<T extends JsonObject>(
  sql: SQL,
  context: RegistryMutationContext,
  operation: string,
  request: unknown,
  mutate: (tx: SQL) => Promise<T>,
): Promise<T> {
  const requestHash = hash(request);
  try {
    return await sql.begin(async (tx) => {
      const inserted = await tx<{ id: string }[]>`INSERT INTO idempotency_records (
        id, actor_id, operation, idempotency_key, request_hash
      ) VALUES (${id()}, ${context.actorId}, ${operation}, ${context.idempotencyKey}, ${requestHash})
      ON CONFLICT (actor_id, operation, idempotency_key) DO NOTHING
      RETURNING id`;
      if (inserted.length === 0) {
        const existing = await tx<{ request_hash: string; response_json: unknown }[]>`
          SELECT request_hash, response_json
          FROM idempotency_records
          WHERE actor_id = ${context.actorId}
            AND operation = ${operation}
            AND idempotency_key = ${context.idempotencyKey}
          FOR UPDATE
        `;
        const record = existing[0];
        if (!record || record.request_hash !== requestHash) {
          throw new RegistryRuleError("idempotency_key_reused", 409);
        }
        if (record.response_json === null) throw new RegistryRuleError("idempotency_incomplete", 409);
        return asObject(record.response_json) as T;
      }
      const response = await mutate(tx);
      const responseJson = JSON.stringify(response);
      await tx`UPDATE idempotency_records
        SET response_json = ${responseJson}::text::jsonb, completed_at = clock_timestamp()
        WHERE actor_id = ${context.actorId}
          AND operation = ${operation}
          AND idempotency_key = ${context.idempotencyKey}`;
      return response;
    });
  } catch (error) {
    if (error instanceof RegistryRuleError) throw error;
    throw databaseError(error) ?? error;
  }
}

export class PostgresRegistryStore implements RegistryStore {
  constructor(private readonly sql: SQL) {}

  importCandidates(context: RegistryMutationContext, command: SourceCandidateImport): Promise<JsonObject> {
    return idempotent(this.sql, context, "registry.import_candidates", command, async (tx) => {
      const candidateIds: string[] = [];
      let duplicates = 0;
      for (const row of command.rows) {
        const fingerprint = hash({
          companyName: row.companyName.toLowerCase(),
          primaryDomain: row.primaryDomain ?? null,
          careersUrl: row.careersUrl ?? null,
          atsUrl: row.atsUrl ?? null,
        });
        const candidateId = id();
        const inserted = await tx<{ id: string }[]>`INSERT INTO source_candidates (
          id, raw_company_name, raw_domain, raw_careers_url, raw_ats_url,
          discovery_provider, discovery_reference, first_observed_at, last_observed_at,
          candidate_fingerprint
        ) VALUES (
          ${candidateId}, ${row.companyName}, ${row.primaryDomain ?? null}, ${row.careersUrl ?? null},
          ${row.atsUrl ?? null}, ${"operator_import"}, ${row.discoveryReference ?? null},
          clock_timestamp(), clock_timestamp(), ${fingerprint}
        ) ON CONFLICT (candidate_fingerprint) DO UPDATE
          SET last_observed_at = clock_timestamp()
        RETURNING id`;
        const returnedId = inserted[0]?.id;
        if (!returnedId) throw new Error("candidate import did not return an id");
        candidateIds.push(returnedId);
        if (returnedId !== candidateId) duplicates += 1;
      }
      const response = { imported: command.rows.length - duplicates, duplicates, candidateIds };
      await audit(tx, context, "registry.candidates_imported", "source_candidate_batch", null, command.reason, null, response);
      return response;
    });
  }

  createPolicy(context: RegistryMutationContext, command: SourcePolicyCreate): Promise<JsonObject> {
    return idempotent(this.sql, context, "registry.create_policy", command, async (tx) => {
      const policyId = id();
      const rows = await tx<JsonObject[]>`INSERT INTO source_policies (
        id, source_family, host_pattern, access_class, robots_review_url, terms_review_url,
        reviewed_at, reviewed_by, retention_class, attribution_requirements,
        max_requests_per_minute, max_concurrency, contact_email, user_agent, state, expires_at
      ) VALUES (
        ${policyId}, ${command.sourceFamily}, ${command.hostPattern}, ${command.accessClass},
        ${command.robotsReviewUrl ?? null}, ${command.termsReviewUrl ?? null}, ${command.reviewedAt},
        ${context.actorId}, ${command.retentionClass}, ${command.attributionRequirements ?? null},
        ${command.maxRequestsPerMinute}, ${command.maxConcurrency}, ${command.contactEmail},
        ${command.userAgent}, ${command.state}, ${command.expiresAt}
      ) RETURNING *`;
      const after = rows[0];
      if (!after) throw new Error("policy creation returned no row");
      await audit(tx, context, "registry.policy_created", "source_policy", policyId, command.reason, null, after);
      return { policy: after };
    });
  }

  verifyCandidate(
    context: RegistryMutationContext,
    candidateId: string,
    command: VerifySourceCandidate,
  ): Promise<JsonObject> {
    return idempotent(this.sql, context, `registry.verify_candidate:${candidateId}`, command, async (tx) => {
      const candidates = await tx<JsonObject[]>`
        SELECT * FROM source_candidates WHERE id = ${candidateId} FOR UPDATE
      `;
      const before = candidates[0];
      if (!before) throw new RegistryRuleError("candidate_not_found", 404);
      if (before.review_state !== "pending") throw new RegistryRuleError("candidate_already_reviewed", 409);
      const policies = await tx<{ expires_at: Date | string; host_pattern: string; source_family: string; state: string }[]>`
        SELECT state, expires_at, host_pattern, source_family FROM source_policies WHERE id = ${command.policyId} FOR SHARE
      `;
      const policy = policies[0];
      if (!policy) throw new RegistryRuleError("policy_not_found", 404);
      if (policy.state !== "approved" || new Date(policy.expires_at) <= new Date()) {
        throw new RegistryRuleError("policy_not_current", 422);
      }
      const boardHost = new URL(command.source.boardUrl).hostname;
      const apiHost = new URL(command.source.apiBaseUrl).hostname;
      if (policy.source_family !== command.source.connectorId
        || !hostMatches(boardHost, policy.host_pattern)
        || !hostMatches(apiHost, policy.host_pattern)) {
        throw new RegistryRuleError("source_outside_policy_scope", 422);
      }

      const companyId = id();
      const sourceId = id();
      await tx`INSERT INTO companies (
        id, legal_name, display_name, normalized_name, primary_domain, resolution_status, resolution_confidence
      ) VALUES (
        ${companyId}, ${command.company.legalName ?? null}, ${command.company.displayName},
        ${normalizedName(command.company.displayName)}, ${command.company.primaryDomain}, ${"verified"},
        ${command.evidence.confidence}
      )`;
      await tx`INSERT INTO sources (
        id, company_id, connector_id, tenant_key, board_url, api_base_url, region,
        verification_method, verified_at, enabled, policy_id, policy_review_due_at, connector_version
      ) VALUES (
        ${sourceId}, ${companyId}, ${command.source.connectorId}, ${command.source.tenantKey},
        ${command.source.boardUrl}, ${command.source.apiBaseUrl}, ${command.source.region},
        ${command.evidence.type === "employer_domain_link" ? "employer_link" : command.evidence.type === "ats_identity" ? "ats_identity" : "human_review"},
        clock_timestamp(), false, ${command.policyId}, ${new Date(policy.expires_at).toISOString()}, ${command.source.connectorVersion}
      )`;
      await tx`INSERT INTO ownership_evidence (
        id, source_candidate_id, company_id, source_id, evidence_type, artifact_id,
        evidence_url, statement, confidence, recorded_by
      ) VALUES (
        ${id()}, ${candidateId}, ${companyId}, ${sourceId}, ${command.evidence.type},
        ${command.evidence.artifactId ?? null}, ${command.evidence.evidenceUrl ?? null},
        ${command.evidence.statement}, ${command.evidence.confidence}, ${context.actorId}
      )`;
      const rows = await tx<JsonObject[]>`UPDATE source_candidates
        SET review_state = ${"verified"}, review_reason = ${command.reason},
          verified_company_id = ${companyId}, verified_source_id = ${sourceId}
        WHERE id = ${candidateId}
        RETURNING *`;
      const after = rows[0];
      if (!after) throw new Error("candidate verification returned no row");
      await audit(tx, context, "registry.candidate_verified", "source_candidate", candidateId, command.reason, before, after);
      return { candidate: after, companyId, sourceId };
    });
  }

  rejectCandidate(
    context: RegistryMutationContext,
    candidateId: string,
    command: RejectSourceCandidate,
  ): Promise<JsonObject> {
    return idempotent(this.sql, context, `registry.reject_candidate:${candidateId}`, command, async (tx) => {
      const before = (await tx<JsonObject[]>`SELECT * FROM source_candidates WHERE id = ${candidateId} FOR UPDATE`)[0];
      if (!before) throw new RegistryRuleError("candidate_not_found", 404);
      if (before.review_state !== "pending") throw new RegistryRuleError("candidate_already_reviewed", 409);
      const after = (await tx<JsonObject[]>`UPDATE source_candidates
        SET review_state = ${"rejected"}, review_reason = ${command.reason}
        WHERE id = ${candidateId} RETURNING *`)[0];
      if (!after) throw new Error("candidate rejection returned no row");
      await audit(tx, context, "registry.candidate_rejected", "source_candidate", candidateId, command.reason, before, after);
      return { candidate: after };
    });
  }

  updatePolicy(
    context: RegistryMutationContext,
    policyId: string,
    command: SourcePolicyPatch,
  ): Promise<JsonObject> {
    return idempotent(this.sql, context, `registry.update_policy:${policyId}`, command, async (tx) => {
      const before = (await tx<JsonObject[]>`SELECT * FROM source_policies WHERE id = ${policyId} FOR UPDATE`)[0];
      if (!before) throw new RegistryRuleError("policy_not_found", 404);
      const after = (await tx<JsonObject[]>`UPDATE source_policies
        SET state = ${command.state}, reviewed_at = ${command.reviewedAt}, reviewed_by = ${context.actorId},
          expires_at = ${command.expiresAt}
        WHERE id = ${policyId} RETURNING *`)[0];
      if (!after) throw new Error("policy update returned no row");
      if (command.state === "approved") {
        await tx`UPDATE sources SET policy_review_due_at = ${command.expiresAt} WHERE policy_id = ${policyId}`;
      }
      await audit(tx, context, "registry.policy_updated", "source_policy", policyId, command.reason, before, after);
      return { policy: after };
    });
  }

  updateSource(context: RegistryMutationContext, sourceId: string, command: SourcePatch): Promise<JsonObject> {
    return idempotent(this.sql, context, `registry.update_source:${sourceId}`, command, async (tx) => {
      const before = (await tx<JsonObject[]>`SELECT * FROM sources WHERE id = ${sourceId} FOR UPDATE`)[0];
      if (!before) throw new RegistryRuleError("source_not_found", 404);
      const cadence = command.cadenceSeconds ?? Number(before.cadence_seconds);
      const after = (await tx<JsonObject[]>`UPDATE sources
        SET enabled = ${command.enabled}, cadence_seconds = ${cadence},
          next_scan_at = ${command.enabled ? new Date().toISOString() : null}
        WHERE id = ${sourceId} RETURNING *`)[0];
      if (!after) throw new Error("source update returned no row");
      await audit(tx, context, "registry.source_updated", "source", sourceId, command.reason, before, after);
      return { source: after };
    });
  }

  async listCandidates(state?: string): Promise<JsonObject> {
    const rows = state
      ? await this.sql<JsonObject[]>`SELECT * FROM source_candidates WHERE review_state = ${state} ORDER BY first_observed_at, id LIMIT 500`
      : await this.sql<JsonObject[]>`SELECT * FROM source_candidates ORDER BY first_observed_at, id LIMIT 500`;
    return { candidates: rows };
  }

  async listSources(enabled?: boolean): Promise<JsonObject> {
    const rows = enabled === undefined
      ? await this.sql<JsonObject[]>`SELECT * FROM sources ORDER BY created_at, id LIMIT 500`
      : await this.sql<JsonObject[]>`SELECT * FROM sources WHERE enabled = ${enabled} ORDER BY created_at, id LIMIT 500`;
    return { sources: rows };
  }
}
