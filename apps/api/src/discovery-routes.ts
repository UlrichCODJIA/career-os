import { guardRequest, RequestSecurityError } from "@career-os/auth";
import {
  DiscoveryApiError, parseCompanyFilters, parseOpportunityFilters, parseProblemReport, projectLegacyJob,
  type DiscoveryReadService,
} from "@career-os/discovery-api";
import type { RuntimeConfig } from "@career-os/contracts";

const UUID_PATTERN = "[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[1-8][0-9a-fA-F]{3}-[89abAB][0-9a-fA-F]{3}-[0-9a-fA-F]{12}";
const MAX_BODY_BYTES = 16_384;

export interface DiscoveryRouteOptions { service?: DiscoveryReadService; remoteAddress?: string; headers(request: Request): Headers }
function result(body: unknown, status: number, headers: Headers, requestId: string): Response {
  headers.set("x-request-id", requestId); headers.set("content-type", "application/json");
  return Response.json(body, { status, headers });
}
function problem(code: string, status: number, headers: Headers, requestId: string): Response {
  return result({ type: `https://career-os.dev/problems/${code}`, title: code.replaceAll("_", " "), status, code, requestId }, status, headers, requestId);
}
async function jsonBody(request: Request): Promise<unknown> {
  const declared = Number(request.headers.get("content-length") ?? 0);
  if (Number.isFinite(declared) && declared > MAX_BODY_BYTES) throw new DiscoveryApiError("request_body_too_large");
  const bytes = await request.arrayBuffer();
  if (bytes.byteLength > MAX_BODY_BYTES) throw new DiscoveryApiError("request_body_too_large");
  try { return JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes)); }
  catch { throw new DiscoveryApiError("invalid_json"); }
}
function idempotencyKey(request: Request): string {
  const value = request.headers.get("idempotency-key");
  if (!value || !/^[A-Za-z0-9._:-]{8,128}$/u.test(value)) throw new DiscoveryApiError("idempotency_key_required");
  return value;
}

export async function handleDiscoveryRoute(request: Request, config: RuntimeConfig, options: DiscoveryRouteOptions): Promise<Response | undefined> {
  const url = new URL(request.url);
  const opportunityDetail = new RegExp(`^/api/v1/opportunities/(${UUID_PATTERN})$`).exec(url.pathname);
  const opportunityReport = new RegExp(`^/api/v1/opportunities/(${UUID_PATTERN})/report$`).exec(url.pathname);
  const companyDetail = new RegExp(`^/api/v1/companies/(${UUID_PATTERN})$`).exec(url.pathname);
  const companyOpportunities = new RegExp(`^/api/v1/companies/(${UUID_PATTERN})/opportunities$`).exec(url.pathname);
  const recognized = url.pathname === "/api/v1/opportunities" || url.pathname === "/api/v1/companies" || url.pathname === "/api/jobs"
    || Boolean(opportunityDetail || opportunityReport || companyDetail || companyOpportunities);
  if (!recognized) return undefined;
  const requestId = crypto.randomUUID();
  const headers = options.headers(request);
  try {
    const unsafe = Boolean(opportunityReport);
    const principal = guardRequest(request, config, { unsafe, remoteAddress: options.remoteAddress });
    if (!options.service) return problem("discovery_unavailable", 503, headers, requestId);
    if (request.method === "GET" && url.pathname === "/api/v1/opportunities") {
      return result(await options.service.searchOpportunities(parseOpportunityFilters(url.searchParams)), 200, headers, requestId);
    }
    if (request.method === "GET" && url.pathname === "/api/v1/companies") {
      return result(await options.service.searchCompanies(parseCompanyFilters(url.searchParams)), 200, headers, requestId);
    }
    if (request.method === "GET" && opportunityDetail) {
      const item = await options.service.getOpportunity(opportunityDetail[1]!);
      return item ? result(item, 200, headers, requestId) : problem("not_found", 404, headers, requestId);
    }
    if (request.method === "GET" && companyDetail) {
      const item = await options.service.getCompany(companyDetail[1]!);
      return item ? result(item, 200, headers, requestId) : problem("not_found", 404, headers, requestId);
    }
    if (request.method === "GET" && companyOpportunities) {
      const params = new URLSearchParams(url.searchParams);
      const includeHistorical = params.get("include_historical");
      params.delete("include_historical");
      if (includeHistorical !== null && includeHistorical !== "true" && includeHistorical !== "false") throw new DiscoveryApiError("invalid_query");
      if (!params.has("status")) params.set("status", includeHistorical === "true" ? "all" : "active");
      params.set("company_id", companyOpportunities[1]!);
      return result(await options.service.searchOpportunities(parseOpportunityFilters(params)), 200, headers, requestId);
    }
    if (request.method === "POST" && opportunityReport) {
      const response = await options.service.reportOpportunity({ actorId: principal.id, idempotencyKey: idempotencyKey(request) },
        opportunityReport[1]!, parseProblemReport(await jsonBody(request)));
      return result(response, 202, headers, requestId);
    }
    if (request.method === "GET" && url.pathname === "/api/jobs") {
      const params = new URLSearchParams(url.searchParams);
      if (!params.has("limit")) params.set("limit", "100");
      const page = await options.service.searchOpportunities(parseOpportunityFilters(params));
      if (page.nextCursor) headers.set("x-next-cursor", page.nextCursor);
      headers.set("deprecation", "true"); headers.set("sunset", "DSV-020");
      return result(page.items.map(projectLegacyJob), 200, headers, requestId);
    }
    return problem("method_not_allowed", 405, headers, requestId);
  } catch (error) {
    if (error instanceof RequestSecurityError) throw error;
    if (error instanceof DiscoveryApiError) return problem(error.code, error.status, headers, requestId);
    console.error("Discovery API operation failed", { path: url.pathname, method: request.method, requestId,
      error: error instanceof Error ? error.name : "unknown_error" });
    return problem("internal_error", 500, headers, requestId);
  }
}
