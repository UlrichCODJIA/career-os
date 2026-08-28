import { createHash } from "node:crypto";
import { SQL } from "bun";

export const WORK_QUEUE_SCHEDULER_LOCK_KEY = 7_211_046_301;

export interface QueueClock {
  now(): Date;
  random(): number;
}

export interface WorkLease {
  id: string;
  type: string;
  payload: Record<string, unknown>;
  attempt: number;
  maxAttempts: number;
  leaseToken: string;
  leaseGeneration: number;
  leaseExpiresAt: Date;
}

export interface QueueHealth {
  queued: number;
  leased: number;
  retryableFailed: number;
  terminalFailed: number;
  oldestReadyAt: Date | null;
  expiredLeases: number;
}

export class QueueRuleError extends Error {
  constructor(public readonly code: string) {
    super(code);
    this.name = "QueueRuleError";
  }
}

function jsonObject(value: unknown): Record<string, unknown> {
  if (typeof value === "string") return JSON.parse(value) as Record<string, unknown>;
  return value as Record<string, unknown>;
}

function date(value: Date | string): Date {
  return value instanceof Date ? value : new Date(value);
}

function retryDelayMs(attempt: number, random: number): number {
  const capMs = Math.min(3_600_000, 5_000 * 2 ** Math.max(0, attempt - 1));
  return Math.floor(capMs * Math.min(0.999999, Math.max(0, random)));
}

function deterministicJitterMs(sourceId: string, bucket: number, cadenceSeconds: number): number {
  const prefix = createHash("sha256").update(`${sourceId}:${bucket}`).digest("hex").slice(0, 8);
  return Math.floor(cadenceSeconds * 1000 * 0.1 * (Number.parseInt(prefix, 16) / 0xffffffff));
}

export class PostgresWorkQueue {
  constructor(
    private readonly sql: SQL,
    private readonly clock: QueueClock = { now: () => new Date(), random: () => Math.random() },
  ) {}

  async scheduleDueSources(limit = 500): Promise<{ elected: boolean; enqueued: number; sourceIds: string[] }> {
    if (!Number.isInteger(limit) || limit < 1 || limit > 500) throw new QueueRuleError("invalid_schedule_limit");
    const now = this.clock.now();
    return this.sql.begin(async (tx) => {
      const elected = (await tx<{ elected: boolean }[]>`
        SELECT pg_try_advisory_xact_lock(${WORK_QUEUE_SCHEDULER_LOCK_KEY}) AS elected
      `)[0]?.elected ?? false;
      if (!elected) return { elected: false, enqueued: 0, sourceIds: [] };

      const sources = await tx<{
        id: string;
        cadence_seconds: number;
        connector_id: string;
        connector_version: string;
        tenant_key: string;
      }[]>`
        SELECT source.id, source.cadence_seconds, source.connector_id, source.connector_version, source.tenant_key
        FROM sources source
        JOIN source_policies policy ON policy.id = source.policy_id
        WHERE source.enabled
          AND source.next_scan_at IS NOT NULL
          AND source.next_scan_at <= ${now.toISOString()}
          AND source.policy_review_due_at > ${now.toISOString()}
          AND policy.state = 'approved'
          AND policy.expires_at > ${now.toISOString()}
          AND EXISTS (
            SELECT 1 FROM ownership_evidence evidence
            WHERE evidence.source_id = source.id AND evidence.confidence >= 0.9
          )
        ORDER BY source.next_scan_at, source.id
        LIMIT ${limit}
        FOR UPDATE OF source SKIP LOCKED
      `;

      let enqueued = 0;
      for (const source of sources) {
        const bucket = Math.floor(now.getTime() / 1000 / source.cadence_seconds);
        const dedupeKey = `scan_source:${source.id}:${bucket}`;
        const payload = JSON.stringify({
          sourceId: source.id,
          connectorId: source.connector_id,
          connectorVersion: source.connector_version,
          tenantKey: source.tenant_key,
          cadenceBucket: bucket,
        });
        const inserted = await tx<{ id: string }[]>`INSERT INTO work_jobs (
          id, type, dedupe_key, payload_json, priority, status, scheduled_at
        ) VALUES (
          ${Bun.randomUUIDv7()}, ${"scan_source"}, ${dedupeKey}, ${payload}::text::jsonb,
          ${0}, ${"queued"}, ${now.toISOString()}
        ) ON CONFLICT DO NOTHING RETURNING id`;
        enqueued += inserted.length;
        const jitterMs = deterministicJitterMs(source.id, bucket, source.cadence_seconds);
        const nextScanAt = new Date(now.getTime() + source.cadence_seconds * 1000 + jitterMs);
        await tx`UPDATE sources SET next_scan_at = ${nextScanAt.toISOString()} WHERE id = ${source.id}`;
      }
      return { elected: true, enqueued, sourceIds: sources.map((source) => source.id) };
    });
  }

