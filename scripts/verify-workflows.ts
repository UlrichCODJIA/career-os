import { readFile } from "node:fs/promises";
import { join } from "node:path";

const root = join(import.meta.dir, "..");
export function validateWorkflowPolicy(ci: string, provenance: string): string[] {
  const failures: string[] = [];

  for (const [label, workflow] of [["CI", ci], ["provenance", provenance]] as const) {
    try {
      Bun.YAML.parse(workflow);
    } catch (error) {
      failures.push(`${label} workflow is invalid YAML: ${error instanceof Error ? error.message : String(error)}`);
    }
    if (/uses:\s+[^\s@]+@(?![0-9a-f]{40}(?:\s|$))/m.test(workflow)) {
      failures.push(`${label} workflow contains a mutable or malformed action reference`);
    }
    if (workflow.includes("pull_request_target")) failures.push(`${label} workflow must not use pull_request_target`);
    if (/secrets\.[A-Za-z0-9_]+/.test(workflow)) failures.push(`${label} workflow must not consume repository secrets`);
  }

  for (const check of [
    "Validate repository baseline",
    "Validate migrations",
    "Scan repository secrets",
    "Review dependency changes",
    "Generate SBOM",
  ]) {
    if (!ci.includes(`name: ${check}`)) failures.push(`CI workflow is missing check: ${check}`);
  }

  if (!ci.includes("permissions:\n  contents: read")) failures.push("CI workflow must default to contents: read");
  if (!ci.includes("github.event_name == 'pull_request'")) failures.push("dependency review must be pull-request scoped");
  if (!provenance.includes("branches: [main]") || provenance.includes("pull_request:")) {
    failures.push("provenance workflow must run only after merge to main or manual dispatch");
  }
  try {
    const parsed = Bun.YAML.parse(provenance) as { jobs?: { attest?: { if?: unknown } } };
    if (parsed.jobs?.attest?.if !== "github.ref == 'refs/heads/main'") {
      failures.push("provenance attest job must require the exact protected-main ref");
    }
  } catch {
    // Invalid YAML is reported by the shared syntax check above.
  }
  for (const permission of ["contents: read", "id-token: write", "attestations: write"]) {
    if (!provenance.includes(permission)) failures.push(`provenance workflow is missing permission: ${permission}`);
  }

  return failures;
}

export async function verifyWorkflows(): Promise<void> {
  const ci = await readFile(join(root, ".github", "workflows", "ci.yml"), "utf8");
  const provenance = await readFile(join(root, ".github", "workflows", "provenance.yml"), "utf8");
  const failures = validateWorkflowPolicy(ci, provenance);
  if (failures.length > 0) {
    console.error("Workflow policy verification failed:");
    for (const failure of failures) console.error(`- ${failure}`);
    process.exit(1);
  }

  console.log("Workflow policy verified: pull requests are secretless and actions are immutable; attestation is main-only.");
}

if (import.meta.main) await verifyWorkflows();
