export const OPPORTUNITY_RESOLVER_VERSION = "1.0.0";

export interface RequisitionEvidenceKey {
  kind: "employer_requisition_id" | "connector_mapping";
  value: string;
  evidenceId: string;
}

export interface OpportunityListingCandidate {
  sourceListingId: string;
  companyId: string;
  normalizedTitle: string;
  descriptionFingerprint: string;
  locationSignature: string;
  activeFrom: string;
  activeUntil?: string;
  requisitionKeys: RequisitionEvidenceKey[];
}

export interface ExistingOpportunityCandidate {
  opportunityId: string;
  companyId: string;
  sourceListingIds: string[];
  normalizedTitle: string;
  descriptionFingerprint: string;
  locationSignature: string;
  activeFrom: string;
  activeUntil?: string;
  requisitionKeys: RequisitionEvidenceKey[];
}

export type OpportunityResolution =
  | { action: "existing_member"; opportunityId: string; reason: "source_listing_identity"; confidence: 1; resolverVersion: string }
  | { action: "automatic_match"; opportunityId: string; reason: "exact_requisition_key" | "exact_content_interval"; confidence: number; evidenceIds: string[]; resolverVersion: string }
  | { action: "create_new"; reason: "no_candidate"; confidence: 1; resolverVersion: string }
  | { action: "review"; reason: string; candidateOpportunityIds: string[]; resolverVersion: string };

function instant(value: string): number {
  const result = Date.parse(value);
  if (!Number.isFinite(result)) throw new Error("invalid_active_interval");
  return result;
}

function overlaps(left: OpportunityListingCandidate, right: ExistingOpportunityCandidate): boolean {
  const leftStart = instant(left.activeFrom);
  const rightStart = instant(right.activeFrom);
  const leftEnd = left.activeUntil ? instant(left.activeUntil) : Number.POSITIVE_INFINITY;
  const rightEnd = right.activeUntil ? instant(right.activeUntil) : Number.POSITIVE_INFINITY;
  if (leftEnd < leftStart || rightEnd < rightStart) throw new Error("invalid_active_interval");
  return leftStart <= rightEnd && rightStart <= leftEnd;
}

function key(value: RequisitionEvidenceKey): string {
  const normalized = value.value.normalize("NFKC").trim().toLocaleLowerCase("und");
  if (!normalized || normalized.length > 256 || !value.evidenceId) throw new Error("invalid_requisition_evidence");
  return `${value.kind}:${normalized}`;
}

function titleTokens(value: string): Set<string> {
  return new Set(value.normalize("NFKC").toLocaleLowerCase("und").split(/[^\p{L}\p{N}]+/u).filter(Boolean));
}

export function titleSimilarity(left: string, right: string): number {
  const a = titleTokens(left);
  const b = titleTokens(right);
  if (a.size === 0 || b.size === 0) return 0;
  let common = 0;
  for (const item of a) if (b.has(item)) common += 1;
  return Number((common / (a.size + b.size - common)).toFixed(4));
}

