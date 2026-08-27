import { describe, expect, test } from "bun:test";
import { gzipSync } from "node:zlib";
import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import {
  SafeFetchClient,
  SafeFetchError,
  isPublicAddress,
  sameAddress,
  type SafeFetchDecision,
  type SafeFetchPolicy,
  type SafeFetchTransport,
  type TransportRequest,
  type TransportResponse,
} from "../packages/safe-fetch/src/index.ts";
import * as safeFetchExports from "../packages/safe-fetch/src/index.ts";

const policy: SafeFetchPolicy = {
  id: "test-careers",
  allowedHosts: ["careers.example.com", "*.ats.example.com"],
  allowedContentTypes: ["text/html", "application/json"],
  maxRequestsPerMinute: 20,
  maxConcurrency: 2,
  maxRedirects: 2,
  timeoutMs: 500,
  maxWireBytes: 1_024,
  maxResponseBytes: 2_048,
  userAgent: "CareerOS-Test/1.0",
};

function response(overrides: Partial<TransportResponse> = {}): TransportResponse {
  return {
    status: 200,
    headers: { "content-type": "text/html; charset=utf-8" },
    body: new TextEncoder().encode("jobs"),
    remoteAddress: "93.184.216.34",
    ...overrides,
  };
}

class FakeTransport implements SafeFetchTransport {
  readonly requests: TransportRequest[] = [];
  constructor(private readonly responder: (request: TransportRequest, index: number) => Promise<TransportResponse> | TransportResponse = () => response()) {}
  async request(request: TransportRequest): Promise<TransportResponse> {
    this.requests.push(request);
    return this.responder(request, this.requests.length - 1);
  }
}

function client(
  transport = new FakeTransport(),
  decisions: SafeFetchDecision[] = [],
  resolve: (hostname: string) => Promise<readonly { address: string; family: 4 | 6 }[]> = async () => [{ address: "93.184.216.34", family: 4 }],
): SafeFetchClient {
  return new SafeFetchClient({ transport, resolve, onDecision: (decision) => decisions.push(decision), now: () => 1_700_000_000_000 });
}

async function expectCode(promise: Promise<unknown>, code: string): Promise<SafeFetchError> {
  try {
    await promise;
    throw new Error("expected rejection");
  } catch (error) {
    expect(error).toBeInstanceOf(SafeFetchError);
    expect((error as SafeFetchError).code).toBe(code);
    return error as SafeFetchError;
  }
}

describe("safe fetch address policy", () => {
  test("rejects private, loopback, link-local, metadata, documentation, multicast, and special IPv6 space", () => {
    for (const address of [
      "0.0.0.0", "10.0.0.1", "100.64.0.1", "127.0.0.1", "169.254.169.254", "172.16.0.1",
      "192.168.1.1", "192.0.2.1", "198.51.100.1", "203.0.113.1", "224.0.0.1", "255.255.255.255",
      "::", "::1", "fc00::1", "fe80::1", "ff02::1", "2001:10::1", "2001:20::1", "2001:30::1", "2001:db8::1", "2002:7f00:1::",
    ]) expect(isPublicAddress(address)).toBe(false);
    expect(isPublicAddress("8.8.8.8")).toBe(true);
    expect(isPublicAddress("2606:4700:4700::1111")).toBe(true);
    expect(sameAddress("2606:4700:4700:0:0:0:0:1111", "2606:4700:4700::1111")).toBe(true);
  });

  test("rejects literal and encoded IP URLs before transport", async () => {
    for (const raw of ["https://127.0.0.1/jobs", "https://2130706433/jobs", "https://[::1]/jobs"]) {
      const transport = new FakeTransport();
      await expectCode(client(transport).fetch({ url: new URL(raw), policy }), "literal_ip_forbidden");
      expect(transport.requests).toHaveLength(0);
    }
  });

  test("rejects an entire DNS answer set if any result is non-public", async () => {
    const transport = new FakeTransport();
    const fetcher = client(transport, [], async () => [
      { address: "93.184.216.34", family: 4 },
      { address: "169.254.169.254", family: 4 },
    ]);
    await expectCode(fetcher.fetch({ url: new URL("https://careers.example.com/jobs"), policy }), "dns_non_public_answer");
    expect(transport.requests).toHaveLength(0);
  });
});

