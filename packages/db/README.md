# Database package

This package owns parameterized Bun SQL access, transaction helpers, and the forward-only migration runner. Reviewed SQL files remain under `db/migrations`; production API and worker roles must not receive schema-altering privileges.

The registry store executes idempotent operator mutations in a single PostgreSQL transaction. Ownership evidence and audit events are append-only. Source activation is rejected unless both policy and ownership evidence are current, and discovery schedulers must read `schedulable_sources` so a policy that expires with time cannot produce new fetches.

The durable queue elects one scheduler per tick with an advisory lock, locks due sources and jobs using `SKIP LOCKED`, enforces active-job deduplication, and fences every claim with both an unguessable lease token and monotonic generation. Completion, heartbeat, failure, cancellation, and reaping fail closed for stale leases. Retry delay uses bounded exponential full jitter.
