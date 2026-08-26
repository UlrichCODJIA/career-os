# API app boundary

Owns request validation, authentication/authorization, pagination and application orchestration. Long-running discovery work is delegated to durable jobs.

DSV-002 provides the executable Bun composition root and `/healthz`; product routes and authentication land in later tasks.
