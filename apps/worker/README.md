# Worker app boundary

Owns scheduler composition and durable job handlers. Shared-index scan workers do not receive candidate-private repositories or model-provider secrets.

DSV-002 provides the executable Bun composition root and `/healthz`. DSV-007 adds the one-minute scheduler loop, transaction-scoped PostgreSQL advisory-lock election, expired-lease reaping, and due-source enqueueing. The current worker also claims fenced `scan_source` leases, fetches reviewed ATS endpoints through safe-fetch, persists retention-governed artifacts, invokes network-free connectors, and commits complete or explicitly incomplete scan-ledger outcomes transactionally.
