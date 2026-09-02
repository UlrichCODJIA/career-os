import { afterEach, describe, expect, test } from "bun:test";
import type { RuntimeConfig } from "../packages/contracts/src/index.ts";
import { createWebServer } from "../apps/web/src/server.ts";
import { shellHtml, shellScript, shellStyles } from "../apps/web/src/shell.ts";
import { operatorHtml, operatorScript, operatorStyles } from "../apps/web/src/operator-shell.ts";

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
});
