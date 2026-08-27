import { ArtifactRetentionService } from "@career-os/artifact-store";

export interface RetentionHandle { stop(): void; tick(): Promise<void> }

export function startRetentionWorker(
  retention: ArtifactRetentionService,
  options: { intervalMs?: number; reconcileIntervalMs?: number; onError?: (error: unknown) => void } = {},
): RetentionHandle {
  const intervalMs = options.intervalMs ?? 300_000;
  const reconcileIntervalMs = options.reconcileIntervalMs ?? 86_400_000;
  if (!Number.isInteger(intervalMs) || intervalMs < 1_000) throw new Error("retention interval must be at least one second");
  if (!Number.isInteger(reconcileIntervalMs) || reconcileIntervalMs < intervalMs) {
    throw new Error("reconciliation interval must not be shorter than the retention interval");
  }
  let running = false;
  let stopped = false;
  let lastReconciledAt = 0;
  const tick = async (): Promise<void> => {
    if (running || stopped) return;
    running = true;
    try {
      const now = new Date();
      await retention.deleteExpired(now, 100);
      if (now.getTime() - lastReconciledAt >= reconcileIntervalMs) {
        await retention.reconcile(now);
        lastReconciledAt = now.getTime();
      }
    } catch (error) {
      options.onError?.(error);
    } finally {
      running = false;
    }
  };
  const timer = setInterval(() => void tick(), intervalMs);
  timer.unref();
  void tick();
  return { tick, stop() { stopped = true; clearInterval(timer); } };
}