describe("safe fetch hop enforcement", () => {
  test("pins transport to the prevalidated DNS address and re-resolves every redirect", async () => {
    const transport = new FakeTransport((_request, index) => index === 0
      ? response({ status: 302, headers: { location: "https://tenant.ats.example.com/openings" } })
      : response({ headers: { "content-type": "application/json" }, body: new TextEncoder().encode("[]") }));
    const hosts: string[] = [];
    const fetcher = client(transport, [], async (host) => {
      hosts.push(host);
      return [{ address: host.startsWith("tenant") ? "1.1.1.1" : "93.184.216.34", family: 4 }];
    });
    const result = await fetcher.fetch({ url: new URL("https://careers.example.com/jobs?token=secret"), policy });
    expect(hosts).toEqual(["careers.example.com", "tenant.ats.example.com"]);
    expect(transport.requests.map((request) => request.address)).toEqual(["93.184.216.34", "1.1.1.1"]);
    expect(result.finalUrl.hostname).toBe("tenant.ats.example.com");
    expect(result.decisions.map((decision) => decision.outcome)).toEqual(["allowed", "redirected", "allowed", "succeeded"]);
  });

  test("blocks a redirect outside the host allowlist before resolving or connecting", async () => {
    const transport = new FakeTransport(() => response({ status: 302, headers: { location: "https://evil.example.net/steal" } }));
    const hosts: string[] = [];
    const fetcher = client(transport, [], async (host) => { hosts.push(host); return [{ address: "93.184.216.34", family: 4 }]; });
    await expectCode(fetcher.fetch({ url: new URL("https://careers.example.com/jobs"), policy }), "host_not_allowed");
    expect(hosts).toEqual(["careers.example.com"]);
    expect(transport.requests).toHaveLength(1);
  });

  test("rejects credentials, fragments, plaintext HTTP, and non-TLS ports", async () => {
    const cases: Array<[string, string]> = [
      ["https://user:pass@careers.example.com/jobs", "credentials_forbidden"],
      ["https://careers.example.com/jobs#secret", "fragment_forbidden"],
      ["http://careers.example.com/jobs", "https_required"],
      ["https://careers.example.com:8443/jobs", "port_not_allowed"],
    ];
    for (const [raw, code] of cases) await expectCode(client().fetch({ url: new URL(raw), policy }), code);
  });
});

