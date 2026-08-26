import { z } from "zod";

export const ServiceNameSchema = z.enum(["api", "web", "worker"]);

export const HealthResponseSchema = z.object({
  service: ServiceNameSchema,
  status: z.literal("ok"),
  profile: z.enum(["local", "hosted", "test"]),
  timestamp: z.iso.datetime(),
  version: z.string().min(1),
}).strict();

export type HealthResponse = z.infer<typeof HealthResponseSchema>;

const PortSchema = z.coerce.number().int().min(0).max(65_535);
const HostSchema = z.string().trim().min(1).max(255);
const SecretSchema = z.string().min(32).max(4_096);

export const NetworkBoundarySchema = z.enum(["loopback", "container-loopback", "remote"]);
export const AuthenticationModeSchema = z.enum(["local", "bearer", "cookie"]);
export const TransportSecuritySchema = z.enum(["none", "tls", "trusted-proxy"]);

const SecurityConfigSchema = z
  .object({
    networkBoundary: NetworkBoundarySchema.default("loopback"),
    localOnly: z.boolean().default(true),
    publicBaseUrl: z.url(),
    allowedOrigins: z.array(z.url()).min(1),
    authenticationMode: AuthenticationModeSchema.default("local"),
    transportSecurity: TransportSecuritySchema.default("none"),
    operatorToken: SecretSchema.optional(),
    userToken: SecretSchema.optional(),
    csrfSecret: SecretSchema.optional(),
    trustedProxyIps: z.array(z.union([z.ipv4(), z.ipv6()])).default([]),
    tlsCertFile: z.string().trim().min(1).optional(),
    tlsKeyFile: z.string().trim().min(1).optional(),
  })
  .superRefine((security, context) => {
    const publicUrl = new URL(security.publicBaseUrl);
    const normalizedOrigins = security.allowedOrigins.map((origin) => new URL(origin).origin);

    if (!normalizedOrigins.includes(publicUrl.origin)) {
      context.addIssue({
        code: "custom",
        path: ["allowedOrigins"],
        message: "allowed origins must include the public base URL origin",
      });
    }

    if (security.operatorToken && security.operatorToken === security.userToken) {
      context.addIssue({
        code: "custom",
        path: ["userToken"],
        message: "user and operator tokens must be distinct",
      });
    }

    if (security.networkBoundary === "remote") {
      if (publicUrl.protocol !== "https:") {
        context.addIssue({ code: "custom", path: ["publicBaseUrl"], message: "remote public URL must use HTTPS" });
      }
      if (normalizedOrigins.some((origin) => new URL(origin).protocol !== "https:")) {
        context.addIssue({ code: "custom", path: ["allowedOrigins"], message: "remote origins must use HTTPS" });
      }
      if (security.authenticationMode === "local") {
        context.addIssue({ code: "custom", path: ["authenticationMode"], message: "remote boundary requires authentication" });
      }
      if (security.transportSecurity === "none") {
        context.addIssue({ code: "custom", path: ["transportSecurity"], message: "remote boundary requires TLS" });
      }
      if (!security.operatorToken) {
        context.addIssue({ code: "custom", path: ["operatorToken"], message: "remote boundary requires an operator token" });
      }
      if (security.authenticationMode === "cookie" && !security.csrfSecret) {
        context.addIssue({ code: "custom", path: ["csrfSecret"], message: "cookie authentication requires a CSRF secret" });
      }
      if (security.transportSecurity === "trusted-proxy" && security.trustedProxyIps.length === 0) {
        context.addIssue({
          code: "custom",
          path: ["trustedProxyIps"],
          message: "trusted-proxy transport requires at least one exact proxy IP",
        });
      }
      if (security.transportSecurity === "tls" && (!security.tlsCertFile || !security.tlsKeyFile)) {
        context.addIssue({
          code: "custom",
          path: ["transportSecurity"],
          message: "direct TLS requires certificate and key files",
        });
      }
    } else {
      if (!isLoopbackHost(publicUrl.hostname)) {
        context.addIssue({ code: "custom", path: ["publicBaseUrl"], message: "local public URL must be loopback" });
      }
      if (normalizedOrigins.some((origin) => !isLoopbackHost(new URL(origin).hostname))) {
        context.addIssue({ code: "custom", path: ["allowedOrigins"], message: "local origins must be loopback" });
      }
    }
  });

export type SecurityConfig = z.infer<typeof SecurityConfigSchema>;

export function isLoopbackHost(host: string): boolean {
  const normalized = host.trim().toLowerCase().replace(/^\[|\]$/g, "");
  if (normalized === "localhost" || normalized === "::1" || normalized === "0:0:0:0:0:0:0:1") return true;
  const mappedIpv4 = /^(?:::ffff:|0:0:0:0:0:ffff:)(\d{1,3}(?:\.\d{1,3}){3})$/.exec(normalized)?.[1];
  if (mappedIpv4) return isLoopbackHost(mappedIpv4);
  const parts = normalized.split(".");
  return (
    parts.length === 4 &&
    parts.every((part) => /^\d{1,3}$/.test(part) && Number(part) <= 255) &&
    Number(parts[0]) === 127
  );
}

