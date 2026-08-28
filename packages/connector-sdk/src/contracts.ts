import { z } from "zod";

const IdentifierSchema = z.string().trim().min(1).max(200).regex(/^[a-zA-Z0-9._:-]+$/);
const VersionSchema = z.string().trim().min(1).max(100).regex(/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/);
const HttpsUrlSchema = z.url().refine((value) => new URL(value).protocol === "https:", "URL must use HTTPS");
const TimestampSchema = z.iso.datetime({ offset: true });
const Sha256Schema = z.string().regex(/^[a-f0-9]{64}$/);

export const ConnectorIdSchema = z.enum(["greenhouse", "lever", "ashby"]);
export type ConnectorId = z.infer<typeof ConnectorIdSchema>;

export const SourceDescriptorSchema = z.object({
  sourceId: IdentifierSchema,
  connectorId: ConnectorIdSchema,
  tenantKey: IdentifierSchema,
  boardUrl: HttpsUrlSchema,
  apiBaseUrl: HttpsUrlSchema,
  region: z.enum(["global", "eu"]).default("global"),
  policyId: IdentifierSchema,
}).strict();
export type SourceDescriptor = z.infer<typeof SourceDescriptorSchema>;

export const ArtifactViewSchema = z.object({
  artifactId: IdentifierSchema,
  digest: Sha256Schema,
  contentType: z.string().trim().min(1).max(200),
  sourceUrl: HttpsUrlSchema,
  fetchedAt: TimestampSchema,
  bytes: z.instanceof(Uint8Array),
}).strict();
export type ArtifactView = z.infer<typeof ArtifactViewSchema>;

export const FetchPlanSchema = z.object({
  requests: z.array(z.object({
    url: HttpsUrlSchema,
    method: z.literal("GET"),
    accept: z.string().trim().min(1).max(200),
    pageToken: z.string().min(1).max(2_000).optional(),
  }).strict()).min(1).max(100),
}).strict();
export type FetchPlan = z.infer<typeof FetchPlanSchema>;

export const DetectionResultSchema = z.object({
  detected: z.boolean(),
  connectorId: ConnectorIdSchema,
  tenantKey: IdentifierSchema.optional(),
  confidence: z.number().min(0).max(1),
  reason: z.enum(["recognized_host", "recognized_path", "not_recognized", "invalid_candidate"]),
}).strict().superRefine((value, context) => {
  if (value.detected && (!value.tenantKey || value.confidence <= 0)) {
    context.addIssue({ code: "custom", message: "detected candidates require tenant identity and positive confidence" });
  }
  if (!value.detected && value.tenantKey) {
    context.addIssue({ code: "custom", path: ["tenantKey"], message: "undetected candidates cannot claim tenant identity" });
  }
});
export type DetectionResult = z.infer<typeof DetectionResultSchema>;

export const TextSpanSchema = z.object({
  start: z.number().int().min(0),
  end: z.number().int().positive(),
  quoteHash: Sha256Schema,
}).strict().refine((span) => span.end > span.start, "text span must be non-empty");

export const EvidenceLocatorSchema = z.union([
  z.object({ kind: z.literal("json_pointer"), pointer: z.string().startsWith("/").max(2_000) }).strict(),
  z.object({ kind: z.literal("text_span"), span: TextSpanSchema }).strict(),
]);
export type EvidenceLocator = z.infer<typeof EvidenceLocatorSchema>;

export function EvidenceValueSchema<T extends z.ZodType>(valueSchema: T) {
  return z.object({
    value: valueSchema,
    origin: z.enum(["source_field", "source_text", "deterministic_rule", "model_derived", "human_review"]),
    artifactId: IdentifierSchema,
    locator: EvidenceLocatorSchema,
    extractorId: IdentifierSchema,
    extractorVersion: VersionSchema,
    confidence: z.number().min(0).max(1),
  }).strict().superRefine((evidence, context) => {
    if (evidence.origin === "source_field" && evidence.confidence < 1) {
      context.addIssue({ code: "custom", path: ["confidence"], message: "literal source fields must use confidence 1" });
    }
  });
}
export type EvidenceValue<T> = {
  readonly value: T;
  readonly origin: "source_field" | "source_text" | "deterministic_rule" | "model_derived" | "human_review";
  readonly artifactId: string;
  readonly locator: EvidenceLocator;
  readonly extractorId: string;
  readonly extractorVersion: string;
  readonly confidence: number;
};

export const RawLocationSchema = z.object({
  label: z.string().trim().min(1).max(500),
  countryCode: z.string().regex(/^[A-Z]{2}$/).optional(),
  subdivision: z.string().trim().min(1).max(100).optional(),
  locality: z.string().trim().min(1).max(200).optional(),
}).strict();
export type RawLocation = z.infer<typeof RawLocationSchema>;

export const RawCompensationSchema = z.object({
  rawText: z.string().trim().min(1).max(2_000),
  minimum: z.number().finite().nonnegative().optional(),
  maximum: z.number().finite().nonnegative().optional(),
  currency: z.string().regex(/^[A-Z]{3}$/).optional(),
  period: z.enum(["hour", "day", "week", "month", "year", "unknown"]),
}).strict().refine((value) => value.minimum === undefined || value.maximum === undefined || value.minimum <= value.maximum, "minimum compensation cannot exceed maximum");
export type RawCompensation = z.infer<typeof RawCompensationSchema>;

