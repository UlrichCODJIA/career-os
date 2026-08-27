# Worker app boundary

Owns scheduler composition and durable job handlers. Shared-index scan workers do not receive candidate-private repositories or model-provider secrets.

DSV-002 provides the executable Bun composition root and `/healthz`. DSV-007 adds the one-minute scheduler loop, transaction-scoped PostgreSQL advisory-lock election, expired-lease reaping, and due-source enqueueing. Scan handlers land with connector orchestration; until then the worker schedules durable `scan_source` jobs but does not claim them.
