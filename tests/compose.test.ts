import { describe, expect, test } from "bun:test";
import { join } from "node:path";

interface ComposeService {
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

    expect(web?.environment).not.toHaveProperty("DATABASE_URL");
    expect(web?.environment).not.toHaveProperty("ARTIFACT_ROOT");
    expect(web?.volumes ?? []).not.toContain("artifacts:/data/artifacts");
    expect(web?.networks).toEqual(["frontend"]);

    expect(api?.environment).toHaveProperty("DATABASE_URL");
    expect(api?.networks).toEqual(["frontend", "backend"]);
    expect(worker?.environment).toHaveProperty("DATABASE_URL");
    expect(worker?.environment).toHaveProperty("ARTIFACT_ROOT");
    expect(worker?.volumes).toContain("artifacts:/data/artifacts");
    expect(worker?.networks).toEqual(["backend"]);
    expect(worker?.ports ?? []).toEqual([]);
  });
});
