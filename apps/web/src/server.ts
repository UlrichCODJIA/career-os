import { createHealthResponse, type RuntimeConfig } from "@career-os/contracts";
import { shellHtml } from "./shell.ts";

export function createWebServer(config: RuntimeConfig) {
  return Bun.serve({
    hostname: config.host,
    port: config.port,
    fetch(request) {
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
            "content-security-policy": "default-src 'none'; style-src 'unsafe-inline'; base-uri 'none'; frame-ancestors 'none'",
            "x-content-type-options": "nosniff",
          },
        });
      }
      return new Response("Not found", { status: 404 });
    },
  });
}
