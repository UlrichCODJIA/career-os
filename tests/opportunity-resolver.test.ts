import { describe, expect, test } from "bun:test";
import { projectOpportunity, resolveOpportunity, type ExistingOpportunityCandidate, type OpportunityFieldAssertion, type OpportunityListingCandidate } from "../packages/opportunity-resolver/src/index.ts";

const listing: OpportunityListingCandidate = {
  sourceListingId: "00000000-0000-7000-8000-000000000001", companyId: "00000000-0000-7000-8000-000000000010",
  normalizedTitle: "senior platform engineer", descriptionFingerprint: "description-a", locationSignature: "remote:US",
  activeFrom: "2026-01-01T00:00:00Z", requisitionKeys: [{ kind: "employer_requisition_id", value: "REQ-42", evidenceId: "incoming-req" }],
};
const opportunity: ExistingOpportunityCandidate = {
  opportunityId: "00000000-0000-7000-8000-000000000020", companyId: listing.companyId,
  sourceListingIds: [], normalizedTitle: listing.normalizedTitle, descriptionFingerprint: listing.descriptionFingerprint,
  locationSignature: listing.locationSignature, activeFrom: "2025-12-20T00:00:00Z",
  requisitionKeys: [{ kind: "employer_requisition_id", value: "req-42", evidenceId: "existing-req" }],
};

describe("opportunity clustering", () => {
  test("keeps exact source membership above every clustering rule", () => {
    expect(resolveOpportunity(listing, [{ ...opportunity, sourceListingIds: [listing.sourceListingId] }])).toMatchObject({ action: "existing_member", confidence: 1 });
  });
  test("automatically matches one verified-company requisition key", () => {
    expect(resolveOpportunity(listing, [opportunity])).toMatchObject({ action: "automatic_match", reason: "exact_requisition_key", opportunityId: opportunity.opportunityId });
  });
  test("never crosses company identity even with the same requisition key", () => {
    expect(resolveOpportunity(listing, [{ ...opportunity, companyId: "00000000-0000-7000-8000-000000000099" }])).toMatchObject({ action: "create_new" });
  });
  test("queues duplicate strong keys and title-only near collisions", () => {
    const duplicate = { ...opportunity, opportunityId: "00000000-0000-7000-8000-000000000021" };
    expect(resolveOpportunity(listing, [opportunity, duplicate])).toMatchObject({ action: "review", reason: "ambiguous_requisition_key" });
    const titleOnly = { ...opportunity, requisitionKeys: [], descriptionFingerprint: "different", locationSignature: "onsite:GB" };
    expect(resolveOpportunity({ ...listing, requisitionKeys: [] }, [titleOnly])).toMatchObject({ action: "review", reason: "title_similarity_without_strong_evidence" });
  });
  test("matches exact content only with equivalent location and overlapping interval", () => {
    expect(resolveOpportunity({ ...listing, requisitionKeys: [] }, [{ ...opportunity, requisitionKeys: [] }])).toMatchObject({ action: "automatic_match", reason: "exact_content_interval" });
    expect(resolveOpportunity({ ...listing, requisitionKeys: [], activeFrom: "2026-01-01T00:00:00Z" }, [{ ...opportunity, requisitionKeys: [], activeFrom: "2025-01-01T00:00:00Z", activeUntil: "2025-12-01T00:00:00Z" }])).toMatchObject({ action: "review" });
  });
});

describe("deterministic evidence projection", () => {
  const base: OpportunityFieldAssertion[] = [
    ["/displayTitle", "Platform Engineer"], ["/normalizedTitle", "platform engineer"], ["/descriptionText", "Build systems"],
    ["/workplaceType", "remote"], ["/canonicalSourceUrl", "https://example.test/jobs/1"], ["/applyUrl", "https://example.test/jobs/1/apply"],
  ].map(([fieldPath, value], index) => ({ assertionId: `a-${index}`, sourceListingId: "listing-a", listingVersionId: "version-a",
    fieldPath: fieldPath as OpportunityFieldAssertion["fieldPath"], value, origin: "source_field", confidence: 1, reviewState: "unreviewed", artifactId: "artifact-a" }));
  test("selects fields deterministically and retains all alternatives", () => {
    const alternative = { ...base[0]!, assertionId: "a-reviewed", sourceListingId: "listing-b", value: "Senior Platform Engineer", origin: "human_review" as const, reviewState: "accepted" as const, confidence: 0.9 };
    const left = projectOpportunity([...base, alternative]);
    const right = projectOpportunity([alternative, ...base].reverse());
    expect(left).toEqual(right);
    expect(left.fields.displayTitle).toBe("Senior Platform Engineer");
    expect(left.provenance["/displayTitle"]?.assertionIds).toHaveLength(2);
  });
  test("fails closed when a displayed field has no retained assertion", () => {
    expect(() => projectOpportunity(base.filter((item) => item.fieldPath !== "/applyUrl"))).toThrow("missing_opportunity_assertion:/applyUrl");
  });
});
