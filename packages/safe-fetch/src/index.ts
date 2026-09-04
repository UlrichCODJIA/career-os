import { createHash } from "node:crypto";
import { lookup as dnsLookup } from "node:dns/promises";
import { brotliDecompressSync, gunzipSync, inflateSync } from "node:zlib";
import { isIP } from "node:net";
import { isPublicAddress } from "./ip.ts";
import { NodeSafeFetchTransport, type SafeFetchTransport, type TransportResponse } from "./node-transport.ts";

export { isPublicAddress, sameAddress } from "./ip.ts";
export type { SafeFetchTransport, TransportRequest, TransportResponse } from "./node-transport.ts";

export interface SafeFetchPolicy {
  readonly id: string;
  readonly allowedHosts: readonly string[];
  readonly allowedContentTypes: readonly string[];
  readonly maxRequestsPerMinute: number;
  readonly maxConcurrency: number;
  readonly maxRedirects: number;
  readonly timeoutMs: number;
  readonly maxWireBytes: number;
  readonly maxResponseBytes: number;
  readonly userAgent: string;
}

export interface SafeFetchRequest {
  readonly url: URL;
  readonly policy: SafeFetchPolicy;
  readonly accept?: string;
  readonly etag?: string;
  readonly modifiedSince?: string;
}

export type SafeFetchOutcome = "allowed" | "blocked" | "failed" | "redirected" | "succeeded";

export interface SafeFetchDecision {
  readonly policyId: string;
  readonly hop: number;
  readonly timestamp: string;
  readonly scheme: string;
  readonly hostname: string;
  readonly port: string;
  readonly pathHash: string;
  readonly resolvedAddresses: readonly string[];
  readonly selectedAddress?: string;
  readonly status?: number;
  readonly outcome: SafeFetchOutcome;
  readonly reason: string;
}

export interface SafeFetchResult {
  readonly bytes: Uint8Array;
  readonly contentType: string;
  readonly finalUrl: URL;
  readonly status: number;
  readonly headers: Readonly<Record<string, string>>;
  readonly decisions: readonly SafeFetchDecision[];
}

export interface SafeFetchPort {
  fetch(request: SafeFetchRequest): Promise<SafeFetchResult>;
}

export interface SafeFetchClientOptions {
  readonly transport?: SafeFetchTransport;
  readonly resolve?: (hostname: string) => Promise<readonly { address: string; family: 4 | 6 }[]>;
  readonly onDecision?: (decision: SafeFetchDecision) => void;
  readonly now?: () => number;
  readonly wait?: (milliseconds: number) => Promise<void>;
}

export class SafeFetchError extends Error {
  constructor(readonly code: string, readonly decisions: readonly SafeFetchDecision[]) {
    super(`Safe fetch rejected: ${code}`);
    this.name = "SafeFetchError";
  }
}

interface Budget { window: number; count: number; active: number }

const HARD_LIMITS = {
  requestsPerMinute: 10_000,
  concurrency: 100,
  redirects: 10,
  timeoutMs: 60_000,
  wireBytes: 50 * 1024 * 1024,
  responseBytes: 100 * 1024 * 1024,
} as const;

function hostAllowed(hostname: string, allowedHosts: readonly string[]): boolean {
  const host = hostname.toLowerCase().replace(/\.$/, "");
  return allowedHosts.some((entry) => {
    const rule = entry.toLowerCase().replace(/\.$/, "");
    return rule.startsWith("*.") ? host.endsWith(rule.slice(1)) && host !== rule.slice(2) : host === rule;
  });
}

function pathHash(url: URL): string {
  return createHash("sha256").update(url.pathname).digest("hex").slice(0, 16);
}

function contentType(headers: Readonly<Record<string, string>>): string {
  return (headers["content-type"] ?? "").split(";", 1)[0]!.trim().toLowerCase();
}

function failureCode(error: unknown): string {
  if (error instanceof SafeFetchError) return error.code;
  if (error instanceof Error && ["wire_limit_exceeded", "decoded_limit_exceeded", "unsupported_content_encoding", "remote_address_mismatch", "request_aborted", "request_timeout"].includes(error.message)) return error.message;
  return "transport_failure";
}

function awaitWithAbort<T>(operation: Promise<T>, signal: AbortSignal): Promise<T> {
  return new Promise((resolve, reject) => {
    const abort = () => reject(new Error("request_aborted"));
    if (signal.aborted) {
      abort();
      return;
    }
    signal.addEventListener("abort", abort, { once: true });
    operation.then(
      (value) => { signal.removeEventListener("abort", abort); resolve(value); },
      (error: unknown) => { signal.removeEventListener("abort", abort); reject(error); },
    );
  });
}

