export const COMPANY_RESOLVER_VERSION = "1.0.0";

export type CompanyIdentityKeyType = "verified_domain" | "ats_tenant" | "verified_alias";

export interface CompanyIdentityKey {
  type: CompanyIdentityKeyType;
  value: string;
  evidenceId: string;
  confidence: number;
}

export interface CompanyIdentityCandidate {
  id: string;
  displayName: string;
  legalName?: string;
  keys: CompanyIdentityKey[];
}

export interface IncomingCompanyIdentity {
  displayName: string;
  legalName?: string;
  keys: CompanyIdentityKey[];
}

export interface RankedCompanyCandidate {
  companyId: string;
  displayName: string;
  exactKeyTypes: CompanyIdentityKeyType[];
  nameScore: number;
  confidence: number;
  evidenceIds: string[];
}

export type CompanyResolution =
  | { action: "automatic_match"; companyId: string; confidence: number; reason: string; evidenceIds: string[]; resolverVersion: string }
  | { action: "create_new"; confidence: number; reason: string; evidenceIds: string[]; resolverVersion: string }
  | { action: "review"; reason: string; candidates: RankedCompanyCandidate[]; resolverVersion: string };

const priority: Record<CompanyIdentityKeyType, number> = {
  verified_domain: 3,
  ats_tenant: 2,
  verified_alias: 1,
};

function cleanText(value: string): string {
  return value.normalize("NFKC").replace(/[\u0000-\u001f\u007f\u061c\u200e\u200f\u202a-\u202e\u2066-\u2069\ufeff]/gu, " ").trim();
}

export function normalizeCompanyName(value: string): string {
  return cleanText(value)
    .toLocaleLowerCase("und")
    .normalize("NFD")
    .replace(/([\p{Script=Latin}])\p{M}+/gu, "$1")
    .normalize("NFC")
    .replace(/[^\p{L}\p{N}]+/gu, " ")
    .trim()
    .replace(/\s+/g, " ");
}

export function normalizeCompanyIdentityKey(type: CompanyIdentityKeyType, value: string): string {
  const cleaned = cleanText(value);
  if (type === "verified_domain") {
    const parsed = new URL(`https://${cleaned.replace(/\.$/u, "")}`);
    if (parsed.username || parsed.password || parsed.port || parsed.pathname !== "/" || parsed.search || parsed.hash) {
      throw new Error("verified domains must be host names only");
    }
    const host = parsed.hostname.toLowerCase();
    if (!host || host === "localhost" || !host.includes(".")) throw new Error("invalid verified domain");
    return host;
  }
  if (type === "ats_tenant") {
    const parts = cleaned.toLowerCase().split(":");
    if (parts.length !== 3 || parts.some((part) => !/^[a-z0-9][a-z0-9._-]{0,127}$/u.test(part))) {
      throw new Error("ATS tenant keys must be connector:region:tenant");
    }
    return parts.join(":");
  }
  return normalizeCompanyName(cleaned);
}

function bigrams(value: string): Set<string> {
  const normalized = ` ${normalizeCompanyName(value)} `;
  const result = new Set<string>();
  for (let index = 0; index < normalized.length - 1; index += 1) result.add(normalized.slice(index, index + 2));
  return result;
}

export function companyNameScore(left: string, right: string): number {
  const leftSet = bigrams(left);
  const rightSet = bigrams(right);
  if (leftSet.size === 0 || rightSet.size === 0) return 0;
  let intersection = 0;
  for (const token of leftSet) if (rightSet.has(token)) intersection += 1;
  return Number(((2 * intersection) / (leftSet.size + rightSet.size)).toFixed(4));
}

function validKeys(keys: CompanyIdentityKey[]): Array<CompanyIdentityKey & { normalized: string }> {
  return keys
    .filter((key) => key.confidence >= 0.9 && key.confidence <= 1 && key.evidenceId.length > 0)
    .map((key) => ({ ...key, normalized: normalizeCompanyIdentityKey(key.type, key.value) }));
}

