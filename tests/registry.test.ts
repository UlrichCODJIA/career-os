import { afterEach, describe, expect, test } from "bun:test";
import {
  OwnershipEvidenceSchema,
  SourceCandidateImportSchema,
  readRuntimeConfig,
} from "../packages/contracts/src/index.ts";
import {
  RegistryRuleError,
  RegistryService,
  type RegistryMutationContext,
  type RegistryStore,
} from "../packages/discovery-domain/src/index.ts";
import { createApiServer } from "../apps/api/src/server.ts";

const operatorToken = "operator-token-that-is-at-least-32-characters";
const userToken = "ordinary-user-token-that-is-at-least-32-characters";
const origin = "https://career.example";
const servers: Array<{ stop(closeActiveConnections?: boolean): void }> = [];

const validImport = {
  rows: [{ companyName: "Example", primaryDomain: "example.com", careersUrl: "https://example.com/careers" }],
  reason: "Reviewed seed registry import",
};

const validPolicy = {
  sourceFamily: "greenhouse",
  hostPattern: "*.greenhouse.io",
  accessClass: "documented_public_feed" as const,
  reviewedAt: new Date(Date.now() - 60_000).toISOString(),
  expiresAt: new Date(Date.now() + 86_400_000).toISOString(),
  retentionClass: "standard",
  maxRequestsPerMinute: 60,
  maxConcurrency: 2,
  contactEmail: "operator@example.com",
  userAgent: "Career OS registry verifier",
  state: "approved" as const,
  reason: "Initial reviewed policy approval",
};

class FakeStore implements RegistryStore {
  calls: Array<{ name: string; context?: RegistryMutationContext; value?: unknown }> = [];
  importCandidates(context: RegistryMutationContext, value: never): Promise<unknown> {
    this.calls.push({ name: "import", context, value });
    return Promise.resolve({ imported: 1, duplicates: 0 });
  }
  createPolicy(context: RegistryMutationContext, value: never): Promise<unknown> {
    this.calls.push({ name: "createPolicy", context, value });
    return Promise.resolve({ policy: { id: crypto.randomUUID() } });
  }
  verifyCandidate(context: RegistryMutationContext, candidateId: string, value: never): Promise<unknown> {
    this.calls.push({ name: "verify", context, value: { candidateId, value } });
    return Promise.resolve({ candidateId });
  }
  rejectCandidate(): Promise<unknown> { return Promise.resolve({}); }
  updatePolicy(): Promise<unknown> { return Promise.resolve({}); }
  updateSource(): Promise<unknown> { return Promise.resolve({}); }
  listCandidates(): Promise<unknown> { return Promise.resolve({ candidates: [] }); }
  listSources(): Promise<unknown> { return Promise.resolve({ sources: [] }); }
}

function hostedConfig() {
  return readRuntimeConfig("api", {
    CAREER_OS_PROFILE: "hosted",
    API_HOST: "127.0.0.1",
    API_PORT: "0",
    NETWORK_BOUNDARY: "remote",
    LOCAL_ONLY: "false",
    DISCOVERY_PUBLIC_BASE_URL: origin,
    ALLOWED_ORIGINS: origin,
    AUTH_MODE: "bearer",
    TRANSPORT_SECURITY: "trusted-proxy",
    TRUSTED_PROXY_IPS: "127.0.0.1,::1",
    AUTH_OPERATOR_TOKEN: operatorToken,
    AUTH_USER_TOKEN: userToken,
    ARTIFACT_ROOT: "C:\\career-os\\artifacts",
  });
}

function operatorHeaders(extra: Record<string, string> = {}): Record<string, string> {
  return {
    authorization: `Bearer ${operatorToken}`,
    origin,
    "x-forwarded-proto": "https",
    "content-type": "application/json",
    ...extra,
  };
}

afterEach(() => {
  for (const server of servers.splice(0)) server.stop(true);
});

