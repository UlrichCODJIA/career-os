import { createHash } from "node:crypto";
import { z } from "zod";
import {
  ArtifactViewSchema,
  DetectionResultSchema,
  EnumeratedListingSchema,
  EnumerationResultSchema,
  ParsedListingSchema,
  SourceDescriptorSchema,
  validateConnectorIdentity,
  validateParsedListingEvidence,
  type ArtifactView,
  type EnumeratedListing,
  type SourceConnector,
} from "./contracts.ts";

export const FIXTURE_FORMAT_VERSION = 1 as const;

const FixtureArtifactDescriptorSchema = z.object({
  artifactId: z.string().trim().min(1).max(200),
  path: z.string().regex(/^[a-zA-Z0-9][a-zA-Z0-9._/-]*$/).refine((path) => path.split("/").every((segment) => segment.length > 0 && segment !== "." && segment !== "..") && !path.includes("\\"), "fixture path must be relative and normalized"),
  sourceUrl: z.url().refine((value) => new URL(value).protocol === "https:"),
  contentType: z.string().trim().min(1).max(200),
  fetchedAt: z.iso.datetime({ offset: true }),
}).strict();

const FixtureExpectationSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("result"), value: z.unknown() }).strict(),
  z.object({ kind: z.literal("error"), code: z.string().trim().min(1).max(100) }).strict(),
]);
const FixtureBaseSchema = z.object({ formatVersion: z.literal(1), caseId: z.string().trim().min(1).max(200), expected: FixtureExpectationSchema });
export const FrozenFixtureManifestSchema = z.object({
  formatVersion: z.literal(1),
  connectorId: z.enum(["greenhouse", "lever", "ashby"]),
  connectorVersion: z.string().regex(/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/),
  provenance: z.object({ source: z.string().trim().min(1).max(500), capturedAt: z.iso.datetime({ offset: true }), licenseReviewed: z.literal(true), sanitized: z.literal(true) }).strict(),
  cases: z.array(z.discriminatedUnion("operation", [
    FixtureBaseSchema.extend({ operation: z.literal("detect"), candidateUrl: z.url() }).strict(),
    FixtureBaseSchema.extend({ operation: z.literal("enumeration"), artifacts: z.array(FixtureArtifactDescriptorSchema).min(1).max(100) }).strict(),
    FixtureBaseSchema.extend({ operation: z.literal("listing"), artifacts: z.array(FixtureArtifactDescriptorSchema).min(1).max(100), item: z.unknown() }).strict(),
  ])).min(1).max(1_000),
}).strict().superRefine((manifest, context) => {
  const caseIds = new Set<string>();
  for (const [index, fixture] of manifest.cases.entries()) {
    if (caseIds.has(fixture.caseId)) context.addIssue({ code: "custom", path: ["cases", index, "caseId"], message: "fixture case IDs must be unique" });
    caseIds.add(fixture.caseId);
  }
});
export type FrozenFixtureManifest = z.infer<typeof FrozenFixtureManifestSchema>;

export interface FrozenArtifactFixture {
  readonly artifactId: string;
  readonly sourceUrl: string;
  readonly contentType: string;
  readonly fetchedAt: string;
  readonly bytes: Uint8Array;
}

export type FixtureExpectation =
  | { readonly kind: "result"; readonly value: unknown }
  | { readonly kind: "error"; readonly code: string };

export type FrozenFixtureCase =
  | { readonly formatVersion: 1; readonly caseId: string; readonly operation: "detect"; readonly candidateUrl: string; readonly expected: FixtureExpectation }
  | { readonly formatVersion: 1; readonly caseId: string; readonly operation: "enumeration"; readonly artifacts: readonly FrozenArtifactFixture[]; readonly expected: FixtureExpectation }
  | { readonly formatVersion: 1; readonly caseId: string; readonly operation: "listing"; readonly artifacts: readonly FrozenArtifactFixture[]; readonly item: EnumeratedListing; readonly expected: FixtureExpectation };

export interface FixtureResult {
  readonly caseId: string;
  readonly passed: boolean;
  readonly actual: FixtureExpectation;
  readonly expected: FixtureExpectation;
  readonly differences: readonly ShadowDifference[];
}

export interface ShadowDifference {
  readonly path: string;
  readonly baseline: unknown;
  readonly candidate: unknown;
  readonly kind: "added" | "removed" | "changed";
}

export interface ShadowDiffResult {
  readonly caseId: string;
  readonly changed: boolean;
  readonly differences: readonly ShadowDifference[];
}

function fixtureArtifact(input: FrozenArtifactFixture): ArtifactView {
  return Object.freeze(ArtifactViewSchema.parse({
    artifactId: input.artifactId,
    digest: createHash("sha256").update(input.bytes).digest("hex"),
    contentType: input.contentType,
    sourceUrl: input.sourceUrl,
    fetchedAt: input.fetchedAt,
    bytes: input.bytes.slice(),
  }));
}

