import { guardRequest } from "@career-os/auth";
import {
  ClearCircuitBreakerSchema,
  CompanyReviewDecisionSchema,
  CompanySplitDecisionSchema,
  OpportunityReviewDecisionSchema,
  OpportunitySplitDecisionSchema,
  type RuntimeConfig,
} from "@career-os/contracts";
import {
  CompanyResolutionError,
  LifecycleStoreError,
  OpportunityResolutionError,
  type OperatorConsoleService,
} from "@career-os/db";

const MAX_BODY_BYTES = 1_048_576;
const UUID = "[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[1-8][0-9a-fA-F]{3}-[89abAB][0-9a-fA-F]{3}-[0-9a-fA-F]{12}";
interface Schema<T> { safeParse(value: unknown): { success: true; data: T } | { success: false } }

export interface OperatorRouteOptions { service?: OperatorConsoleService; remoteAddress?: string; headers(request: Request): Headers }

function reply(value: unknown, status: number, headers: Headers): Response { return Response.json(value, { status, headers }); }
function key(request: Request): string {
  const value = request.headers.get("idempotency-key");
  if (!value || !/^[A-Za-z0-9._:-]{8,128}$/u.test(value)) throw new Error("idempotency_key_required");
  return value;
}
async function body<T>(request: Request, schema: Schema<T>): Promise<T> {
  const declared = Number(request.headers.get("content-length") ?? 0);
  if (Number.isFinite(declared) && declared > MAX_BODY_BYTES) throw new Error("request_body_too_large");
  const bytes = await request.arrayBuffer();
  if (bytes.byteLength > MAX_BODY_BYTES) throw new Error("request_body_too_large");
  let value: unknown;
  try { value = JSON.parse(new TextDecoder().decode(bytes)); } catch { throw new Error("invalid_json"); }
  const result = schema.safeParse(value);
  if (!result.success) throw new Error("invalid_request");
  return result.data;
}

export async function handleOperatorRoute(request: Request, config: RuntimeConfig, options: OperatorRouteOptions): Promise<Response | undefined> {
  const { pathname, searchParams } = new URL(request.url);
  const isPath = pathname === "/api/v1/admin/overview" || pathname === "/api/v1/admin/reviews"
    || new RegExp(`^/api/v1/admin/reviews/${UUID}$`).test(pathname)
    || new RegExp(`^/api/v1/admin/sources/${UUID}/evidence$`).test(pathname)
    || new RegExp(`^/api/v1/admin/circuit-breakers/${UUID}/clear$`).test(pathname)
    || new RegExp(`^/api/v1/admin/reviews/${UUID}/company-merge$`).test(pathname)
    || pathname === "/api/v1/admin/company-merges/split"
    || new RegExp(`^/api/v1/admin/reviews/${UUID}/opportunity-attach$`).test(pathname)
    || pathname === "/api/v1/admin/opportunity-memberships/split";
  if (!isPath) return undefined;
  const principal = guardRequest(request, config, { requiredRole: "operator", unsafe: request.method !== "GET", remoteAddress: options.remoteAddress });
  const headers = options.headers(request);
  if (!options.service) return reply({ error: "operator_console_unavailable" }, 503, headers);
  try {
    if (request.method === "GET" && pathname === "/api/v1/admin/overview") return reply(await options.service.overview(), 200, headers);
    if (request.method === "GET" && pathname === "/api/v1/admin/reviews") {
      const state = searchParams.get("state") ?? "pending";
      if (state !== "pending" && state !== "approved" && state !== "rejected") throw new Error("invalid_query");
      return reply(await options.service.reviews(state), 200, headers);
    }
    const review = new RegExp(`^/api/v1/admin/reviews/(${UUID})$`).exec(pathname);
    if (request.method === "GET" && review) {
      const result = await options.service.review(review[1]!);
      return result ? reply(result, 200, headers) : reply({ error: "review_not_found" }, 404, headers);
    }
    const evidence = new RegExp(`^/api/v1/admin/sources/(${UUID})/evidence$`).exec(pathname);
    if (request.method === "GET" && evidence) {
      const result = await options.service.sourceEvidence(evidence[1]!);
      return result ? reply(result, 200, headers) : reply({ error: "source_not_found" }, 404, headers);
    }
    const context = { actorId: principal.id, idempotencyKey: key(request) };
    const breaker = new RegExp(`^/api/v1/admin/circuit-breakers/(${UUID})/clear$`).exec(pathname);
    if (request.method === "POST" && breaker) {
      const input = await body(request, ClearCircuitBreakerSchema);
      return reply(await options.service.clearBreaker(context, breaker[1]!, input.reason), 200, headers);
    }
    const company = new RegExp(`^/api/v1/admin/reviews/(${UUID})/company-merge$`).exec(pathname);
    if (request.method === "POST" && company) {
      const input = await body(request, CompanyReviewDecisionSchema);
      return reply(await options.service.mergeCompanyReview(context, { reviewId: company[1]!, ...input }), 200, headers);
    }
    if (request.method === "POST" && pathname === "/api/v1/admin/company-merges/split") {
      return reply(await options.service.splitCompany(context, await body(request, CompanySplitDecisionSchema)), 200, headers);
    }
    const opportunity = new RegExp(`^/api/v1/admin/reviews/(${UUID})/opportunity-attach$`).exec(pathname);
    if (request.method === "POST" && opportunity) {
      const input = await body(request, OpportunityReviewDecisionSchema);
      return reply(await options.service.attachOpportunityReview(context, { reviewId: opportunity[1]!, ...input }), 200, headers);
    }
    if (request.method === "POST" && pathname === "/api/v1/admin/opportunity-memberships/split") {
      return reply(await options.service.splitOpportunity(context, await body(request, OpportunitySplitDecisionSchema)), 200, headers);
    }
    return reply({ error: "method_not_allowed" }, 405, headers);
  } catch (error) {
    const code = error instanceof Error ? error.message : "internal_error";
    if (["idempotency_key_required", "request_body_too_large", "invalid_json", "invalid_request", "invalid_query"].includes(code)) return reply({ error: code }, 400, headers);
    if (error instanceof CompanyResolutionError || error instanceof OpportunityResolutionError || error instanceof LifecycleStoreError) {
      const status = /not_found/u.test(error.code) ? 404 : /idempotency/u.test(error.code) ? 409 : 422;
      return reply({ error: error.code }, status, headers);
    }
    console.error("Operator console operation failed", { path: pathname, method: request.method });
    return reply({ error: "internal_error" }, 500, headers);
  }
}
