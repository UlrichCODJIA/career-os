import { describe, expect, test } from "bun:test";
import { readFile } from "node:fs/promises";
import { join } from "node:path";

const root = join(import.meta.dir, "..");

describe("repository foundation", () => {
  test("pins the approved license and toolchain", async () => {
    const manifest = JSON.parse(await readFile(join(root, "package.json"), "utf8"));
    expect(manifest.private).toBe(true);
    expect(manifest.license).toBe("AGPL-3.0-or-later");
    expect(manifest.packageManager).toBe("bun@1.3.14");
  });

  test("does not depend on either legacy repository", async () => {
    const manifest = await readFile(join(root, "package.json"), "utf8");
    expect(manifest).not.toContain("ai-job-search-dashboard");
    expect(manifest).not.toContain("MadsLorentzen/ai-job-search");
    expect(manifest).not.toContain("file:");
    expect(manifest).not.toContain("link:");
  });

  test("documents security policy and module direction", async () => {
    const security = await readFile(join(root, "SECURITY.md"), "utf8");
    const boundaries = await readFile(join(root, "docs/architecture/module-boundaries.md"), "utf8");
    expect(security).toContain("External content is always handled as untrusted data");
    expect(boundaries).toContain("Dependencies point inward");
  });
});
