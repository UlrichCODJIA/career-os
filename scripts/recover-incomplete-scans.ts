import { createHash } from "node:crypto";
import { createDatabase, PostgresRegistryStore } from "../packages/db/src/index.ts";

function required(name: string): string {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`${name} is required`);
  return value;
}

function instant(name: string): Date {
  const value = new Date(required(name));
  if (!Number.isFinite(value.getTime())) throw new Error(`${name} must be an ISO timestamp`);
  return value;
}

const actorId = required("RECOVERY_ACTOR_ID");
const key = required("RECOVERY_IDEMPOTENCY_KEY");
const reason = required("RECOVERY_REASON");
const failedAfter = instant("RECOVERY_FAILED_AFTER");
const failedBefore = instant("RECOVERY_FAILED_BEFORE");
const allowedReasons = new Set(["blocked", "pagination_incomplete", "schema_invalid", "suspicious_empty"]);
const reasons = required("RECOVERY_COMPLETENESS_REASONS").split(",").map((value) => value.trim()).filter(Boolean);
const rawLimit = process.env.RECOVERY_LIMIT?.trim() ?? "1000";
if (!/^[A-Za-z0-9._:-]{8,80}$/.test(key)) throw new Error("RECOVERY_IDEMPOTENCY_KEY is invalid");
if (reason.length < 8 || reason.length > 900) throw new Error("RECOVERY_REASON is invalid");
if (!Number.isInteger(Number(rawLimit)) || Number(rawLimit) < 1 || Number(rawLimit) > 1_000) throw new Error("RECOVERY_LIMIT is invalid");
if (failedAfter >= failedBefore || failedBefore.getTime() - failedAfter.getTime() > 7 * 86_400_000) throw new Error("recovery window is invalid");
if (reasons.length < 1 || new Set(reasons).size !== reasons.length || reasons.some((value) => !allowedReasons.has(value))) {
  throw new Error("RECOVERY_COMPLETENESS_REASONS is invalid");
}

const database = createDatabase(required("DATABASE_URL"));
try {
  const sources = await database<{ id: string }[]>`
    SELECT source.id
    FROM sources source
    JOIN LATERAL (
      SELECT scan.ended_at, scan.completeness_reason
      FROM source_scans scan
      WHERE scan.source_id = source.id AND scan.ended_at >= ${failedAfter} AND scan.ended_at < ${failedBefore}
      ORDER BY scan.ended_at DESC, scan.id DESC LIMIT 1
    ) latest ON true
    WHERE source.enabled AND latest.completeness_reason = ANY(string_to_array(${reasons.sort().join(",")}, ','))
      AND NOT EXISTS (
        SELECT 1 FROM source_scans newer WHERE newer.source_id = source.id
          AND newer.completeness_reason = 'complete' AND newer.ended_at > latest.ended_at
      )
      AND NOT EXISTS (
        SELECT 1 FROM work_jobs active WHERE active.type = 'scan_source'
          AND active.status IN ('queued', 'leased', 'retryable_failed')
          AND active.payload_json->>'sourceId' = source.id::text
      )
    ORDER BY latest.ended_at, source.id LIMIT ${Number(rawLimit)}
  `;
  const registry = new PostgresRegistryStore(database);
  let recovered = 0;
  for (const source of sources) {
    const suffix = createHash("sha256").update(source.id).digest("hex").slice(0, 16);
    await registry.updateSource(
      { actorId, idempotencyKey: `${key}.pause.${suffix}` },
      source.id,
      { enabled: false, reason: `${reason} (audited pause)` },
    );
    await registry.updateSource(
      { actorId, idempotencyKey: `${key}.resume.${suffix}` },
      source.id,
      { enabled: true, reason: `${reason} (audited reschedule)` },
    );
    recovered += 1;
  }
  console.log(JSON.stringify({ ok: true, selected: sources.length, recovered }));
} finally {
  await database.close();
}