export function resolveOpportunity(
  listing: OpportunityListingCandidate,
  opportunities: ExistingOpportunityCandidate[],
): OpportunityResolution {
  const existingMember = opportunities.find((candidate) => candidate.sourceListingIds.includes(listing.sourceListingId));
  if (existingMember) return { action: "existing_member", opportunityId: existingMember.opportunityId, reason: "source_listing_identity", confidence: 1, resolverVersion: OPPORTUNITY_RESOLVER_VERSION };

  const sameCompany = opportunities.filter((candidate) => candidate.companyId === listing.companyId);
  const listingKeys = new Map(listing.requisitionKeys.map((item) => [key(item), item]));
  const exact = sameCompany.flatMap((candidate) => candidate.requisitionKeys.flatMap((item) => {
    const incoming = listingKeys.get(key(item));
    return incoming ? [{ candidate, evidenceIds: [incoming.evidenceId, item.evidenceId].sort() }] : [];
  }));
  const exactIds = [...new Set(exact.map((match) => match.candidate.opportunityId))].sort();
  if (exactIds.length > 1) return { action: "review", reason: "ambiguous_requisition_key", candidateOpportunityIds: exactIds, resolverVersion: OPPORTUNITY_RESOLVER_VERSION };
  if (exactIds.length === 1) {
    const match = exact.find((item) => item.candidate.opportunityId === exactIds[0])!;
    return { action: "automatic_match", opportunityId: exactIds[0]!, reason: "exact_requisition_key", confidence: 1,
      evidenceIds: [...new Set(match.evidenceIds)], resolverVersion: OPPORTUNITY_RESOLVER_VERSION };
  }

  const contentMatches = sameCompany.filter((candidate) => candidate.normalizedTitle === listing.normalizedTitle
    && candidate.descriptionFingerprint === listing.descriptionFingerprint
    && candidate.locationSignature === listing.locationSignature && overlaps(listing, candidate));
  if (contentMatches.length > 1) return { action: "review", reason: "ambiguous_exact_content", candidateOpportunityIds: contentMatches.map((item) => item.opportunityId).sort(), resolverVersion: OPPORTUNITY_RESOLVER_VERSION };
  if (contentMatches.length === 1) return { action: "automatic_match", opportunityId: contentMatches[0]!.opportunityId,
    reason: "exact_content_interval", confidence: 0.97, evidenceIds: [], resolverVersion: OPPORTUNITY_RESOLVER_VERSION };

  const near = sameCompany.filter((candidate) => titleSimilarity(listing.normalizedTitle, candidate.normalizedTitle) >= 0.6)
    .map((candidate) => candidate.opportunityId).sort();
  if (near.length > 0) return { action: "review", reason: "title_similarity_without_strong_evidence", candidateOpportunityIds: near, resolverVersion: OPPORTUNITY_RESOLVER_VERSION };
  return { action: "create_new", reason: "no_candidate", confidence: 1, resolverVersion: OPPORTUNITY_RESOLVER_VERSION };
}

export type OpportunityFieldPath = "/displayTitle" | "/normalizedTitle" | "/descriptionText" | "/workplaceType"
  | "/employmentType" | "/canonicalSourceUrl" | "/applyUrl";

export interface OpportunityFieldAssertion {
  assertionId: string;
  sourceListingId: string;
  listingVersionId: string;
  fieldPath: OpportunityFieldPath;
  value: unknown;
  origin: "source_field" | "source_text" | "deterministic_rule" | "model_derived" | "human_review";
  confidence: number;
  reviewState: "unreviewed" | "accepted" | "rejected";
  artifactId?: string;
}

export interface OpportunityProjection {
  fields: Record<string, unknown>;
  provenance: Record<string, { selectedAssertionId: string; assertionIds: string[] }>;
  resolverVersion: string;
}

const required = ["/displayTitle", "/normalizedTitle", "/descriptionText", "/workplaceType", "/canonicalSourceUrl", "/applyUrl"] as const;
const originRank: Record<OpportunityFieldAssertion["origin"], number> = {
  human_review: 5, source_field: 4, source_text: 3, deterministic_rule: 2, model_derived: 1,
};

export function projectOpportunity(assertions: OpportunityFieldAssertion[]): OpportunityProjection {
  const usable = assertions.filter((item) => item.reviewState !== "rejected" && Number.isFinite(item.confidence)
    && item.confidence >= 0 && item.confidence <= 1 && item.assertionId && item.listingVersionId && item.sourceListingId);
  const fields: Record<string, unknown> = {};
  const provenance: OpportunityProjection["provenance"] = {};
  for (const path of [...new Set(usable.map((item) => item.fieldPath))].sort()) {
    const candidates = usable.filter((item) => item.fieldPath === path).sort((left, right) =>
      Number(right.reviewState === "accepted") - Number(left.reviewState === "accepted")
      || right.confidence - left.confidence || originRank[right.origin] - originRank[left.origin]
      || left.sourceListingId.localeCompare(right.sourceListingId) || left.assertionId.localeCompare(right.assertionId));
    const selected = candidates[0];
    if (!selected) continue;
    fields[path.slice(1)] = selected.value;
    provenance[path] = { selectedAssertionId: selected.assertionId, assertionIds: candidates.map((item) => item.assertionId) };
  }
  for (const path of required) if (!(path in provenance)) throw new Error(`missing_opportunity_assertion:${path}`);
  return { fields, provenance, resolverVersion: OPPORTUNITY_RESOLVER_VERSION };
}
