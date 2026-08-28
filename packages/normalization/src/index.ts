import { createHash } from "node:crypto";
import { sanitizeUntrustedHtml, type EvidenceLocator, type EvidenceValue, type ParsedListing, type RawCompensation, type RawLocation } from "@career-os/connector-sdk";

export const NORMALIZER_VERSION = "1.0.0";
export const TAXONOMY_VERSION = "1.0.0";

export interface NormalizedLocation {
  label: string;
  countryCode?: string;
  subdivision?: string;
  locality?: string;
  remoteEligible: boolean;
}

export interface NormalizedCompensation {
  rawText: string;
  minimum?: number;
  maximum?: number;
  currency?: string;
  period: RawCompensation["period"];
}

export interface NormalizedCandidate {
  sourceJobId: string;
  displayTitle: string;
  normalizedTitle: string;
  descriptionText: string;
  descriptionHtml?: string;
  locations: NormalizedLocation[];
  workplaceType: "remote" | "hybrid" | "onsite" | "unspecified";
  employmentType?: string;
  compensation?: NormalizedCompensation;
  department?: string;
  team?: string;
  applyUrl: string;
  canonicalSourceUrl: string;
}

export interface NormalizedAssertion {
  fieldPath: string;
  value: unknown;
  origin: "source_field" | "source_text" | "deterministic_rule" | "model_derived" | "human_review";
  artifactId: string;
  locator: EvidenceLocator;
  extractorId: string;
  extractorVersion: string;
  confidence: number;
}

export interface NormalizationResult {
  candidate: NormalizedCandidate;
  assertions: NormalizedAssertion[];
  semanticFingerprint: string;
  normalizerVersion: typeof NORMALIZER_VERSION;
  taxonomyVersion: typeof TAXONOMY_VERSION;
}

const REMOTE = /\b(remote|anywhere|distributed|home[- ]?based|t[eé]l[eé]travail|remoto|remota|fernarbeit|homeoffice)\b/iu;
const HYBRID = /\b(hybrid|hybride|h[ií]brido|h[ií]brida)\b/iu;
const EMPLOYMENT: Array<[RegExp, string]> = [
  [/\b(full[- ]?time|temps plein|tiempo completo|vollzeit|permanent)\b/iu, "full_time"],
  [/\b(part[- ]?time|temps partiel|medio tiempo|teilzeit)\b/iu, "part_time"],
  [/\b(contract|contractor|freelance|consultant|cdd)\b/iu, "contract"],
  [/\b(intern(ship)?|stage|stagiaire|praktikum)\b/iu, "internship"],
  [/\b(temporary|temporaire|temporal)\b/iu, "temporary"],
];
const TRACKING_QUERY = /^(utm_.+|fbclid|gclid|mc_cid|mc_eid|ref|referrer|source)$/i;
const SENSITIVE_QUERY = /(?:^|[-_])(auth|authorization|credential|jwt|key|password|secret|session|sig|signature|token)(?:$|[-_])|api[-_]?key|access[-_]?token|^x-(?:amz|goog)-/i;

function text(value: string, maximum = 1_000_000): string {
  const normalized = value.normalize("NFKC").replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, "")
    .replace(/[\u061c\u200e\u200f\u202a-\u202e\u2066-\u2069\ufeff]/g, "")
    .replace(/\r\n?/g, "\n").replace(/[\t ]+/g, " ").replace(/\n{3,}/g, "\n\n").trim();
  return normalized.slice(0, maximum);
}

export function normalizeTitle(value: string): { display: string; search: string } {
  const display = text(value, 500);
  const search = display.normalize("NFKD").replace(/([\p{Script=Latin}])\p{M}+/gu, "$1").toLocaleLowerCase("und")
    .replace(/[\p{P}\p{S}]+/gu, " ").replace(/\s+/g, " ").trim().normalize("NFC");
  return { display, search };
}

export function canonicalizeJobUrl(value: string): string {
  const url = new URL(value);
  if (url.protocol !== "https:" || url.username || url.password) throw new Error("normalized_url_invalid");
  url.hostname = url.hostname.toLowerCase().replace(/\.$/, "");
  url.hash = "";
  for (const name of [...url.searchParams.keys()]) if (TRACKING_QUERY.test(name) || SENSITIVE_QUERY.test(name)) url.searchParams.delete(name);
  url.searchParams.sort();
  url.pathname = url.pathname.replace(/\/{2,}/g, "/").replace(/\/$/, "") || "/";
  return url.toString();
}

function normalizedEmployment(value?: string): string | undefined {
  if (!value) return undefined;
  const source = text(value, 200);
  return EMPLOYMENT.find(([pattern]) => pattern.test(source))?.[1] ?? source.toLocaleLowerCase("und").replace(/[^\p{L}\p{N}]+/gu, "_").replace(/^_|_$/g, "");
}

