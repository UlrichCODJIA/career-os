import { createHash } from "node:crypto";
import { z } from "zod";
import {
  SourceDescriptorSchema,
  parseBoundedJson,
  sanitizeUntrustedHtml,
  type ArtifactView,
  type DetectionResult,
  type EnumeratedListing,
  type EnumerationResult,
  type EvidenceValue,
  type FetchPlan,
  type ParsedListing,
  type RawCompensation,
  type RawLocation,
  type SourceConnector,
  type SourceDescriptor,
} from "@career-os/connector-sdk";

export const LEVER_CONNECTOR_VERSION = "1.0.0";
export const LEVER_PAGE_SIZE = 100;
export const LEVER_MAX_SKIP = 9_900;

const SITE = /^[a-z0-9][a-z0-9-]{0,127}$/;
const POSTING_ID = /^[a-f0-9]{8}-[a-f0-9]{4}-[1-5][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/;
const HttpsUrlSchema = z.url().refine((value) => {
  const url = new URL(value);
  return url.protocol === "https:" && !url.username && !url.password && !url.hash;
}, "Lever URLs must use HTTPS without credentials or fragments");

const CategoriesSchema = z.object({
  location: z.string().max(500).nullable().optional(),
  commitment: z.string().max(200).nullable().optional(),
  team: z.string().max(500).nullable().optional(),
  department: z.string().max(500).nullable().optional(),
  level: z.string().max(200).nullable().optional(),
  allLocations: z.array(z.string().max(500)).max(100).optional(),
}).passthrough();

const SalaryRangeSchema = z.object({
  currency: z.string().regex(/^[A-Z]{3}$/),
  interval: z.string().trim().min(1).max(100),
  min: z.number().finite().nonnegative(),
  max: z.number().finite().nonnegative(),
}).passthrough().refine((range) => range.min <= range.max, "Lever salary minimum cannot exceed maximum");

const LeverPostingSchema = z.object({
  id: z.string().regex(POSTING_ID),
  text: z.string().trim().min(1).max(500),
  categories: CategoriesSchema,
  country: z.string().regex(/^[A-Z]{2}$/).nullable().optional(),
  createdAt: z.number().int().nonnegative().safe().optional(),
  opening: z.string().max(1_000_000).optional(),
  openingPlain: z.string().max(1_000_000).optional(),
  description: z.string().trim().min(1).max(1_000_000),
  descriptionPlain: z.string().max(1_000_000).optional(),
  descriptionBody: z.string().max(1_000_000).optional(),
  descriptionBodyPlain: z.string().max(1_000_000).optional(),
  lists: z.array(z.object({ text: z.string().max(500), content: z.string().max(1_000_000) }).passthrough()).max(100).optional(),
  additional: z.string().max(1_000_000).optional(),
  additionalPlain: z.string().max(1_000_000).optional(),
  hostedUrl: HttpsUrlSchema,
  applyUrl: HttpsUrlSchema,
  workplaceType: z.enum(["unspecified", "on-site", "remote", "hybrid"]).optional(),
  salaryRange: SalaryRangeSchema.optional(),
  salaryDescription: z.string().max(10_000).optional(),
  salaryDescriptionPlain: z.string().max(10_000).optional(),
}).passthrough();

const LeverPageSchema = z.array(LeverPostingSchema).max(LEVER_PAGE_SIZE);

type LeverRegion = SourceDescriptor["region"];

export class LeverConnectorError extends Error {
  constructor(readonly code: "lever_source_invalid" | "lever_identity_mismatch" | "lever_schema_invalid" | "lever_artifact_count" | "lever_cursor_invalid") {
    super(`Lever connector rejected: ${code}`);
    this.name = "LeverConnectorError";
  }
}

function apiHost(region: LeverRegion): string {
  return region === "eu" ? "api.eu.lever.co" : "api.lever.co";
}

function jobsHost(region: LeverRegion): string {
  return region === "eu" ? "jobs.eu.lever.co" : "jobs.lever.co";
}

function apiBase(region: LeverRegion, site: string): string {
  return `https://${apiHost(region)}/v0/postings/${site}`;
}

function siteToken(value: string): string | undefined {
  return SITE.test(value) ? value : undefined;
}

function identityFromUrl(url: URL): { recognized: boolean; region?: LeverRegion; site?: string; postingId?: string; apply?: boolean } {
  const host = url.hostname.toLowerCase().replace(/\.$/, "");
  const segments = url.pathname.split("/").filter(Boolean);
  let region: LeverRegion | undefined;
  let api = false;
  if (host === "api.lever.co") { region = "global"; api = true; }
  if (host === "api.eu.lever.co") { region = "eu"; api = true; }
  if (host === "jobs.lever.co") region = "global";
  if (host === "jobs.eu.lever.co") region = "eu";
  if (!region) return { recognized: false };
  if (url.port) return { recognized: true, region };
  if (api) {
    if (segments[0] !== "v0" || segments[1] !== "postings" || segments.length > 4) return { recognized: false };
    if (segments[3] !== undefined && !POSTING_ID.test(segments[3])) return { recognized: true, region };
    return { recognized: true, region, site: segments[2] ? siteToken(segments[2]) : undefined, postingId: segments[3] && POSTING_ID.test(segments[3]) ? segments[3] : undefined };
  }
  if (segments.length > 3 || (segments[2] !== undefined && segments[2] !== "apply")) return { recognized: false };
  if (segments[1] !== undefined && !POSTING_ID.test(segments[1])) return { recognized: true, region };
  return { recognized: true, region, site: segments[0] ? siteToken(segments[0]) : undefined, postingId: segments[1] && POSTING_ID.test(segments[1]) ? segments[1] : undefined, apply: segments[2] === "apply" };
}

export function validateLeverSource(input: SourceDescriptor): SourceDescriptor {
  const source = SourceDescriptorSchema.parse(input);
  const site = siteToken(source.tenantKey);
  if (source.connectorId !== "lever" || !site || site !== source.tenantKey) throw new LeverConnectorError("lever_source_invalid");
  if (source.apiBaseUrl.replace(/\/$/, "") !== apiBase(source.region, site)) throw new LeverConnectorError("lever_source_invalid");
  const boardUrl = new URL(source.boardUrl);
  if (boardUrl.username || boardUrl.password || boardUrl.hash) throw new LeverConnectorError("lever_source_invalid");
  const board = identityFromUrl(boardUrl);
  if (board.recognized && (boardUrl.port || boardUrl.search || board.region !== source.region || board.site !== site || board.postingId)) throw new LeverConnectorError("lever_source_invalid");
  return source;
}

function oneArtifact(artifacts: readonly ArtifactView[]): ArtifactView {
  if (artifacts.length !== 1) throw new LeverConnectorError("lever_artifact_count");
  return artifacts[0]!;
}

function pageContext(artifact: ArtifactView): { region: LeverRegion; site: string; skip: number } {
  const url = new URL(artifact.sourceUrl);
  const identity = identityFromUrl(url);
  if (!identity.recognized || !identity.region || !identity.site || identity.postingId || url.username || url.password || url.hash || url.port) throw new LeverConnectorError("lever_source_invalid");
  const expected = new URL(apiBase(identity.region, identity.site));
  if (url.hostname !== expected.hostname || url.pathname !== expected.pathname) throw new LeverConnectorError("lever_source_invalid");
  const mode = url.searchParams.getAll("mode");
  const skips = url.searchParams.getAll("skip");
  const limits = url.searchParams.getAll("limit");
  if ([...url.searchParams.keys()].some((key) => !["mode", "skip", "limit"].includes(key)) || mode.length !== 1 || mode[0] !== "json" || skips.length !== 1 || limits.length !== 1 || limits[0] !== String(LEVER_PAGE_SIZE) || !/^\d+$/.test(skips[0]!)) throw new LeverConnectorError("lever_source_invalid");
  const skip = Number(skips[0]);
  if (!Number.isSafeInteger(skip) || skip < 0 || skip > LEVER_MAX_SKIP || skip % LEVER_PAGE_SIZE !== 0) throw new LeverConnectorError("lever_source_invalid");
  return { region: identity.region, site: identity.site, skip };
}

function validatePostingUrl(value: string, region: LeverRegion, site: string, postingId: string, apply: boolean): void {
  const url = new URL(value);
  const identity = identityFromUrl(url);
  if (!identity.recognized || identity.region !== region || identity.site !== site || identity.postingId !== postingId || Boolean(identity.apply) !== apply || url.search || url.port || url.username || url.password || url.hash) throw new LeverConnectorError("lever_identity_mismatch");
}

function digest(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

function evidence<T>(value: T, artifact: ArtifactView, pointer: string, origin: EvidenceValue<T>["origin"], version: string): EvidenceValue<T> {
  return { value, origin, artifactId: artifact.artifactId, locator: { kind: "json_pointer", pointer }, extractorId: "lever", extractorVersion: version, confidence: origin === "source_field" ? 1 : 0.99 };
}

function timestamp(milliseconds: number | undefined): string | undefined {
  if (milliseconds === undefined) return undefined;
  const date = new Date(milliseconds);
  return Number.isNaN(date.valueOf()) ? undefined : date.toISOString();
}

function locations(posting: z.infer<typeof LeverPostingSchema>): RawLocation[] {
  const labels = posting.categories.allLocations?.length ? posting.categories.allLocations : posting.categories.location ? [posting.categories.location] : [];
  return [...new Set(labels.map((label) => label.trim()).filter(Boolean))].map((label) => ({ label, ...(posting.country ? { countryCode: posting.country } : {}) }));
}

function salary(range: z.infer<typeof SalaryRangeSchema>): RawCompensation {
  const normalized = range.interval.toLowerCase();
  const period = normalized.includes("hour") ? "hour" : normalized.includes("day") ? "day" : normalized.includes("week") ? "week" : normalized.includes("month") ? "month" : normalized.includes("year") || normalized.includes("annual") ? "year" : "unknown";
  return { rawText: `${range.currency} ${range.min}–${range.max} (${range.interval})`, minimum: range.min, maximum: range.max, currency: range.currency, period };
}

function workplace(value: z.infer<typeof LeverPostingSchema>["workplaceType"]): "remote" | "hybrid" | "onsite" | "unspecified" {
  return value === "on-site" ? "onsite" : value ?? "unspecified";
}

export function createLeverConnector(version = LEVER_CONNECTOR_VERSION): SourceConnector {
  if (!/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/.test(version)) throw new TypeError("invalid Lever connector version");
  return Object.freeze({
    id: "lever" as const,
    version,

    detect(candidateUrl: URL): DetectionResult {
      if (candidateUrl.protocol !== "https:" || candidateUrl.port || candidateUrl.username || candidateUrl.password || candidateUrl.hash) return { detected: false, connectorId: "lever", confidence: 0, reason: "invalid_candidate" };
      const identity = identityFromUrl(candidateUrl);
      if (!identity.recognized) return { detected: false, connectorId: "lever", confidence: 0, reason: "not_recognized" };
      if (!identity.site) return { detected: false, connectorId: "lever", confidence: 0, reason: "invalid_candidate" };
      return { detected: true, connectorId: "lever", tenantKey: identity.site, confidence: 1, reason: candidateUrl.hostname.startsWith("api.") ? "recognized_path" : "recognized_host" };
    },

    planEnumeration(source: SourceDescriptor, cursor?: string): FetchPlan {
      const validated = validateLeverSource(source);
      const skip = cursor === undefined ? 0 : /^\d+$/.test(cursor) ? Number(cursor) : Number.NaN;
      if (!Number.isSafeInteger(skip) || skip < 0 || skip > LEVER_MAX_SKIP || skip % LEVER_PAGE_SIZE !== 0) throw new LeverConnectorError("lever_cursor_invalid");
      const url = `${apiBase(validated.region, validated.tenantKey)}?mode=json&skip=${skip}&limit=${LEVER_PAGE_SIZE}`;
      return { requests: [{ url, method: "GET", accept: "application/json", ...(cursor === undefined ? {} : { pageToken: cursor }) }] };
    },

    parseEnumeration(artifacts: readonly ArtifactView[]): EnumerationResult {
      if (artifacts.length === 0 || artifacts.length > 100) throw new LeverConnectorError("lever_artifact_count");
      const responseArtifacts = artifacts.map((artifact) => artifact.artifactId);
      if (new Set(responseArtifacts).size !== responseArtifacts.length) throw new LeverConnectorError("lever_artifact_count");
      const contexts = artifacts.map(pageContext);
      const firstContext = contexts[0]!;
      for (const [index, context] of contexts.entries()) {
        if (context.region !== firstContext.region || context.site !== firstContext.site || context.skip !== index * LEVER_PAGE_SIZE) throw new LeverConnectorError("lever_source_invalid");
      }
      const pages = artifacts.map((artifact) => LeverPageSchema.safeParse(parseBoundedJson(artifact.bytes)));
      if (pages.some((page) => !page.success)) return { listings: [], complete: false, completenessReason: "schema_invalid", responseArtifacts, connectorVersion: version };
      const pageData = pages.map((page) => page.success ? page.data : []);
      if (pageData.slice(0, -1).some((page) => page.length !== LEVER_PAGE_SIZE)) return { listings: [], complete: false, completenessReason: "schema_invalid", responseArtifacts, connectorVersion: version };
      const listings: EnumeratedListing[] = [];
      const seen = new Set<string>();
      let invalidIdentity = false;
      for (const [pageIndex, page] of pageData.entries()) {
        const artifact = artifacts[pageIndex]!;
        for (const posting of page) {
        try {
          validatePostingUrl(posting.hostedUrl, firstContext.region, firstContext.site, posting.id, false);
          validatePostingUrl(posting.applyUrl, firstContext.region, firstContext.site, posting.id, true);
        } catch {
          invalidIdentity = true;
          continue;
        }
        if (seen.has(posting.id)) { invalidIdentity = true; continue; }
        seen.add(posting.id);
        listings.push({
          sourceJobId: posting.id,
          detailUrl: `${apiBase(firstContext.region, firstContext.site)}/${posting.id}`,
          canonicalSourceUrl: posting.hostedUrl,
          applyUrl: posting.applyUrl,
          lightweightFingerprint: digest(JSON.stringify([posting.id, posting.text, posting.categories, posting.country ?? null, posting.createdAt ?? null, posting.hostedUrl, posting.applyUrl, posting.workplaceType ?? null, posting.salaryRange ?? null])),
          artifactId: artifact.artifactId,
        });
        }
      }
      if (invalidIdentity) return { listings, complete: false, completenessReason: "schema_invalid", responseArtifacts, connectorVersion: version };
      const lastPage = pageData.at(-1)!;
      const lastContext = contexts.at(-1)!;
      if (lastPage.length === 0 && artifacts.length === 1) return { listings: [], complete: false, completenessReason: "suspicious_empty", responseArtifacts, connectorVersion: version };
      if (lastPage.length === LEVER_PAGE_SIZE) {
        if (lastContext.skip === LEVER_MAX_SKIP) return { listings, complete: false, completenessReason: "limit_exceeded", responseArtifacts, connectorVersion: version };
        return { listings, complete: false, completenessReason: "pagination_incomplete", nextPageToken: String(lastContext.skip + LEVER_PAGE_SIZE), responseArtifacts, connectorVersion: version };
      }
      return { listings, complete: true, completenessReason: "complete", responseArtifacts, connectorVersion: version };
    },

    planDetails(source: SourceDescriptor, item: EnumeratedListing): FetchPlan {
      const validated = validateLeverSource(source);
      if (!POSTING_ID.test(item.sourceJobId)) throw new LeverConnectorError("lever_identity_mismatch");
      return { requests: [{ url: `${apiBase(validated.region, validated.tenantKey)}/${item.sourceJobId}`, method: "GET", accept: "application/json" }] };
    },

    parseListing(artifacts: readonly ArtifactView[], item: EnumeratedListing): ParsedListing {
      const artifact = oneArtifact(artifacts);
      const url = new URL(artifact.sourceUrl);
      const identity = identityFromUrl(url);
      if (!identity.recognized || !identity.region || !identity.site || identity.postingId !== item.sourceJobId || url.search || url.port || url.username || url.password || url.hash) throw new LeverConnectorError("lever_source_invalid");
      const parsed = LeverPostingSchema.safeParse(parseBoundedJson(artifact.bytes));
      if (!parsed.success) throw new LeverConnectorError("lever_schema_invalid");
      const posting = parsed.data;
      if (posting.id !== item.sourceJobId || posting.hostedUrl !== item.canonicalSourceUrl) throw new LeverConnectorError("lever_identity_mismatch");
      validatePostingUrl(posting.hostedUrl, identity.region, identity.site, posting.id, false);
      validatePostingUrl(posting.applyUrl, identity.region, identity.site, posting.id, true);
      const sanitized = sanitizeUntrustedHtml(new TextEncoder().encode(posting.description));
      const rawLocations = locations(posting);
      if (!sanitized.text || rawLocations.length === 0) throw new LeverConnectorError("lever_schema_invalid");
      const createdAt = timestamp(posting.createdAt);
      return {
        sourceJobId: posting.id,
        ...(createdAt ? { sourcePostedAt: createdAt } : {}),
        title: evidence(posting.text, artifact, "/text", "source_field", version),
        descriptionHtml: evidence(sanitized.html, artifact, "/description", "deterministic_rule", version),
        descriptionText: evidence(sanitized.text, artifact, "/description", "deterministic_rule", version),
        locations: evidence(rawLocations, artifact, posting.categories.allLocations?.length ? "/categories/allLocations" : "/categories/location", "deterministic_rule", version),
        ...(posting.workplaceType ? { workplaceType: evidence(workplace(posting.workplaceType), artifact, "/workplaceType", "source_field", version) } : {}),
        ...(posting.categories.commitment?.trim() ? { employmentType: evidence(posting.categories.commitment.trim(), artifact, "/categories/commitment", "source_field", version) } : {}),
        ...(posting.salaryRange ? { compensation: evidence(salary(posting.salaryRange), artifact, "/salaryRange", "deterministic_rule", version) } : {}),
        ...(posting.categories.department?.trim() ? { department: evidence(posting.categories.department.trim(), artifact, "/categories/department", "source_field", version) } : {}),
        ...(posting.categories.team?.trim() ? { team: evidence(posting.categories.team.trim(), artifact, "/categories/team", "source_field", version) } : {}),
        applyUrl: evidence(posting.applyUrl, artifact, "/applyUrl", "source_field", version),
        canonicalSourceUrl: evidence(posting.hostedUrl, artifact, "/hostedUrl", "source_field", version),
      };
    },
  });
}

export const leverConnector = createLeverConnector();
