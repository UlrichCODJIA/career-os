import { readRuntimeConfig } from "@career-os/contracts";
import { logServiceEvent } from "@career-os/observability";
import { RegistryService } from "@career-os/discovery-domain";
import { createDatabase, PostgresRegistryStore } from "@career-os/db";
import { createApiServer } from "./server.ts";

const config = readRuntimeConfig("api");
const databaseUrl = process.env.DATABASE_URL;
const database = databaseUrl ? createDatabase(databaseUrl) : undefined;
const server = createApiServer(config, {
  registryService: database ? new RegistryService(new PostgresRegistryStore(database)) : undefined,
});

logServiceEvent({
  event: "service_started",
  service: "api",
  profile: config.profile,
  version: "0.0.0",
  host: config.host,
  port: server.port ?? config.port,
});
