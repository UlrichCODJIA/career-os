import { afterEach, describe, expect, test } from "bun:test";
import {
  RequestSecurityError,
  generateCsrfToken,
  guardRequest,
} from "../packages/auth/src/index.ts";
import {
  HealthResponseSchema,
  createHealthResponse,
  readRuntimeConfig,
  type RuntimeConfig,
} from "../packages/contracts/src/index.ts";
import { createApiServer } from "../apps/api/src/server.ts";

const operatorToken = "operator-token-that-is-at-least-32-characters";
const userToken = "ordinary-user-token-that-is-at-least-32-characters";
const csrfSecret = "csrf-secret-that-is-at-least-32-characters-long";
const origin = "https://career.example";
const servers: Array<{ stop(closeActiveConnections?: boolean): void }> = [];

function hostedConfig(authenticationMode: "bearer" | "cookie" = "bearer"): RuntimeConfig {
  return readRuntimeConfig("api", {
    CAREER_OS_PROFILE: "hosted",
    API_HOST: "127.0.0.1",
    API_PORT: "0",
    NETWORK_BOUNDARY: "remote",
    LOCAL_ONLY: "false",
    DISCOVERY_PUBLIC_BASE_URL: origin,
    ALLOWED_ORIGINS: origin,
    AUTH_MODE: authenticationMode,
    TRANSPORT_SECURITY: "trusted-proxy",
    TRUSTED_PROXY_IPS: "127.0.0.1,::1",
    AUTH_OPERATOR_TOKEN: operatorToken,
    AUTH_USER_TOKEN: userToken,
    AUTH_CSRF_SECRET: authenticationMode === "cookie" ? csrfSecret : undefined,
    ARTIFACT_ROOT: "C:\\Users\\operator\\private\\career-os\\artifacts",
  });
}

afterEach(() => {
  for (const server of servers.splice(0)) server.stop(true);
});

describe("deployment-profile boundary", () => {
  test("rejects non-loopback startup without an approved boundary", () => {
    expect(() => readRuntimeConfig("api", { API_HOST: "0.0.0.0" })).toThrow(
      "loopback boundary must bind to a loopback host",
    );
  });

  test("rejects incomplete remote authentication and transport configuration", () => {
    expect(() =>
      readRuntimeConfig("api", {
        CAREER_OS_PROFILE: "hosted",
        API_HOST: "0.0.0.0",
        NETWORK_BOUNDARY: "remote",
        LOCAL_ONLY: "false",
        DISCOVERY_PUBLIC_BASE_URL: "http://career.example",
        ALLOWED_ORIGINS: "http://career.example",
      }),
    ).toThrow();
  });

  test("accepts explicit local-container and complete remote profiles", () => {
    expect(
      readRuntimeConfig("worker", {
        WORKER_HOST: "0.0.0.0",
        NETWORK_BOUNDARY: "container-loopback",
        LOCAL_ONLY: "true",
      }).security.networkBoundary,
    ).toBe("container-loopback");
    expect(hostedConfig().security.transportSecurity).toBe("trusted-proxy");
    expect(() =>
      readRuntimeConfig("worker", {
        CAREER_OS_PROFILE: "hosted",
        NETWORK_BOUNDARY: "remote",
        LOCAL_ONLY: "false",
        DISCOVERY_PUBLIC_BASE_URL: origin,
        ALLOWED_ORIGINS: origin,
        AUTH_MODE: "bearer",
        TRANSPORT_SECURITY: "trusted-proxy",
        TRUSTED_PROXY_IPS: "127.0.0.1",
        AUTH_OPERATOR_TOKEN: operatorToken,
      }),
    ).toThrow("does not yet support a remote boundary");
  });

  test("requires credentials for every non-loopback API bind", () => {
    for (const host of ["0.0.0.0", "::", "192.168.1.10", "api.internal"]) {
      expect(() =>
        readRuntimeConfig("api", {
          API_HOST: host,
          NETWORK_BOUNDARY: "container-loopback",
          LOCAL_ONLY: "true",
        }),
      ).toThrow("requires bearer or cookie authentication");
    }

    const config = readRuntimeConfig("api", {
      API_HOST: "0.0.0.0",
      NETWORK_BOUNDARY: "container-loopback",
      LOCAL_ONLY: "true",
      AUTH_MODE: "bearer",
      AUTH_OPERATOR_TOKEN: operatorToken,
    });
    expect(config.security.authenticationMode).toBe("bearer");
  });

  test("rejects a directly constructed unsafe API config before binding", () => {
    const unsafe = {
      ...readRuntimeConfig("api", {}),
      host: "0.0.0.0",
      security: { ...readRuntimeConfig("api", {}).security, networkBoundary: "container-loopback" as const },
    };
    expect(() => createApiServer(unsafe)).toThrow("requires bearer or cookie authentication");

    const contradictory = {
      ...readRuntimeConfig("api", {}),
      profile: "hosted" as const,
      security: {
        ...readRuntimeConfig("api", {}).security,
        networkBoundary: "remote" as const,
        transportSecurity: "trusted-proxy" as const,
        trustedProxyIps: ["127.0.0.1"],
      },
    };
    expect(() => createApiServer(contradictory)).toThrow();
  });

  test("recognizes canonical loopback address forms", () => {
    expect(readRuntimeConfig("api", { API_HOST: "0:0:0:0:0:0:0:1" }).security.networkBoundary).toBe("loopback");
    expect(readRuntimeConfig("api", { API_HOST: "::ffff:127.0.0.1" }).security.networkBoundary).toBe("loopback");
    expect(() => readRuntimeConfig("api", { API_HOST: "127.999.0.1" })).toThrow();
  });

  test("keeps remote health output path-free", () => {
    const config = hostedConfig();
    const health = HealthResponseSchema.parse(createHealthResponse("api", config.profile));
    expect(JSON.stringify(health)).not.toContain(config.artifactRoot);
    expect(Object.keys(health).sort()).toEqual(["profile", "service", "status", "timestamp", "version"]);
  });
});