export function resolveCompanyIdentity(
  incoming: IncomingCompanyIdentity,
  companies: CompanyIdentityCandidate[],
): CompanyResolution {
  const incomingKeys = validKeys(incoming.keys);
  const ranked: RankedCompanyCandidate[] = companies.map((company) => {
    const companyKeys = validKeys(company.keys);
    const matches = incomingKeys.flatMap((incomingKey) => companyKeys
      .filter((key) => key.type === incomingKey.type && key.normalized === incomingKey.normalized)
      .map((key) => ({ type: key.type, confidence: Math.min(key.confidence, incomingKey.confidence), evidence: [incomingKey.evidenceId, key.evidenceId] })));
    const exactKeyTypes = [...new Set(matches.map((match) => match.type))].sort((a, b) => priority[b] - priority[a]);
    const strongest = matches.sort((a, b) => priority[b.type] - priority[a.type] || b.confidence - a.confidence)[0];
    return {
      companyId: company.id,
      displayName: company.displayName,
      exactKeyTypes,
      nameScore: Math.max(companyNameScore(incoming.displayName, company.displayName), company.legalName ? companyNameScore(incoming.displayName, company.legalName) : 0),
      confidence: strongest?.confidence ?? 0,
      evidenceIds: [...new Set(matches.flatMap((match) => match.evidence))].sort(),
    };
  }).sort((left, right) => {
    const leftPriority = priority[left.exactKeyTypes[0] ?? "verified_alias"] * Number(left.exactKeyTypes.length > 0);
    const rightPriority = priority[right.exactKeyTypes[0] ?? "verified_alias"] * Number(right.exactKeyTypes.length > 0);
    return rightPriority - leftPriority || right.confidence - left.confidence || right.nameScore - left.nameScore || left.companyId.localeCompare(right.companyId);
  });

  for (const type of ["verified_domain", "ats_tenant", "verified_alias"] as const) {
    const matches = ranked.filter((candidate) => candidate.exactKeyTypes.includes(type));
    if (matches.length > 1) return { action: "review", reason: `ambiguous_${type}`, candidates: ranked.slice(0, 10), resolverVersion: COMPANY_RESOLVER_VERSION };
    if (matches.length === 1) {
      const conflicts = ranked.filter((candidate) => candidate.companyId !== matches[0]!.companyId && candidate.exactKeyTypes.length > 0);
      if (conflicts.length > 0) return { action: "review", reason: "conflicting_exact_evidence", candidates: ranked.slice(0, 10), resolverVersion: COMPANY_RESOLVER_VERSION };
      return {
        action: "automatic_match",
        companyId: matches[0]!.companyId,
        confidence: matches[0]!.confidence,
        reason: `exact_${type}`,
        evidenceIds: matches[0]!.evidenceIds,
        resolverVersion: COMPANY_RESOLVER_VERSION,
      };
    }
  }

  const similar = ranked.filter((candidate) => candidate.nameScore >= 0.65).slice(0, 10);
  if (similar.length > 0) return { action: "review", reason: "name_similarity_requires_review", candidates: similar, resolverVersion: COMPANY_RESOLVER_VERSION };
  if (incomingKeys.some((key) => key.type === "verified_domain" || key.type === "ats_tenant")) {
    return {
      action: "create_new",
      confidence: Math.max(...incomingKeys.map((key) => key.confidence)),
      reason: "unclaimed_exact_identity",
      evidenceIds: [...new Set(incomingKeys.map((key) => key.evidenceId))].sort(),
      resolverVersion: COMPANY_RESOLVER_VERSION,
    };
  }
  return { action: "review", reason: "insufficient_exact_evidence", candidates: ranked.slice(0, 10), resolverVersion: COMPANY_RESOLVER_VERSION };
}
