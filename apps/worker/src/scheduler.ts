export interface SchedulerQueue {
  scheduleDueSources(limit?: number): Promise<{ elected: boolean; enqueued: number }>;
  reapExpired(limit?: number): Promise<{ retried: number; terminal: number }>;
}

export interface SchedulerHandle {
  stop(): void;
  tick(): Promise<void>;
}

export function startScheduler(
  queue: SchedulerQueue,
  options: { intervalMs?: number; onError?: (error: unknown) => void } = {},
): SchedulerHandle {
  const intervalMs = options.intervalMs ?? 60_000;
  if (!Number.isInteger(intervalMs) || intervalMs < 1_000) throw new Error("scheduler interval must be at least one second");
  let running = false;
  let stopped = false;

  const tick = async (): Promise<void> => {
    if (running || stopped) return;
    running = true;
    try {
      await queue.reapExpired(100);
      await queue.scheduleDueSources(500);
    } catch (error) {
      options.onError?.(error);
    } finally {
      running = false;
    }
  };
  const timer = setInterval(() => void tick(), intervalMs);
  timer.unref();
  void tick();
  return {
    tick,
    stop() {
      stopped = true;
      clearInterval(timer);
    },
  };
}
