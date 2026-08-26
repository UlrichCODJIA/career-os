import { createHealthResponse, type RuntimeConfig } from "@career-os/contracts";

export function createWorkerHealthServer(config: RuntimeConfig) {
  return Bun.serve({
    hostname: config.host,
    port: config.port,
    fetch(request) {
      const url = new URL(request.url);
      if (request.method === "GET" && url.pathname === "/healthz") {
        return Response.json(createHealthResponse("worker", config.profile), {
          headers: { "cache-control": "no-store" },
        });
      }
      return Response.json({ error: "not_found" }, { status: 404 });
    },
  });
}
