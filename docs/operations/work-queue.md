# Durable work queue operations

The pilot queue is PostgreSQL-backed. The worker runs one scheduler tick per minute; a transaction-scoped advisory lock permits only one active scheduler transaction. Due sources are locked with `SKIP LOCKED`, checked against current policy and ownership evidence, and enqueued under `scan_source:{source_id}:{cadence_bucket}`. `next_scan_at` advances only in the transaction that attempts the durable enqueue.

Workers claim ready jobs with `SKIP LOCKED`. A claim increments `attempt` and `lease_generation` and issues a new lease token. Heartbeat, success, and failure must match job ID, worker ID, token, generation, status, and unexpired lease. A stale worker cannot commit after the reaper or another claim advances the generation.

Retryable failures use exponential full jitter capped at one hour and stop at `max_attempts`. The reaper applies the same attempt budget to expired leases. Exhausted, explicitly non-retryable, and cancelled jobs remain as terminal records; do not delete queue history during incident response.

After a verified remediation, `bun run queue:recover-terminal-scans` can append bounded replacement jobs for a specified failure window and allowlisted transient error codes. It requires `DATABASE_URL`, `RECOVERY_ACTOR_ID`, `RECOVERY_IDEMPOTENCY_KEY`, `RECOVERY_REASON`, `RECOVERY_FAILED_AFTER`, `RECOVERY_FAILED_BEFORE`, and `RECOVERY_ERROR_CODES`; `RECOVERY_LIMIT` defaults to 1,000. The command rejects windows longer than seven days, skips disabled or policy-expired sources, skips sources with active work or a later complete scan, advances the regular cadence only for appended jobs, and writes one aggregate operator audit event. Replaying the exact command is idempotent. Reusing its key with different input fails closed.

Recovery never changes the terminal job, its attempts, or its scan ledger. The replacement payload retains an internal `recoveredFromJobId` link for investigation, while command output and aggregate audit metadata omit source IDs and tenant keys.

Operator health is available at `GET /api/v1/admin/queue/health`. Investigate increasing ready age, expired leases, or terminal failures before raising concurrency. Do not bypass `schedulable_sources`, manually lower lease generations, clear terminal history, or enqueue source scans without the deterministic dedupe key.
