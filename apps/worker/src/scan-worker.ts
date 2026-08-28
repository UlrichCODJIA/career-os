import type { SQL } from "bun";
import { LocalArtifactStore } from "@career-os/artifact-store";
import { ashbyConnector, greenhouseConnector, leverConnector } from "@career-os/connectors";
import type { SourceConnector, SourceDescriptor } from "@career-os/connector-sdk";
import { PostgresArtifactMetadata, PostgresScanLedger, PostgresWorkQueue } from "@career-os/db";
import { SafeFetchClient, type SafeFetchPolicy } from "@career-os/safe-fetch";
import { SourceScanRunner } from "./scan-runner.ts";

interface ScanContext {
  source: SourceDescriptor;
  connector: SourceConnector;
  policy: SafeFetchPolicy;
  retentionClass: string;
}

export interface ScanWorkerOptions {
  intervalMs?: number;
  workerId?: string;
  onError?: (error: unknown) => void;
}

const connectors = new Map<string, SourceConnector>([
  [greenhouseConnector.id, greenhouseConnector],
  [leverConnector.id, leverConnector],
  [ashbyConnector.id, ashbyConnector],
]);

async function loadContext(sql: SQL, sourceId: string): Promise<ScanContext> {
  const row = (await sql<{
    id: string; connector_id: string; connector_version: string; tenant_key: string; board_url: string;
    api_base_url: string; region: "global" | "eu"; policy_id: string; retention_class: string;
    max_requests_per_minute: number; max_concurrency: number; user_agent: string; policy_state: string;
    policy_expires_at: Date | string | null; policy_review_due_at: Date | string;
  }[]>`
    SELECT source.id, source.connector_id, source.connector_version, source.tenant_key, source.board_url,
      source.api_base_url, source.region, source.policy_id, source.policy_review_due_at,
      policy.retention_class, policy.max_requests_per_minute, policy.max_concurrency,
      policy.user_agent, policy.state AS policy_state, policy.expires_at AS policy_expires_at
    FROM sources source JOIN source_policies policy ON policy.id = source.policy_id
    WHERE source.id = ${sourceId} AND source.enabled
  `)[0];
  if (!row) throw new Error("source_not_enabled");
  const now = Date.now();
  if (row.policy_state !== "approved" || !row.policy_expires_at
    || new Date(row.policy_expires_at).getTime() <= now || new Date(row.policy_review_due_at).getTime() <= now) {
    throw new Error("source_policy_blocked");
  }
  const connector = connectors.get(row.connector_id);
  if (!connector || connector.version !== row.connector_version) throw new Error("connector_version_unavailable");
  const apiHost = new URL(row.api_base_url).hostname;
  return {
    source: {
      sourceId: row.id, connectorId: connector.id, tenantKey: row.tenant_key, boardUrl: row.board_url,
      apiBaseUrl: row.api_base_url, region: row.region, policyId: row.policy_id,
    },
    connector,
    policy: {
      id: row.policy_id, allowedHosts: [apiHost], allowedContentTypes: ["application/json"],
      maxRequestsPerMinute: row.max_requests_per_minute, maxConcurrency: row.max_concurrency,
      maxRedirects: 3, timeoutMs: 30_000, maxWireBytes: 20 * 1024 * 1024,
      maxResponseBytes: 40 * 1024 * 1024, userAgent: row.user_agent,
    },
    retentionClass: row.retention_class,
  };
}

export function startScanWorker(sql: SQL, artifactRoot: string, options: ScanWorkerOptions = {}) {
  const intervalMs = options.intervalMs ?? 1_000;
  if (!Number.isInteger(intervalMs) || intervalMs < 1_000) throw new Error("scan worker interval must be at least one second");
  const workerId = options.workerId ?? `scan-worker:${process.pid}:${crypto.randomUUID()}`;
  const queue = new PostgresWorkQueue(sql);
  const runner = new SourceScanRunner(
    new SafeFetchClient(), new LocalArtifactStore({ root: artifactRoot }), new PostgresArtifactMetadata(sql), new PostgresScanLedger(sql),
  );
  let stopped = false;
  let active: Promise<void> | undefined;
  const tick = (): Promise<void> => {
    if (active) return active;
    active = (async () => {
      const lease = (await queue.claim(workerId, 1, 300, "scan_source"))[0];
      if (!lease) return;
      const sourceId = typeof lease.payload.sourceId === "string" ? lease.payload.sourceId : "";
      try {
        const context = await loadContext(sql, sourceId);
        await runner.run({
          lease, workerId, ...context, safeFetchPolicyVersion: "1.0.0",
        });
      } catch (error) {
        // A setup/database failure leaves the fenced lease for the durable reaper; runner failures are recorded atomically.
        options.onError?.(error);
      }
    })().finally(() => { active = undefined; });
    return active;
  };
  const timer = setInterval(() => { if (!stopped) void tick(); }, intervalMs);
  void tick();
  return { tick, stop: () => { stopped = true; clearInterval(timer); } };
}
