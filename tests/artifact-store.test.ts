import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, mkdir, readdir, rm, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  ArtifactRetentionService,
  LocalArtifactStore,
  artifactStorageKey,
  redactArtifactMetadata,
  requireArtifactDigest,
  sha256,
  type ArtifactRetentionMetadata,
  type RetentionClaim,
} from "../packages/artifact-store/src/index.ts";

const temporaryRoots: string[] = [];

async function temporaryRoot(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "career-os-artifacts-"));
  temporaryRoots.push(root);
  return root;
}

afterEach(async () => {
  await Promise.all(temporaryRoots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe("local content-addressed artifact store", () => {
  test("hashes, atomically stores, verifies, and deduplicates identical bytes", async () => {
    const store = new LocalArtifactStore({ root: await temporaryRoot() });
    const bytes = new TextEncoder().encode("immutable source evidence");
    const first = await store.put(bytes, "text/plain; charset=utf-8");
    const second = await store.put(bytes, "text/plain; charset=utf-8");

    expect(first.digest).toBe(sha256(bytes));
    expect(first.storageKey).toBe(artifactStorageKey(first.digest));
    expect(first.created).toBe(true);
    expect(second.created).toBe(false);
    expect(await store.get(first.digest)).toEqual(bytes);
    expect(await store.list()).toHaveLength(1);
  });

  test("deduplicates concurrent writers without replacing the committed object", async () => {
    const store = new LocalArtifactStore({ root: await temporaryRoot() });
    const bytes = new TextEncoder().encode("concurrent immutable evidence");
    const writes = await Promise.all(Array.from({ length: 8 }, () => store.put(bytes, "text/plain")));
    expect(writes.filter((write) => write.created)).toHaveLength(1);
    expect(new Set(writes.map((write) => write.digest)).size).toBe(1);
    expect(await store.get(writes[0]!.digest)).toEqual(bytes);
  });

  test("accepts only digest-derived keys and rejects traversal and platform path forms", () => {
    for (const value of ["../outside", "..\\outside", "C:\\outside", "/etc/passwd", "A".repeat(64), "a".repeat(63)]) {
      expect(() => requireArtifactDigest(value)).toThrow("artifact digest");
    }
  });

  test("enforces its byte ceiling on both writes and reads", async () => {
    const store = new LocalArtifactStore({ root: await temporaryRoot(), maxBytes: 4 });
    await expect(store.put(new Uint8Array(5), "application/octet-stream")).rejects.toThrow("byte limit");
  });

  test("rejects a symbolic-link component instead of following it outside the root", async () => {
    const root = await temporaryRoot();
    const outside = await temporaryRoot();
    const bytes = new TextEncoder().encode("symlink canary");
    const digest = sha256(bytes);
    await mkdir(join(root, "sha256"), { recursive: true });
    await symlink(outside, join(root, "sha256", digest.slice(0, 2)), "junction");
    const store = new LocalArtifactStore({ root });
    await expect(store.put(bytes, "text/plain")).rejects.toThrow("symbolic link");
    expect(await readdir(outside)).toEqual([]);
  });

  test("removes a staged file when an atomic write is interrupted", async () => {
    const root = await temporaryRoot();
    const store = new LocalArtifactStore({
      root,
      beforeCommit: () => { throw new Error("simulated interruption"); },
    });
    await expect(store.put(new TextEncoder().encode("interrupted"), "text/plain")).rejects.toThrow("simulated interruption");
    expect(await store.list()).toEqual([]);
    const names = await readdir(root, { recursive: true });
    expect(names.some((name) => name.toString().endsWith(".tmp"))).toBe(false);
  });
});

describe("artifact provenance redaction", () => {
  test("removes URL credentials, signed query fields, authorization, cookies, and unsafe headers", () => {
    const canary = "DO-NOT-PERSIST-SECRET";
    const redacted = redactArtifactMetadata({
      canonicalSourceUrl: `https://user:${canary}@example.test/jobs?page=2&token=${canary}&apiKey=${canary}&AWSAccessKeyId=${canary}&redirect=https%3A%2F%2Fother.test%2F%3Fsignature%3D${canary}&X-Amz-Signature=${canary}#private`,
      responseHeaders: {
        Authorization: `Bearer ${canary}`,
        "Set-Cookie": `session=${canary}`,
        "Content-Type": "application/json",
        Location: `https://example.test/next?signature=${canary}&page=3`,
        "X-Debug-Secret": canary,
      },
    });
    const serialized = JSON.stringify(redacted);
    expect(serialized).not.toContain(canary);
    expect(serialized).not.toContain("authorization");
    expect(serialized).not.toContain("set-cookie");
    expect(redacted.canonicalSourceUrl).toBe("https://example.test/jobs?page=2");
    expect(redacted.responseHeaders["content-type"]).toBe("application/json");
    expect(redacted.responseHeaders.location).toBe("https://example.test/next?page=3");
  });
});

class MemoryRetentionMetadata implements ArtifactRetentionMetadata {
  readonly claims: Array<RetentionClaim & { dueAt: Date; state: "present" | "deleting" | "deleted" | "failed" | "missing" }> = [];
  readonly known = new Set<string>();
  readonly present: Array<{ id: string; digest: string }> = [];

  async claimDue(now: Date, limit: number): Promise<RetentionClaim[]> {
    const due = this.claims.filter((row) => row.state === "present" && row.dueAt <= now).slice(0, limit);
    due.forEach((row) => { row.state = "deleting"; });
    return due.map(({ id, digest }) => ({ id, digest }));
  }
  async completeDeletion(id: string): Promise<void> { const row = this.claims.find((item) => item.id === id); if (row) row.state = "deleted"; }
  async failDeletion(id: string): Promise<void> { const row = this.claims.find((item) => item.id === id); if (row) row.state = "failed"; }
  async hasDigest(digest: string): Promise<boolean> { return this.known.has(digest); }
  async listPresentDigests(limit: number): Promise<Array<{ id: string; digest: string }>> { return this.present.slice(0, limit); }
  async markMissing(id: string): Promise<void> { const row = this.claims.find((item) => item.id === id); if (row) row.state = "missing"; }
}

describe("artifact retention and reconciliation", () => {
  test("deletes only clock-due claims and treats an already absent object as reconciled", async () => {
    const store = new LocalArtifactStore({ root: await temporaryRoot() });
    const due = await store.put(new TextEncoder().encode("due"), "text/plain");
    const future = await store.put(new TextEncoder().encode("future"), "text/plain");
    const metadata = new MemoryRetentionMetadata();
    const now = new Date("2026-08-27T12:00:00.000Z");
    metadata.claims.push(
      { id: "due", digest: due.digest, dueAt: new Date(now.getTime() - 1), state: "present" },
      { id: "future", digest: future.digest, dueAt: new Date(now.getTime() + 1), state: "present" },
      { id: "absent", digest: "f".repeat(64), dueAt: new Date(now.getTime() - 1), state: "present" },
    );
    const result = await new ArtifactRetentionService(store, metadata).deleteExpired(now);
    expect(result).toEqual({ deleted: 2, failed: 0 });
    expect(await store.has(due.digest)).toBe(false);
    expect(await store.has(future.digest)).toBe(true);
    expect(metadata.claims.map((row) => row.state)).toEqual(["deleted", "present", "deleted"]);
  });

  test("removes aged orphan bytes and marks metadata whose bytes disappeared", async () => {
    const store = new LocalArtifactStore({ root: await temporaryRoot() });
    const orphan = await store.put(new TextEncoder().encode("orphan"), "text/plain");
    const metadata = new MemoryRetentionMetadata();
    const missingDigest = "e".repeat(64);
    metadata.present.push({ id: "missing", digest: missingDigest });
    metadata.claims.push({ id: "missing", digest: missingDigest, dueAt: new Date(0), state: "present" });
    const result = await new ArtifactRetentionService(store, metadata).reconcile(new Date(Date.now() + 10_000), 0);
    expect(result).toEqual({ orphansDeleted: 1, missingMarked: 1 });
    expect(await store.has(orphan.digest)).toBe(false);
    expect(metadata.claims[0]?.state).toBe("missing");
  });
});
