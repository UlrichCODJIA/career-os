import { randomBytes } from "node:crypto";
import type { HealthResponse } from "@career-os/contracts";

export type JsonScalar = string | number | boolean | null;
export type TelemetryFields = Readonly<Record<string, unknown>>;

export interface CorrelationContext {
  correlationId: string;
  traceId: string;
  spanId: string;
  workJobId?: string;
  sourceId?: string;
  scanId?: string;
  artifactId?: string;
  connectorId?: string;
  connectorVersion?: string;
}

export type OperationalEventName =
  | "service_started"
  | "service_stopped"
  | "queue_tick_failed"
  | "scan_started"
  | "scan_artifact_recorded"
  | "scan_completed"
  | "scan_failed"
  | "ssrf_request_rejected"
  | "retention_tick_failed";

export type LogLevel = "debug" | "info" | "warn" | "error";

export interface StructuredLogEntry {
  timestamp: string;
  level: LogLevel;
  event: OperationalEventName;
  correlation?: CorrelationContext;
  fields: Record<string, unknown>;
}

export interface LogSink { write(entry: StructuredLogEntry): void; }
export interface StructuredLogger {
  record(event: OperationalEventName, fields?: TelemetryFields, context?: CorrelationContext, level?: LogLevel): void;
}

export const REDACTED = "[REDACTED]";
const MAX_LOG_DEPTH = 6;
const MAX_LOG_KEYS = 100;
const MAX_LOG_STRING = 1_000;
const FORBIDDEN_KEY = /(?:authorization|cookie|credential|password|passwd|secret|token|api[_-]?key|private[_-]?key|request[_-]?body|response[_-]?body|raw[_-]?(?:body|document|prompt)|resume|curriculum|cover[_-]?letter|email|phone)/iu;
const SECRET_VALUE = /(?:\b(?:bearer|basic)\s+[A-Za-z0-9+/_.=-]{8,}|(?:sk|phc|ghp|github_pat|xox[baprs])[_-][A-Za-z0-9_-]{8,}|CANARY[_-]?SECRET[^\s]*)/iu;
const SIGNED_QUERY = /(?:^|[?&])(?:x-amz-(?:algorithm|credential|signature)|signature|sig|token|access_token|key-pair-id)=/iu;
const URL_VALUE = /https?:\/\/\S+/iu;

