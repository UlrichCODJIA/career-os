import { afterEach, expect, test } from "bun:test";
import { execFileSync } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { deployedReleaseCommit } from "../scripts/release-build-identity.ts";

const temporaryDirectories: string[] = [];

afterEach(async () => {
  for (const directory of temporaryDirectories.splice(0)) {
    await rm(directory, { force: true, recursive: true });
  }
});

test("production image uses only a full pinned commit marker when Git metadata is absent", async () => {
  const directory = await mkdtemp(join(tmpdir(), "career-os-release-marker-"));
  temporaryDirectories.push(directory);
  const marker = join(directory, ".release-commit");
  const commit = "a".repeat(40);

  await writeFile(marker, `${commit}\n`);
  expect(await deployedReleaseCommit(directory)).toBe(commit);

  await writeFile(marker, "unbound\n");
  await expect(deployedReleaseCommit(directory)).rejects.toThrow("no valid release commit marker");

  await rm(marker);
  await expect(deployedReleaseCommit(directory)).rejects.toThrow();
});

test("a source checkout derives its commit from Git, not an injected marker", async () => {
  const directory = await mkdtemp(join(tmpdir(), "career-os-release-git-"));
  temporaryDirectories.push(directory);
  execFileSync("git", ["init", "-q", directory]);
  execFileSync("git", ["-c", "user.name=Career OS Test", "-c", "user.email=test@example.invalid",
    "commit", "--allow-empty", "-qm", "fixture"], { cwd: directory });
  await writeFile(join(directory, ".release-commit"), `${"b".repeat(40)}\n`);
  const head = execFileSync("git", ["rev-parse", "HEAD"], { cwd: directory, encoding: "utf8" }).trim();
  expect(await deployedReleaseCommit(directory)).toBe(head);
});
