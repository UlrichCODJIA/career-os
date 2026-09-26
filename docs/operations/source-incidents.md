# Source and connector incident runbook

## First response

1. Open the operator console and identify the affected source, connector/version, latest scan ID, circuit-breaker state, and classified error. Do not open raw artifacts during initial triage.
2. Use the structured-log `correlationId` to follow the work-job ID, source ID, artifact IDs, and final scan ID. Confirm that all records belong to the same connector/version.
3. Pause the individual source if repeated requests could increase external load. A connector-version breaker already quarantines every matching source; do not bypass it.
4. Preserve immutable scan, artifact digest, policy, and decision evidence. Never paste response bodies, headers, signed URLs, or credentials into tickets, chat, analytics, or logs.
5. After the remediation passes a single-source canary, use the bounded terminal-scan recovery command for only the affected time window and transient error codes. Replay it to prove idempotency, then verify that the original terminal count is unchanged and exactly one aggregate recovery audit was appended.

## Count collapse

A baseline of at least ten listings falling to 20% or less is critical.

1. Confirm the scan is complete and inspect response count, byte count, status code, connector/version, and artifact digest only.
2. Compare multiple affected tenants. One tenant suggests source closure or policy change; several tenants on one connector/version suggest schema drift.
3. Keep absence inference blocked while the lifecycle circuit breaker is open. Never bulk-close jobs from an anomalous scan.
4. Reproduce with the connector's frozen fixture harness. Add a sanitized fixture for a legitimate schema change, update the connector, and pass the full suite.
5. Clear the breaker with an explicit reason only after a new complete scan matches the expected count envelope.

## Closure spike

Ten or more closures affecting at least 35% of observed listings is critical.

1. Verify that two separated complete absences exist and no incomplete, empty, blocked, or schema-invalid scan was treated as closure evidence.
2. Check whether a source breaker or connector-version breaker tripped. Keep bulk lifecycle projection paused.
3. Compare source listing state with canonical opportunity membership. A surviving member must keep the canonical opportunity open.
4. Resume only after a complete verification scan and record the operator reason.

## SSRF rejection

Every safe-fetch SSRF rejection is security-relevant, but a rejection means the fail-closed control worked.

1. Record the policy ID, connector ID/version, classified rejection code, destination hostname category, and correlation ID. Do not record the full URL, DNS answer, request headers, or credentials.
2. Confirm no raw socket, alternate HTTP client, browser renderer, redirect, or proxy bypassed `safe-fetch`.
3. Disable the source and revoke its policy approval if the destination was newly introduced or ownership is uncertain.
4. Escalate repeated or cross-source attempts to the security owner. Preserve redacted logs and immutable policy/audit records.

## Connector-wide failure

1. Identify the exact connector version and affected source count.
2. Let the connector-version breaker quarantine the version; do not downgrade silently.
3. Run frozen valid, malformed, hostile, schema-drift, empty, and pagination fixtures offline.
4. Release a new immutable connector version, perform a canary source scan, then migrate sources deliberately.

## Exit criteria

The incident ends only when a complete canary scan succeeds, the anomaly is inside its expected envelope, no private data entered telemetry, the breaker decision is audited, and follow-up work has an owner.