describe("request authentication and authorization", () => {
  test("returns unauthenticated, forbidden, and operator principals distinctly", () => {
    const config = hostedConfig();
    expect(() =>
      guardRequest(
        new Request(`${origin}/api/v1/admin/queue/health`, { headers: { "x-forwarded-proto": "https" } }),
        config,
        { remoteAddress: "127.0.0.1" },
      ),
    ).toThrow(RequestSecurityError);
    expect(() =>
      guardRequest(
        new Request(`${origin}/api/v1/admin/queue/health`, {
          headers: { authorization: `Bearer ${userToken}`, "x-forwarded-proto": "https" },
        }),
        config,
        { requiredRole: "operator", remoteAddress: "127.0.0.1" },
      ),
    ).toThrow("forbidden");
    expect(
      guardRequest(
        new Request(`${origin}/api/v1/admin/queue/health`, {
          headers: { authorization: `Bearer ${operatorToken}`, "x-forwarded-proto": "https" },
        }),
        config,
        { requiredRole: "operator", remoteAddress: "127.0.0.1" },
      ).role,
    ).toBe("operator");
  });

  test("rejects cross-origin unsafe HTTP and WebSocket requests", () => {
    const config = hostedConfig();
    for (const options of [{ unsafe: true }, { websocket: true }]) {
      expect(() =>
        guardRequest(
          new Request(`${origin}/api/v1/admin/runs/run-1/approve`, {
            method: options.unsafe ? "POST" : "GET",
            headers: {
              authorization: `Bearer ${operatorToken}`,
              origin: "https://malicious.example",
              "x-forwarded-proto": "https",
            },
          }),
          config,
          { ...options, remoteAddress: "127.0.0.1" },
        ),
      ).toThrow("origin_rejected");
    }
  });

  test("rejects a spoofed secure-forwarding header from an untrusted peer", () => {
    const config = hostedConfig();
    expect(() =>
      guardRequest(
        new Request(`${origin}/api/v1/admin/queue/health`, {
          headers: { authorization: `Bearer ${operatorToken}`, "x-forwarded-proto": "https" },
        }),
        config,
        { requiredRole: "operator", remoteAddress: "203.0.113.50" },
      ),
    ).toThrow("forbidden");
  });

  test("requires a valid CSRF token for cookie mutations", () => {
    const config = hostedConfig("cookie");
    const baseHeaders = { cookie: `career_os_session=${operatorToken}`, origin, "x-forwarded-proto": "https" };
    expect(() =>
      guardRequest(new Request(`${origin}/approve`, { method: "POST", headers: baseHeaders }), config, {
        unsafe: true,
        requiredRole: "operator",
        remoteAddress: "127.0.0.1",
      }),
    ).toThrow("csrf_rejected");

    const principal = guardRequest(
      new Request(`${origin}/approve`, {
        method: "POST",
        headers: {
          ...baseHeaders,
          "x-csrf-token": generateCsrfToken(operatorToken, csrfSecret),
        },
      }),
      config,
      { unsafe: true, requiredRole: "operator", remoteAddress: "127.0.0.1" },
    );
    expect(principal.authenticationMethod).toBe("cookie");
  });

  test("enforces the operator boundary in the HTTP server", async () => {
    const config = hostedConfig();
    const server = createApiServer(config);
    servers.push(server);
    const base = `http://127.0.0.1:${server.port}`;

    const unauthenticated = await fetch(`${base}/api/v1/admin/queue/health`, {
      headers: { "x-forwarded-proto": "https" },
    });
    expect(unauthenticated.status).toBe(401);

    const forbidden = await fetch(`${base}/api/v1/admin/queue/health`, {
      headers: { authorization: `Bearer ${userToken}`, "x-forwarded-proto": "https" },
    });
    expect(forbidden.status).toBe(403);

    const allowed = await fetch(`${base}/api/v1/admin/queue/health`, {
      headers: { authorization: `Bearer ${operatorToken}`, "x-forwarded-proto": "https" },
    });
    expect(allowed.status).toBe(200);

    const corsAllowed = await fetch(`${base}/api/v1/admin/queue/health`, {
      headers: {
        authorization: `Bearer ${operatorToken}`,
        origin,
        "x-forwarded-proto": "https",
      },
    });
    expect(corsAllowed.headers.get("access-control-allow-origin")).toBe(origin);
    expect(corsAllowed.headers.get("access-control-allow-credentials")).toBe("true");

    const crossOrigin = await fetch(`${base}/api/v1/admin/runs/run-1/approve`, {
      method: "POST",
      headers: {
        authorization: `Bearer ${operatorToken}`,
        origin: "https://malicious.example",
        "idempotency-key": "approval-0001",
        "x-forwarded-proto": "https",
      },
    });
    expect(crossOrigin.status).toBe(403);

    const approved = await fetch(`${base}/api/v1/admin/runs/run-1/approve`, {
      method: "POST",
      headers: {
        authorization: `Bearer ${operatorToken}`,
        origin,
        "idempotency-key": "approval-0001",
        "x-forwarded-proto": "https",
      },
    });
    expect(approved.status).toBe(202);
    expect(await approved.json()).toMatchObject({ principalId: "configured-operator" });

    const root = await fetch(`${base}/`, { headers: { "x-forwarded-proto": "https" } });
    expect(root.status).toBe(401);

    const notFound = await fetch(`${base}/missing`, { headers: { "x-forwarded-proto": "https" } });
    expect(notFound.status).toBe(401);
  });

  test("binds the same authenticated principal to a WebSocket upgrade", async () => {
    const config = readRuntimeConfig("api", { API_PORT: "0" });
    const server = createApiServer(config);
    servers.push(server);

    const message = await new Promise<string>((resolve, reject) => {
      const BunWebSocket = WebSocket as unknown as new (
        url: string,
        options: { headers: Record<string, string> },
      ) => WebSocket;
      const socket = new BunWebSocket(`ws://127.0.0.1:${server.port}/api/v1/ws`, {
        headers: { origin: config.security.publicBaseUrl },
      });
      socket.addEventListener("message", (event) => {
        resolve(String(event.data));
        socket.close();
      });
      socket.addEventListener("error", () => reject(new Error("WebSocket upgrade failed")));
    });

    expect(JSON.parse(message)).toMatchObject({
      type: "connected",
      principal: { id: "local-operator", role: "operator", authenticationMethod: "local" },
    });
  });
});