function safeUrl(value: string): string | undefined {
  if (!/^https?:\/\//iu.test(value)) return;
  try {
    const url = new URL(value);
    if (url.username || url.password || SIGNED_QUERY.test(url.search)) return "[REDACTED_SIGNED_URL]";
    return url.search || url.hash ? `${url.origin}${url.pathname}?[REDACTED]` : url.href;
  } catch {
    return REDACTED;
  }
}

function redactedValue(value: unknown, depth: number, seen: WeakSet<object>): unknown {
  if (depth > MAX_LOG_DEPTH) return "[TRUNCATED]";
  if (value === null || typeof value === "number" || typeof value === "boolean") return value;
  if (typeof value === "bigint") return value.toString();
  if (value instanceof Date) return value.toISOString();
  if (value instanceof Error) {
    const code = "code" in value && typeof value.code === "string" && /^[a-z0-9_.:-]{1,100}$/u.test(value.code) ? value.code : undefined;
    return { name: value.name.slice(0, 100), ...(code ? { code } : {}), message: REDACTED };
  }
  if (typeof value === "string") {
    if (SECRET_VALUE.test(value)) return REDACTED;
    const url = safeUrl(value);
    if (!url && URL_VALUE.test(value)) return "[REDACTED_URL_TEXT]";
    return (url ?? value).slice(0, MAX_LOG_STRING);
  }
  if (typeof value !== "object") return String(value).slice(0, MAX_LOG_STRING);
  if (seen.has(value)) return "[CIRCULAR]";
  seen.add(value);
  if (Array.isArray(value)) return value.slice(0, MAX_LOG_KEYS).map((item) => redactedValue(item, depth + 1, seen));
  const output: Record<string, unknown> = {};
  for (const [key, item] of Object.entries(value).slice(0, MAX_LOG_KEYS)) {
    output[key] = FORBIDDEN_KEY.test(key) ? REDACTED : redactedValue(item, depth + 1, seen);
  }
  return output;
}

export function redactTelemetryFields(fields: TelemetryFields): Record<string, unknown> {
  return redactedValue(fields, 0, new WeakSet()) as Record<string, unknown>;
}

export class JsonConsoleSink implements LogSink {
  write(entry: StructuredLogEntry): void {
    const line = JSON.stringify(entry);
    if (entry.level === "error") console.error(line);
    else if (entry.level === "warn") console.warn(line);
    else console.log(line);
  }
}

export function createStructuredLogger(sink: LogSink = new JsonConsoleSink(), now: () => Date = () => new Date()): StructuredLogger {
  return {
    record(event, fields = {}, context, level = "info") {
      sink.write({ timestamp: now().toISOString(), level, event, ...(context ? { correlation: context } : {}), fields: redactTelemetryFields(fields) });
    },
  };
}

function hex(bytes: number): string { return randomBytes(bytes).toString("hex"); }

export function createCorrelationContext(input: Omit<Partial<CorrelationContext>, "traceId" | "spanId"> = {}): CorrelationContext {
  return { correlationId: input.correlationId ?? crypto.randomUUID(), traceId: hex(16), spanId: hex(8), ...input };
}

export function childCorrelation(parent: CorrelationContext, records: Partial<Pick<CorrelationContext, "scanId" | "artifactId">> = {}): CorrelationContext {
  return { ...parent, ...records, spanId: hex(8) };
}

export function traceparent(context: CorrelationContext): string { return `00-${context.traceId}-${context.spanId}-01`; }

export interface ServiceEvent extends Pick<HealthResponse, "service" | "profile" | "version"> {
  event: "service_started" | "service_stopped";
  host: string;
  port: number;
}

const defaultLogger = createStructuredLogger();
export function logServiceEvent(event: ServiceEvent): void {
  const { event: name, ...fields } = event;
  defaultLogger.record(name, fields);
}

const PRODUCT_EVENT_SCHEMAS = {
  "source scan completed": { required: ["connector_id", "outcome", "completeness_reason", "observation_count", "duration_bucket"] as const, optional: ["replayed"] as const },
  "source scan failed": { required: ["connector_id", "outcome", "error_code", "retryable", "duration_bucket"] as const, optional: [] as const },
  "operator decision recorded": { required: ["decision_type", "outcome"] as const, optional: [] as const },
  "discovery search completed": { required: ["result_bucket", "latency_bucket", "filter_count", "outcome"] as const, optional: [] as const },
} as const;

const PRODUCT_PROPERTY_RULES: Record<string, (value: JsonScalar) => boolean> = {
  connector_id: (value) => typeof value === "string" && /^[a-z0-9][a-z0-9._:-]{0,99}$/u.test(value),
  outcome: (value) => typeof value === "string" && ["completed", "failed", "accepted", "rejected", "succeeded"].includes(value),
  completeness_reason: (value) => typeof value === "string" && ["complete", "pagination_incomplete", "schema_invalid", "suspicious_empty", "blocked", "transport_failure", "limit_exceeded"].includes(value),
  observation_count: (value) => typeof value === "number" && Number.isSafeInteger(value) && value >= 0,
  duration_bucket: (value) => typeof value === "string" && ["under_1s", "1s_to_10s", "10s_to_60s", "over_60s"].includes(value),
  replayed: (value) => typeof value === "boolean",
  error_code: (value) => typeof value === "string" && /^[a-z0-9][a-z0-9._:-]{0,99}$/u.test(value),
  retryable: (value) => typeof value === "boolean",
  decision_type: (value) => typeof value === "string" && /^[a-z0-9][a-z0-9._:-]{0,99}$/u.test(value),
  result_bucket: (value) => typeof value === "string" && ["zero", "one_to_9", "ten_to_49", "50_plus"].includes(value),
  latency_bucket: (value) => typeof value === "string" && ["under_1s", "1s_to_10s", "10s_to_60s", "over_60s"].includes(value),
  filter_count: (value) => typeof value === "number" && Number.isSafeInteger(value) && value >= 0 && value <= 20,
};

export type ProductEventName = keyof typeof PRODUCT_EVENT_SCHEMAS;
export type ProductEventProperties = Readonly<Record<string, JsonScalar>>;

export class ProductEventValidationError extends Error {
  constructor(readonly code: "unknown_event" | "unknown_property" | "missing_property" | "unsafe_property" | "invalid_property_value") {
    super(code);
    this.name = "ProductEventValidationError";
  }
}

export function validateProductEvent(name: string, properties: ProductEventProperties): asserts name is ProductEventName {
  const schema = PRODUCT_EVENT_SCHEMAS[name as ProductEventName];
  if (!schema) throw new ProductEventValidationError("unknown_event");
  const allowed = new Set<string>([...schema.required, ...schema.optional]);
  for (const required of schema.required) if (!(required in properties)) throw new ProductEventValidationError("missing_property");
  for (const [key, value] of Object.entries(properties)) {
    if (FORBIDDEN_KEY.test(key)) throw new ProductEventValidationError("unsafe_property");
    if (!allowed.has(key)) throw new ProductEventValidationError("unknown_property");
    if (typeof value === "string" && (SECRET_VALUE.test(value) || URL_VALUE.test(value))) throw new ProductEventValidationError("unsafe_property");
    if (!PRODUCT_PROPERTY_RULES[key]?.(value)) throw new ProductEventValidationError("invalid_property_value");
  }
}

export interface ProductEventSink { capture(name: ProductEventName, properties: ProductEventProperties): Promise<void>; }
export class NoopProductEventSink implements ProductEventSink {
  async capture(_name: ProductEventName, _properties: ProductEventProperties): Promise<void> {}
}

export interface PostHogConfig { apiKey: string; host: string; timeoutMs?: number; }

export class PostHogHttpSink implements ProductEventSink {
  private readonly endpoint: URL;
  constructor(private readonly config: PostHogConfig, private readonly transport: typeof fetch = fetch) {
    const host = new URL(config.host);
    if (!config.apiKey || config.apiKey.length > 500) throw new TypeError("posthog_api_key_invalid");
    if (host.username || host.password || host.search || host.hash) throw new TypeError("posthog_host_invalid");
    if (host.protocol !== "https:" && host.hostname !== "127.0.0.1" && host.hostname !== "localhost") throw new TypeError("posthog_host_must_use_https");
    this.endpoint = new URL("/capture/", host);
  }
  async capture(name: ProductEventName, properties: ProductEventProperties): Promise<void> {
    validateProductEvent(name, properties);
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), this.config.timeoutMs ?? 5_000);
    try {
      const response = await this.transport(this.endpoint, {
        method: "POST", headers: { "content-type": "application/json" },
        body: JSON.stringify({ api_key: this.config.apiKey, event: name, distinct_id: "career-os-system", properties: { ...properties, $process_person_profile: false, $geoip_disable: true } }),
        signal: controller.signal,
      });
      if (!response.ok) throw new Error(`posthog_capture_failed:${response.status}`);
    } finally { clearTimeout(timeout); }
  }
}

