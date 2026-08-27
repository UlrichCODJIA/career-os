import { describe, expect, test } from "bun:test";
import { validateMigrationCandidates } from "../scripts/verify-migrations.ts";
import { validateWorkflowPolicy } from "../scripts/verify-workflows.ts";
import { readFile } from "node:fs/promises";
import { join } from "node:path";

const root = join(import.meta.dir, "..");

describe("delivery policy", () => {
  test("accepts a contiguous forward-only migration sequence", () => {
    expect(
      validateMigrationCandidates([
        { name: "0001_create_registry.sql", content: "CREATE TABLE registry (id text PRIMARY KEY);", isFile: true, isSymbolicLink: false },
        { name: "0002_add_policy.sql", content: "ALTER TABLE registry ADD COLUMN policy text;", isFile: true, isSymbolicLink: false },
      ]),
    ).toEqual([]);
  });

  test("rejects gaps, unsafe SQL, unexpected names, and symlinks", () => {
    const failures = validateMigrationCandidates([
      { name: "0002_gap.sql", content: "DROP DATABASE career_os;", isFile: true, isSymbolicLink: false },
      { name: "manual.sql", content: "SELECT 1;", isFile: true, isSymbolicLink: false },
      { name: "0003_link.sql", content: "SELECT 1;", isFile: false, isSymbolicLink: true },
    ]);
    expect(failures.some((failure) => failure.includes("expected 0001"))).toBe(true);
    expect(failures.some((failure) => failure.includes("prohibited SQL"))).toBe(true);
    expect(failures.some((failure) => failure.includes("must match"))).toBe(true);
    expect(failures.some((failure) => failure.includes("non-symlink"))).toBe(true);
  });

  test("rejects mutable actions, repository secrets, and pull-request provenance", async () => {
    const ci = await readFile(join(root, ".github", "workflows", "ci.yml"), "utf8");
    const provenance = await readFile(join(root, ".github", "workflows", "provenance.yml"), "utf8");
    const unsafeCi = ci
      .replace("actions/checkout@3d3c42e5aac5ba805825da76410c181273ba90b1", "actions/checkout@v7")
      .concat("\n# ${{ secrets.PRODUCTION_TOKEN }}\npull_request_target:\n");
    const unsafeProvenance = provenance.concat("\npull_request:\n");
    const failures = validateWorkflowPolicy(unsafeCi, unsafeProvenance);
    expect(failures.some((failure) => failure.includes("mutable"))).toBe(true);
    expect(failures.some((failure) => failure.includes("repository secrets"))).toBe(true);
    expect(failures.some((failure) => failure.includes("pull_request_target"))).toBe(true);
    expect(failures.some((failure) => failure.includes("after merge to main"))).toBe(true);
  });

  test("requires the attestation job to use the exact protected-main ref", async () => {
    const ci = await readFile(join(root, ".github", "workflows", "ci.yml"), "utf8");
    const provenance = await readFile(join(root, ".github", "workflows", "provenance.yml"), "utf8");
    const unguarded = provenance.replace("    if: github.ref == 'refs/heads/main'\n", "");
    const ambiguous = provenance.replace("github.ref == 'refs/heads/main'", "github.ref_name == 'main'");

    expect(validateWorkflowPolicy(ci, provenance)).toEqual([]);
    expect(validateWorkflowPolicy(ci, unguarded).some((failure) => failure.includes("exact protected-main ref"))).toBe(true);
    expect(validateWorkflowPolicy(ci, ambiguous).some((failure) => failure.includes("exact protected-main ref"))).toBe(true);
  });
});