  async claim(workerId: string, limit = 1, leaseSeconds = 300, jobType?: string): Promise<WorkLease[]> {
    if (!workerId.trim() || workerId.length > 200) throw new QueueRuleError("invalid_worker_id");
    if (!Number.isInteger(limit) || limit < 1 || limit > 100) throw new QueueRuleError("invalid_claim_limit");
    if (!Number.isInteger(leaseSeconds) || leaseSeconds < 5 || leaseSeconds > 3_600) {
      throw new QueueRuleError("invalid_lease_duration");
    }
    if (jobType !== undefined && !/^[a-z0-9_.:-]{1,100}$/.test(jobType)) throw new QueueRuleError("invalid_job_type");
    const now = this.clock.now();
    const expiresAt = new Date(now.getTime() + leaseSeconds * 1000);
    const rows = await this.sql<{
      id: string; type: string; payload_json: unknown; attempt: number; max_attempts: number;
      lease_token: string; lease_generation: number; lease_expires_at: Date | string;
    }[]>`
      WITH claimable AS (
        SELECT id FROM work_jobs
        WHERE status IN ('queued', 'retryable_failed')
          AND scheduled_at <= ${now.toISOString()}
          AND (${jobType ?? null}::text IS NULL OR type = ${jobType ?? null})
          AND attempt < max_attempts
        ORDER BY scheduled_at, priority DESC, id
        LIMIT ${limit}
        FOR UPDATE SKIP LOCKED
      )
      UPDATE work_jobs job
      SET status = 'leased', leased_at = ${now.toISOString()}, lease_expires_at = ${expiresAt.toISOString()},
        lease_owner = ${workerId}, lease_token = gen_random_uuid(), attempt = job.attempt + 1,
        lease_generation = job.lease_generation + 1,
        last_error_code = NULL, last_error_message = NULL
      FROM claimable
      WHERE job.id = claimable.id
      RETURNING job.id, job.type, job.payload_json, job.attempt, job.max_attempts,
        job.lease_token, job.lease_generation, job.lease_expires_at
    `;
    return rows.map((row) => ({
      id: row.id,
      type: row.type,
      payload: jsonObject(row.payload_json),
      attempt: row.attempt,
      maxAttempts: row.max_attempts,
      leaseToken: row.lease_token,
      leaseGeneration: Number(row.lease_generation),
      leaseExpiresAt: date(row.lease_expires_at),
    }));
  }

  async heartbeat(lease: Pick<WorkLease, "id" | "leaseToken" | "leaseGeneration">, workerId: string, leaseSeconds = 300): Promise<Date> {
    if (!Number.isInteger(leaseSeconds) || leaseSeconds < 5 || leaseSeconds > 3_600) {
      throw new QueueRuleError("invalid_lease_duration");
    }
    const now = this.clock.now();
    const expiresAt = new Date(now.getTime() + leaseSeconds * 1000);
    const rows = await this.sql<{ lease_expires_at: Date | string }[]>`UPDATE work_jobs
      SET lease_expires_at = ${expiresAt.toISOString()}
      WHERE id = ${lease.id} AND status = 'leased' AND lease_owner = ${workerId}
        AND lease_token = ${lease.leaseToken} AND lease_generation = ${lease.leaseGeneration}
        AND lease_expires_at > ${now.toISOString()}
      RETURNING lease_expires_at`;
    if (!rows[0]) throw new QueueRuleError("stale_lease");
    return date(rows[0].lease_expires_at);
  }

  async succeed(lease: Pick<WorkLease, "id" | "leaseToken" | "leaseGeneration">, workerId: string): Promise<void> {
    const now = this.clock.now();
    const rows = await this.sql<{ id: string }[]>`UPDATE work_jobs SET
      status = 'succeeded', completed_at = ${now.toISOString()},
      leased_at = NULL, lease_expires_at = NULL, lease_owner = NULL, lease_token = NULL
      WHERE id = ${lease.id} AND status = 'leased' AND lease_owner = ${workerId}
        AND lease_token = ${lease.leaseToken} AND lease_generation = ${lease.leaseGeneration}
        AND lease_expires_at > ${now.toISOString()}
      RETURNING id`;
    if (!rows[0]) throw new QueueRuleError("stale_lease");
  }

