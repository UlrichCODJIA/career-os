import { createHealthResponse, isLoopbackHost, type RuntimeConfig } from "@career-os/contracts";
import { shellHtml, shellScript, shellStyles } from "./shell.ts";
import { operatorHtml, operatorOverrides, operatorScript, operatorStyles } from "./operator-shell.ts";
import { operatorSummaryScript } from "./operator-summary.ts";

export interface WebApiProxyConfig {
  upstreamBaseUrl: string;
  bearerToken: string;
}

function environmentProxyConfig(): WebApiProxyConfig | undefined {
  const upstreamBaseUrl = process.env.INTERNAL_API_URL?.trim();
  const bearerToken = process.env.AUTH_OPERATOR_TOKEN?.trim();
  return upstreamBaseUrl && bearerToken ? { upstreamBaseUrl, bearerToken } : undefined;
}

function validateProxyConfig(config: RuntimeConfig, proxy: WebApiProxyConfig | undefined): URL | undefined {
  if (!proxy) return undefined;
  if (config.profile !== "local" || !config.security.localOnly || config.security.networkBoundary !== "container-loopback") {
    throw new Error("authenticated API proxy is restricted to the local container profile");
  }
  const upstream = new URL(proxy.upstreamBaseUrl);
  if (
    upstream.protocol !== "http:"
    || upstream.username
    || upstream.password
    || upstream.pathname !== "/"
    || upstream.search
    || upstream.hash
    || (upstream.hostname !== "api" && !isLoopbackHost(upstream.hostname))
  ) {
    throw new Error("authenticated API proxy requires a credential-free local HTTP upstream origin");
  }
  return upstream;
}

async function boundedProxyBody(request: Request, maximumBytes: number): Promise<ArrayBuffer | undefined> {
  if (request.method === "GET") return undefined;
  const reader = request.body?.getReader();
  if (!reader) return new ArrayBuffer(0);
  const chunks: Uint8Array[] = [];
  let total = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > maximumBytes) {
      await reader.cancel();
      throw new RangeError("request_too_large");
    }
    chunks.push(value);
  }
  const output = new Uint8Array(new ArrayBuffer(total));
  let offset = 0;
  for (const chunk of chunks) {
    output.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return output.buffer;
}

function proxyResponse(upstream: Response): Response {
  const headers = new Headers({ "cache-control": "no-store", "x-content-type-options": "nosniff" });
  const contentType = upstream.headers.get("content-type");
  if (contentType) headers.set("content-type", contentType);
  return new Response(upstream.body, { status: upstream.status, headers });
}

export function createWebServer(
  config: RuntimeConfig,
  apiBaseUrl = process.env.PUBLIC_API_URL ?? "http://127.0.0.1:4100",
  proxy = environmentProxyConfig(),
) {
  const upstreamBase = validateProxyConfig(config, proxy);
  const apiOrigin = new URL(apiBaseUrl).origin;
  const clientApiBaseUrl = proxy ? "" : apiBaseUrl;
  const connectSource = proxy ? "'self'" : `'self' ${apiOrigin}`;
  return Bun.serve({
    hostname: config.host,
    port: config.port,
    async fetch(request) {
      const url = new URL(request.url);
      if (request.method === "GET" && url.pathname === "/healthz") {
        return Response.json(createHealthResponse("web", config.profile), {
          headers: { "cache-control": "no-store" },
        });
      }
      if (request.method === "GET" && url.pathname === "/") {
        return new Response(shellHtml, {
          headers: {
            "content-type": "text/html; charset=utf-8",
            "content-security-policy": `default-src 'none'; style-src 'self'; script-src 'self'; connect-src ${connectSource}; base-uri 'none'; frame-ancestors 'none'; form-action 'self'`,
            "x-content-type-options": "nosniff",
          },
        });
      }
      if (request.method === "GET" && url.pathname === "/operator") {
        return new Response(operatorHtml, { headers: {
          "content-type": "text/html; charset=utf-8",
          "content-security-policy": `default-src 'none'; style-src 'self'; script-src 'self'; connect-src ${connectSource}; base-uri 'none'; frame-ancestors 'none'; form-action 'self'`,
          "x-content-type-options": "nosniff",
        } });
      }
      if (url.pathname.startsWith("/api/v1/") && proxy) {
        if (!["GET", "POST", "PATCH", "DELETE"].includes(request.method)) {
          return Response.json({ error: "method_not_allowed" }, { status: 405, headers: { "cache-control": "no-store" } });
        }
        const origin = request.headers.get("origin");
        let publicOrigin: string;
        try {
          publicOrigin = new URL(config.security.publicBaseUrl).origin;
          if (url.origin !== publicOrigin) throw new Error("host mismatch");
          if (request.method !== "GET" && (!origin || new URL(origin).origin !== publicOrigin)) throw new Error("origin mismatch");
        } catch {
          return Response.json({ error: "origin_rejected" }, { status: 403, headers: { "cache-control": "no-store" } });
        }
        const contentLength = Number(request.headers.get("content-length") ?? "0");
        if (!Number.isSafeInteger(contentLength) || contentLength < 0 || contentLength > 65_536) {
          return Response.json({ error: "request_too_large" }, { status: 413, headers: { "cache-control": "no-store" } });
        }
        const headers = new Headers({ authorization: `Bearer ${proxy.bearerToken}` });
        for (const name of ["content-type", "idempotency-key"] as const) {
          const value = request.headers.get(name);
          if (value) headers.set(name, value);
        }
        headers.set("origin", publicOrigin);
        const upstreamUrl = new URL(`${url.pathname}${url.search}`, upstreamBase);
        try {
          const body = await boundedProxyBody(request, 65_536);
          const upstream = await fetch(upstreamUrl, {
            method: request.method,
            headers,
            body,
            signal: AbortSignal.timeout(15_000),
            redirect: "error",
          });
          return proxyResponse(upstream);
        } catch (error) {
          if (error instanceof RangeError && error.message === "request_too_large") {
            return Response.json({ error: "request_too_large" }, { status: 413, headers: { "cache-control": "no-store" } });
          }
          return Response.json({ error: "api_unavailable" }, { status: 502, headers: { "cache-control": "no-store" } });
        }
      }
      if (request.method === "GET" && url.pathname === "/styles.css") return new Response(shellStyles, { headers: { "content-type": "text/css; charset=utf-8", "cache-control": "no-store", "x-content-type-options": "nosniff" } });
      if (request.method === "GET" && url.pathname === "/app.js") return new Response(shellScript(clientApiBaseUrl), { headers: { "content-type": "text/javascript; charset=utf-8", "cache-control": "no-store", "x-content-type-options": "nosniff" } });
      if (request.method === "GET" && url.pathname === "/operator.css") return new Response(operatorStyles + operatorOverrides, { headers: { "content-type": "text/css; charset=utf-8", "cache-control": "no-store", "x-content-type-options": "nosniff" } });
      if (request.method === "GET" && url.pathname === "/operator.js") return new Response(operatorScript(clientApiBaseUrl), { headers: { "content-type": "text/javascript; charset=utf-8", "cache-control": "no-store", "x-content-type-options": "nosniff" } });
      if (request.method === "GET" && url.pathname === "/operator-summary.js") return new Response(operatorSummaryScript(clientApiBaseUrl), { headers: { "content-type": "text/javascript; charset=utf-8", "cache-control": "no-store", "x-content-type-options": "nosniff" } });
      return new Response("Not found", { status: 404 });
    },
  });
}