export function productEventSinkFromEnv(environment: Record<string, string | undefined> = process.env): ProductEventSink {
  const apiKey = environment.POSTHOG_API_KEY?.trim();
  if (!apiKey) return new NoopProductEventSink();
  return new PostHogHttpSink({ apiKey, host: environment.POSTHOG_HOST?.trim() || "https://eu.i.posthog.com" });
}

export type AlertName = "queue_lag" | "count_collapse" | "closure_spike" | "disk_pressure" | "ssrf_rejection";
export interface AlertSignal { name: AlertName; severity: "warning" | "critical"; observed: number; threshold: number; runbook: string; }
export interface OperationalSnapshot {
  queueLagSeconds?: number;
  countRatio?: number;
  countBaseline?: number;
  closureRatio?: number;
  closureCount?: number;
  diskUsageRatio?: number;
  ssrfRejections?: number;
}

export const OPERATIONAL_THRESHOLDS = Object.freeze({
  queueLagWarningSeconds: 900, queueLagCriticalSeconds: 1_800, countCollapseRatio: 0.2, minimumCountBaseline: 10,
  closureSpikeRatio: 0.35, minimumClosureCount: 10, diskWarningRatio: 0.8, diskCriticalRatio: 0.9, ssrfRejections: 1,
});

export function evaluateOperationalAlerts(snapshot: OperationalSnapshot): AlertSignal[] {
  const alerts: AlertSignal[] = [];
  if ((snapshot.queueLagSeconds ?? 0) >= OPERATIONAL_THRESHOLDS.queueLagWarningSeconds) alerts.push({ name: "queue_lag", severity: snapshot.queueLagSeconds! >= OPERATIONAL_THRESHOLDS.queueLagCriticalSeconds ? "critical" : "warning", observed: snapshot.queueLagSeconds!, threshold: OPERATIONAL_THRESHOLDS.queueLagWarningSeconds, runbook: "docs/operations/work-queue.md" });
  if ((snapshot.countBaseline ?? 0) >= OPERATIONAL_THRESHOLDS.minimumCountBaseline && (snapshot.countRatio ?? 1) <= OPERATIONAL_THRESHOLDS.countCollapseRatio) alerts.push({ name: "count_collapse", severity: "critical", observed: snapshot.countRatio!, threshold: OPERATIONAL_THRESHOLDS.countCollapseRatio, runbook: "docs/operations/source-incidents.md#count-collapse" });
  if ((snapshot.closureCount ?? 0) >= OPERATIONAL_THRESHOLDS.minimumClosureCount && (snapshot.closureRatio ?? 0) >= OPERATIONAL_THRESHOLDS.closureSpikeRatio) alerts.push({ name: "closure_spike", severity: "critical", observed: snapshot.closureRatio!, threshold: OPERATIONAL_THRESHOLDS.closureSpikeRatio, runbook: "docs/operations/source-incidents.md#closure-spike" });
  if ((snapshot.diskUsageRatio ?? 0) >= OPERATIONAL_THRESHOLDS.diskWarningRatio) alerts.push({ name: "disk_pressure", severity: snapshot.diskUsageRatio! >= OPERATIONAL_THRESHOLDS.diskCriticalRatio ? "critical" : "warning", observed: snapshot.diskUsageRatio!, threshold: OPERATIONAL_THRESHOLDS.diskWarningRatio, runbook: "docs/operations/artifact-retention.md" });
  if ((snapshot.ssrfRejections ?? 0) >= OPERATIONAL_THRESHOLDS.ssrfRejections) alerts.push({ name: "ssrf_rejection", severity: "warning", observed: snapshot.ssrfRejections!, threshold: OPERATIONAL_THRESHOLDS.ssrfRejections, runbook: "docs/operations/source-incidents.md#ssrf-rejection" });
  return alerts;
}

export function durationBucket(milliseconds: number): string {
  if (milliseconds < 1_000) return "under_1s";
  if (milliseconds < 10_000) return "1s_to_10s";
  if (milliseconds < 60_000) return "10s_to_60s";
  return "over_60s";
}
