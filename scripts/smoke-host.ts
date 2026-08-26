import { HealthResponseSchema } from "../packages/contracts/src/index.ts";
import { join } from "node:path";

const root = join(import.meta.dir, "..");
const services = [
  { name: "web", entry: "apps/web/src/index.ts", endpoint: "http://127.0.0.1:4300/healthz", env: { WEB_PORT: "4300" } },
  { name: "api", entry: "apps/api/src/index.ts", endpoint: "http://127.0.0.1:4301/healthz", env: { API_PORT: "4301" } },
  {
    name: "worker",
    entry: "apps/worker/src/index.ts",
    endpoint: "http://127.0.0.1:4302/healthz",
    env: { WORKER_HEALTH_PORT: "4302" },
  },
] as const;

const processes = services.map((service) =>
  Bun.spawn([process.execPath, "run", join(root, service.entry)], {
    cwd: root,
    env: { ...process.env, ...service.env, CAREER_OS_PROFILE: "test" },
    stdout: "pipe",
    stderr: "pipe",
  }),
);

async function waitForHealth(name: string, endpoint: string): Promise<void> {
  const deadline = Date.now() + 8_000;
  let lastError: unknown;
  while (Date.now() < deadline) {
    try {
      const response = await fetch(endpoint, { signal: AbortSignal.timeout(500) });
      const health = HealthResponseSchema.parse(await response.json());
      if (response.ok && health.service === name && health.status === "ok") return;
    } catch (error) {
      lastError = error;
    }
    await Bun.sleep(100);
  }
  throw new Error(`${name} did not become healthy`, { cause: lastError });
}

try {
  await Promise.all(services.map((service) => waitForHealth(service.name, service.endpoint)));
  console.log("Host smoke passed: web, API, and worker are healthy.");
} finally {
  for (const child of processes) child.kill();
  await Promise.allSettled(processes.map((child) => child.exited));
}
