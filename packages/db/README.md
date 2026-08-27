# Database package

This package owns parameterized Bun SQL access, transaction helpers, and the forward-only migration runner. Reviewed SQL files remain under `db/migrations`; production API and worker roles must not receive schema-altering privileges.

The registry store executes idempotent operator mutations in a single PostgreSQL transaction. Ownership evidence and audit events are append-only. Source activation is rejected unless both policy and ownership evidence are current, and discovery schedulers must read `schedulable_sources` so a policy that expires with time cannot produce new fetches.
