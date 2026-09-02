import { afterEach, describe, expect, test } from "bun:test";
import { generateCsrfToken } from "../packages/auth/src/index.ts";
import { readRuntimeConfig } from "../packages/contracts/src/index.ts";
import type { OperatorConsoleService, OperatorContext } from "../packages/db/src/index.ts";
import { createApiServer } from "../apps/api/src/server.ts";

const origin = "https://career.example";
const operatorToken = "operator-token-that-is-at-least-32-characters";
const userToken = "ordinary-user-token-that-is-at-least-32-characters";
const csrfSecret = `test-only-${"x".repeat(32)}`;
const sourceId = "01900000-0000-7000-8000-000000000201";
const reviewId = "01900000-0000-7000-8000-000000000301";
const servers: Array<{ stop(close?: boolean): void }> = [];

class FakeOperatorConsole implements OperatorConsoleService {
  calls: Array<{ name: string; context?: OperatorContext; value?: unknown }> = [];
  overview(): Promise<Record<string, unknown>> { return Promise.resolve({ activeBreakers: 1 }); }
  reviews(): Promise<Record<string, unknown>> { return Promise.resolve({ reviews: [] }); }
  review(): Promise<Record<string, unknown>> { return Promise.resolve({ id: reviewId, candidate: { candidateOpportunityIds: [sourceId] } }); }
  sourceEvidence(): Promise<Record<string, unknown>> { return Promise.resolve({ source: { id: sourceId }, scans: [], rawArtifactAccess: { available: false } }); }
  clearBreaker(context: OperatorContext, breakerId: string, reason: string): Promise<unknown> { this.calls.push({ name: "clear", context, value: { breakerId, reason } }); return Promise.resolve({ breakerId }); }
  mergeCompanyReview(): Promise<unknown> { return Promise.resolve({}); }
  splitCompany(): Promise<unknown> { return Promise.resolve({}); }
  attachOpportunityReview(): Promise<unknown> { return Promise.resolve({}); }
  splitOpportunity(): Promise<unknown> { return Promise.resolve({}); }
}

function config(mode: "bearer" | "cookie") {
  return readRuntimeConfig("api", {
    CAREER_OS_PROFILE: "hosted", API_HOST: "127.0.0.1", API_PORT: "0", NETWORK_BOUNDARY: "remote", LOCAL_ONLY: "false",
    DISCOVERY_PUBLIC_BASE_URL: origin, ALLOWED_ORIGINS: origin, AUTH_MODE: mode, TRANSPORT_SECURITY: "trusted-proxy",
    TRUSTED_PROXY_IPS: "127.0.0.1,::1", AUTH_OPERATOR_TOKEN: operatorToken, AUTH_USER_TOKEN: userToken,
    AUTH_CSRF_SECRET: mode === "cookie" ? csrfSecret : undefined, ARTIFACT_ROOT: "C:\\career-os\\artifacts",
  });
}

function baseHeaders(token = operatorToken): Record<string, string> {
  return { authorization: `Bearer ${token}`, origin, "x-forwarded-proto": "https", "content-type": "application/json" };
}

afterEach(() => { for (const server of servers.splice(0)) server.stop(true); });

describe("operator console API", () => {
  test("enforces the operator role on redacted read models", async () => {
    const service = new FakeOperatorConsole();
    const server = createApiServer(config("bearer"), { operatorConsole: service }); servers.push(server);
    const endpoint = `http://127.0.0.1:${server.port}/api/v1/admin/sources/${sourceId}/evidence`;
    const forbidden = await fetch(endpoint, { headers: baseHeaders(userToken) });
    expect(forbidden.status).toBe(403);
    const allowed = await fetch(endpoint, { headers: baseHeaders() });
    expect(allowed.status).toBe(200);
    const body = await allowed.json();
    expect(body.rawArtifactAccess).toEqual({ available: false });
    expect(JSON.stringify(body)).not.toMatch(/authorization|cookie|responseHeaders|storageUri/i);
  });

  test("requires idempotency, a valid reason, and delegates a bounded breaker clearance", async () => {
    const service = new FakeOperatorConsole();
    const server = createApiServer(config("bearer"), { operatorConsole: service }); servers.push(server);
    const endpoint = `http://127.0.0.1:${server.port}/api/v1/admin/circuit-breakers/${sourceId}/clear`;
    const missing = await fetch(endpoint, { method: "POST", headers: baseHeaders(), body: JSON.stringify({ reason: "Reviewed anomaly evidence" }) });
    expect(missing.status).toBe(400);
    const invalid = await fetch(endpoint, { method: "POST", headers: { ...baseHeaders(), "idempotency-key": "breaker-0001" }, body: JSON.stringify({ reason: "short" }) });
    expect(invalid.status).toBe(400);
    const accepted = await fetch(endpoint, { method: "POST", headers: { ...baseHeaders(), "idempotency-key": "breaker-0001" }, body: JSON.stringify({ reason: "Reviewed anomaly evidence" }) });
    expect(accepted.status).toBe(200);
    expect(service.calls[0]).toMatchObject({ name: "clear", context: { actorId: "configured-operator", idempotencyKey: "breaker-0001" } });
  });

  test("rejects cookie mutations without exact-origin CSRF evidence", async () => {
    const service = new FakeOperatorConsole();
    const server = createApiServer(config("cookie"), { operatorConsole: service }); servers.push(server);
    const endpoint = `http://127.0.0.1:${server.port}/api/v1/admin/circuit-breakers/${sourceId}/clear`;
    const headers = { origin, "x-forwarded-proto": "https", "content-type": "application/json", "idempotency-key": "breaker-0002", cookie: `career_os_session=${operatorToken}` };
    const rejected = await fetch(endpoint, { method: "POST", headers, body: JSON.stringify({ reason: "Reviewed anomaly evidence" }) });
    expect(rejected.status).toBe(403);
    const accepted = await fetch(endpoint, { method: "POST", headers: { ...headers, "x-csrf-token": generateCsrfToken(operatorToken, csrfSecret) }, body: JSON.stringify({ reason: "Reviewed anomaly evidence" }) });
    expect(accepted.status).toBe(200);
  });
});
