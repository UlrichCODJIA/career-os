import { describe, expect, test } from "bun:test";
import {
  PostHogHttpSink,
  ProductEventValidationError,
  childCorrelation,
  createCorrelationContext,
  createStructuredLogger,
  evaluateOperationalAlerts,
  productEventSinkFromEnv,
  redactTelemetryFields,
  traceparent,
  validateProductEvent,
  type StructuredLogEntry,
} from "../packages/observability/src/index.ts";

describe("privacy-safe observability", () => {
  test("recursively redacts credentials, bodies, canary secrets, and signed URLs", () => {
    const circular: Record<string, unknown> = {};
    circular.self = circular;
    const fields = redactTelemetryFields({
      authorization: "Bearer do-not-emit-this",
      nested: { responseBody: "private application", value: "CANARY_SECRET_observability_123" },
      signed: "https://objects.example/file?X-Amz-Signature=secret",
      ordinary: "https://boards.example/jobs?team=platform",
      embedded: "request failed at https://objects.example/file?signature=secret",
      failure: new Error("request failed at https://private.example?token=CANARY_SECRET_error"),
      circular,
    });
    const encoded = JSON.stringify(fields);
    expect(encoded).not.toContain("do-not-emit-this");
    expect(encoded).not.toContain("private application");
    expect(encoded).not.toContain("observability_123");
    expect(encoded).not.toContain("X-Amz-Signature");
    expect(encoded).not.toContain("private.example");
    expect(encoded).not.toContain("objects.example");
    expect(fields).toMatchObject({ authorization: "[REDACTED]", signed: "[REDACTED_SIGNED_URL]", ordinary: "https://boards.example/jobs?[REDACTED]" });
    expect(encoded).toContain("[CIRCULAR]");
  });

  test("emits bounded JSON with record correlation and W3C trace context", () => {
    const entries: StructuredLogEntry[] = [];
    const context = createCorrelationContext({ correlationId: "correlation-1", workJobId: "job-1", sourceId: "source-1", connectorId: "greenhouse", connectorVersion: "1.0.0" });
    const artifact = childCorrelation(context, { artifactId: "artifact-1" });
    createStructuredLogger({ write: (entry) => entries.push(entry) }, () => new Date("2026-09-03T00:00:00Z"))
      .record("scan_artifact_recorded", { byteCount: 42 }, artifact);
    expect(entries[0]).toMatchObject({ event: "scan_artifact_recorded", correlation: { correlationId: "correlation-1", workJobId: "job-1", artifactId: "artifact-1" }, fields: { byteCount: 42 } });
    expect(traceparent(artifact)).toMatch(/^00-[0-9a-f]{32}-[0-9a-f]{16}-01$/);
    expect(artifact.traceId).toBe(context.traceId);
    expect(artifact.spanId).not.toBe(context.spanId);
  });

  test("rejects unapproved events, extra fields, PII keys, secrets, and URLs", () => {
    const valid = { connector_id: "greenhouse", outcome: "completed", completeness_reason: "complete", observation_count: 42, duration_bucket: "1s_to_10s" };
    expect(() => validateProductEvent("source scan completed", valid)).not.toThrow();
    for (const [name, properties, code] of [
      ["candidate viewed", valid, "unknown_event"],
      ["source scan completed", { ...valid, source_id: "private-record" }, "unknown_property"],
      ["source scan completed", { ...valid, email: "person@example.com" }, "unsafe_property"],
      ["source scan completed", { ...valid, outcome: "CANARY_SECRET_event" }, "unsafe_property"],
      ["source scan completed", { ...valid, outcome: "https://example.com/job" }, "unsafe_property"],
      ["source scan completed", { ...valid, outcome: "failed at https://example.com/job" }, "unsafe_property"],
      ["source scan completed", { ...valid, observation_count: "forty-two" }, "invalid_property_value"],
    ] as const) {
      try { validateProductEvent(name, properties); throw new Error("accepted unsafe event"); }
      catch (error) { expect(error).toBeInstanceOf(ProductEventValidationError); expect((error as ProductEventValidationError).code).toBe(code); }
    }
  });

  test("sends personless events and never places the project key in a header or URL", async () => {
    let request: { url: string; init?: RequestInit } | undefined;
    const transport = (async (input: URL | RequestInfo, init?: RequestInit) => {
      request = { url: String(input), init };
      return new Response("ok");
    }) as typeof fetch;
    const sink = new PostHogHttpSink({ apiKey: "project-key", host: "https://eu.i.posthog.com" }, transport);
    await sink.capture("source scan failed", { connector_id: "lever", outcome: "failed", error_code: "source_blocked", retryable: false, duration_bucket: "under_1s" });
    expect(request?.url).toBe("https://eu.i.posthog.com/capture/");
    expect(JSON.stringify(request?.init?.headers)).not.toContain("project-key");
    expect(JSON.parse(String(request?.init?.body))).toMatchObject({ api_key: "project-key", distinct_id: "career-os-system", properties: { $process_person_profile: false, $geoip_disable: true } });
    expect(productEventSinkFromEnv({})).toHaveProperty("capture");
    expect(() => new PostHogHttpSink({ apiKey: "key", host: "http://posthog.example" })).toThrow("posthog_host_must_use_https");
    expect(() => new PostHogHttpSink({ apiKey: "", host: "https://posthog.example" })).toThrow("posthog_api_key_invalid");
    expect(() => new PostHogHttpSink({ apiKey: "key", host: "https://user:pass@posthog.example" })).toThrow("posthog_host_invalid");
  });
});

describe("operational alert simulations", () => {
  test("does not alert inside the healthy envelope", () => {
    expect(evaluateOperationalAlerts({ queueLagSeconds: 30, countBaseline: 100, countRatio: 0.95, closureCount: 2, closureRatio: 0.02, diskUsageRatio: 0.3, ssrfRejections: 0 })).toEqual([]);
  });

  test.each([
    [{ queueLagSeconds: 1_801 }, "queue_lag", "critical"],
    [{ countBaseline: 100, countRatio: 0.1 }, "count_collapse", "critical"],
    [{ closureCount: 20, closureRatio: 0.5 }, "closure_spike", "critical"],
    [{ diskUsageRatio: 0.81 }, "disk_pressure", "warning"],
    [{ ssrfRejections: 1 }, "ssrf_rejection", "warning"],
  ] as const)("maps anomaly %o to its owned runbook", (snapshot, name, severity) => {
    expect(evaluateOperationalAlerts(snapshot)).toEqual([expect.objectContaining({ name, severity, runbook: expect.stringContaining("docs/operations/") })]);
  });
});