export const RuntimeConfigSchema = z.object({
  profile: z.enum(["local", "hosted", "test"]).default("local"),
  host: HostSchema.default("127.0.0.1"),
  port: PortSchema,
  databaseUrl: z.url().startsWith("postgresql://").optional(),
  artifactRoot: z.string().trim().min(1).default("./artifacts"),
  security: SecurityConfigSchema,
}).superRefine((config, context) => {
  const loopback = isLoopbackHost(config.host);
  const { networkBoundary } = config.security;

  if (networkBoundary === "loopback" && !loopback) {
    context.addIssue({ code: "custom", path: ["host"], message: "loopback boundary must bind to a loopback host" });
  }
  if (networkBoundary === "container-loopback") {
    if (config.profile === "hosted" || !config.security.localOnly) {
      context.addIssue({
        code: "custom",
        path: ["security", "networkBoundary"],
        message: "container-loopback is valid only for a local-only profile",
      });
    }
  }
  if (!loopback && networkBoundary !== "container-loopback" && networkBoundary !== "remote") {
    context.addIssue({ code: "custom", path: ["host"], message: "non-loopback bind requires an approved boundary" });
  }
  if (networkBoundary === "remote" && config.profile !== "hosted") {
    context.addIssue({ code: "custom", path: ["profile"], message: "remote boundary requires the hosted profile" });
  }
  if (config.profile === "hosted" && networkBoundary !== "remote") {
    context.addIssue({ code: "custom", path: ["profile"], message: "hosted profile requires the remote boundary" });
  }
});

export type RuntimeConfig = z.infer<typeof RuntimeConfigSchema>;

export function assertApiSecurityBoundary(config: RuntimeConfig): void {
  if (isLoopbackHost(config.host)) return;
  if (config.security.authenticationMode === "local") {
    throw new Error("non-loopback API bind requires bearer or cookie authentication");
  }
  if (!config.security.operatorToken) {
    throw new Error("non-loopback API bind requires an operator token");
  }
  if (config.security.authenticationMode === "cookie" && !config.security.csrfSecret) {
    throw new Error("non-loopback cookie authentication requires a CSRF secret");
  }
}

export function parseApiRuntimeConfig(config: RuntimeConfig): RuntimeConfig {
  const parsed = RuntimeConfigSchema.parse(config);
  assertApiSecurityBoundary(parsed);
  return parsed;
}

export function readRuntimeConfig(
  service: z.infer<typeof ServiceNameSchema>,
  env: Record<string, string | undefined> = process.env,
): RuntimeConfig {
  const prefix = service.toUpperCase();
  const port =
    (service === "worker" ? env.WORKER_HEALTH_PORT : env[`${prefix}_PORT`]) ??
    (service === "web" ? 3000 : service === "api" ? 4100 : 4101);
  const publicBaseUrl = env.DISCOVERY_PUBLIC_BASE_URL ?? `http://127.0.0.1:${port}`;
  const allowedOrigins = (env.ALLOWED_ORIGINS ?? publicBaseUrl)
    .split(",")
    .map((origin) => origin.trim())
    .filter(Boolean);

  const config = RuntimeConfigSchema.parse({
    profile: env.CAREER_OS_PROFILE,
    host: env[`${prefix}_HOST`],
    port,
    databaseUrl: env.DATABASE_URL,
    artifactRoot: env.ARTIFACT_ROOT,
    security: {
      networkBoundary: env.NETWORK_BOUNDARY,
      localOnly: env.LOCAL_ONLY === undefined ? undefined : env.LOCAL_ONLY === "true",
      publicBaseUrl,
      allowedOrigins,
      authenticationMode: env.AUTH_MODE,
      transportSecurity: env.TRANSPORT_SECURITY,
      operatorToken: env.AUTH_OPERATOR_TOKEN,
      userToken: env.AUTH_USER_TOKEN,
      csrfSecret: env.AUTH_CSRF_SECRET,
      trustedProxyIps: (env.TRUSTED_PROXY_IPS ?? "")
        .split(",")
        .map((address) => address.trim())
        .filter(Boolean),
      tlsCertFile: env.TLS_CERT_FILE,
      tlsKeyFile: env.TLS_KEY_FILE,
    },
  });
  if (config.security.networkBoundary === "remote" && service !== "api") {
    throw new Error(`${service} does not yet support a remote boundary; keep it internal or loopback-only`);
  }
  if (service === "api") assertApiSecurityBoundary(config);
  return config;
}

export function createHealthResponse(
  service: z.infer<typeof ServiceNameSchema>,
  profile: RuntimeConfig["profile"],
): HealthResponse {
  return HealthResponseSchema.parse({
    service,
    status: "ok",
    profile,
    timestamp: new Date().toISOString(),
    version: "0.0.0",
  });
}

export const LegacyDiscoveryJobSchema = z
  .object({
    key: z.string().min(1),
    title: z.string().min(1),
    company: z.string().min(1),
    url: z.url(),
    first_seen: z.iso.date(),
    fit: z.string().min(1),
    status: z.string().min(1),
    location: z.string().nullable().optional(),
    deadline: z.string().nullable().optional(),
    salary: z.string().nullable().optional(),
  })
  .catchall(z.unknown());

export const LegacyRunEventSchema = z.discriminatedUnion("type", [
  z.object({ type: z.literal("run_started"), runId: z.string().min(1), command: z.string().min(1), args: z.string().optional() }),
  z.object({ type: z.literal("assistant_text"), text: z.string(), agentID: z.string().optional() }),
  z.object({ type: z.literal("run_result"), status: z.enum(["success", "error"]), result: z.string().optional() }),
]);

export type LegacyDiscoveryJob = z.infer<typeof LegacyDiscoveryJobSchema>;
export type LegacyRunEvent = z.infer<typeof LegacyRunEventSchema>;
