import { afterEach, describe, expect, test } from "bun:test";
import type { RuntimeConfig } from "../packages/contracts/src/index.ts";
import { createWebServer } from "../apps/web/src/server.ts";
import { shellHtml, shellScript, shellStyles } from "../apps/web/src/shell.ts";
import { operatorHtml, operatorScript, operatorStyles } from "../apps/web/src/operator-shell.ts";
import { operatorSummaryScript } from "../apps/web/src/operator-summary.ts";

const servers: Array<{ stop(closeActiveConnections?: boolean): void }> = [];
const config: RuntimeConfig = {
  profile: "test",
  host: "127.0.0.1",
  port: 0,
  artifactRoot: "./artifacts",
  security: {
    networkBoundary: "loopback",
    localOnly: true,
    publicBaseUrl: "http://127.0.0.1:4100",
    allowedOrigins: ["http://127.0.0.1:4100"],
    authenticationMode: "local",
    transportSecurity: "none",
    trustedProxyIps: [],
  },
};

function localProxyConfig(port: number): RuntimeConfig {
  return {
    ...config,
    profile: "local",
    host: "127.0.0.1",
    port,
    security: {
      ...config.security,
      networkBoundary: "container-loopback",
      publicBaseUrl: `http://127.0.0.1:${port}`,
      allowedOrigins: [`http://127.0.0.1:${port}`],
      authenticationMode: "bearer",
      operatorToken: "local-operator-token-that-stays-server-side",
    },
  };
}

function availablePort(): number {
  const reservation = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: () => new Response() });
  const port = reservation.port!;
  reservation.stop(true);
  return port;
}

afterEach(() => {
  for (const server of servers.splice(0)) server.stop(true);
});

