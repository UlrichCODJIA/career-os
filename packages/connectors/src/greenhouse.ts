import { createHash } from "node:crypto";
import { z } from "zod";
import {
  BoundedParseError,
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

export const GREENHOUSE_CONNECTOR_VERSION = "1.0.0";
export const GREENHOUSE_API_HOST = "boards-api.greenhouse.io";
export const GREENHOUSE_BOARD_HOSTS = Object.freeze(["boards.greenhouse.io", "job-boards.greenhouse.io"] as const);

const TOKEN = /^[a-z0-9][a-z0-9_-]{0,127}$/;
const HttpsUrlSchema = z.url().refine((value) => {
  const url = new URL(value);
  return url.protocol === "https:" && !url.username && !url.password && !url.hash;
}, "Greenhouse URLs must use HTTPS without credentials or fragments");
const TimestampSchema = z.iso.datetime({ offset: true });

const GreenhouseListJobSchema = z.object({
  id: z.number().int().positive().safe(),
  internal_job_id: z.number().int().positive().safe().nullable().optional(),
  title: z.string().trim().min(1).max(500),
  updated_at: TimestampSchema,
  location: z.object({ name: z.string().trim().min(1).max(500) }).passthrough(),
  absolute_url: HttpsUrlSchema,
  language: z.string().trim().min(1).max(35).optional(),
}).passthrough();

const GreenhouseListResponseSchema = z.object({
  jobs: z.array(GreenhouseListJobSchema).max(100_000),
  meta: z.object({ total: z.number().int().nonnegative().max(100_000) }).passthrough(),
}).passthrough();

const DepartmentSchema = z.object({ id: z.number().int().positive().safe(), name: z.string().trim().min(1).max(500) }).passthrough();
const OfficeSchema = z.object({ id: z.number().int().positive().safe(), name: z.string().trim().min(1).max(500), location: z.string().trim().min(1).max(500).optional() }).passthrough();
const PayRangeSchema = z.object({
  min_cents: z.number().int().nonnegative().safe(),
  max_cents: z.number().int().nonnegative().safe(),
  currency_type: z.string().regex(/^[A-Z]{3}$/),
  title: z.string().trim().min(1).max(500),
  blurb: z.string().max(10_000).optional(),
}).passthrough().refine((range) => range.min_cents <= range.max_cents, "Greenhouse pay minimum cannot exceed maximum");

const GreenhouseDetailSchema = z.object({
  id: z.number().int().positive().safe(),
  title: z.string().trim().min(1).max(500),
  company_name: z.string().trim().min(1).max(500).optional(),
  first_published: TimestampSchema.optional(),
  updated_at: TimestampSchema.optional(),
  application_deadline: TimestampSchema.nullable().optional(),
  location: z.object({ name: z.string().trim().min(1).max(500) }).passthrough(),
  content: z.string().trim().min(1).max(1_000_000),
  absolute_url: HttpsUrlSchema,
  departments: z.array(DepartmentSchema).max(100).optional(),
  offices: z.array(OfficeSchema).max(100).optional(),
  pay_input_ranges: z.array(PayRangeSchema).max(20).optional(),
}).passthrough();

export class GreenhouseConnectorError extends Error {
  constructor(readonly code: "greenhouse_source_invalid" | "greenhouse_identity_mismatch" | "greenhouse_schema_invalid" | "greenhouse_artifact_count" | "greenhouse_cursor_unsupported") {
    super(`Greenhouse connector rejected: ${code}`);
    this.name = "GreenhouseConnectorError";
  }
}

function boardToken(value: string): string | undefined {
  return TOKEN.test(value) ? value : undefined;
}

function tokenFromCandidate(url: URL): { token?: string; recognizedHost: boolean } {
  const hostname = url.hostname.toLowerCase().replace(/\.$/, "");
  const segments = url.pathname.split("/").filter(Boolean);
  if (GREENHOUSE_BOARD_HOSTS.includes(hostname as (typeof GREENHOUSE_BOARD_HOSTS)[number])) {
    return { token: segments[0] ? boardToken(segments[0]) : undefined, recognizedHost: true };
  }
  if (
    hostname === GREENHOUSE_API_HOST
    && segments[0] === "v1"
    && segments[1] === "boards"
    && (segments.length === 3 || (segments[3] === "jobs" && segments.length <= 5))
  ) {
    return { token: segments[2] ? boardToken(segments[2]) : undefined, recognizedHost: true };
  }
  return { recognizedHost: false };
}

function canonicalApiBase(token: string): string {
  return `https://${GREENHOUSE_API_HOST}/v1/boards/${token}`;
}

export function validateGreenhouseSource(input: SourceDescriptor): SourceDescriptor {
  const source = SourceDescriptorSchema.parse(input);
  const token = boardToken(source.tenantKey);
  if (source.connectorId !== "greenhouse" || !token || source.tenantKey !== token) throw new GreenhouseConnectorError("greenhouse_source_invalid");
  const expected = canonicalApiBase(token);
  if (source.apiBaseUrl.replace(/\/$/, "") !== expected) throw new GreenhouseConnectorError("greenhouse_source_invalid");
  const boardUrl = new URL(source.boardUrl);
  if (boardUrl.username || boardUrl.password || boardUrl.hash) throw new GreenhouseConnectorError("greenhouse_source_invalid");
  const boardCandidate = tokenFromCandidate(boardUrl);
  if (boardCandidate.recognizedHost && boardUrl.port) throw new GreenhouseConnectorError("greenhouse_source_invalid");
  if (boardCandidate.recognizedHost && boardCandidate.token !== token) throw new GreenhouseConnectorError("greenhouse_source_invalid");
  return source;
}

function validateArtifactEndpoint(artifact: ArtifactView, expectedPath: string, expectedQuery = ""): void {
  const url = new URL(artifact.sourceUrl);
  if (url.hostname !== GREENHOUSE_API_HOST || url.port || url.username || url.password || url.hash || url.pathname !== expectedPath || url.search !== expectedQuery) {
    throw new GreenhouseConnectorError("greenhouse_source_invalid");
  }
}

function oneArtifact(artifacts: readonly ArtifactView[]): ArtifactView {
  if (artifacts.length !== 1) throw new GreenhouseConnectorError("greenhouse_artifact_count");
  return artifacts[0]!;
}

function digest(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

function evidence<T>(value: T, artifact: ArtifactView, pointer: string, origin: EvidenceValue<T>["origin"], extractorVersion: string): EvidenceValue<T> {
  return {
    value,
    origin,
    artifactId: artifact.artifactId,
    locator: { kind: "json_pointer", pointer },
    extractorId: "greenhouse",
    extractorVersion,
    confidence: origin === "source_field" ? 1 : 0.99,
  };
}

function decodeEntityLayer(value: string): string {
  const named: Readonly<Record<string, string>> = { amp: "&", lt: "<", gt: ">", quot: "\"", apos: "'", nbsp: " " };
  return value.replace(/&(?:#(\d+)|#x([a-f0-9]+)|([a-z]+));/gi, (match, decimal: string | undefined, hex: string | undefined, name: string | undefined) => {
    const code = decimal ? Number(decimal) : hex ? Number.parseInt(hex, 16) : undefined;
    if (code !== undefined && Number.isSafeInteger(code) && code > 0 && code <= 0x10ffff && !(code >= 0xd800 && code <= 0xdfff)) return String.fromCodePoint(code);
    return name ? (named[name.toLowerCase()] ?? match) : match;
  });
}

function sanitizedContent(content: string) {
  let decoded = content;
  for (let layer = 0; layer < 2; layer += 1) decoded = decodeEntityLayer(decoded);
  return sanitizeUntrustedHtml(new TextEncoder().encode(decoded));
}

function compensation(range: z.infer<typeof PayRangeSchema>): RawCompensation {
  return {
    rawText: `${range.title}: ${range.currency_type} ${(range.min_cents / 100).toFixed(2)}–${(range.max_cents / 100).toFixed(2)}`,
    minimum: range.min_cents / 100,
    maximum: range.max_cents / 100,
    currency: range.currency_type,
    period: "unknown",
  };
}

export function createGreenhouseConnector(version = GREENHOUSE_CONNECTOR_VERSION): SourceConnector {
  if (!/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/.test(version)) throw new TypeError("invalid Greenhouse connector version");
  return Object.freeze({
    id: "greenhouse" as const,
    version,

    detect(candidateUrl: URL): DetectionResult {
      if (candidateUrl.protocol !== "https:" || candidateUrl.port || candidateUrl.username || candidateUrl.password || candidateUrl.hash) {
        return { detected: false, connectorId: "greenhouse", confidence: 0, reason: "invalid_candidate" };
      }
      const candidate = tokenFromCandidate(candidateUrl);
      if (!candidate.recognizedHost) return { detected: false, connectorId: "greenhouse", confidence: 0, reason: "not_recognized" };
      if (!candidate.token) return { detected: false, connectorId: "greenhouse", confidence: 0, reason: "invalid_candidate" };
      return { detected: true, connectorId: "greenhouse", tenantKey: candidate.token, confidence: 1, reason: candidateUrl.hostname === GREENHOUSE_API_HOST ? "recognized_path" : "recognized_host" };
    },

    planEnumeration(source: SourceDescriptor, cursor?: string): FetchPlan {
    const validated = validateGreenhouseSource(source);
    if (cursor !== undefined) throw new GreenhouseConnectorError("greenhouse_cursor_unsupported");
    return { requests: [{ url: `${canonicalApiBase(validated.tenantKey)}/jobs`, method: "GET", accept: "application/json" }] };
    },

    parseEnumeration(artifacts: readonly ArtifactView[]): EnumerationResult {
    const artifact = oneArtifact(artifacts);
    const artifactUrl = new URL(artifact.sourceUrl);
    const candidate = tokenFromCandidate(artifactUrl);
    if (!candidate.token) throw new GreenhouseConnectorError("greenhouse_source_invalid");
    const apiBase = canonicalApiBase(candidate.token);
    validateArtifactEndpoint(artifact, `/v1/boards/${candidate.token}/jobs`);
    const decoded = parseBoundedJson(artifact.bytes);
    const parsed = GreenhouseListResponseSchema.safeParse(decoded);
    if (!parsed.success) return { listings: [], complete: false, completenessReason: "schema_invalid", responseArtifacts: [artifact.artifactId], connectorVersion: version };
    const listings: EnumeratedListing[] = [];
    const seen = new Set<string>();
    let duplicateCount = 0;
    let identityMismatch = false;
    for (const job of parsed.data.jobs) {
      const hostedJob = tokenFromCandidate(new URL(job.absolute_url));
      if (hostedJob.recognizedHost && hostedJob.token !== candidate.token) {
        identityMismatch = true;
        continue;
      }
      const sourceJobId = String(job.id);
      if (seen.has(sourceJobId)) {
        duplicateCount += 1;
        continue;
      }
      seen.add(sourceJobId);
      listings.push({
        sourceJobId,
        detailUrl: `${apiBase}/jobs/${job.id}?pay_transparency=true`,
        canonicalSourceUrl: job.absolute_url,
        applyUrl: job.absolute_url,
        lightweightFingerprint: digest(JSON.stringify([job.id, job.internal_job_id ?? null, job.title, job.updated_at, job.location.name, job.absolute_url, job.language ?? null])),
        sourceUpdatedAt: job.updated_at,
        artifactId: artifact.artifactId,
      });
    }
    const countMatches = parsed.data.meta.total === parsed.data.jobs.length && duplicateCount === 0 && !identityMismatch;
    const completenessReason = !countMatches ? "schema_invalid" : listings.length === 0 ? "suspicious_empty" : "complete";
    return { listings, complete: completenessReason === "complete", completenessReason, responseArtifacts: [artifact.artifactId], connectorVersion: version };
    },

    planDetails(source: SourceDescriptor, item: EnumeratedListing): FetchPlan {
    const validated = validateGreenhouseSource(source);
    if (!/^\d+$/.test(item.sourceJobId)) throw new GreenhouseConnectorError("greenhouse_identity_mismatch");
    return { requests: [{ url: `${canonicalApiBase(validated.tenantKey)}/jobs/${item.sourceJobId}?pay_transparency=true`, method: "GET", accept: "application/json" }] };
    },

    parseListing(artifacts: readonly ArtifactView[], item: EnumeratedListing): ParsedListing {
    const artifact = oneArtifact(artifacts);
    const artifactUrl = new URL(artifact.sourceUrl);
    const candidate = tokenFromCandidate(artifactUrl);
    if (!candidate.token || !/^\d+$/.test(item.sourceJobId)) throw new GreenhouseConnectorError("greenhouse_source_invalid");
    validateArtifactEndpoint(artifact, `/v1/boards/${candidate.token}/jobs/${item.sourceJobId}`, "?pay_transparency=true");
    let decoded: unknown;
    try { decoded = parseBoundedJson(artifact.bytes); } catch (error) {
      if (error instanceof BoundedParseError) throw error;
      throw new GreenhouseConnectorError("greenhouse_schema_invalid");
    }
    const result = GreenhouseDetailSchema.safeParse(decoded);
    if (!result.success) throw new GreenhouseConnectorError("greenhouse_schema_invalid");
    const job = result.data;
    const hostedJob = tokenFromCandidate(new URL(job.absolute_url));
    if (hostedJob.recognizedHost && hostedJob.token !== candidate.token) throw new GreenhouseConnectorError("greenhouse_identity_mismatch");
    if (String(job.id) !== item.sourceJobId || job.absolute_url !== item.canonicalSourceUrl) throw new GreenhouseConnectorError("greenhouse_identity_mismatch");
    const sanitized = sanitizedContent(job.content);
    if (!sanitized.text) throw new GreenhouseConnectorError("greenhouse_schema_invalid");
    const locations: RawLocation[] = [{ label: job.location.name }];
    const parsed: ParsedListing = {
      sourceJobId: item.sourceJobId,
      ...(job.first_published ? { sourcePostedAt: job.first_published } : {}),
      ...(job.updated_at ? { sourceUpdatedAt: job.updated_at } : {}),
      ...(job.application_deadline ? { validThrough: job.application_deadline } : {}),
      title: evidence(job.title, artifact, "/title", "source_field", version),
      descriptionHtml: evidence(sanitized.html, artifact, "/content", "deterministic_rule", version),
      descriptionText: evidence(sanitized.text, artifact, "/content", "deterministic_rule", version),
      locations: evidence(locations, artifact, "/location/name", "deterministic_rule", version),
      ...(job.departments?.length === 1 ? { department: evidence(job.departments[0]!.name, artifact, "/departments/0/name", "source_field", version) } : {}),
      ...(job.pay_input_ranges?.length === 1 ? { compensation: evidence(compensation(job.pay_input_ranges[0]!), artifact, "/pay_input_ranges/0", "deterministic_rule", version) } : {}),
      applyUrl: evidence(job.absolute_url, artifact, "/absolute_url", "source_field", version),
      canonicalSourceUrl: evidence(job.absolute_url, artifact, "/absolute_url", "source_field", version),
    };
    return parsed;
    },
  });
}

export const greenhouseConnector = createGreenhouseConnector();
