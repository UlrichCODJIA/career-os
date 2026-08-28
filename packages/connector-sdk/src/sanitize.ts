import { decodeArtifact, type ParseLimits, DEFAULT_PARSE_LIMITS } from "./bounded.ts";

export interface SanitizedContent {
  readonly text: string;
  readonly html: string;
  readonly truncated: boolean;
}

const ENTITY: Readonly<Record<string, string>> = Object.freeze({ amp: "&", lt: "<", gt: ">", quot: "\"", apos: "'", nbsp: " " });

function decodeEntities(value: string): string {
  return value.replace(/&(?:#(\d+)|#x([a-f0-9]+)|([a-z]+));/gi, (match, decimal: string | undefined, hex: string | undefined, named: string | undefined) => {
    const code = decimal ? Number(decimal) : hex ? Number.parseInt(hex, 16) : undefined;
    if (code !== undefined && Number.isSafeInteger(code) && code > 0 && code <= 0x10ffff && !(code >= 0xd800 && code <= 0xdfff)) return String.fromCodePoint(code);
    return named ? (ENTITY[named.toLowerCase()] ?? match) : match;
  });
}

function escapeHtml(value: string): string {
  return value.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;").replaceAll("\"", "&quot;").replaceAll("'", "&#39;");
}

export function sanitizeUntrustedHtml(bytes: Uint8Array, limits: ParseLimits = DEFAULT_PARSE_LIMITS): SanitizedContent {
  const input = decodeArtifact(bytes, limits);
  const chunks: string[] = [];
  let textLength = 0;
  let index = 0;
  const suppressed: Array<"script" | "style"> = [];
  const append = (value: string) => {
    if (value.length === 0 || textLength > limits.maxStringLength) return;
    chunks.push(value);
    textLength += value.length;
  };
  while (index < input.length) {
    if (input[index] !== "<") {
      if (suppressed.length === 0) append(input[index]!);
      index += 1;
      continue;
    }
    const close = input.indexOf(">", index + 1);
    if (close === -1) {
      if (suppressed.length === 0) append(input.slice(index));
      break;
    }
    const token = input.slice(index + 1, close).trim().toLowerCase();
    const closing = token.startsWith("/");
    const name = token.replace(/^\//, "").split(/[\s/]/, 1)[0];
    if (name === "script" || name === "style") {
      if (closing) {
        const matching = suppressed.lastIndexOf(name);
        if (matching >= 0) suppressed.splice(matching, 1);
      } else if (!token.endsWith("/")) {
        suppressed.push(name);
      }
    } else if (suppressed.length === 0 && (closing || name === "br") && ["p", "div", "li", "h1", "h2", "h3", "h4", "br"].includes(name ?? "")) {
      append("\n");
    }
    index = close + 1;
    if (textLength > limits.maxStringLength) break;
  }
  const normalized = decodeEntities(chunks.join("")).replace(/\r\n?/g, "\n").replace(/[\t ]+/g, " ").replace(/\n{3,}/g, "\n\n").trim();
  const truncated = normalized.length > limits.maxStringLength;
  const bounded = truncated ? normalized.slice(0, limits.maxStringLength) : normalized;
  return { text: bounded, html: escapeHtml(bounded).replaceAll("\n", "<br>"), truncated };
}
