import { readRuntimeConfig } from "@career-os/contracts";
import { createStructuredLogger, logServiceEvent } from "@career-os/observability";
import { createDatabase, PostgresWorkQueue } from "@career-os/db";
import { PostgresArtifactMetadata } from "@career-os/db";
import { ArtifactRetentionService, LocalArtifactStore } from "@career-os/artifact-store";
import { createWorkerHealthServer } from "./server.ts";
import { startScheduler } from "./scheduler.ts";
import { startRetentionWorker } from "./retention.ts";
import { startScanWorker } from "./scan-worker.ts";

const config = readRuntimeConfig("worker");
const server = createWorkerHealthServer(config);
const databaseUrl = process.env.DATABASE_URL;
const database = databaseUrl ? createDatabase(databaseUrl) : undefined;
const logger = createStructuredLogger();
const scheduler = database
  ? startScheduler(new PostgresWorkQueue(database), {
      onError: (error) => logger.record("queue_tick_failed", { error }, undefined, "error"),
    })
  : undefined;
const artifactRoot = process.env.ARTIFACT_ROOT;
const retention = database && artifactRoot
  ? startRetentionWorker(
      new ArtifactRetentionService(new LocalArtifactStore({ root: artifactRoot }), new PostgresArtifactMetadata(database)),
      { onError: (error) => logger.record("retention_tick_failed", { error }, undefined, "error") },
    )
  : undefined;
const scanner = database && artifactRoot
  ? startScanWorker(database, artifactRoot, { onError: (error) => logger.record("scan_failed", { error, phase: "worker_setup" }, undefined, "error") })
  : undefined;

for (const signal of ["SIGINT", "SIGTERM"] as const) {
  process.once(signal, async () => {
    scheduler?.stop();
    retention?.stop();
    scanner?.stop();
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
