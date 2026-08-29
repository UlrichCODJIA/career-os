import { createHash } from "node:crypto";
import { lstat, mkdir, open, rename, rm } from "node:fs/promises";
import { dirname, join, relative, resolve, sep } from "node:path";

export const DISCOVERY_API_VERSION = "1.0.0";
export const LEGACY_PROJECTION_VERSION = "career-os.jobs.v1";
export const MAX_PAGE_SIZE = 100;
export const LEGACY_EXPORT_PATH = join("job_scraper", "seen_jobs.json");

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;
const COUNTRY = /^[A-Z]{2}$/u;
const CURRENCY = /^[A-Z]{3}$/u;
const allowedQueryKeys = new Set([
  "q", "company_id", "title", "country", "region", "workplace_mode", "eligible_country",
  "employment_type", "seniority", "skill", "language", "visa", "min_compensation", "currency",
  "compensation_period", "first_seen_after", "source_posted_after", "status", "sort", "cursor", "limit",
]);

export type OpportunitySort = "first_seen_desc" | "source_posted_desc" | "relevance" | "compensation_desc";
export type OpportunityStatus = "active" | "possibly_closed" | "closed" | "all";
export type ReportKind = "closed" | "wrong_company" | "wrong_location" | "wrong_salary" | "duplicate" | "broken_link" | "other";

export interface OpportunityFilters {
  q?: string; companyId?: string; title?: string; country?: string; region?: string;
  workplaceMode?: "remote" | "hybrid" | "onsite" | "unspecified"; eligibleCountry?: string;
  employmentType?: string; seniority?: string; skill?: string; language?: string; visa?: boolean;
  minCompensation?: number; currency?: string; compensationPeriod?: "hour" | "day" | "week" | "month" | "year";
  firstSeenAfter?: string; sourcePostedAfter?: string; status: OpportunityStatus; sort: OpportunitySort;
  limit: number; cursor?: string;
}

export interface CursorAfter { primary: string | number; id: string }
interface CursorEnvelope { v: 1; scope: string; filterHash: string; after: CursorAfter }

export class DiscoveryApiError extends Error {
  constructor(public readonly code: string, public readonly status = 400) { super(code); this.name = "DiscoveryApiError"; }
}

function one(params: URLSearchParams, key: string): string | undefined {
  const values = params.getAll(key);
  if (values.length > 1) throw new DiscoveryApiError("duplicate_query_parameter");
  const value = values[0]?.trim();
  return value ? value : undefined;
}
function bounded(value: string | undefined, max: number, code = "invalid_query"): string | undefined {
  if (value !== undefined && value.length > max) throw new DiscoveryApiError(code);
  return value;
}
function date(value: string | undefined): string | undefined {
  if (value === undefined) return undefined;
  const parsed = new Date(value);
  if (!Number.isFinite(parsed.getTime())) throw new DiscoveryApiError("invalid_query");
  return parsed.toISOString();
}
function enumValue<T extends string>(value: string | undefined, allowed: readonly T[], fallback?: T): T | undefined {
  if (value === undefined) return fallback;
  if (!allowed.includes(value as T)) throw new DiscoveryApiError("invalid_query");
  return value as T;
}

export function parseOpportunityFilters(params: URLSearchParams): OpportunityFilters {
  for (const key of params.keys()) if (!allowedQueryKeys.has(key)) throw new DiscoveryApiError("unknown_query_parameter");
  const companyId = one(params, "company_id");
  if (companyId && !UUID.test(companyId)) throw new DiscoveryApiError("invalid_query");
  const country = one(params, "country")?.toUpperCase();
  const eligibleCountry = one(params, "eligible_country")?.toUpperCase();
  const currency = one(params, "currency")?.toUpperCase();
  if ((country && !COUNTRY.test(country)) || (eligibleCountry && !COUNTRY.test(eligibleCountry)) || (currency && !CURRENCY.test(currency))) {
    throw new DiscoveryApiError("invalid_query");
  }
  const rawLimit = one(params, "limit");
  const limit = rawLimit === undefined ? 25 : Number(rawLimit);
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > MAX_PAGE_SIZE) throw new DiscoveryApiError("invalid_page_size");
  const rawMinimum = one(params, "min_compensation");
  const minCompensation = rawMinimum === undefined ? undefined : Number(rawMinimum);
  if (minCompensation !== undefined && (!Number.isFinite(minCompensation) || minCompensation < 0 || minCompensation > 1_000_000_000)) {
    throw new DiscoveryApiError("invalid_query");
  }
  const rawVisa = one(params, "visa");
  if (rawVisa !== undefined && rawVisa !== "true" && rawVisa !== "false") throw new DiscoveryApiError("invalid_query");
  const q = bounded(one(params, "q"), 200);
  const sort = enumValue(one(params, "sort"), ["first_seen_desc", "source_posted_desc", "relevance", "compensation_desc"] as const, "first_seen_desc")!;
  if (sort === "relevance" && !q) throw new DiscoveryApiError("relevance_requires_query");
  return {
    q, companyId, title: bounded(one(params, "title"), 200), country, region: bounded(one(params, "region"), 120),
    workplaceMode: enumValue(one(params, "workplace_mode"), ["remote", "hybrid", "onsite", "unspecified"] as const),
    eligibleCountry, employmentType: bounded(one(params, "employment_type"), 80), seniority: bounded(one(params, "seniority"), 80),
    skill: bounded(one(params, "skill"), 100), language: bounded(one(params, "language"), 40),
    visa: rawVisa === undefined ? undefined : rawVisa === "true", minCompensation, currency,
    compensationPeriod: enumValue(one(params, "compensation_period"), ["hour", "day", "week", "month", "year"] as const),
    firstSeenAfter: date(one(params, "first_seen_after")), sourcePostedAfter: date(one(params, "source_posted_after")),
    status: enumValue(one(params, "status"), ["active", "possibly_closed", "closed", "all"] as const, "active")!,
    sort, limit, cursor: bounded(one(params, "cursor"), 2_048, "invalid_cursor"),
  };
}

