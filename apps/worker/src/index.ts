import { readRuntimeConfig } from "@career-os/contracts";
import { logServiceEvent } from "@career-os/observability";
import { createWorkerHealthServer } from "./server.ts";

const config = readRuntimeConfig("worker");
const server = createWorkerHealthServer(config);

logServiceEvent({
  event: "service_started",
  service: "worker",
  profile: config.profile,
  version: "0.0.0",
  host: config.host,
  port: server.port ?? config.port,
});
