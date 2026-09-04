# Release evidence and pilot soak

ARM-28 / DSV-024 is fail-closed. A release is not ready because CI is green or a canary succeeded; all twenty gates in `@career-os/release-gates` must pass against one exact release commit and pilot-registry digest.

## Evidence set

Keep release evidence outside source control under `private/release` or in an access-controlled equivalent. The local worker mounts a dedicated `release-evidence` volume at `/data/release-evidence`. Evidence files contain aggregate counts and reviewer decisions, never source IDs, tenant keys, job text, URLs, credentials, or raw artifacts.

- `soak/*.json`: immutable twice-daily operational snapshots.
- `quality-audit.json`: a named review of at least 100 stratified records.
- `drill-receipt.json`: database/artifact restore, connector outage, worker crash, connector rollback, and browser verification outcomes.
- `security-receipt.json`: the standard Codex Security scan reference and unresolved Critical/High counts.
- `gate-report.json`: derived release decision from `bun run release:evaluate`.

Every receipt and snapshot is bound to a 40-character release commit. Registry-dependent evidence is also bound to the approved 64-character canonical registry digest. Mixed subjects fail the release.

## Snapshot capture

`bun run release:capture-soak` requires `DATABASE_URL`, `SOAK_STARTED_AT`, `RELEASE_COMMIT`, and `REGISTRY_DIGEST`. `SOAK_EVIDENCE_DIR` optionally selects the private output directory. Each invocation exclusively creates one timestamped JSON file and prints only aggregate progress.

The capture query defines metrics consistently:

- schedule success uses completed `scan_source` jobs created since soak start;
- queue lag measures scheduled-to-first-attempt time, or current wait for not-yet-started jobs;
- twice-enumerated freshness counts healthy enabled sources with at least two complete scans in the preceding 24 hours;
- publication lag uses nonnegative listing-version creation minus source-posted timestamps;
- closures come from immutable lifecycle events, while confirmed mass false-closure incidents come from explicit release audit events;
- idempotency and duplicate checks use the database uniqueness subjects `(work_job_id, lease_generation)` and `(source_id, source_job_id)`;
- provenance counts selected assertions and their retained evidence locator or deterministic/human origin.

Start the soak only after the recovery backlog is empty, all 1,000 sources are healthy, the release commit is frozen, and the exact registry digest is recorded. Capture at least twice per day for seven full days. The evaluator requires at least 14 snapshots, at least 168 hours of coverage, no gap above 14 hours, and mature freshness/queue observations after the first 24 hours.

## Thresholds

The evaluator requires 1,000 verified and enabled sources; at least 99% completed-job success; at least 95% rolling freshness; queue-lag p95 below 30 minutes; publication median below 12 hours and p95 below 18 hours; zero mass false closures; sampled false-close rate below 0.5%; 100% idempotent reprocessing; source-local duplicates below 0.1%; at least 95% workplace, eligible-country, and displayed compensation currency/pay-period correctness; 100% displayed-fact provenance; and broken employer/apply links below 2%.

Database and artifact restore integrity, connector-outage closure safety, worker-crash history, connector rollback history, browser E2E, and the standard security scan must all pass. Any unresolved Critical or High security finding blocks release.

## Final decision

Run `bun run release:evaluate` with `RELEASE_EVIDENCE_DIR`, `RELEASE_COMMIT`, and `REGISTRY_DIGEST`. The command writes the complete gate report and exits nonzero if any gate is missing or below threshold. A human reviewer signs the final checklist only after inspecting the report and referenced evidence; tooling must never synthesize reviewer approval.