function stableFilterValue(filters: OpportunityFilters): string {
  const { cursor: _cursor, limit: _limit, ...bound } = filters;
  return JSON.stringify(Object.fromEntries(Object.entries(bound).filter(([, value]) => value !== undefined).sort(([a], [b]) => a.localeCompare(b))));
}
export function filterHash(filters: OpportunityFilters): string {
  return createHash("sha256").update(stableFilterValue(filters)).digest("hex");
}
export function encodeCursor(scope: string, filters: OpportunityFilters, after: CursorAfter): string {
  if (!UUID.test(after.id) || (typeof after.primary === "string" && after.primary.length > 100) || !Number.isFinite(typeof after.primary === "number" ? after.primary : 0)) {
    throw new DiscoveryApiError("invalid_cursor");
  }
  return Buffer.from(JSON.stringify({ v: 1, scope, filterHash: filterHash(filters), after } satisfies CursorEnvelope)).toString("base64url");
}
export function decodeCursor(scope: string, filters: OpportunityFilters): CursorAfter | undefined {
  if (!filters.cursor) return undefined;
  try {
    const parsed = JSON.parse(Buffer.from(filters.cursor, "base64url").toString("utf8")) as Partial<CursorEnvelope>;
    if (parsed.v !== 1 || parsed.scope !== scope || parsed.filterHash !== filterHash(filters) || !parsed.after || !UUID.test(parsed.after.id)
      || (typeof parsed.after.primary !== "string" && typeof parsed.after.primary !== "number")
      || (typeof parsed.after.primary === "string" && parsed.after.primary.length > 100)
      || (typeof parsed.after.primary === "number" && !Number.isFinite(parsed.after.primary))) throw new Error("invalid");
    return parsed.after;
  } catch { throw new DiscoveryApiError("invalid_cursor"); }
}

export function parseCompanyFilters(params: URLSearchParams): { q?: string; limit: number; cursor?: string } {
  for (const key of params.keys()) if (!["q", "limit", "cursor"].includes(key)) throw new DiscoveryApiError("unknown_query_parameter");
  const q = bounded(one(params, "q"), 200);
  const cursor = bounded(one(params, "cursor"), 2_048, "invalid_cursor");
  const raw = one(params, "limit");
  const limit = raw === undefined ? 25 : Number(raw);
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > MAX_PAGE_SIZE) throw new DiscoveryApiError("invalid_page_size");
  return { q, limit, cursor };
}
export function encodeCompanyCursor(input: { q?: string; limit: number }, after: CursorAfter): string {
  const hash = createHash("sha256").update(input.q ?? "").digest("hex");
  return Buffer.from(JSON.stringify({ v: 1, scope: "companies", filterHash: hash, after } satisfies CursorEnvelope)).toString("base64url");
}
export function decodeCompanyCursor(input: { q?: string; limit: number; cursor?: string }): CursorAfter | undefined {
  if (!input.cursor) return undefined;
  try {
    const parsed = JSON.parse(Buffer.from(input.cursor, "base64url").toString("utf8")) as Partial<CursorEnvelope>;
    const hash = createHash("sha256").update(input.q ?? "").digest("hex");
    if (parsed.v !== 1 || parsed.scope !== "companies" || parsed.filterHash !== hash || !parsed.after
      || typeof parsed.after.primary !== "string" || parsed.after.primary.length > 200 || !UUID.test(parsed.after.id)) throw new Error("invalid");
    return parsed.after;
  } catch { throw new DiscoveryApiError("invalid_cursor"); }
}

