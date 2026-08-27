# Durable work queue operations

The pilot queue is PostgreSQL-backed. The worker runs one scheduler tick per minute; a transaction-scoped advisory lock permits only one active scheduler transaction. Due sources are locked with `SKIP LOCKED`, checked against current policy and ownership evidence, and enqueued under `scan_source:{source_id}:{cadence_bucket}`. `next_scan_at` advances only in the transaction that attempts the durable enqueue.

Workers claim ready jobs with `SKIP LOCKED`. A claim increments `attempt` and `lease_generation` and issues a new lease token. Heartbeat, success, and failure must match job ID, worker ID, token, generation, status, and unexpired lease. A stale worker cannot commit after the reaper or another claim advances the generation.

Retryable failures use exponential full jitter capped at one hour and stop at `max_attempts`. The reaper applies the same attempt budget to expired leases. Exhausted, explicitly non-retryable, and cancelled jobs remain as terminal records; do not delete queue history during incident response.

Operator health is available at `GET /api/v1/admin/queue/health`. Investigate increasing ready age, expired leases, or terminal failures before raising concurrency. Do not bypass `schedulable_sources`, manually lower lease generations, clear terminal history, or enqueue source scans without the deterministic dedupe key.
