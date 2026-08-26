import { describe, expect, test } from "bun:test";
import { join } from "node:path";
import {
  LegacyDiscoveryJobSchema,
  LegacyRunEventSchema,
  RuntimeConfigSchema,
  readRuntimeConfig,
} from "../packages/contracts/src/index.ts";

const fixtureRoot = join(import.meta.dir, "fixtures", "legacy-dashboard");

describe("workspace contracts", () => {
  test("validates synthetic legacy Discovery fixtures", async () => {
    const value: unknown = await Bun.file(join(fixtureRoot, "discovery-jobs.json")).json();
    const jobs = LegacyDiscoveryJobSchema.array().parse(value);
    expect(jobs).toHaveLength(2);
    expect(jobs[0]?.key).toBe("example-inc/platform-engineer");
  });

  test("validates the selected legacy run-event subset", async () => {
    const value: unknown = await Bun.file(join(fixtureRoot, "run-events.json")).json();
    const events = LegacyRunEventSchema.array().parse(value);
    expect(events.map((event) => event.type)).toEqual(["run_started", "assistant_text", "run_result"]);
  });

  test("coerces service configuration and rejects invalid ports", () => {
    expect(readRuntimeConfig("api", { API_PORT: "4200", CAREER_OS_PROFILE: "test" })).toMatchObject({
      host: "127.0.0.1",
      port: 4200,
      profile: "test",
    });
    expect(() => RuntimeConfigSchema.parse({ profile: "local", host: "127.0.0.1", port: 70_000 })).toThrow();
  });
});