describe("registry contracts and rules", () => {
  test("accepts reviewed imports and rejects missing identity, insecure URLs, and oversized batches", () => {
    expect(SourceCandidateImportSchema.safeParse(validImport).success).toBe(true);
    expect(SourceCandidateImportSchema.safeParse({ rows: [{ companyName: "No identity" }], reason: validImport.reason }).success).toBe(false);
    expect(SourceCandidateImportSchema.safeParse({ rows: [{ companyName: "Bad", careersUrl: "http://example.com" }], reason: validImport.reason }).success).toBe(false);
    expect(SourceCandidateImportSchema.safeParse({ rows: [{ companyName: "Private", careersUrl: "https://127.0.0.1/careers" }], reason: validImport.reason }).success).toBe(false);
    expect(SourceCandidateImportSchema.safeParse({ rows: Array.from({ length: 1001 }, () => validImport.rows[0]), reason: validImport.reason }).success).toBe(false);
  });

  test("requires evidence locators and operator review for ambiguous automatic ownership", async () => {
    expect(OwnershipEvidenceSchema.safeParse({ type: "ats_identity", statement: "Matched tenant identity", confidence: 0.99 }).success).toBe(false);
    const service = new RegistryService(new FakeStore());
    expect(() => service.verifyCandidate(
      { actorId: "operator", idempotencyKey: "verify-0001" },
      crypto.randomUUID(),
      {
        company: { displayName: "Example", primaryDomain: "example.com" },
        source: {
          connectorId: "greenhouse", tenantKey: "example", boardUrl: "https://boards.greenhouse.io/example",
          apiBaseUrl: "https://boards-api.greenhouse.io/v1/boards/example", region: "global", connectorVersion: "1.0.0",
        },
        policyId: crypto.randomUUID(),
        evidence: { type: "ats_identity", evidenceUrl: "https://example.com/careers", statement: "Uncertain ATS identity match", confidence: 0.7 },
        reason: "Ownership evidence needs review",
      },
    )).toThrow("ambiguous_ownership_requires_review");
  });

  test("rejects invalid and expired policy approval windows", async () => {
    const service = new RegistryService(new FakeStore());
    const context = { actorId: "operator", idempotencyKey: "policy-0001" };
    expect(() => service.createPolicy(context, { ...validPolicy, reviewedAt: new Date(Date.now() + 60_000).toISOString() })).toThrow(RegistryRuleError);
    expect(() => service.createPolicy(context, { ...validPolicy, expiresAt: new Date(Date.now() - 1).toISOString() })).toThrow(RegistryRuleError);
  });
});

describe("registry admin API", () => {
  test("requires an operator and an idempotency key, then delegates a valid import", async () => {
    const store = new FakeStore();
    const server = createApiServer(hostedConfig(), { registryService: new RegistryService(store) });
    servers.push(server);
    const endpoint = `http://127.0.0.1:${server.port}/api/v1/admin/source-candidates/import`;

    const forbidden = await fetch(endpoint, {
      method: "POST",
      headers: { ...operatorHeaders(), authorization: `Bearer ${userToken}` },
      body: JSON.stringify(validImport),
    });
    expect(forbidden.status).toBe(403);

    const missingKey = await fetch(endpoint, { method: "POST", headers: operatorHeaders(), body: JSON.stringify(validImport) });
    expect(missingKey.status).toBe(400);
    expect(await missingKey.json()).toEqual({ error: "idempotency_key_required" });

    const accepted = await fetch(endpoint, {
      method: "POST",
      headers: operatorHeaders({ "idempotency-key": "import-0001" }),
      body: JSON.stringify(validImport),
    });
    expect(accepted.status).toBe(201);
    expect(await accepted.json()).toEqual({ imported: 1, duplicates: 0 });
    expect(store.calls[0]).toMatchObject({ name: "import", context: { actorId: "configured-operator", idempotencyKey: "import-0001" } });
  });

  test("rejects invalid JSON and oversized bodies without invoking the store", async () => {
    const store = new FakeStore();
    const server = createApiServer(hostedConfig(), { registryService: new RegistryService(store) });
    servers.push(server);
    const endpoint = `http://127.0.0.1:${server.port}/api/v1/admin/source-candidates/import`;
    const invalid = await fetch(endpoint, {
      method: "POST", headers: operatorHeaders({ "idempotency-key": "import-0002" }), body: "{",
    });
    expect(invalid.status).toBe(400);
    const oversized = await fetch(endpoint, {
      method: "POST", headers: operatorHeaders({ "idempotency-key": "import-0003" }), body: "x".repeat(1_048_577),
    });
    expect(oversized.status).toBe(400);
    expect(store.calls).toHaveLength(0);
  });
});