function decode(response: TransportResponse, maximum: number): Uint8Array {
  const encoding = (response.headers["content-encoding"] ?? "identity").toLowerCase().trim();
  try {
    const options = { maxOutputLength: maximum };
    const result = encoding === "gzip" ? gunzipSync(response.body, options)
      : encoding === "deflate" ? inflateSync(response.body, options)
      : encoding === "br" ? brotliDecompressSync(response.body, options)
      : encoding === "identity" || encoding === "" ? response.body
      : (() => { throw new Error("unsupported_content_encoding"); })();
    if (result.byteLength > maximum) throw new Error("decoded_limit_exceeded");
    return result;
  } catch (error) {
    if (error instanceof Error && error.message === "unsupported_content_encoding") throw error;
    throw new Error("decoded_limit_exceeded");
  }
}

function safeHeaders(response: TransportResponse): Readonly<Record<string, string>> {
  const output: Record<string, string> = {};
  for (const name of ["content-type", "etag", "last-modified", "cache-control"]) {
    const value = response.headers[name];
    if (value !== undefined) output[name] = value;
  }
  return output;
}

export class SafeFetchClient implements SafeFetchPort {
  private readonly transport: SafeFetchTransport;
  private readonly resolveHost: NonNullable<SafeFetchClientOptions["resolve"]>;
  private readonly emit: (decision: SafeFetchDecision) => void;
  private readonly now: () => number;
  private readonly wait: (milliseconds: number) => Promise<void>;
  private readonly budgets = new Map<string, Budget>();

  constructor(options: SafeFetchClientOptions = {}) {
    this.transport = options.transport ?? new NodeSafeFetchTransport();
    this.resolveHost = options.resolve ?? (async (hostname) => {
      const answers = await dnsLookup(hostname, { all: true, verbatim: true });
      return answers.filter((answer): answer is { address: string; family: 4 | 6 } => answer.family === 4 || answer.family === 6);
    });
    this.emit = options.onDecision ?? (() => undefined);
    this.now = options.now ?? Date.now;
    this.wait = options.wait ?? ((milliseconds) => Bun.sleep(milliseconds));
  }

