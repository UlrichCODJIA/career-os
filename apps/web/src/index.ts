import { readRuntimeConfig } from "@career-os/contracts";
import { logServiceEvent } from "@career-os/observability";
import { createWebServer } from "./server.ts";

const config = readRuntimeConfig("web");
const server = createWebServer(config);

logServiceEvent({
  event: "service_started",
  service: "web",
  profile: config.profile,
  version: "0.0.0",
  host: config.host,
  port: server.port ?? config.port,
});