export interface ProblemReportInput { kind: ReportKind; detail?: string; duplicateOpportunityId?: string }
export function parseProblemReport(value: unknown): ProblemReportInput {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new DiscoveryApiError("invalid_request");
  const record = value as Record<string, unknown>;
  if (Object.keys(record).some((key) => !["kind", "detail", "duplicateOpportunityId"].includes(key))) throw new DiscoveryApiError("invalid_request");
  const kinds: ReportKind[] = ["closed", "wrong_company", "wrong_location", "wrong_salary", "duplicate", "broken_link", "other"];
  if (typeof record.kind !== "string" || !kinds.includes(record.kind as ReportKind)) throw new DiscoveryApiError("invalid_request");
  if (record.detail !== undefined && (typeof record.detail !== "string" || record.detail.trim().length < 3 || record.detail.length > 2_000)) throw new DiscoveryApiError("invalid_request");
  if (record.duplicateOpportunityId !== undefined && (typeof record.duplicateOpportunityId !== "string" || !UUID.test(record.duplicateOpportunityId))) throw new DiscoveryApiError("invalid_request");
  if ((record.kind === "duplicate") !== Boolean(record.duplicateOpportunityId)) throw new DiscoveryApiError("duplicate_target_required");
  if (record.kind === "other" && record.detail === undefined) throw new DiscoveryApiError("report_detail_required");
  return { kind: record.kind as ReportKind, detail: record.detail?.toString().trim(), duplicateOpportunityId: record.duplicateOpportunityId?.toString() };
}

export interface PublicOpportunityItem { id: string; company: { id: string; name: string; domain: string | null }; title: string; workplaceMode: string; remoteScope: { kind: "worldwide" | "countries" | "unspecified"; countryCodes: string[] }; locations: unknown[]; compensation: unknown; sourcePostedAt: string | null; firstSeenAt: string; lastVerifiedOpenAt: string; primaryApplyUrl: string; sourceCount: number; provenanceCoverage: number; status: string }
export interface OpportunityPage { items: PublicOpportunityItem[]; nextCursor: string | null }
export interface CompanyPage { items: Array<{ id: string; name: string; domain: string | null; careersUrl: string | null; headquartersCountry: string | null }>; nextCursor: string | null }
export interface DiscoveryReadService {
  searchOpportunities(filters: OpportunityFilters): Promise<OpportunityPage>;
  searchCompanies(input: { q?: string; limit: number; cursor?: string }): Promise<CompanyPage>;
  getOpportunity(id: string): Promise<Record<string, unknown> | null>;
  getCompany(id: string): Promise<Record<string, unknown> | null>;
  reportOpportunity(context: { actorId: string; idempotencyKey: string }, opportunityId: string, input: ProblemReportInput): Promise<{ reportId: string; state: "pending" }>;
}
export interface LegacyJob { key: string; canonical_opportunity_id: string; title: string; company: string; url: string; first_seen: string; last_seen: string; fit: "unranked"; status: "open" | "possibly_closed" | "closed"; location: string | null; salary: string | null; projection_version: string }
export function projectLegacyJob(item: PublicOpportunityItem): LegacyJob {
  const location = item.locations[0] as { locality?: string; region?: string; countryCode?: string } | undefined;
  const compensation = item.compensation as { currency?: string; minimum?: number | null; maximum?: number | null; period?: string } | null;
  return { key: item.id, canonical_opportunity_id: item.id, title: item.title, company: item.company.name, url: item.primaryApplyUrl,
    first_seen: item.firstSeenAt, last_seen: item.lastVerifiedOpenAt, fit: "unranked",
    status: item.status === "active" ? "open" : item.status === "possibly_closed" ? "possibly_closed" : "closed",
    location: location ? [location.locality, location.region, location.countryCode].filter(Boolean).join(", ") || null : null,
    salary: compensation ? [compensation.currency, compensation.minimum, compensation.maximum, compensation.period].filter((v) => v !== null && v !== undefined).join(" ") : null,
    projection_version: LEGACY_PROJECTION_VERSION };
}

export function resolveLegacyExportPath(root: string, relativePath = LEGACY_EXPORT_PATH): string {
  const canonicalRoot = resolve(root);
  const target = resolve(canonicalRoot, relativePath);
  const rel = relative(canonicalRoot, target);
  if (relativePath !== LEGACY_EXPORT_PATH || !rel || rel.startsWith(`..${sep}`) || rel === ".." || resolve(target) === canonicalRoot) {
    throw new DiscoveryApiError("legacy_export_path_rejected");
  }
  return target;
}
export async function writeLegacyExport(root: string, jobs: LegacyJob[], relativePath = LEGACY_EXPORT_PATH): Promise<string> {
  if (jobs.length > 10_000) throw new DiscoveryApiError("legacy_export_too_large");
  const target = resolveLegacyExportPath(root, relativePath);
  const parent = dirname(target);
  await mkdir(parent, { recursive: true });
  for (const candidate of [resolve(root), parent]) {
    const stat = await lstat(candidate);
    if (stat.isSymbolicLink() || !stat.isDirectory()) throw new DiscoveryApiError("legacy_export_path_rejected");
  }
  const temporary = `${target}.${crypto.randomUUID()}.tmp`;
  try {
    const handle = await open(temporary, "wx", 0o600);
    try { await handle.writeFile(`${JSON.stringify(jobs, null, 2)}\n`, "utf8"); await handle.sync(); }
    finally { await handle.close(); }
    await rename(temporary, target);
  } catch (error) { await rm(temporary, { force: true }); throw error; }
  return target;
}