  async fail(
    lease: Pick<WorkLease, "id" | "leaseToken" | "leaseGeneration">,
    workerId: string,
    errorCode: string,
    redactedMessage: string,
    retryable = true,
  ): Promise<{ status: "retryable_failed" | "terminal_failed"; scheduledAt: Date | null }> {
    if (!/^[a-z0-9_.:-]{1,100}$/.test(errorCode) || redactedMessage.length > 1_000) {
      throw new QueueRuleError("invalid_failure_metadata");
    }
    const now = this.clock.now();
    return this.sql.begin(async (tx) => {
      const rows = await tx<{ attempt: number; max_attempts: number }[]>`
        SELECT attempt, max_attempts FROM work_jobs
        WHERE id = ${lease.id} AND status = 'leased' AND lease_owner = ${workerId}
          AND lease_token = ${lease.leaseToken} AND lease_generation = ${lease.leaseGeneration}
          AND lease_expires_at > ${now.toISOString()}
        FOR UPDATE
      `;
      const job = rows[0];
      if (!job) throw new QueueRuleError("stale_lease");
      const canRetry = retryable && job.attempt < job.max_attempts;
      const status = canRetry ? "retryable_failed" as const : "terminal_failed" as const;
      const scheduledAt = canRetry ? new Date(now.getTime() + retryDelayMs(job.attempt, this.clock.random())) : null;
      await tx`UPDATE work_jobs SET status = ${status}, scheduled_at = ${scheduledAt?.toISOString() ?? now.toISOString()},
        completed_at = ${canRetry ? null : now.toISOString()}, last_error_code = ${errorCode},
        last_error_message = ${redactedMessage}, leased_at = NULL, lease_expires_at = NULL,
        lease_owner = NULL, lease_token = NULL WHERE id = ${lease.id}`;
      return { status, scheduledAt };
    });
  }

  async reapExpired(limit = 100): Promise<{ retried: number; terminal: number }> {
    if (!Number.isInteger(limit) || limit < 1 || limit > 1_000) throw new QueueRuleError("invalid_reaper_limit");
    const now = this.clock.now();
    return this.sql.begin(async (tx) => {
      const rows = await tx<{ id: string; attempt: number; max_attempts: number }[]>`
        SELECT id, attempt, max_attempts FROM work_jobs
        WHERE status = 'leased' AND lease_expires_at <= ${now.toISOString()}
        ORDER BY lease_expires_at, id LIMIT ${limit} FOR UPDATE SKIP LOCKED
      `;
      let retried = 0;
      let terminal = 0;
      for (const job of rows) {
        const canRetry = job.attempt < job.max_attempts;
        const status = canRetry ? "retryable_failed" : "terminal_failed";
        const scheduledAt = canRetry ? new Date(now.getTime() + retryDelayMs(job.attempt, this.clock.random())) : now;
        await tx`UPDATE work_jobs SET status = ${status}, scheduled_at = ${scheduledAt.toISOString()},
          completed_at = ${canRetry ? null : now.toISOString()}, last_error_code = ${"lease_expired"},
          last_error_message = ${"Worker lease expired before completion"}, leased_at = NULL,
          lease_expires_at = NULL, lease_owner = NULL, lease_token = NULL WHERE id = ${job.id}`;
        if (canRetry) retried += 1; else terminal += 1;
      }
      return { retried, terminal };
    });
  }

  async cancel(jobId: string, redactedReason: string): Promise<void> {
    if (!redactedReason.trim() || redactedReason.length > 1_000) throw new QueueRuleError("invalid_cancel_reason");
    const rows = await this.sql<{ id: string }[]>`UPDATE work_jobs SET
      status = 'cancelled', completed_at = ${this.clock.now().toISOString()},
      last_error_code = ${"cancelled"}, last_error_message = ${redactedReason},
      leased_at = NULL, lease_expires_at = NULL, lease_owner = NULL, lease_token = NULL
      WHERE id = ${jobId} AND status IN ('queued', 'leased', 'retryable_failed')
      RETURNING id`;
    if (!rows[0]) throw new QueueRuleError("job_not_cancellable");
  }

  async health(): Promise<QueueHealth> {
    const now = this.clock.now();
    const rows = await this.sql<{
      queued: number; leased: number; retryable_failed: number; terminal_failed: number;
      oldest_ready_at: Date | string | null; expired_leases: number;
    }[]>`
      SELECT
        count(*) FILTER (WHERE status = 'queued')::int AS queued,
        count(*) FILTER (WHERE status = 'leased')::int AS leased,
        count(*) FILTER (WHERE status = 'retryable_failed')::int AS retryable_failed,
        count(*) FILTER (WHERE status = 'terminal_failed')::int AS terminal_failed,
        min(scheduled_at) FILTER (
          WHERE status IN ('queued', 'retryable_failed') AND scheduled_at <= ${now.toISOString()}
        ) AS oldest_ready_at,
        count(*) FILTER (WHERE status = 'leased' AND lease_expires_at <= ${now.toISOString()})::int AS expired_leases
      FROM work_jobs
    `;
    const row = rows[0];
    if (!row) throw new Error("queue health query returned no row");
    return {
      queued: row.queued,
      leased: row.leased,
      retryableFailed: row.retryable_failed,
      terminalFailed: row.terminal_failed,
      oldestReadyAt: row.oldest_ready_at ? date(row.oldest_ready_at) : null,
      expiredLeases: row.expired_leases,
    };
  }
}
