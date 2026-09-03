# Observability and alert operations

## Data boundaries

Career OS separates operational telemetry from product analytics.

- Structured JSON logs are the system-of-record operational stream. They contain timestamps, severity, an allowlisted event name, redacted fields, and optional correlation context.
- Correlation context carries record identifiers only: correlation/trace/span IDs plus work-job, source, scan, artifact, and connector/version IDs. Follow those IDs in the database for evidence; never copy artifact bodies into logs.
- PostHog receives only approved aggregate product events. It receives no candidate identifier, source/scan/artifact identifier, URL, query, raw body, prompt, document, email, phone number, credential, or signed URL.
- PostHog events set `$process_person_profile` to `false` and `$geoip_disable` to `true`. Capture is disabled when `POSTHOG_API_KEY` is unset.
- The API key is a runtime secret. Do not commit it, log it, expose it to the browser, or place it in a URL.

The implementation follows PostHog's guidance to control sensitive data before it reaches PostHog and uses its schema-management model for planned typed events:

- <https://posthog.com/docs/privacy/data-collection>
- <https://posthog.com/docs/product-analytics/schema-management>
- <https://posthog.com/docs/getting-started/send-events#3-capture-backend-events>

## Approved product-event contract

| Event | Required properties | Optional properties |
| --- | --- | --- |
| `source scan completed` | `connector_id`, `outcome`, `completeness_reason`, `observation_count`, `duration_bucket` | `replayed` |
| `source scan failed` | `connector_id`, `outcome`, `error_code`, `retryable`, `duration_bucket` | none |
| `operator decision recorded` | `decision_type`, `outcome` | none |
| `discovery search completed` | `result_bucket`, `latency_bucket`, `filter_count`, `outcome` | none |

Event names are stable. Changes require a code review updating the runtime validator, tests, and this table before capture. PostHog's connected project had no recently ingested Career OS events when this contract was established, so dashboards must be created only after a controlled non-production event proves the live schema.

## Operational signals and paging policy

| Signal | Warning | Critical | Owner/runbook |
| --- | ---: | ---: | --- |
| oldest ready queue item | 15 minutes | 30 minutes | Discovery operator; `work-queue.md` |
| observed count / established baseline (baseline >= 10) | — | <= 20% | Source owner; `source-incidents.md#count-collapse` |
| closures / observed listings (at least 10 closures) | — | >= 35% | Discovery operator; `source-incidents.md#closure-spike` |
| artifact volume utilization | 80% | 90% | Storage operator; `artifact-retention.md` |
| safe-fetch SSRF rejections | >= 1 | escalation after confirmed attack/repetition | Security owner; `source-incidents.md#ssrf-rejection` |

Alerts are calculated by `evaluateOperationalAlerts`; adapters may export the same signals to OpenTelemetry, Prometheus, a hosted monitor, or a local process. An adapter must preserve names, thresholds, and runbook ownership.

## Dashboard rollout

After a controlled event reaches the intended PostHog project, verify its properties against the runtime table before creating these cards:

1. scan outcomes by connector and completeness reason;
2. scan duration bucket by connector;
3. observations per successful scan;
4. failures by classified error and retryability;
5. operator decisions by type and outcome;
6. discovery-search result and latency buckets.

Do not use autocapture or session replay on candidate/application surfaces. PostHog is a product-usage view, not the queue, scan-ledger, artifact, or security-alert source of truth.

## Verification and tabletop

Run `bun test tests/observability.test.ts`. The suite injects canary credentials, nested bodies, signed URLs, and cyclic data; verifies event-schema rejection and personless PostHog payloads; and simulates every alert threshold. During release tabletop, select one alert from each row, locate the linked runbook, name the incident commander, and record the decision without including raw source content.
