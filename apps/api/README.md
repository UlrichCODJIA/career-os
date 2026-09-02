# API app boundary

Owns request validation, authentication/authorization, pagination and application orchestration. Long-running discovery work is delegated to durable jobs.

DSV-002 provides the executable Bun composition root and `/healthz`. DSV-003 adds the shared HTTP/WebSocket principal boundary, operator-role guards, exact-origin and cookie-CSRF enforcement, and fail-closed remote transport validation.

DSV-006 adds durable registry administration under `/api/v1/admin`: candidate list/import/verify/reject, source-policy create/update, and source list/update. Every mutation requires an authenticated operator, an exact allowed origin, a valid `Idempotency-Key`, a schema-valid JSON body no larger than 1 MiB, and an immutable audit event. The API returns stable error codes and does not expose database diagnostics.

DSV-021 adds the operator control plane: bounded health summaries, pending canonicalization reviews, redacted source/scan/artifact evidence, explicit circuit-breaker clearance, and reversible company/opportunity decisions. Raw artifact bytes, stored URLs, response headers, and storage locators are deliberately unavailable. The routes reuse the DSV-003 operator/origin/CSRF boundary and the existing transaction-scoped idempotency and audit stores.
