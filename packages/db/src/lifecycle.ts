import { createHash } from "node:crypto";
import type { SQL } from "bun";

export class LifecycleStoreError extends Error {
  constructor(public readonly code: string) { super(code); this.name = "LifecycleStoreError"; }
}

export class PostgresLifecycleStore {
  constructor(private readonly sql: SQL) {}

  async clearCircuitBreaker(context: { actorId: string; idempotencyKey: string }, command: {
    circuitBreakerId: string; reason: string;
  }): Promise<{ circuitBreakerId: string; sourceId: string | null; scopeType: string }> {
    if (!context.actorId.trim() || context.actorId.length > 200 || !/^[A-Za-z0-9._:-]{8,128}$/u.test(context.idempotencyKey)) {
      throw new LifecycleStoreError("invalid_decision_context");
    }
    if (command.reason.trim().length < 8 || command.reason.length > 1_000) throw new LifecycleStoreError("invalid_clear_reason");
    const requestHash = createHash("sha256").update(JSON.stringify(command)).digest("hex");
    return this.sql.begin(async (tx) => {
      const inserted = await tx<{ id: string }[]>`INSERT INTO idempotency_records (id, actor_id, operation, idempotency_key, request_hash)
        VALUES (${Bun.randomUUIDv7()}, ${context.actorId}, ${"lifecycle.clear_breaker"}, ${context.idempotencyKey}, ${requestHash})
        ON CONFLICT (actor_id, operation, idempotency_key) DO NOTHING RETURNING id`;
      if (!inserted.length) {
        const prior = (await tx<{ request_hash: string; response_json: unknown }[]>`SELECT request_hash, response_json FROM idempotency_records
          WHERE actor_id = ${context.actorId} AND operation = 'lifecycle.clear_breaker' AND idempotency_key = ${context.idempotencyKey} FOR UPDATE`)[0];
        if (!prior || prior.request_hash !== requestHash || prior.response_json === null) throw new LifecycleStoreError("idempotency_replay_mismatch");
        return (typeof prior.response_json === "string" ? JSON.parse(prior.response_json) : prior.response_json) as { circuitBreakerId: string; sourceId: string | null; scopeType: string };
      }
      const snapshot = (await tx<{ source_id: string | null; connector_id: string; connector_version: string }[]>`SELECT source_id, connector_id, connector_version FROM lifecycle_circuit_breakers
        WHERE id = ${command.circuitBreakerId}`)[0];
      if (!snapshot) throw new LifecycleStoreError("active_circuit_breaker_not_found");
      if (snapshot.source_id) await tx`SELECT id FROM sources WHERE id = ${snapshot.source_id} FOR UPDATE`;
      else await tx`SELECT id FROM sources WHERE connector_id = ${snapshot.connector_id} AND connector_version = ${snapshot.connector_version}
        ORDER BY id FOR UPDATE`;
      const breaker = (await tx<{ source_id: string | null; state: string; scope_type: string; connector_id: string; connector_version: string }[]>`
        SELECT source_id, state, scope_type, connector_id, connector_version FROM lifecycle_circuit_breakers
        WHERE id = ${command.circuitBreakerId} FOR UPDATE`)[0];
      if (!breaker || breaker.state !== "tripped") throw new LifecycleStoreError("active_circuit_breaker_not_found");
      await tx`UPDATE lifecycle_circuit_breakers SET state = 'cleared', cleared_by = ${context.actorId},
        cleared_reason = ${command.reason}, cleared_at = clock_timestamp() WHERE id = ${command.circuitBreakerId}`;
      await tx`INSERT INTO lifecycle_circuit_breaker_events (id, circuit_breaker_id, event_type, actor_type, actor_id, reason)
        VALUES (${Bun.randomUUIDv7()}, ${command.circuitBreakerId}, ${"cleared"}, ${"operator"}, ${context.actorId}, ${command.reason})`;
      await tx`UPDATE sources source SET health_state = CASE WHEN EXISTS (
          SELECT 1 FROM lifecycle_circuit_breakers active WHERE active.state = 'tripped' AND (
            (active.scope_type = 'source' AND active.source_id = source.id)
            OR (active.scope_type = 'connector_version' AND active.connector_id = source.connector_id
              AND active.connector_version = source.connector_version)
          )
        ) THEN 'quarantined' ELSE 'degraded' END,
        next_scan_at = CASE WHEN EXISTS (
          SELECT 1 FROM lifecycle_circuit_breakers active WHERE active.state = 'tripped' AND (
            (active.scope_type = 'source' AND active.source_id = source.id)
            OR (active.scope_type = 'connector_version' AND active.connector_id = source.connector_id
              AND active.connector_version = source.connector_version)
          )
        ) THEN source.next_scan_at ELSE clock_timestamp() END
        WHERE (${breaker.source_id}::uuid IS NOT NULL AND source.id = ${breaker.source_id}) OR
          (${breaker.source_id}::uuid IS NULL AND source.connector_id = ${breaker.connector_id}
            AND source.connector_version = ${breaker.connector_version})`;
      const response = { circuitBreakerId: command.circuitBreakerId, sourceId: breaker.source_id, scopeType: breaker.scope_type };
      await tx`INSERT INTO audit_events (id, actor_type, actor_id, action, target_type, target_id, reason, correlation_id, metadata)
        VALUES (${Bun.randomUUIDv7()}, ${"operator"}, ${context.actorId}, ${"lifecycle.breaker_cleared"}, ${"source"},
          ${breaker.source_id}, ${command.reason}, ${Bun.randomUUIDv7()}, ${JSON.stringify({ circuitBreakerId: command.circuitBreakerId,
            scopeType: breaker.scope_type, connectorId: breaker.connector_id, connectorVersion: breaker.connector_version,
            idempotencyKey: context.idempotencyKey })}::text::jsonb)`;
      await tx`UPDATE idempotency_records SET response_json = ${JSON.stringify(response)}::text::jsonb, completed_at = clock_timestamp()
        WHERE actor_id = ${context.actorId} AND operation = 'lifecycle.clear_breaker' AND idempotency_key = ${context.idempotencyKey}`;
      return response;
    });
  }
}
