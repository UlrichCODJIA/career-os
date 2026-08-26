import { readRuntimeConfig } from "@career-os/contracts";
import { logServiceEvent } from "@career-os/observability";
import { createApiServer } from "./server.ts";

const config = readRuntimeConfig("api");
const server = createApiServer(config);

logServiceEvent({
  event: "service_started",
  service: "api",
  profile: config.profile,
  version: "0.0.0",
  host: config.host,
  port: server.port ?? config.port,
});
