import { describe, expect, test } from "bun:test";
import { join } from "node:path";

interface ComposeService {
  command?: string[];
  depends_on?: Record<string, { condition?: string }>;
  environment?: Record<string, string>;
  networks?: string[];
  ports?: string[];
  volumes?: string[];
}

interface ComposeConfig {
  services: Record<string, ComposeService>;
}

const root = join(import.meta.dir, "..");

describe("local Compose capability boundaries", () => {
  test("keeps data-plane capabilities out of the web service", async () => {
    const source = await Bun.file(join(root, "compose.yaml")).text();
    const config = Bun.YAML.parse(source) as ComposeConfig;
    const web = config.services.web;
    const api = config.services.api;
    const worker = config.services.worker;
    const migrate = config.services.migrate;
    const postgres = config.services.postgres;

    expect(migrate?.command).toEqual(["bun", "run", "scripts/migrate.ts"]);
    expect(migrate?.environment).toEqual({ DATABASE_URL: "postgresql://career_os:local-development-only@postgres:5432/career_os" });
    expect(migrate?.networks).toEqual(["backend"]);
    expect(postgres?.networks).toEqual(["backend"]);
    expect(api?.depends_on?.migrate?.condition).toBe("service_completed_successfully");
    expect(worker?.depends_on?.migrate?.condition).toBe("service_completed_successfully");

    expect(web?.environment).not.toHaveProperty("DATABASE_URL");
    expect(web?.environment).not.toHaveProperty("ARTIFACT_ROOT");
    expect(web?.volumes ?? []).not.toContain("artifacts:/data/artifacts");
    expect(web?.networks).toEqual(["frontend"]);

    expect(api?.environment).toHaveProperty("DATABASE_URL");
    expect(api?.environment).toHaveProperty("AUTH_MODE", "bearer");
    expect(api?.environment?.AUTH_OPERATOR_TOKEN).toContain("CAREER_OS_LOCAL_API_TOKEN");
    expect(api?.networks).toEqual(["frontend", "backend"]);
    expect(worker?.environment).toHaveProperty("DATABASE_URL");
    expect(worker?.environment).toHaveProperty("ARTIFACT_ROOT");
    for (const prohibited of ["AUTH_OPERATOR_TOKEN", "MODEL_API_KEY", "OPENAI_API_KEY", "ANTHROPIC_API_KEY", "CANDIDATE_PRIVATE_URL"]) {
      expect(worker?.environment).not.toHaveProperty(prohibited);
    }
    expect(worker?.volumes).toContain("artifacts:/data/artifacts");
    expect(worker?.volumes).toContain("release-evidence:/data/release-evidence");
    expect(worker?.networks).toEqual(["backend", "egress"]);
    expect(worker?.ports ?? []).toEqual([]);
  });
});
