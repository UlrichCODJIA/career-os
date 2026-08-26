import { z } from "zod";

export const ServiceNameSchema = z.enum(["api", "web", "worker"]);

export const HealthResponseSchema = z.object({
  service: ServiceNameSchema,
  status: z.literal("ok"),
  profile: z.enum(["local", "hosted", "test"]),
  timestamp: z.iso.datetime(),
  version: z.string().min(1),
});

export type HealthResponse = z.infer<typeof HealthResponseSchema>;

const PortSchema = z.coerce.number().int().min(0).max(65_535);
const HostSchema = z.string().trim().min(1).max(255);

export const RuntimeConfigSchema = z.object({
  profile: z.enum(["local", "hosted", "test"]).default("local"),
  host: HostSchema.default("127.0.0.1"),
  port: PortSchema,
  databaseUrl: z.url().startsWith("postgresql://").optional(),
  artifactRoot: z.string().trim().min(1).default("./artifacts"),
});

export type RuntimeConfig = z.infer<typeof RuntimeConfigSchema>;

export function readRuntimeConfig(
  service: z.infer<typeof ServiceNameSchema>,
  env: Record<string, string | undefined> = process.env,
): RuntimeConfig {
  const prefix = service.toUpperCase();
  return RuntimeConfigSchema.parse({
    profile: env.CAREER_OS_PROFILE,
    host: env[`${prefix}_HOST`],
    port:
      (service === "worker" ? env.WORKER_HEALTH_PORT : env[`${prefix}_PORT`]) ??
      (service === "web" ? 3000 : service === "api" ? 4100 : 4101),
    databaseUrl: env.DATABASE_URL,
    artifactRoot: env.ARTIFACT_ROOT,
  });
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
