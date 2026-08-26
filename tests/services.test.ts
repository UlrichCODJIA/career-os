import { afterEach, describe, expect, test } from "bun:test";
import type { RuntimeConfig } from "../packages/contracts/src/index.ts";
import { HealthResponseSchema } from "../packages/contracts/src/index.ts";
import { createApiServer } from "../apps/api/src/server.ts";
import { createWebServer } from "../apps/web/src/server.ts";
import { createWorkerHealthServer } from "../apps/worker/src/server.ts";

const servers: Array<{ stop(closeActiveConnections?: boolean): void }> = [];
const config: RuntimeConfig = {
  profile: "test",
  host: "127.0.0.1",
  port: 0,
  artifactRoot: "./artifacts",
  security: {
    networkBoundary: "loopback",
    localOnly: true,
    publicBaseUrl: "http://127.0.0.1:4100",
    allowedOrigins: ["http://127.0.0.1:4100"],
    authenticationMode: "local",
    transportSecurity: "none",
    trustedProxyIps: [],
  },
};

afterEach(() => {
  for (const server of servers.splice(0)) server.stop(true);
});

describe("local service surfaces", () => {
  test.each([
    ["api", createApiServer],
    ["web", createWebServer],
    ["worker", createWorkerHealthServer],
  ] as const)("serves a validated %s health response", async (expectedService, createServer) => {
    const server = createServer(config);
    servers.push(server);
    const response = await fetch(`http://127.0.0.1:${server.port}/healthz`);
    const health = HealthResponseSchema.parse(await response.json());
    expect(response.status).toBe(200);
    expect(health).toMatchObject({ service: expectedService, status: "ok", profile: "test" });
  });

  test("serves the shell with restrictive baseline headers", async () => {
    const server = createWebServer(config);
    servers.push(server);
    const response = await fetch(`http://127.0.0.1:${server.port}/`);
    expect(await response.text()).toContain("Your search.");
    expect(response.headers.get("content-security-policy")).toContain("default-src 'none'");
    expect(response.headers.get("x-content-type-options")).toBe("nosniff");
  });
});
