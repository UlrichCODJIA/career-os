import { readRuntimeConfig } from "@career-os/contracts";
import { logServiceEvent } from "@career-os/observability";
import { createDatabase, PostgresWorkQueue } from "@career-os/db";
import { createWorkerHealthServer } from "./server.ts";
import { startScheduler } from "./scheduler.ts";

const config = readRuntimeConfig("worker");
const server = createWorkerHealthServer(config);
const databaseUrl = process.env.DATABASE_URL;
const database = databaseUrl ? createDatabase(databaseUrl) : undefined;
const scheduler = database
  ? startScheduler(new PostgresWorkQueue(database), {
      onError: () => console.error("Scheduler tick failed"),
    })
  : undefined;

for (const signal of ["SIGINT", "SIGTERM"] as const) {
  process.once(signal, async () => {
    scheduler?.stop();
    server.stop(true);
    await database?.close();
    process.exit(0);
  });
}

logServiceEvent({
  event: "service_started",
  service: "worker",
  profile: config.profile,
  version: "0.0.0",
  host: config.host,
  port: server.port ?? config.port,
});
