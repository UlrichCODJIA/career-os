import {
  RequestSecurityError,
  assertRequestOrigin,
  assertSecureTransport,
  csrfTokenForRequest,
  guardRequest,
  type AuthenticatedPrincipal,
} from "@career-os/auth";
import { createHealthResponse, parseApiRuntimeConfig, type RuntimeConfig } from "@career-os/contracts";
import type { QueueHealth, PostgresWorkQueue } from "@career-os/db";
import type { RegistryService } from "@career-os/discovery-domain";
import type { DiscoveryReadService } from "@career-os/discovery-api";
import { handleRegistryRoute } from "./registry-routes.ts";
import { handleDiscoveryRoute } from "./discovery-routes.ts";

interface WebSocketData {
  principal: AuthenticatedPrincipal;
}

function corsHeaders(request: Request, config: RuntimeConfig): Headers {
  const headers = new Headers({ "cache-control": "no-store" });
  const origin = request.headers.get("origin");
  if (!origin) return headers;
  assertRequestOrigin(request, config);
  headers.set("access-control-allow-origin", new URL(origin).origin);
  headers.set("access-control-allow-credentials", "true");
  headers.set("vary", "Origin");
  return headers;
}

function securityErrorResponse(error: unknown, request: Request, config: RuntimeConfig): Response {
  if (error instanceof RequestSecurityError) {
    const headers = new Headers({ "cache-control": "no-store" });
    try {
      const allowedHeaders = corsHeaders(request, config);
      for (const [name, value] of allowedHeaders) headers.set(name, value);
    } catch {
      // A rejected origin must not receive cross-origin response access.
    }
    if (error.status === 401) headers.set("www-authenticate", "Bearer");
    return Response.json({ error: error.code }, { status: error.status, headers });
  }
  throw error;
}

function isIdempotencyKey(value: string | null): value is string {
  return value !== null && /^[A-Za-z0-9._:-]{8,128}$/.test(value);
}

export interface ApiDependencies {
  registryService?: RegistryService;
  workQueue?: Pick<PostgresWorkQueue, "health">;
  discoveryService?: DiscoveryReadService;
}

export function createApiServer(config: RuntimeConfig, dependencies: ApiDependencies = {}) {
  config = parseApiRuntimeConfig(config);
  return Bun.serve<WebSocketData>({
    hostname: config.host,
    port: config.port,
    tls:
      config.security.transportSecurity === "tls"
        ? { cert: Bun.file(config.security.tlsCertFile!), key: Bun.file(config.security.tlsKeyFile!) }
        : undefined,
    async fetch(request, server) {
      const url = new URL(request.url);
      const remoteAddress = server.requestIP(request)?.address;
      if (request.method === "GET" && url.pathname === "/healthz") {
        try {
          assertSecureTransport(request, config, remoteAddress);
          return Response.json(createHealthResponse("api", config.profile), {
            headers: { "cache-control": "no-store" },
          });
        } catch (error) {
          return securityErrorResponse(error, request, config);
        }
      }

      try {
        if (request.method === "OPTIONS" && url.pathname.startsWith("/api/v1/")) {
          assertSecureTransport(request, config, remoteAddress);
          assertRequestOrigin(request, config);
          const origin = request.headers.get("origin")!;
          return new Response(null, {
            status: 204,
            headers: {
              "access-control-allow-origin": new URL(origin).origin,
              "access-control-allow-credentials": "true",
              "access-control-allow-methods": "GET,POST,PATCH,DELETE,OPTIONS",
              "access-control-allow-headers": "authorization,content-type,idempotency-key,x-csrf-token",
              "cache-control": "no-store",
              vary: "Origin",
            },
          });
        }

        if (request.method === "GET" && url.pathname === "/api/v1/session") {
          const principal = guardRequest(request, config, { remoteAddress });
          return Response.json(
            { principal, csrfToken: csrfTokenForRequest(request, config) },
            { headers: corsHeaders(request, config) },
          );
        }

        if (request.method === "GET" && url.pathname === "/api/v1/admin/queue/health") {
          const principal = guardRequest(request, config, { requiredRole: "operator", remoteAddress });
          const queueHealth: QueueHealth | { status: "not_configured" } = dependencies.workQueue
            ? await dependencies.workQueue.health()
            : { status: "not_configured" };
          return Response.json(
            { ...queueHealth, principalId: principal.id },
            { headers: corsHeaders(request, config) },
          );
        }

        const discoveryResponse = await handleDiscoveryRoute(request, config, {
          service: dependencies.discoveryService,
          remoteAddress,
          headers: (discoveryRequest) => corsHeaders(discoveryRequest, config),
        });
        if (discoveryResponse) return discoveryResponse;

        const registryResponse = await handleRegistryRoute(request, config, {
          service: dependencies.registryService,
          remoteAddress,
          headers: (registryRequest) => corsHeaders(registryRequest, config),
        });
        if (registryResponse) return registryResponse;

        if (request.method === "POST" && /^\/api\/v1\/admin\/runs\/[^/]+\/approve$/.test(url.pathname)) {
          const principal = guardRequest(request, config, {
            requiredRole: "operator",
            unsafe: true,
            remoteAddress,
          });
          if (!isIdempotencyKey(request.headers.get("idempotency-key"))) {
            return Response.json(
              { error: "idempotency_key_required" },
              { status: 400, headers: corsHeaders(request, config) },
            );
          }
          return Response.json(
            { status: "accepted", principalId: principal.id },
            { status: 202, headers: corsHeaders(request, config) },
          );
        }

        if (request.method === "GET" && url.pathname === "/api/v1/ws") {
          const principal = guardRequest(request, config, { websocket: true, remoteAddress });
          if (server.upgrade(request, { data: { principal } })) return;
          return Response.json({ error: "websocket_upgrade_required" }, { status: 426 });
        }
        if (request.method === "GET" && url.pathname === "/") {
          guardRequest(request, config, { remoteAddress });
          return Response.json(
            { name: "Career OS API", version: "0.0.0" },
            { headers: corsHeaders(request, config) },
          );
        }

        guardRequest(request, config, { remoteAddress });
      } catch (error) {
        return securityErrorResponse(error, request, config);
      }

      return Response.json({ error: "not_found" }, { status: 404, headers: corsHeaders(request, config) });
    },
    websocket: {
      open(socket) {
        socket.send(JSON.stringify({ type: "connected", principal: socket.data.principal }));
      },
      message() {
        // DSV-003 establishes identity at upgrade. Domain messages arrive in later workstreams.
      },
    },
  });
}
