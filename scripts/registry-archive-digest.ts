import { createHash } from "node:crypto";

// The approved pilot digest identifies the exact reviewed JSON archive bytes.
// It is not the digest of a parsed or reserialized manifest.
export function registryArchiveDigest(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}