export function diffConnectorOutput(baseline: unknown, candidate: unknown, maximumDifferences = 1_000): readonly ShadowDifference[] {
  if (!Number.isSafeInteger(maximumDifferences) || maximumDifferences <= 0 || maximumDifferences > 10_000) throw new TypeError("invalid shadow diff limit");
  const differences: ShadowDifference[] = [];
  const stack: Array<{ baseline: unknown; candidate: unknown; path: string }> = [{ baseline, candidate, path: "$" }];
  const comparedPairs = new WeakMap<object, WeakSet<object>>();
  const maximumNodes = Math.min(1_000_000, Math.max(10_000, maximumDifferences * 1_000));
  let visitedNodes = 0;
  while (stack.length > 0 && differences.length < maximumDifferences) {
    const current = stack.pop()!;
    visitedNodes += 1;
    if (visitedNodes > maximumNodes) {
      differences.push({ path: "$.__diffTraversalLimit", baseline: "traversal_limit", candidate: "traversal_limit", kind: "changed" });
      break;
    }
    if (Object.is(current.baseline, current.candidate)) continue;
    if (current.baseline !== null && current.candidate !== null && typeof current.baseline === "object" && typeof current.candidate === "object") {
      const previouslyCompared = comparedPairs.get(current.baseline);
      if (previouslyCompared?.has(current.candidate)) continue;
      if (previouslyCompared) previouslyCompared.add(current.candidate);
      else comparedPairs.set(current.baseline, new WeakSet([current.candidate]));
    }
    if (Array.isArray(current.baseline) && Array.isArray(current.candidate)) {
      const length = Math.max(current.baseline.length, current.candidate.length);
      for (let index = length - 1; index >= 0; index -= 1) stack.push({ baseline: current.baseline[index], candidate: current.candidate[index], path: `${current.path}[${index}]` });
      continue;
    }
    if (current.baseline !== null && current.candidate !== null && typeof current.baseline === "object" && typeof current.candidate === "object" && !Array.isArray(current.baseline) && !Array.isArray(current.candidate)) {
      const left = current.baseline as Record<string, unknown>;
      const right = current.candidate as Record<string, unknown>;
      const keys = [...new Set([...Object.keys(left), ...Object.keys(right)])].sort().reverse();
      for (const key of keys) {
        const childPath = /^[A-Za-z_$][A-Za-z0-9_$]*$/.test(key) ? `${current.path}.${key}` : `${current.path}[${JSON.stringify(key)}]`;
        stack.push({ baseline: left[key], candidate: right[key], path: childPath });
      }
      continue;
    }
    differences.push({ path: current.path, baseline: current.baseline, candidate: current.candidate, kind: current.baseline === undefined ? "added" : current.candidate === undefined ? "removed" : "changed" });
  }
  return differences;
}

export async function runFrozenFixture(connector: SourceConnector, fixture: FrozenFixtureCase): Promise<FixtureResult> {
  validateConnectorIdentity(connector);
  if (fixture.formatVersion !== FIXTURE_FORMAT_VERSION || !fixture.caseId || fixture.caseId.length > 200) throw new TypeError("unsupported fixture format");
  let actual: FixtureExpectation;
  try {
    let value: unknown;
    if (fixture.operation === "detect") {
      const detection = DetectionResultSchema.parse(await connector.detect(new URL(fixture.candidateUrl)));
      if (detection.connectorId !== connector.id) throw new TypeError("connector_identity_mismatch");
      value = detection;
    } else if (fixture.operation === "enumeration") {
      const enumeration = EnumerationResultSchema.parse(await connector.parseEnumeration(fixture.artifacts.map(fixtureArtifact)));
      if (enumeration.connectorVersion !== connector.version) throw new TypeError("connector_version_mismatch");
      value = enumeration;
    } else {
      const artifacts = fixture.artifacts.map(fixtureArtifact);
      const item = EnumeratedListingSchema.parse(fixture.item);
      const listing = ParsedListingSchema.parse(await connector.parseListing(artifacts, item));
      validateParsedListingEvidence(listing, artifacts);
      value = listing;
    }
    actual = { kind: "result", value };
  } catch (error) {
    const code = error !== null && typeof error === "object" && "code" in error && typeof error.code === "string"
      ? error.code
      : error instanceof Error ? error.name : "unknown_error";
    actual = { kind: "error", code };
  }
  const differences = diffConnectorOutput(fixture.expected, actual);
  return { caseId: fixture.caseId, passed: differences.length === 0, actual, expected: fixture.expected, differences };
}

export async function runShadowDiff(baseline: SourceConnector, candidate: SourceConnector, fixtures: readonly FrozenFixtureCase[]): Promise<readonly ShadowDiffResult[]> {
  if (baseline.id !== candidate.id) throw new TypeError("shadow connectors must implement the same connector ID");
  if (baseline.version === candidate.version) throw new TypeError("shadow connector versions must differ");
  const results: ShadowDiffResult[] = [];
  for (const fixture of fixtures) {
    const ignored: FixtureExpectation = { kind: "result", value: undefined };
    const baselineResult = await runFrozenFixture(baseline, { ...fixture, expected: ignored } as FrozenFixtureCase);
    const candidateResult = await runFrozenFixture(candidate, { ...fixture, expected: ignored } as FrozenFixtureCase);
    const differences = diffConnectorOutput(baselineResult.actual, candidateResult.actual);
    results.push({ caseId: fixture.caseId, changed: differences.length > 0, differences });
  }
  return results;
}

export function validateSourceDescriptor(input: unknown) {
  return SourceDescriptorSchema.parse(input);
}