export const EnumeratedListingSchema = z.object({
  sourceJobId: IdentifierSchema,
  detailUrl: HttpsUrlSchema.optional(),
  canonicalSourceUrl: HttpsUrlSchema,
  applyUrl: HttpsUrlSchema.optional(),
  lightweightFingerprint: Sha256Schema,
  sourceUpdatedAt: TimestampSchema.optional(),
  artifactId: IdentifierSchema,
}).strict();
export type EnumeratedListing = z.infer<typeof EnumeratedListingSchema>;

export const CompletenessReasonSchema = z.enum([
  "complete", "pagination_incomplete", "schema_invalid", "suspicious_empty", "blocked", "transport_failure", "limit_exceeded",
]);
export type CompletenessReason = z.infer<typeof CompletenessReasonSchema>;

export const EnumerationResultSchema = z.object({
  listings: z.array(EnumeratedListingSchema).max(100_000),
  complete: z.boolean(),
  completenessReason: CompletenessReasonSchema,
  nextPageToken: z.string().min(1).max(2_000).optional(),
  responseArtifacts: z.array(IdentifierSchema).min(1).max(100),
  connectorVersion: VersionSchema,
}).strict().superRefine((result, context) => {
  if (result.complete !== (result.completenessReason === "complete")) {
    context.addIssue({ code: "custom", path: ["complete"], message: "complete must agree with completenessReason" });
  }
  if (result.completenessReason === "complete" && result.nextPageToken) {
    context.addIssue({ code: "custom", path: ["nextPageToken"], message: "a complete result cannot retain a page token" });
  }
  const ids = new Set<string>();
  for (const [index, listing] of result.listings.entries()) {
    if (ids.has(listing.sourceJobId)) context.addIssue({ code: "custom", path: ["listings", index, "sourceJobId"], message: "source job IDs must be unique" });
    ids.add(listing.sourceJobId);
    if (!result.responseArtifacts.includes(listing.artifactId)) context.addIssue({ code: "custom", path: ["listings", index, "artifactId"], message: "listing evidence artifact is not in this response" });
  }
});
export type EnumerationResult = z.infer<typeof EnumerationResultSchema>;

export const ParsedListingSchema = z.object({
  sourceJobId: IdentifierSchema,
  sourcePostedAt: TimestampSchema.optional(),
  sourceUpdatedAt: TimestampSchema.optional(),
  validThrough: TimestampSchema.optional(),
  title: EvidenceValueSchema(z.string().trim().min(1).max(500)),
  descriptionHtml: EvidenceValueSchema(z.string().max(1_000_000)).optional(),
  descriptionText: EvidenceValueSchema(z.string().trim().min(1).max(1_000_000)),
  locations: EvidenceValueSchema(z.array(RawLocationSchema).max(100)),
  workplaceType: EvidenceValueSchema(z.enum(["remote", "hybrid", "onsite", "unspecified"])).optional(),
  employmentType: EvidenceValueSchema(z.string().trim().min(1).max(200)).optional(),
  compensation: EvidenceValueSchema(RawCompensationSchema).optional(),
  department: EvidenceValueSchema(z.string().trim().min(1).max(500)).optional(),
  team: EvidenceValueSchema(z.string().trim().min(1).max(500)).optional(),
  applyUrl: EvidenceValueSchema(HttpsUrlSchema),
  canonicalSourceUrl: EvidenceValueSchema(HttpsUrlSchema),
}).strict();
export type ParsedListing = z.infer<typeof ParsedListingSchema>;

export interface SourceConnector {
  readonly id: ConnectorId;
  readonly version: string;
  detect(candidateUrl: URL): Promise<DetectionResult> | DetectionResult;
  planEnumeration(source: SourceDescriptor, cursor?: string): FetchPlan;
  parseEnumeration(artifacts: readonly ArtifactView[]): Promise<EnumerationResult> | EnumerationResult;
  planDetails(source: SourceDescriptor, item: EnumeratedListing): FetchPlan | null;
  parseListing(artifacts: readonly ArtifactView[], item: EnumeratedListing): Promise<ParsedListing> | ParsedListing;
}

export function successfulForAbsenceInference(input: unknown): boolean {
  const result = EnumerationResultSchema.safeParse(input);
  return result.success && result.data.complete && result.data.completenessReason === "complete";
}

const EVIDENCE_FIELDS = [
  "title", "descriptionHtml", "descriptionText", "locations", "workplaceType", "employmentType",
  "compensation", "department", "team", "applyUrl", "canonicalSourceUrl",
] as const;

export function validateParsedListingEvidence(listing: ParsedListing, artifacts: readonly ArtifactView[]): void {
  const artifactIds = new Set(artifacts.map((artifact) => artifact.artifactId));
  for (const field of EVIDENCE_FIELDS) {
    const evidence = listing[field];
    if (evidence !== undefined && !artifactIds.has(evidence.artifactId)) {
      throw new TypeError(`listing evidence for ${field} references an artifact outside this parse invocation`);
    }
  }
}

export function validateConnectorIdentity(connector: SourceConnector): void {
  ConnectorIdSchema.parse(connector.id);
  VersionSchema.parse(connector.version);
}