function locations(values: readonly RawLocation[]): NormalizedLocation[] {
  const seen = new Set<string>();
  const output: NormalizedLocation[] = [];
  for (const raw of values) {
    const value: NormalizedLocation = {
      label: text(raw.label, 500),
      ...(raw.countryCode ? { countryCode: raw.countryCode.toUpperCase() } : {}),
      ...(raw.subdivision ? { subdivision: text(raw.subdivision, 100) } : {}),
      ...(raw.locality ? { locality: text(raw.locality, 200) } : {}),
      remoteEligible: REMOTE.test(raw.label),
    };
    const key = JSON.stringify(value).toLocaleLowerCase("und");
    if (!seen.has(key)) { seen.add(key); output.push(value); }
  }
  return output;
}

function assertion(fieldPath: string, value: unknown, evidence: EvidenceValue<unknown>, origin = evidence.origin): NormalizedAssertion {
  const deterministic = origin === "deterministic_rule";
  return { fieldPath, value, origin, artifactId: evidence.artifactId, locator: evidence.locator,
    extractorId: deterministic ? "career-os-normalizer" : evidence.extractorId,
    extractorVersion: deterministic ? NORMALIZER_VERSION : evidence.extractorVersion,
    confidence: evidence.confidence };
}

function stable(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stable).join(",")}]`;
  if (value && typeof value === "object") return `{${Object.entries(value as Record<string, unknown>).sort(([a], [b]) => a.localeCompare(b)).map(([key, item]) => `${JSON.stringify(key)}:${stable(item)}`).join(",")}}`;
  return JSON.stringify(value);
}

export function normalizeParsedListing(parsed: ParsedListing): NormalizationResult {
  const title = normalizeTitle(parsed.title.value);
  const normalizedLocations = locations(parsed.locations.value);
  const inferredWorkplace = parsed.workplaceType?.value ?? (normalizedLocations.some((item) => item.remoteEligible) ? "remote" : "unspecified");
  const safeDescription = parsed.descriptionHtml
    ? sanitizeUntrustedHtml(new TextEncoder().encode(parsed.descriptionHtml.value))
    : undefined;
  const candidate: NormalizedCandidate = {
    sourceJobId: parsed.sourceJobId,
    displayTitle: title.display,
    normalizedTitle: title.search,
    descriptionText: text(parsed.descriptionText.value),
    ...(safeDescription ? { descriptionHtml: safeDescription.html } : {}),
    locations: normalizedLocations,
    workplaceType: inferredWorkplace,
    ...(parsed.employmentType ? { employmentType: normalizedEmployment(parsed.employmentType.value) } : {}),
    ...(parsed.compensation ? { compensation: { ...parsed.compensation.value, rawText: text(parsed.compensation.value.rawText, 2_000) } } : {}),
    ...(parsed.department ? { department: text(parsed.department.value, 500) } : {}),
    ...(parsed.team ? { team: text(parsed.team.value, 500) } : {}),
    applyUrl: canonicalizeJobUrl(parsed.applyUrl.value),
    canonicalSourceUrl: canonicalizeJobUrl(parsed.canonicalSourceUrl.value),
  };
  const assertions: NormalizedAssertion[] = [
    assertion("/displayTitle", candidate.displayTitle, parsed.title, candidate.displayTitle === parsed.title.value ? parsed.title.origin : "deterministic_rule"),
    assertion("/normalizedTitle", candidate.normalizedTitle, parsed.title, "deterministic_rule"),
    assertion("/descriptionText", candidate.descriptionText, parsed.descriptionText, candidate.descriptionText === parsed.descriptionText.value ? parsed.descriptionText.origin : "deterministic_rule"),
    assertion("/locations", candidate.locations, parsed.locations, "deterministic_rule"),
    assertion("/workplaceType", candidate.workplaceType, parsed.workplaceType ?? parsed.locations, parsed.workplaceType?.origin ?? "deterministic_rule"),
    assertion("/applyUrl", candidate.applyUrl, parsed.applyUrl, candidate.applyUrl === parsed.applyUrl.value ? parsed.applyUrl.origin : "deterministic_rule"),
    assertion("/canonicalSourceUrl", candidate.canonicalSourceUrl, parsed.canonicalSourceUrl, candidate.canonicalSourceUrl === parsed.canonicalSourceUrl.value ? parsed.canonicalSourceUrl.origin : "deterministic_rule"),
  ];
  if (parsed.descriptionHtml) assertions.push(assertion("/descriptionHtml", candidate.descriptionHtml, parsed.descriptionHtml, "deterministic_rule"));
  if (parsed.employmentType) assertions.push(assertion("/employmentType", candidate.employmentType, parsed.employmentType, "deterministic_rule"));
  if (parsed.compensation) assertions.push(assertion("/compensation", candidate.compensation, parsed.compensation, "deterministic_rule"));
  if (parsed.department) assertions.push(assertion("/department", candidate.department, parsed.department, candidate.department === parsed.department.value ? parsed.department.origin : "deterministic_rule"));
  if (parsed.team) assertions.push(assertion("/team", candidate.team, parsed.team, candidate.team === parsed.team.value ? parsed.team.origin : "deterministic_rule"));
  return { candidate, assertions, semanticFingerprint: createHash("sha256").update(stable(candidate)).digest("hex"), normalizerVersion: NORMALIZER_VERSION, taxonomyVersion: TAXONOMY_VERSION };
}
