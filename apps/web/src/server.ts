import { createHealthResponse, type RuntimeConfig } from "@career-os/contracts";
import { shellHtml, shellScript, shellStyles } from "./shell.ts";
import { operatorHtml, operatorOverrides, operatorScript, operatorStyles } from "./operator-shell.ts";

export function createWebServer(config: RuntimeConfig, apiBaseUrl = process.env.PUBLIC_API_URL ?? "http://127.0.0.1:4100") {
  const apiOrigin = new URL(apiBaseUrl).origin;
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
            "content-security-policy": `default-src 'none'; style-src 'self'; script-src 'self'; connect-src 'self' ${apiOrigin}; base-uri 'none'; frame-ancestors 'none'; form-action 'self'`,
            "x-content-type-options": "nosniff",
          },
        });
      }
      if (request.method === "GET" && url.pathname === "/operator") {
        return new Response(operatorHtml, { headers: {
          "content-type": "text/html; charset=utf-8",
          "content-security-policy": `default-src 'none'; style-src 'self'; script-src 'self'; connect-src 'self' ${apiOrigin}; base-uri 'none'; frame-ancestors 'none'; form-action 'self'`,
          "x-content-type-options": "nosniff",
        } });
      }
      if (request.method === "GET" && url.pathname === "/styles.css") return new Response(shellStyles, { headers: { "content-type": "text/css; charset=utf-8", "cache-control": "no-store", "x-content-type-options": "nosniff" } });
      if (request.method === "GET" && url.pathname === "/app.js") return new Response(shellScript(apiBaseUrl), { headers: { "content-type": "text/javascript; charset=utf-8", "cache-control": "no-store", "x-content-type-options": "nosniff" } });
      if (request.method === "GET" && url.pathname === "/operator.css") return new Response(operatorStyles + operatorOverrides, { headers: { "content-type": "text/css; charset=utf-8", "cache-control": "no-store", "x-content-type-options": "nosniff" } });
      if (request.method === "GET" && url.pathname === "/operator.js") return new Response(operatorScript(apiBaseUrl), { headers: { "content-type": "text/javascript; charset=utf-8", "cache-control": "no-store", "x-content-type-options": "nosniff" } });
      return new Response("Not found", { status: 404 });
    },
  });
}
