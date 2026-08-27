import { describe, expect, test } from "bun:test";
import { startScheduler, type SchedulerQueue } from "../apps/worker/src/scheduler.ts";

describe("worker scheduler loop", () => {
  test("reaps before scheduling and never overlaps ticks", async () => {
    const calls: string[] = [];
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const queue: SchedulerQueue = {
      async reapExpired() {
        calls.push("reap:start");
        await gate;
        calls.push("reap:end");
        return { retried: 0, terminal: 0 };
      },
      async scheduleDueSources() {
        calls.push("schedule");
        return { elected: true, enqueued: 0 };
      },
    };
    const scheduler = startScheduler(queue, { intervalMs: 60_000 });
    await Bun.sleep(1);
    const overlapping = scheduler.tick();
    release();
    await overlapping;
    await Bun.sleep(1);
    scheduler.stop();
    expect(calls).toEqual(["reap:start", "reap:end", "schedule"]);
  });

  test("contains tick failures and remains callable", async () => {
    const errors: unknown[] = [];
    let calls = 0;
    const queue: SchedulerQueue = {
      async reapExpired() {
        calls += 1;
        throw new Error("database unavailable");
      },
      async scheduleDueSources() {
        throw new Error("must not run after reaper failure");
      },
    };
    const scheduler = startScheduler(queue, { intervalMs: 60_000, onError: (error) => errors.push(error) });
    await Bun.sleep(1);
    await scheduler.tick();
    scheduler.stop();
    expect(calls).toBe(2);
    expect(errors).toHaveLength(2);
  });

  test("rejects unsafe busy-loop intervals", () => {
    expect(() => startScheduler({} as SchedulerQueue, { intervalMs: 999 })).toThrow("at least one second");
  });
});
