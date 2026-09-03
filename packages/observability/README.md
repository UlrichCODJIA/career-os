# Observability package

Provider-neutral structured logs, W3C-compatible trace correlation, privacy-safe product events, and deterministic operational alert rules.

Operational logs recursively redact credential-bearing fields, raw request/response bodies, candidate-private fields, secret-shaped values, and signed URLs. A scan correlation context links its durable work job, source, connector/version, stored artifacts, and final scan ledger ID without copying record contents.

PostHog is optional and disabled when `POSTHOG_API_KEY` is absent. Only the four allowlisted product events in `src/index.ts` can cross that boundary; unknown events/properties, URLs, secrets, and PII-shaped keys fail closed. Events explicitly disable person-profile processing. Operational logs and raw evidence never go to PostHog.

See `docs/operations/observability.md` for alert ownership and validation, and `docs/operations/source-incidents.md` for response procedures.
