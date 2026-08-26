import { lstat, readFile } from "node:fs/promises";
import { join } from "node:path";

const root = join(import.meta.dir, "..");

const requiredFiles = [
  "LICENSE",
  "README.md",
  "SECURITY.md",
  "CONTRIBUTING.md",
  "CODE_OF_CONDUCT.md",
  ".github/CODEOWNERS",
  ".github/workflows/ci.yml",
  "docs/architecture/module-boundaries.md",
  "docs/security/threat-model.md",
  "docs/reference-sources.md",
  "docs/development/local-profile.md",
  "docs/security/deployment-profiles.md",
  "compose.yaml",
  "Dockerfile",
  ".env.example",
  "docs/architecture/decisions/0001-create-career-os-monorepo.md",
  "docs/architecture/decisions/0002-use-postgresql-for-record-queue-and-search.md",
  "docs/architecture/decisions/0003-use-content-addressed-artifacts.md",
  "docs/architecture/decisions/0004-separate-local-and-hosted-profiles.md",
  "docs/architecture/decisions/0005-separate-shared-and-private-data.md",
  "docs/architecture/decisions/0006-defer-generic-browser-rendering.md",
] as const;

const requiredDirectories = [
  "apps/web",
  "apps/api",
  "apps/worker",
  "packages/contracts",
  "packages/db",
  "packages/discovery-domain",
  "packages/connector-sdk",
  "packages/connectors",
  "packages/model-gateway",
  "packages/agent-runtime",
  "packages/safe-fetch",
  "packages/artifact-store",
  "packages/observability",
  "db/migrations",
  "db/seeds",
  "tests/fixtures",
  "tests/integration",
  "tests/e2e",
] as const;

const failures: string[] = [];

for (const relativePath of requiredFiles) {
  try {
    const stats = await lstat(join(root, relativePath));
    if (!stats.isFile()) failures.push(`${relativePath} must be a regular file`);
  } catch {
    failures.push(`${relativePath} is missing`);
  }
}

for (const relativePath of requiredDirectories) {
  try {
    const stats = await lstat(join(root, relativePath));
    if (!stats.isDirectory()) failures.push(`${relativePath} must be a directory`);
    if (stats.isSymbolicLink()) failures.push(`${relativePath} must not be a symlink`);
  } catch {
    failures.push(`${relativePath} is missing`);
  }
}

const packageJson = JSON.parse(await readFile(join(root, "package.json"), "utf8")) as {
  license?: string;
  packageManager?: string;
  private?: boolean;
  workspaces?: string[];
};

if (packageJson.private !== true) failures.push("root package must remain private");
if (packageJson.license !== "AGPL-3.0-or-later") failures.push("root license must be AGPL-3.0-or-later");
if (packageJson.packageManager !== "bun@1.3.14") failures.push("Bun version must be pinned to 1.3.14");
if (JSON.stringify(packageJson.workspaces) !== JSON.stringify(["apps/*", "packages/*"])) {
  failures.push("workspaces must be exactly apps/* and packages/*");
}

const dependencyFiles = ["package.json", "bun.lock"] as const;
for (const relativePath of dependencyFiles) {
  const content = await readFile(join(root, relativePath), "utf8");
  for (const prohibited of ["ai-job-search-dashboard", "MadsLorentzen/ai-job-search", "file:", "link:"]) {
    if (content.includes(prohibited)) failures.push(`${relativePath} contains prohibited runtime reference: ${prohibited}`);
  }
}

for (const workspace of [...requiredDirectories.filter((path) => path.startsWith("apps/")), ...requiredDirectories.filter((path) => path.startsWith("packages/"))]) {
  try {
    const manifest = JSON.parse(await readFile(join(root, workspace, "package.json"), "utf8")) as {
      name?: string;
      private?: boolean;
      exports?: string;
    };
    if (!manifest.name?.startsWith("@career-os/")) failures.push(`${workspace} must use the @career-os package scope`);
    if (manifest.private !== true) failures.push(`${workspace} must remain private`);
    if (workspace.startsWith("packages/") && manifest.exports !== "./src/index.ts") {
      failures.push(`${workspace} must expose only its public src/index.ts entry point`);
    }
  } catch {
    failures.push(`${workspace}/package.json is missing or invalid`);
  }
}

const exampleEnvironment = await readFile(join(root, ".env.example"), "utf8");
for (const marker of ["sk-", "ghp_", "AKIA", "BEGIN PRIVATE KEY"]) {
  if (exampleEnvironment.includes(marker)) failures.push(`.env.example contains a secret-like marker: ${marker}`);
}

for (const relativePath of requiredFiles.filter((path) => path.includes("/decisions/"))) {
  const content = await readFile(join(root, relativePath), "utf8");
  for (const section of ["## Context", "## Decision", "## Rejected alternatives", "## Consequences", "## Review trigger"]) {
    if (!content.includes(section)) failures.push(`${relativePath} is missing ${section}`);
  }
}

if (failures.length > 0) {
  console.error("Repository-boundary verification failed:");
  for (const failure of failures) console.error(`- ${failure}`);
  process.exit(1);
}

console.log(`Repository boundary verified: ${requiredFiles.length} files and ${requiredDirectories.length} directories.`);
