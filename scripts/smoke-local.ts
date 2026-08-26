import { join } from "node:path";
import { HealthResponseSchema } from "../packages/contracts/src/index.ts";

const endpoints = [
  ["web", process.env.WEB_HEALTH_URL ?? "http://127.0.0.1:3000/healthz"],
  ["api", process.env.API_HEALTH_URL ?? "http://127.0.0.1:4100/healthz"],
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

const workerProbe = Bun.spawn(
  [
    "docker",
    "compose",
    "--profile",
    "local",
    "exec",
    "-T",
    "worker",
    "bun",
    "-e",
    "const r=await fetch('http://127.0.0.1:4101/healthz');if(!r.ok)process.exit(1);console.log(await r.text())",
  ],
  {
    cwd: join(import.meta.dir, ".."),
    stdout: "pipe",
    stderr: "pipe",
  },
);

const workerOutput = await new Response(workerProbe.stdout).text();
const workerError = await new Response(workerProbe.stderr).text();
const workerExitCode = await workerProbe.exited;

if (workerExitCode !== 0) {
  throw new Error(`worker health probe failed: ${workerError.trim()}`);
}

const workerHealth = HealthResponseSchema.parse(JSON.parse(workerOutput));
if (workerHealth.service !== "worker" || workerHealth.status !== "ok") {
  throw new Error("worker returned an unexpected health payload");
}

console.log("worker: ok");
