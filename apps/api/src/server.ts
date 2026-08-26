import { createHealthResponse, type RuntimeConfig } from "@career-os/contracts";

export function createApiServer(config: RuntimeConfig) {
  return Bun.serve({
    hostname: config.host,
    port: config.port,
    fetch(request) {
      const url = new URL(request.url);
      if (request.method === "GET" && url.pathname === "/healthz") {
        return Response.json(createHealthResponse("api", config.profile), {
          headers: { "cache-control": "no-store" },
        });
      }

      if (request.method === "GET" && url.pathname === "/") {
        return Response.json({ name: "Career OS API", version: "0.0.0" });
      }

      return Response.json({ error: "not_found" }, { status: 404 });
    },
  });
}
