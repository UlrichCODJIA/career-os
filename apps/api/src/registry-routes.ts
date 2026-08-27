import { guardRequest } from "@career-os/auth";
import {
  RejectSourceCandidateSchema,
  SourceCandidateImportSchema,
  SourcePatchSchema,
  SourcePolicyCreateSchema,
  SourcePolicyPatchSchema,
  VerifySourceCandidateSchema,
  type RuntimeConfig,
} from "@career-os/contracts";
import { RegistryRuleError, type RegistryService } from "@career-os/discovery-domain";

const MAX_BODY_BYTES = 1_048_576;
const UUID_PATTERN = "[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[1-8][0-9a-fA-F]{3}-[89abAB][0-9a-fA-F]{3}-[0-9a-fA-F]{12}";

interface Schema<T> {
  safeParse(value: unknown): { success: true; data: T } | { success: false };
}

export interface RegistryRouteOptions {
  service?: RegistryService;
  remoteAddress?: string;
  headers(request: Request): Headers;
}

function response(body: unknown, status: number, headers: Headers): Response {
  return Response.json(body, { status, headers });
}

function idempotencyKey(request: Request): string {
  const value = request.headers.get("idempotency-key");
  if (!value || !/^[A-Za-z0-9._:-]{8,128}$/.test(value)) {
    throw new RegistryRuleError("idempotency_key_required", 400);
  }
  return value;
}

async function body<T>(request: Request, schema: Schema<T>): Promise<T> {
  const declaredLength = Number(request.headers.get("content-length") ?? 0);
  if (Number.isFinite(declaredLength) && declaredLength > MAX_BODY_BYTES) {
    throw new RegistryRuleError("request_body_too_large", 400);
  }
  const bytes = await request.arrayBuffer();
  if (bytes.byteLength > MAX_BODY_BYTES) throw new RegistryRuleError("request_body_too_large", 400);
  let value: unknown;
  try {
    value = JSON.parse(new TextDecoder().decode(bytes));
  } catch {
    throw new RegistryRuleError("invalid_json", 400);
  }
  const parsed = schema.safeParse(value);
  if (!parsed.success) throw new RegistryRuleError("invalid_request", 400);
  return parsed.data;
}

export async function handleRegistryRoute(
  request: Request,
  config: RuntimeConfig,
  options: RegistryRouteOptions,
): Promise<Response | undefined> {
  const { pathname, searchParams } = new URL(request.url);
  if (!pathname.startsWith("/api/v1/admin/")) return undefined;
  const isRegistryPath =
    pathname === "/api/v1/admin/source-candidates" ||
    pathname === "/api/v1/admin/source-candidates/import" ||
    new RegExp(`^/api/v1/admin/source-candidates/${UUID_PATTERN}/(?:verify|reject)$`).test(pathname) ||
    pathname === "/api/v1/admin/source-policies" ||
    new RegExp(`^/api/v1/admin/source-policies/${UUID_PATTERN}$`).test(pathname) ||
    pathname === "/api/v1/admin/sources" ||
    new RegExp(`^/api/v1/admin/sources/${UUID_PATTERN}$`).test(pathname);
  if (!isRegistryPath) return undefined;

  const unsafe = request.method !== "GET";
  const principal = guardRequest(request, config, {
    requiredRole: "operator",
    unsafe,
    remoteAddress: options.remoteAddress,
  });
  const headers = options.headers(request);
  if (!options.service) return response({ error: "registry_unavailable" }, 503, headers);

  try {
    if (request.method === "GET" && pathname === "/api/v1/admin/source-candidates") {
      const state = searchParams.get("state") ?? undefined;
      if (state && !["pending", "verified", "rejected", "duplicate"].includes(state)) {
        throw new RegistryRuleError("invalid_query", 400);
      }
      return response(await options.service.listCandidates(state), 200, headers);
    }
    if (request.method === "GET" && pathname === "/api/v1/admin/sources") {
      const raw = searchParams.get("enabled");
      if (raw !== null && raw !== "true" && raw !== "false") throw new RegistryRuleError("invalid_query", 400);
      return response(await options.service.listSources(raw === null ? undefined : raw === "true"), 200, headers);
    }

    const context = { actorId: principal.id, idempotencyKey: idempotencyKey(request) };
    if (request.method === "POST" && pathname === "/api/v1/admin/source-candidates/import") {
      return response(await options.service.importCandidates(context, await body(request, SourceCandidateImportSchema)), 201, headers);
    }
    if (request.method === "POST" && pathname === "/api/v1/admin/source-policies") {
      return response(await options.service.createPolicy(context, await body(request, SourcePolicyCreateSchema)), 201, headers);
    }

    const candidateMatch = new RegExp(`^/api/v1/admin/source-candidates/(${UUID_PATTERN})/(verify|reject)$`).exec(pathname);
    if (request.method === "POST" && candidateMatch) {
      const candidateId = candidateMatch[1]!;
      if (candidateMatch[2] === "verify") {
        return response(await options.service.verifyCandidate(context, candidateId, await body(request, VerifySourceCandidateSchema)), 200, headers);
      }
      return response(await options.service.rejectCandidate(context, candidateId, await body(request, RejectSourceCandidateSchema)), 200, headers);
    }

    const policyMatch = new RegExp(`^/api/v1/admin/source-policies/(${UUID_PATTERN})$`).exec(pathname);
    if (request.method === "PATCH" && policyMatch) {
      return response(await options.service.updatePolicy(context, policyMatch[1]!, await body(request, SourcePolicyPatchSchema)), 200, headers);
    }
    const sourceMatch = new RegExp(`^/api/v1/admin/sources/(${UUID_PATTERN})$`).exec(pathname);
    if (request.method === "PATCH" && sourceMatch) {
      return response(await options.service.updateSource(context, sourceMatch[1]!, await body(request, SourcePatchSchema)), 200, headers);
    }
    return response({ error: "method_not_allowed" }, 405, headers);
  } catch (error) {
    if (error instanceof RegistryRuleError) return response({ error: error.code }, error.status, headers);
    console.error("Registry operation failed", { path: pathname, method: request.method });
    return response({ error: "internal_error" }, 500, headers);
  }
}