describe("canonical Discovery web surface", () => {
  test("serves external assets under a restrictive CSP", async () => {
    const server = createWebServer(config, "http://127.0.0.1:4999");
    servers.push(server);
    const base = `http://127.0.0.1:${server.port}`;
    const [page, styles, script] = await Promise.all([
      fetch(`${base}/`),
      fetch(`${base}/styles.css`),
      fetch(`${base}/app.js`),
    ]);

    const csp = page.headers.get("content-security-policy") ?? "";
    expect(csp).toContain("default-src 'none'");
    expect(csp).toContain("style-src 'self'");
    expect(csp).toContain("script-src 'self'");
    expect(csp).toContain("connect-src 'self' http://127.0.0.1:4999");
    expect(csp).not.toContain("unsafe-inline");
    expect(styles.headers.get("x-content-type-options")).toBe("nosniff");
    expect(script.headers.get("x-content-type-options")).toBe("nosniff");
  });

  test("proxies the local API without exposing its bearer token to the browser", async () => {
    let observed: { authorization: string | null; origin: string | null; cookie: string | null; extra: string | null; path: string } | undefined;
    const upstream = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch(request) {
      observed = {
        authorization: request.headers.get("authorization"), origin: request.headers.get("origin"),
        cookie: request.headers.get("cookie"), extra: request.headers.get("x-extra"), path: new URL(request.url).pathname,
      };
      return Response.json({ ok: true });
    } });
    servers.push(upstream);
    const token = "local-operator-token-that-stays-server-side";
    const port = availablePort();
    const proxyConfig = localProxyConfig(port);
    const server = createWebServer(proxyConfig, "http://127.0.0.1:4999", {
      upstreamBaseUrl: `http://127.0.0.1:${upstream.port}`,
      bearerToken: token,
    });
    servers.push(server);
    const base = `http://127.0.0.1:${server.port}`;
    const response = await fetch(`${base}/api/v1/opportunities?limit=25`, {
      headers: { origin: proxyConfig.security.publicBaseUrl, cookie: "private=browser-cookie", "x-extra": "not-forwarded" },
    });
    const script = await (await fetch(`${base}/app.js`)).text();
    const page = await fetch(`${base}/`);
    expect(response.status).toBe(200);
    expect(observed).toEqual({ authorization: `Bearer ${token}`, origin: proxyConfig.security.publicBaseUrl,
      cookie: null, extra: null, path: "/api/v1/opportunities" });
    expect(script).toContain('const API=""');
    expect(script).not.toContain(token);
    expect(page.headers.get("content-security-policy")).toContain("connect-src 'self';");
    expect(page.headers.get("content-security-policy")).not.toContain("127.0.0.1:4999");
  });

  test("rejects DNS-rebinding authorities and missing origins on unsafe proxy requests", async () => {
    let upstreamCalls = 0;
    const upstream = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch() { upstreamCalls += 1; return Response.json({ ok: true }); } });
    servers.push(upstream);
    const port = availablePort();
    const proxyConfig = localProxyConfig(port);
    const server = createWebServer(proxyConfig, "http://127.0.0.1:4999", {
      upstreamBaseUrl: `http://127.0.0.1:${upstream.port}`,
      bearerToken: proxyConfig.security.operatorToken!,
    });
    servers.push(server);

    const rebound = await fetch(`http://127.0.0.1:${port}/api/v1/admin/overview`, { headers: { host: `attacker.example:${port}` } });
    const missingOrigin = await fetch(`http://127.0.0.1:${port}/api/v1/opportunities/00000000-0000-4000-8000-000000000000/report`, {
      method: "POST", headers: { "content-type": "application/json" }, body: "{}",
    });
    const oversized = await fetch(`http://127.0.0.1:${port}/api/v1/opportunities/00000000-0000-4000-8000-000000000000/report`, {
      method: "POST",
      headers: { "content-type": "application/json", origin: proxyConfig.security.publicBaseUrl },
      body: "x".repeat(65_537),
    });
    expect(rebound.status).toBe(403);
    expect(await rebound.json()).toEqual({ error: "origin_rejected" });
    expect(missingOrigin.status).toBe(403);
    expect(oversized.status).toBe(413);
    expect(upstreamCalls).toBe(0);
  });

  test("refuses the authenticated proxy outside the local container profile", () => {
    expect(() => createWebServer(config, "http://127.0.0.1:4999", {
      upstreamBaseUrl: "http://127.0.0.1:4100",
      bearerToken: "local-operator-token-that-stays-server-side",
    })).toThrow("restricted to the local container profile");
  });

  test("exposes accessible discovery, boundary, state, and reporting controls", () => {
    expect(shellHtml).toContain('role="search"');
    expect(shellHtml).toContain('aria-label="Primary"');
    expect(shellHtml).toContain('aria-label="Search boundaries"');
    expect(shellHtml).toContain('role="status"');
    expect(shellHtml).toContain("<dialog id=\"report\">");
    expect(shellHtml).toContain("Profile facts and fit scoring stay in your workspace");
  });

  test("renders all API-controlled values as text instead of executable markup", () => {
    const script = shellScript("http://127.0.0.1:4100");
    expect(script).toContain("n.textContent=v??''");
    expect(script).toContain("replaceChildren");
    expect(script).not.toContain(".innerHTML");
    expect(script).not.toContain("insertAdjacentHTML");
    expect(script).not.toContain("document.write");
    expect(script).not.toMatch(/\beval\s*\(/);
    expect(script).toContain("a.target='_blank';a.rel='noopener noreferrer'");
  });

  test("only sends canonical public filters and bounded report evidence", () => {
    const script = shellScript("http://127.0.0.1:4100");
    expect(script).toContain("['workplace','workplace_mode']");
    expect(script).toContain("['country','country']");
    expect(script).toContain("['status','status']");
    expect(script).toContain("['sort','sort']");
    expect(script).toContain("JSON.stringify({kind:$('#kind').value,detail:$('#note').value})");
    expect(script).not.toMatch(/p\.set\(['\"](?:profile|resume|candidate|fit)/i);
    expect(script).not.toMatch(/JSON\.stringify\(\{[^}]*?(?:profile|resume|candidate|fit)/i);
  });

  test("keeps loading, empty, and connection failures explicit and responsive", () => {
    const script = shellScript("http://127.0.0.1:4100");
    expect(script).toContain("Reading the canonical index");
    expect(script).toContain("No roles match this evidence set");
    expect(script).toContain("The canonical index could not be reached");
    expect(shellStyles).toContain("@media(max-width:980px)");
    expect(shellStyles).toContain("@media(max-width:680px)");
    expect(shellStyles).toContain("align-items:flex-start");
  });
});

describe("operator web surface", () => {
  test("serves the responsive console with restrictive external assets", async () => {
    const server = createWebServer(config, "http://127.0.0.1:4999"); servers.push(server);
    const base = `http://127.0.0.1:${server.port}`;
    const [page, styles, script] = await Promise.all([fetch(`${base}/operator?demo=1`), fetch(`${base}/operator.css`), fetch(`${base}/operator.js`)]);
    expect(page.status).toBe(200);
    expect(page.headers.get("content-security-policy")).not.toContain("unsafe-inline");
    expect(styles.headers.get("x-content-type-options")).toBe("nosniff");
    expect(script.headers.get("x-content-type-options")).toBe("nosniff");
  });

  test("keeps decisions reasoned, reversible, redacted, and XSS-safe", () => {
    const script = operatorScript("http://127.0.0.1:4100");
    expect(operatorHtml).toContain("Mandatory reason");
    expect(operatorHtml).toContain("Raw artifacts restricted");
    expect(script).toContain("n.textContent=v??''");
    expect(script).toContain("idempotency-key");
    expect(script).toContain("x-csrf-token");
    expect(script).toContain("A later split remains available");
    expect(script).not.toContain(".innerHTML");
    expect(script).not.toContain("document.write");
    expect(operatorStyles).toContain("@media(max-width:680px)");
  });

  test("uses aggregate overview counts instead of the bounded source-card page", () => {
    const script = operatorSummaryScript("");
    expect(operatorHtml).toContain('src="/operator-summary.js"');
    expect(script).toContain("/api/v1/admin/overview");
    expect(script).toContain("Object.fromEntries(overview.sourceHealth");
    expect(script).toContain("total-healthy");
    expect(script).not.toContain("innerHTML");
  });
});
