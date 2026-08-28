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

export const ASHBY_CONNECTOR_VERSION = "1.0.0";
export const ASHBY_API_HOST = "api.ashbyhq.com";
export const ASHBY_BOARD_HOST = "jobs.ashbyhq.com";

const BOARD_NAME = /^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/;
const POSTING_ID = /^[a-f0-9]{8}-[a-f0-9]{4}-[1-5][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/;
const TimestampSchema = z.iso.datetime({ offset: true });
const HttpsUrlSchema = z.url().refine((value) => {
  const url = new URL(value);
  return url.protocol === "https:" && !url.username && !url.password && !url.hash;
}, "Ashby URLs must use HTTPS without credentials or fragments");

const PostalAddressSchema = z.object({
  addressLocality: z.string().max(200).nullable().optional(),
  addressRegion: z.string().max(200).nullable().optional(),
  addressCountry: z.string().max(200).nullable().optional(),
}).passthrough();

const AddressSchema = z.object({ postalAddress: PostalAddressSchema.optional() }).passthrough();
const SecondaryLocationSchema = z.object({
  location: z.string().max(500),
  address: z.union([AddressSchema, PostalAddressSchema]).optional(),
}).passthrough();

const CompensationComponentSchema = z.object({
  compensationType: z.string().trim().min(1).max(100),
  interval: z.string().trim().min(1).max(100),
  currencyCode: z.string().regex(/^[A-Z]{3}$/).nullable().optional(),
  minValue: z.number().finite().nonnegative().nullable().optional(),
  maxValue: z.number().finite().nonnegative().nullable().optional(),
}).passthrough().refine(
  (component) => component.minValue == null || component.maxValue == null || component.minValue <= component.maxValue,
  "Ashby compensation minimum cannot exceed maximum",
);

const CompensationSchema = z.object({
  compensationTierSummary: z.string().max(10_000).nullable().optional(),
  scrapeableCompensationSalarySummary: z.string().max(10_000).nullable().optional(),
  summaryComponents: z.array(CompensationComponentSchema).max(100).optional(),
}).passthrough();

const AshbyJobSchema = z.object({
  id: z.string().regex(POSTING_ID).optional(),
  title: z.string().trim().min(1).max(500),
  location: z.string().max(500),
  secondaryLocations: z.array(SecondaryLocationSchema).max(100).optional(),
  department: z.string().max(500).nullable().optional(),
  team: z.string().max(500).nullable().optional(),
  isListed: z.boolean(),
  isRemote: z.boolean().optional(),
  workplaceType: z.enum(["OnSite", "Remote", "Hybrid"]).optional(),
  descriptionHtml: z.string().max(1_000_000),
  descriptionPlain: z.string().max(1_000_000).optional(),
  publishedAt: TimestampSchema,
  employmentType: z.enum(["FullTime", "PartTime", "Intern", "Contract", "Temporary"]).optional(),
  address: AddressSchema.optional(),
  jobUrl: HttpsUrlSchema,
  applyUrl: HttpsUrlSchema,
  compensation: CompensationSchema.optional(),
}).passthrough();

const AshbyBoardSchema = z.object({
  apiVersion: z.literal("1"),
  jobs: z.array(AshbyJobSchema).max(100_000),
}).passthrough();

interface AshbyIdentity {
  readonly recognized: boolean;
  readonly kind?: "api" | "hosted";
  readonly boardName?: string;
  readonly postingId?: string;
  readonly application?: boolean;
}

export class AshbyConnectorError extends Error {
  constructor(readonly code: "ashby_source_invalid" | "ashby_identity_mismatch" | "ashby_schema_invalid" | "ashby_artifact_count" | "ashby_cursor_unsupported") {
    super(`Ashby connector rejected: ${code}`);
    this.name = "AshbyConnectorError";
  }
}

function boardName(value: string): string | undefined {
  return BOARD_NAME.test(value) ? value : undefined;
}

function identityFromUrl(url: URL): AshbyIdentity {
  const host = url.hostname.toLowerCase().replace(/\.$/, "");
  const segments = url.pathname.split("/").filter(Boolean);
  if (host === ASHBY_API_HOST) {
    if (segments[0] !== "posting-api" || segments[1] !== "job-board" || segments.length !== 3) return { recognized: true };
    return { recognized: true, kind: "api", boardName: segments[2] ? boardName(segments[2]) : undefined };
  }
  if (host === ASHBY_BOARD_HOST) {
    if (segments.length < 1 || segments.length > 3 || (segments[2] !== undefined && segments[2] !== "application")) return { recognized: true };
    const postingId = segments[1] && POSTING_ID.test(segments[1]) ? segments[1] : undefined;
    if (segments[1] !== undefined && !postingId) return { recognized: true };
    return {
      recognized: true,
      kind: "hosted",
      boardName: segments[0] ? boardName(segments[0]) : undefined,
      postingId,
      application: segments[2] === "application",
    };
  }
  return { recognized: false };
}

function canonicalApiBase(name: string): string {
  return `https://${ASHBY_API_HOST}/posting-api/job-board/${name}`;
}

function boardRequestUrl(name: string): string {
  return `${canonicalApiBase(name)}?includeCompensation=true`;
}

export function validateAshbySource(input: SourceDescriptor): SourceDescriptor {
  const source = SourceDescriptorSchema.parse(input);
  const name = boardName(source.tenantKey);
  if (source.connectorId !== "ashby" || source.region !== "global" || !name || source.tenantKey !== name) throw new AshbyConnectorError("ashby_source_invalid");
  if (source.apiBaseUrl.replace(/\/$/, "") !== canonicalApiBase(name)) throw new AshbyConnectorError("ashby_source_invalid");
  const boardUrl = new URL(source.boardUrl);
  if (boardUrl.username || boardUrl.password || boardUrl.hash) throw new AshbyConnectorError("ashby_source_invalid");
  const identity = identityFromUrl(boardUrl);
  if (identity.recognized && (boardUrl.port || boardUrl.search || identity.kind !== "hosted" || identity.boardName !== name || identity.postingId)) throw new AshbyConnectorError("ashby_source_invalid");
  return source;
}

function boardArtifact(artifacts: readonly ArtifactView[]): { artifact: ArtifactView; boardName: string } {
  if (artifacts.length !== 1) throw new AshbyConnectorError("ashby_artifact_count");
  const artifact = artifacts[0]!;
  const url = new URL(artifact.sourceUrl);
  const identity = identityFromUrl(url);
  const compensation = url.searchParams.getAll("includeCompensation");
  if (
    !identity.recognized || identity.kind !== "api" || !identity.boardName || identity.postingId
    || url.port || url.username || url.password || url.hash
    || [...url.searchParams.keys()].some((key) => key !== "includeCompensation")
    || compensation.length !== 1 || compensation[0] !== "true"
  ) throw new AshbyConnectorError("ashby_source_invalid");
  return { artifact, boardName: identity.boardName };
}

function validateJobUrls(job: z.infer<typeof AshbyJobSchema>, expectedBoard: string): string {
  const jobUrl = new URL(job.jobUrl);
  const applyUrl = new URL(job.applyUrl);
  const jobIdentity = identityFromUrl(jobUrl);
  const applyIdentity = identityFromUrl(applyUrl);
  const clean = (url: URL) => !url.port && !url.username && !url.password && !url.hash && !url.search;
  if (
    !clean(jobUrl) || !clean(applyUrl)
    || !jobIdentity.recognized || jobIdentity.kind !== "hosted" || jobIdentity.boardName !== expectedBoard || !jobIdentity.postingId || jobIdentity.application
    || !applyIdentity.recognized || applyIdentity.kind !== "hosted" || applyIdentity.boardName !== expectedBoard || applyIdentity.postingId !== jobIdentity.postingId || !applyIdentity.application
    || (job.id !== undefined && job.id !== jobIdentity.postingId)
  ) throw new AshbyConnectorError("ashby_identity_mismatch");
  return jobIdentity.postingId;
}

function digest(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

function evidence<T>(value: T, artifact: ArtifactView, pointer: string, origin: EvidenceValue<T>["origin"], version: string): EvidenceValue<T> {
  return { value, origin, artifactId: artifact.artifactId, locator: { kind: "json_pointer", pointer }, extractorId: "ashby", extractorVersion: version, confidence: origin === "source_field" ? 1 : 0.99 };
}

function locations(job: z.infer<typeof AshbyJobSchema>): RawLocation[] {
  const values = [job.location, ...(job.secondaryLocations ?? []).map((location) => location.location)];
  return [...new Set(values.map((value) => value.trim()).filter(Boolean))].map((label) => ({ label }));
}

function workplace(job: z.infer<typeof AshbyJobSchema>): "remote" | "hybrid" | "onsite" | "unspecified" | undefined {
  if (job.workplaceType === "Remote") return "remote";
  if (job.workplaceType === "Hybrid") return "hybrid";
  if (job.workplaceType === "OnSite") return "onsite";
  if (job.isRemote === true) return "remote";
  return job.isRemote === false ? "unspecified" : undefined;
}

function compensation(job: z.infer<typeof AshbyJobSchema>): RawCompensation | undefined {
  const value = job.compensation;
  if (!value) return undefined;
  const salaryComponents = (value.summaryComponents ?? []).filter((component) => component.compensationType === "Salary");
  if (salaryComponents.length > 1) return undefined;
  const salary = salaryComponents[0];
  const rawText = value.scrapeableCompensationSalarySummary?.trim() || value.compensationTierSummary?.trim();
  if (!rawText) return undefined;
  const interval = salary?.interval.toLowerCase() ?? "";
  const period = interval.includes("hour") ? "hour" : interval.includes("day") ? "day" : interval.includes("week") ? "week" : interval.includes("month") ? "month" : interval.includes("year") ? "year" : "unknown";
  return {
    rawText,
    ...(salary?.minValue != null ? { minimum: salary.minValue } : {}),
    ...(salary?.maxValue != null ? { maximum: salary.maxValue } : {}),
    ...(salary?.currencyCode ? { currency: salary.currencyCode } : {}),
    period,
  };
}

export function createAshbyConnector(version = ASHBY_CONNECTOR_VERSION): SourceConnector {
  if (!/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/.test(version)) throw new TypeError("invalid Ashby connector version");
  return Object.freeze({
    id: "ashby" as const,
    version,

    detect(candidateUrl: URL): DetectionResult {
      if (candidateUrl.protocol !== "https:" || candidateUrl.port || candidateUrl.username || candidateUrl.password || candidateUrl.hash) return { detected: false, connectorId: "ashby", confidence: 0, reason: "invalid_candidate" };
      const identity = identityFromUrl(candidateUrl);
      if (!identity.recognized) return { detected: false, connectorId: "ashby", confidence: 0, reason: "not_recognized" };
      if (!identity.boardName) return { detected: false, connectorId: "ashby", confidence: 0, reason: "invalid_candidate" };
      if (identity.kind === "api") {
        const keys = [...candidateUrl.searchParams.keys()];
        const compensation = candidateUrl.searchParams.getAll("includeCompensation");
        if (keys.some((key) => key !== "includeCompensation") || compensation.length > 1 || (compensation[0] !== undefined && !["true", "false"].includes(compensation[0]))) return { detected: false, connectorId: "ashby", confidence: 0, reason: "invalid_candidate" };
      } else if (candidateUrl.search) return { detected: false, connectorId: "ashby", confidence: 0, reason: "invalid_candidate" };
      return { detected: true, connectorId: "ashby", tenantKey: identity.boardName, confidence: 1, reason: identity.kind === "api" ? "recognized_path" : "recognized_host" };
    },

    planEnumeration(source: SourceDescriptor, cursor?: string): FetchPlan {
      const validated = validateAshbySource(source);
      if (cursor !== undefined) throw new AshbyConnectorError("ashby_cursor_unsupported");
      return { requests: [{ url: boardRequestUrl(validated.tenantKey), method: "GET", accept: "application/json" }] };
    },

    parseEnumeration(artifacts: readonly ArtifactView[]): EnumerationResult {
      const { artifact, boardName: expectedBoard } = boardArtifact(artifacts);
      const responseArtifacts = [artifact.artifactId];
      const parsed = AshbyBoardSchema.safeParse(parseBoundedJson(artifact.bytes));
      if (!parsed.success) return { listings: [], complete: false, completenessReason: "schema_invalid", responseArtifacts, connectorVersion: version };
      const listings: EnumeratedListing[] = [];
      const seen = new Set<string>();
      let invalidIdentity = false;
      for (const job of parsed.data.jobs) {
        let sourceJobId: string;
        try { sourceJobId = validateJobUrls(job, expectedBoard); }
        catch { invalidIdentity = true; continue; }
        if (seen.has(sourceJobId)) { invalidIdentity = true; continue; }
        seen.add(sourceJobId);
        if (!job.isListed) continue;
        listings.push({
          sourceJobId,
          detailUrl: boardRequestUrl(expectedBoard),
          canonicalSourceUrl: job.jobUrl,
          applyUrl: job.applyUrl,
          lightweightFingerprint: digest(JSON.stringify([sourceJobId, job.title, job.location, job.secondaryLocations ?? [], job.department ?? null, job.team ?? null, job.isListed, job.isRemote ?? null, job.workplaceType ?? null, job.publishedAt, job.employmentType ?? null, job.jobUrl, job.applyUrl, job.compensation ?? null])),
          artifactId: artifact.artifactId,
        });
      }
      if (invalidIdentity) return { listings, complete: false, completenessReason: "schema_invalid", responseArtifacts, connectorVersion: version };
      if (listings.length === 0) return { listings: [], complete: false, completenessReason: "suspicious_empty", responseArtifacts, connectorVersion: version };
      return { listings, complete: true, completenessReason: "complete", responseArtifacts, connectorVersion: version };
    },

    planDetails(source: SourceDescriptor, item: EnumeratedListing): FetchPlan {
      const validated = validateAshbySource(source);
      if (!POSTING_ID.test(item.sourceJobId)) throw new AshbyConnectorError("ashby_identity_mismatch");
      return { requests: [{ url: boardRequestUrl(validated.tenantKey), method: "GET", accept: "application/json" }] };
    },

    parseListing(artifacts: readonly ArtifactView[], item: EnumeratedListing): ParsedListing {
      const { artifact, boardName: expectedBoard } = boardArtifact(artifacts);
      if (!POSTING_ID.test(item.sourceJobId)) throw new AshbyConnectorError("ashby_identity_mismatch");
      const parsed = AshbyBoardSchema.safeParse(parseBoundedJson(artifact.bytes));
      if (!parsed.success) throw new AshbyConnectorError("ashby_schema_invalid");
      const matches: Array<{ job: z.infer<typeof AshbyJobSchema>; index: number }> = [];
      for (const [index, job] of parsed.data.jobs.entries()) {
        let postingId: string;
        try { postingId = validateJobUrls(job, expectedBoard); }
        catch { throw new AshbyConnectorError("ashby_identity_mismatch"); }
        if (postingId === item.sourceJobId) matches.push({ job, index });
      }
      if (matches.length !== 1) throw new AshbyConnectorError("ashby_identity_mismatch");
      const { job, index } = matches[0]!;
      if (!job.isListed || job.jobUrl !== item.canonicalSourceUrl || job.applyUrl !== item.applyUrl) throw new AshbyConnectorError("ashby_identity_mismatch");
      const sanitized = sanitizeUntrustedHtml(new TextEncoder().encode(job.descriptionHtml));
      if (!sanitized.text) throw new AshbyConnectorError("ashby_schema_invalid");
      const rawLocations = locations(job);
      const rawWorkplace = workplace(job);
      const rawCompensation = compensation(job);
      const pointer = `/jobs/${index}`;
      return {
        sourceJobId: item.sourceJobId,
        sourcePostedAt: job.publishedAt,
        title: evidence(job.title, artifact, `${pointer}/title`, "source_field", version),
        descriptionHtml: evidence(sanitized.html, artifact, `${pointer}/descriptionHtml`, "deterministic_rule", version),
        descriptionText: evidence(sanitized.text, artifact, `${pointer}/descriptionHtml`, "deterministic_rule", version),
        locations: evidence(rawLocations, artifact, `${pointer}/location`, "deterministic_rule", version),
        ...(rawWorkplace ? { workplaceType: evidence(rawWorkplace, artifact, job.workplaceType ? `${pointer}/workplaceType` : `${pointer}/isRemote`, "source_field", version) } : {}),
        ...(job.employmentType ? { employmentType: evidence(job.employmentType, artifact, `${pointer}/employmentType`, "source_field", version) } : {}),
        ...(rawCompensation ? { compensation: evidence(rawCompensation, artifact, `${pointer}/compensation`, "deterministic_rule", version) } : {}),
        ...(job.department?.trim() ? { department: evidence(job.department.trim(), artifact, `${pointer}/department`, "source_field", version) } : {}),
        ...(job.team?.trim() ? { team: evidence(job.team.trim(), artifact, `${pointer}/team`, "source_field", version) } : {}),
        applyUrl: evidence(job.applyUrl, artifact, `${pointer}/applyUrl`, "source_field", version),
        canonicalSourceUrl: evidence(job.jobUrl, artifact, `${pointer}/jobUrl`, "source_field", version),
      };
    },
  });
}

export const ashbyConnector = createAshbyConnector();
