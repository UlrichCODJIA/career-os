export interface ParseLimits {
  readonly maxBytes: number;
  readonly maxDepth: number;
  readonly maxNodes: number;
  readonly maxStringLength: number;
}

export const DEFAULT_PARSE_LIMITS: ParseLimits = Object.freeze({
  maxBytes: 5 * 1024 * 1024,
  maxDepth: 64,
  maxNodes: 250_000,
  maxStringLength: 1_000_000,
});

export class BoundedParseError extends Error {
  constructor(readonly code: "byte_limit" | "invalid_utf8" | "invalid_json" | "depth_limit" | "node_limit" | "string_limit") {
    super(`Bounded parse rejected: ${code}`);
    this.name = "BoundedParseError";
  }
}

export function decodeArtifact(bytes: Uint8Array, limits: ParseLimits = DEFAULT_PARSE_LIMITS): string {
  validateLimits(limits);
  if (bytes.byteLength > limits.maxBytes) throw new BoundedParseError("byte_limit");
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    throw new BoundedParseError("invalid_utf8");
  }
}

export function parseBoundedJson(bytes: Uint8Array, limits: ParseLimits = DEFAULT_PARSE_LIMITS): unknown {
  const text = decodeArtifact(bytes, limits);
  let parsed: unknown;
  try { parsed = JSON.parse(text); } catch { throw new BoundedParseError("invalid_json"); }
  const stack: Array<{ value: unknown; depth: number }> = [{ value: parsed, depth: 0 }];
  let nodes = 0;
  while (stack.length > 0) {
    const current = stack.pop()!;
    nodes += 1;
    if (nodes > limits.maxNodes) throw new BoundedParseError("node_limit");
    if (current.depth > limits.maxDepth) throw new BoundedParseError("depth_limit");
    if (typeof current.value === "string" && current.value.length > limits.maxStringLength) throw new BoundedParseError("string_limit");
    if (Array.isArray(current.value)) {
      for (const value of current.value) stack.push({ value, depth: current.depth + 1 });
    } else if (current.value !== null && typeof current.value === "object") {
      for (const [key, value] of Object.entries(current.value)) {
        if (key.length > limits.maxStringLength) throw new BoundedParseError("string_limit");
        stack.push({ value, depth: current.depth + 1 });
      }
    }
  }
  return parsed;
}

function validateLimits(limits: ParseLimits): void {
  for (const value of Object.values(limits)) {
    if (!Number.isSafeInteger(value) || value <= 0) throw new TypeError("parse limits must be positive safe integers");
  }
  if (limits.maxBytes > 50 * 1024 * 1024 || limits.maxDepth > 256 || limits.maxNodes > 1_000_000 || limits.maxStringLength > 5_000_000) {
    throw new TypeError("parse limits exceed SDK hard ceilings");
  }
}
