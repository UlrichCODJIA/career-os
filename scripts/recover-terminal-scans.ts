import { createDatabase, PostgresWorkQueue } from "../packages/db/src/index.ts";

function required(name: string): string {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`${name} is required`);
  return value;
}

function date(name: string): Date {
  const value = new Date(required(name));
  if (!Number.isFinite(value.getTime())) throw new Error(`${name} must be an ISO timestamp`);
  return value;
}

const database = createDatabase(required("DATABASE_URL"));
try {
  const errorCodes = required("RECOVERY_ERROR_CODES").split(",").map((value) => value.trim()).filter(Boolean);
  const rawLimit = process.env.RECOVERY_LIMIT?.trim() ?? "1000";
  if (!/^[0-9]+$/.test(rawLimit)) throw new Error("RECOVERY_LIMIT must be an integer");
  const result = await new PostgresWorkQueue(database).recoverTerminalSourceScans({
    actorId: required("RECOVERY_ACTOR_ID"),
    idempotencyKey: required("RECOVERY_IDEMPOTENCY_KEY"),
    reason: required("RECOVERY_REASON"),
    failedAfter: date("RECOVERY_FAILED_AFTER"),
    failedBefore: date("RECOVERY_FAILED_BEFORE"),
    errorCodes,
    limit: Number(rawLimit),
  });
  console.log(JSON.stringify({ ok: true, ...result }));
} finally {
  await database.close();
}
