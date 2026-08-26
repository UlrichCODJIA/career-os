# API app boundary

Owns request validation, authentication/authorization, pagination and application orchestration. Long-running discovery work is delegated to durable jobs.

DSV-002 provides the executable Bun composition root and `/healthz`. DSV-003 adds the shared HTTP/WebSocket principal boundary, operator-role guards, exact-origin and cookie-CSRF enforcement, and fail-closed remote transport validation. Current administrative routes are boundary probes only; durable source/run mutations and audit storage land with their owning workstreams.
