# Web app boundary

Owns user and operator presentation. DSV-002 establishes the executable, responsive local shell. It consumes versioned API contracts and never imports database or connector internals.

DSV-021 adds `/operator`, a responsive evidence-first console for source health, quarantine/breaker diagnosis, and company/opportunity review. API-controlled values are rendered through text nodes under the same restrictive CSP as Discovery. Mutations require a mandatory reason and send CSRF plus idempotency evidence; no destructive bulk action or raw-artifact viewer is present.
