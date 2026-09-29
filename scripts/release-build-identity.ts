import { execFileSync } from "node:child_process";
import { readFile } from "node:fs/promises";
import { join } from "node:path";

const COMMIT_PATTERN = /^[a-f0-9]{40}$/;

export async function deployedReleaseCommit(root: string): Promise<string> {
  try {
    const head = execFileSync("git", ["rev-parse", "HEAD"], {
      cwd: root,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    }).trim();
    if (!COMMIT_PATTERN.test(head)) throw new Error("invalid Git release commit");
    return head;
  } catch {
    // Production images exclude .git. Their build must bind the archived commit.
    const marker = (await readFile(join(root, ".release-commit"), "utf8")).trim();
    if (!COMMIT_PATTERN.test(marker)) throw new Error("deployed image has no valid release commit marker");
    return marker;
  }
}