  async fetch(request: SafeFetchRequest): Promise<SafeFetchResult> {
    const decisions: SafeFetchDecision[] = [];
    const policy = request.policy;
    this.validatePolicy(policy);
    const budget = await this.acquire(policy, decisions);
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), policy.timeoutMs);
    try {
      let current = new URL(request.url.href);
      for (let hop = 0; hop <= policy.maxRedirects; hop += 1) {
        const base = { policyId: policy.id, hop, timestamp: new Date(this.now()).toISOString(), scheme: current.protocol, hostname: current.hostname.toLowerCase(), port: current.port || "443", pathHash: pathHash(current) };
        try {
          this.validateUrl(current, policy);
          const answers = await awaitWithAbort(this.resolveHost(current.hostname), controller.signal);
          const addresses = [...new Set(answers.map((answer) => answer.address))].sort();
          if (addresses.length === 0) throw new SafeFetchError("dns_no_answers", decisions);
          if (answers.some((answer) => !isPublicAddress(answer.address))) throw new SafeFetchError("dns_non_public_answer", decisions);
          const selected = answers.slice().sort((a, b) => a.address.localeCompare(b.address))[0]!;
          this.record(decisions, { ...base, resolvedAddresses: addresses, selectedAddress: selected.address, outcome: "allowed", reason: "policy_and_dns_allowed" });
          const response = await this.transport.request({
            url: current,
            address: selected.address,
            family: selected.family,
            headers: this.requestHeaders(request, policy),
            timeoutMs: policy.timeoutMs,
            maxWireBytes: policy.maxWireBytes,
            signal: controller.signal,
          });
          const location = response.headers.location;
          if ([301, 302, 303, 307, 308].includes(response.status) && location) {
            if (hop === policy.maxRedirects) throw new SafeFetchError("redirect_limit_exceeded", decisions);
            this.record(decisions, { ...base, resolvedAddresses: addresses, selectedAddress: selected.address, status: response.status, outcome: "redirected", reason: "redirect_revalidation_required" });
            current = new URL(location, current);
            continue;
          }
          if (response.status === 304) {
            this.record(decisions, { ...base, resolvedAddresses: addresses, selectedAddress: selected.address, status: response.status, outcome: "succeeded", reason: "not_modified" });
            return { bytes: new Uint8Array(), contentType: "", finalUrl: current, status: response.status, headers: safeHeaders(response), decisions };
          }
          if (response.status < 200 || response.status >= 300) throw new SafeFetchError("upstream_status_rejected", decisions);
          const type = contentType(response.headers);
          if (!policy.allowedContentTypes.map((item) => item.toLowerCase()).includes(type)) throw new SafeFetchError("content_type_rejected", decisions);
          const bytes = decode(response, policy.maxResponseBytes);
          this.record(decisions, { ...base, resolvedAddresses: addresses, selectedAddress: selected.address, status: response.status, outcome: "succeeded", reason: "response_allowed" });
          return { bytes, contentType: type, finalUrl: current, status: response.status, headers: safeHeaders(response), decisions };
        } catch (error) {
          const code = failureCode(error);
          if (decisions.at(-1)?.hop !== hop || decisions.at(-1)?.outcome !== "blocked") {
            this.record(decisions, { ...base, resolvedAddresses: [], outcome: code.startsWith("request_") || code === "transport_failure" ? "failed" : "blocked", reason: code });
          }
          throw new SafeFetchError(code, decisions);
        }
      }
      throw new SafeFetchError("redirect_limit_exceeded", decisions);
    } finally {
      clearTimeout(timer);
      budget.active -= 1;
    }
  }

  private validatePolicy(policy: SafeFetchPolicy): void {
    const positive = [policy.maxRequestsPerMinute, policy.maxConcurrency, policy.timeoutMs, policy.maxWireBytes, policy.maxResponseBytes];
    const hostsValid = policy.allowedHosts.every((rule) => /^(?:\*\.)?[a-z0-9](?:[a-z0-9.-]{0,251}[a-z0-9])?$/i.test(rule) && !rule.includes("..") && isIP(rule.replace(/^\*\./, "")) === 0);
    const contentTypesValid = policy.allowedContentTypes.every((type) => /^[a-z0-9!#$&^_.+-]+\/[a-z0-9!#$&^_.+-]+$/i.test(type));
    const exceedsHardLimit = policy.maxRequestsPerMinute > HARD_LIMITS.requestsPerMinute
      || policy.maxConcurrency > HARD_LIMITS.concurrency
      || policy.maxRedirects > HARD_LIMITS.redirects
      || policy.timeoutMs > HARD_LIMITS.timeoutMs
      || policy.maxWireBytes > HARD_LIMITS.wireBytes
      || policy.maxResponseBytes > HARD_LIMITS.responseBytes;
    if (!policy.id || policy.id.length > 128 || policy.allowedHosts.length === 0 || policy.allowedHosts.length > 100 || !hostsValid || policy.allowedContentTypes.length === 0 || policy.allowedContentTypes.length > 32 || !contentTypesValid || !this.validHeaderValue(policy.userAgent) || positive.some((value) => !Number.isSafeInteger(value) || value <= 0) || !Number.isSafeInteger(policy.maxRedirects) || policy.maxRedirects < 0 || exceedsHardLimit) {
      throw new SafeFetchError("invalid_policy", []);
    }
  }

  private validateUrl(url: URL, policy: SafeFetchPolicy): void {
    if (url.protocol !== "https:") throw new SafeFetchError("https_required", []);
    if (url.username || url.password) throw new SafeFetchError("credentials_forbidden", []);
    if (url.hash) throw new SafeFetchError("fragment_forbidden", []);
    if (isIP(url.hostname.replace(/^\[|\]$/g, "")) !== 0) throw new SafeFetchError("literal_ip_forbidden", []);
    if (!hostAllowed(url.hostname, policy.allowedHosts)) throw new SafeFetchError("host_not_allowed", []);
    if (url.port && url.port !== "443") throw new SafeFetchError("port_not_allowed", []);
  }

  private requestHeaders(request: SafeFetchRequest, policy: SafeFetchPolicy): Record<string, string> {
    for (const value of [request.accept, request.etag, request.modifiedSince]) {
      if (value !== undefined && !this.validHeaderValue(value)) throw new SafeFetchError("invalid_header_value", []);
    }
    const headers: Record<string, string> = { "accept-encoding": "gzip, deflate, br", "user-agent": policy.userAgent };
    if (request.accept) headers.accept = request.accept;
    if (request.etag) headers["if-none-match"] = request.etag;
    if (request.modifiedSince) headers["if-modified-since"] = request.modifiedSince;
    return headers;
  }

  private validHeaderValue(value: string): boolean {
    return value.length > 0 && value.length <= 1_024 && !/[\r\n\0]/.test(value);
  }

  private async acquire(policy: SafeFetchPolicy, decisions: SafeFetchDecision[]): Promise<Budget> {
    for (;;) {
      const current = this.now();
      const window = Math.floor(current / 60_000);
      let budget = this.budgets.get(policy.id);
      if (!budget || budget.window !== window) {
        budget = { window, count: 0, active: 0 };
        this.budgets.set(policy.id, budget);
      }
      if (budget.active >= policy.maxConcurrency) throw new SafeFetchError("concurrency_limit_exceeded", decisions);
      if (budget.count < policy.maxRequestsPerMinute) {
        budget.count += 1;
        budget.active += 1;
        return budget;
      }
      await this.wait((window + 1) * 60_000 - current + 1);
    }
  }

  private record(decisions: SafeFetchDecision[], decision: SafeFetchDecision): void {
    decisions.push(decision);
    try { this.emit(decision); } catch { /* Observability must never alter fetch policy. */ }
  }
}