describe("safe fetch resource and telemetry controls", () => {
  test("does not inherit proxy credentials or expose arbitrary request headers", async () => {
    const previous = process.env.HTTPS_PROXY;
    process.env.HTTPS_PROXY = "http://proxy-user:proxy-canary@127.0.0.1:3128";
    try {
      const transport = new FakeTransport();
      await client(transport).fetch({ url: new URL("https://careers.example.com/jobs"), policy, accept: "text/html", etag: "etag-1" });
      expect(transport.requests[0]!.headers).toEqual({
        "accept-encoding": "gzip, deflate, br",
        "user-agent": "CareerOS-Test/1.0",
        accept: "text/html",
        "if-none-match": "etag-1",
      });
      expect(JSON.stringify(transport.requests[0])).not.toContain("proxy-canary");
    } finally {
      if (previous === undefined) delete process.env.HTTPS_PROXY;
      else process.env.HTTPS_PROXY = previous;
    }
  });

  test("supports conditional rechecks without requiring a response body", async () => {
    const transport = new FakeTransport(() => response({ status: 304, headers: { etag: "current" }, body: new Uint8Array() }));
    const result = await client(transport).fetch({ url: new URL("https://careers.example.com/jobs"), policy, etag: "previous" });
    expect(result.status).toBe(304);
    expect(result.bytes).toHaveLength(0);
    expect(result.headers).toEqual({ etag: "current" });
  });

  test("caps decompressed responses and rejects unknown encodings and content types", async () => {
    const bomb = gzipSync(Buffer.alloc(10_000, 65));
    const strict = { ...policy, maxWireBytes: bomb.byteLength + 10, maxResponseBytes: 100 };
    await expectCode(client(new FakeTransport(() => response({ headers: { "content-type": "text/html", "content-encoding": "gzip" }, body: bomb }))).fetch({ url: new URL("https://careers.example.com"), policy: strict }), "decoded_limit_exceeded");
    await expectCode(client(new FakeTransport(() => response({ headers: { "content-type": "text/html", "content-encoding": "compress" } }))).fetch({ url: new URL("https://careers.example.com"), policy }), "unsupported_content_encoding");
    await expectCode(client(new FakeTransport(() => response({ headers: { "content-type": "image/svg+xml" } }))).fetch({ url: new URL("https://careers.example.com"), policy }), "content_type_rejected");
  });

  test("applies a whole-operation timeout and concurrency limit", async () => {
    const stalled = new FakeTransport((request) => new Promise((_resolve, reject) => request.signal.addEventListener("abort", () => reject(new Error("request_aborted")), { once: true })));
    const fetcher = client(stalled);
    const short = { ...policy, timeoutMs: 10, maxConcurrency: 1 };
    const first = fetcher.fetch({ url: new URL("https://careers.example.com/one"), policy: short });
    await expectCode(fetcher.fetch({ url: new URL("https://careers.example.com/two"), policy: short }), "concurrency_limit_exceeded");
    await expectCode(first, "request_aborted");
  });

  test("stops awaiting DNS at the whole-operation deadline", async () => {
    const transport = new FakeTransport();
    const neverResolvingDns = new Promise<readonly { address: string; family: 4 | 6 }[]>(() => undefined);
    const fetcher = client(transport, [], () => neverResolvingDns);
    await expectCode(fetcher.fetch({ url: new URL("https://careers.example.com/jobs"), policy: { ...policy, timeoutMs: 10 } }), "request_aborted");
    expect(transport.requests).toHaveLength(0);
  });

  test("rejects policy values that exceed library hard ceilings", async () => {
    await expectCode(client().fetch({ url: new URL("https://careers.example.com"), policy: { ...policy, maxResponseBytes: 101 * 1024 * 1024 } }), "invalid_policy");
    await expectCode(client().fetch({ url: new URL("https://careers.example.com"), policy: { ...policy, allowedHosts: ["*.127.0.0.1"] } }), "invalid_policy");
    await expectCode(client().fetch({ url: new URL("https://careers.example.com"), policy: { ...policy, allowedContentTypes: ["not a media type"] } }), "invalid_policy");
  });

  test("emits redacted decisions without query strings, credentials, proxy data, or paths", async () => {
    const decisions: SafeFetchDecision[] = [];
    const result = await client(new FakeTransport(), decisions).fetch({ url: new URL("https://careers.example.com/sensitive/path?api_key=query-canary"), policy });
    const serialized = JSON.stringify([...decisions, ...result.decisions]);
    for (const canary of ["query-canary", "api_key", "sensitive", "proxy", "password", "user:"]) expect(serialized).not.toContain(canary);
    expect(decisions.every((decision) => /^[a-f0-9]{16}$/.test(decision.pathHash))).toBe(true);
  });
});

async function sourceFiles(root: string): Promise<string[]> {
  const output: string[] = [];
  for (const entry of await readdir(root, { withFileTypes: true })) {
    const path = join(root, entry.name);
    if (entry.isDirectory()) output.push(...await sourceFiles(path));
    else if (entry.name.endsWith(".ts")) output.push(path);
  }
  return output;
}

test("connectors remain pure and cannot acquire ambient network authority", async () => {
  expect(safeFetchExports).not.toHaveProperty("NodeSafeFetchTransport");
  for (const relative of ["../packages/connectors/src", "../packages/connector-sdk/src"]) {
    for (const path of await sourceFiles(join(import.meta.dir, relative))) {
      const source = await readFile(path, "utf8");
      expect(source).not.toMatch(/\bfetch\s*\(/);
      expect(source).not.toMatch(/node:(?:http|https|net|tls|dns)/);
      expect(source).not.toContain("@career-os/safe-fetch");
    }
  }
});
