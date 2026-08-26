import { createHmac, createHash, timingSafeEqual } from "node:crypto";
import type { RuntimeConfig } from "@career-os/contracts";

export type PrincipalRole = "user" | "operator";
export type AuthenticationMethod = "local" | "bearer" | "cookie";

export interface AuthenticatedPrincipal {
  id: string;
  role: PrincipalRole;
  authenticationMethod: AuthenticationMethod;
}

export interface RequestGuardOptions {
  requiredRole?: PrincipalRole;
  unsafe?: boolean;
  websocket?: boolean;
  remoteAddress?: string;
}

export class RequestSecurityError extends Error {
  constructor(
    public readonly status: 401 | 403,
    public readonly code: "unauthenticated" | "forbidden" | "origin_rejected" | "csrf_rejected",
  ) {
    super(code);
    this.name = "RequestSecurityError";
  }
}

function digest(value: string): Buffer {
  return createHash("sha256").update(value).digest();
}

function secretMatches(candidate: string, expected: string | undefined): boolean {
  if (!expected) return false;
  return timingSafeEqual(digest(candidate), digest(expected));
}

function readBearerToken(request: Request): string | undefined {
  const authorization = request.headers.get("authorization");
  if (!authorization) return undefined;
  const match = /^Bearer ([^\s]+)$/i.exec(authorization);
  return match?.[1];
}

function readCookie(request: Request, name: string): string | undefined {
  const header = request.headers.get("cookie");
  if (!header) return undefined;
  for (const segment of header.split(";")) {
    const separator = segment.indexOf("=");
    if (separator < 0) continue;
    if (segment.slice(0, separator).trim() === name) return segment.slice(separator + 1).trim();
  }
  return undefined;
}

function authenticateToken(
  token: string | undefined,
  method: Exclude<AuthenticationMethod, "local">,
  config: RuntimeConfig,
): AuthenticatedPrincipal {
  if (!token) throw new RequestSecurityError(401, "unauthenticated");
  if (secretMatches(token, config.security.operatorToken)) {
    return { id: "configured-operator", role: "operator", authenticationMethod: method };
  }
  if (secretMatches(token, config.security.userToken)) {
    return { id: "configured-user", role: "user", authenticationMethod: method };
  }
  throw new RequestSecurityError(401, "unauthenticated");
}

export function authenticateRequest(request: Request, config: RuntimeConfig): AuthenticatedPrincipal {
  switch (config.security.authenticationMode) {
    case "local":
      return { id: "local-operator", role: "operator", authenticationMethod: "local" };
    case "bearer":
      return authenticateToken(readBearerToken(request), "bearer", config);
    case "cookie":
      return authenticateToken(readCookie(request, "career_os_session"), "cookie", config);
  }
}

export function generateCsrfToken(sessionToken: string, csrfSecret: string): string {
  return createHmac("sha256", csrfSecret).update(sessionToken).digest("base64url");
}

export function assertRequestOrigin(request: Request, config: RuntimeConfig): void {
  const origin = request.headers.get("origin");
  if (!origin) throw new RequestSecurityError(403, "origin_rejected");

  let normalized: string;
  try {
    normalized = new URL(origin).origin;
  } catch {
    throw new RequestSecurityError(403, "origin_rejected");
  }

  const allowed = config.security.allowedOrigins.some((entry) => new URL(entry).origin === normalized);
  if (!allowed) throw new RequestSecurityError(403, "origin_rejected");
}

function assertCsrf(request: Request, config: RuntimeConfig): void {
  const sessionToken = readCookie(request, "career_os_session");
  const supplied = request.headers.get("x-csrf-token");
  if (!sessionToken || !supplied || !config.security.csrfSecret) {
    throw new RequestSecurityError(403, "csrf_rejected");
  }
  const expected = generateCsrfToken(sessionToken, config.security.csrfSecret);
  if (!secretMatches(supplied, expected)) throw new RequestSecurityError(403, "csrf_rejected");
}

export function guardRequest(
  request: Request,
  config: RuntimeConfig,
  options: RequestGuardOptions = {},
): AuthenticatedPrincipal {
  assertSecureTransport(request, config, options.remoteAddress);
  const principal = authenticateRequest(request, config);
  const browserSensitive = options.unsafe || options.websocket || principal.authenticationMethod === "cookie";
  if (browserSensitive) assertRequestOrigin(request, config);
  if (options.unsafe && principal.authenticationMethod === "cookie") assertCsrf(request, config);
  if (options.requiredRole === "operator" && principal.role !== "operator") {
    throw new RequestSecurityError(403, "forbidden");
  }
  return principal;
}

export function assertSecureTransport(
  request: Request,
  config: RuntimeConfig,
  remoteAddress?: string,
): void {
  if (config.security.networkBoundary === "remote") {
    if (config.security.transportSecurity === "tls") {
      if (new URL(request.url).protocol !== "https:") throw new RequestSecurityError(403, "forbidden");
    } else {
      const forwardedProto = request.headers.get("x-forwarded-proto")?.trim().toLowerCase();
      const trustedProxy =
        remoteAddress !== undefined && config.security.trustedProxyIps.includes(remoteAddress);
      if (forwardedProto !== "https" || !trustedProxy) throw new RequestSecurityError(403, "forbidden");
    }
  }
}

export function csrfTokenForRequest(request: Request, config: RuntimeConfig): string | undefined {
  if (config.security.authenticationMode !== "cookie" || !config.security.csrfSecret) return undefined;
  const sessionToken = readCookie(request, "career_os_session");
  return sessionToken ? generateCsrfToken(sessionToken, config.security.csrfSecret) : undefined;
}
