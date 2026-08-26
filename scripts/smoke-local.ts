import { HealthResponseSchema } from "../packages/contracts/src/index.ts";

const endpoints = [
  ["web", process.env.WEB_HEALTH_URL ?? "http://127.0.0.1:3000/healthz"],
  ["api", process.env.API_HEALTH_URL ?? "http://127.0.0.1:4100/healthz"],
  ["worker", process.env.WORKER_HEALTH_URL ?? "http://127.0.0.1:4101/healthz"],
] as const;

for (const [expectedService, endpoint] of endpoints) {
  const response = await fetch(endpoint, { signal: AbortSignal.timeout(5_000) });
  if (!response.ok) throw new Error(`${expectedService} returned HTTP ${response.status}`);

  const health = HealthResponseSchema.parse(await response.json());
  if (health.service !== expectedService || health.status !== "ok") {
    throw new Error(`${expectedService} returned an unexpected health payload`);
  }

  console.log(`${expectedService}: ok`);
}
