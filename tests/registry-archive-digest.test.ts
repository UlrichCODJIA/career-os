import { expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { registryArchiveDigest } from "../scripts/registry-archive-digest.ts";

test("registry gate binds the exact approved archive bytes, including formatting", () => {
  const approved = Buffer.from('{"entries":[]}\n');
  const reformatted = Buffer.from('{ "entries": [] }\n');
  expect(registryArchiveDigest(approved)).toBe(createHash("sha256").update(approved).digest("hex"));
  expect(registryArchiveDigest(reformatted)).not.toBe(registryArchiveDigest(approved));
});
