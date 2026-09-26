# Backup and restore runbook

Career OS recovery requires both PostgreSQL and the content-addressed artifact volume. A database-only restore can preserve metadata while losing reproducibility; an artifact-only restore cannot reconstruct canonical state.

## Backup

1. Record the release revision, migration head, database snapshot time, artifact snapshot time, encryption/key version, storage location, and operator.
2. Create a consistent PostgreSQL backup with a least-privileged backup identity. Store credentials outside command history and logs.
3. Snapshot the artifact volume after database writes are quiesced or at an explicitly recorded consistency boundary.
4. Encrypt both copies, restrict access, and test that retention policy covers backups as well as live data.
5. Calculate and retain integrity manifests without including artifact contents or signed download URLs.

## Restore drill

For the local release candidate, run `bun run release:verify-restore`. The verifier stops the idle worker at a recorded consistency boundary, creates a PostgreSQL custom-format backup, and archives the content-addressed artifact volume. It restores both into generated, isolated targets with outbound networking disabled, compares exact per-table row counts, migration checksums, artifact counts, byte totals, and a path-and-content tree digest, then removes the temporary database, volume, and backup. The worker is restarted in `finally`, including after a failed drill. A successful run writes the private, aggregate-only `private/release/restore-drill-receipt.json`; rerun it after the release commit is frozen so the receipt names the exact candidate.

The verifier refuses to snapshot while any queue job is active. It never logs database rows, artifact contents, credentials, or URLs.

1. Restore into an isolated environment with outbound networking disabled and PostHog capture unset.
2. Restore PostgreSQL, run migration verification, then restore the artifact volume.
3. Run database verification and artifact reconciliation. Treat missing, unexpected, or digest-mismatched objects as a failed drill.
4. Verify queue leases are fenced/reaped safely, source policies remain valid, and no scheduler or scanner starts before the operator enables it.
5. Run local smoke tests, inspect source-health and canonical-review surfaces, and record recovery-point and recovery-time results.
6. Destroy the isolated copy according to the approved retention process.

## Production recovery

Require an incident commander and a second reviewer. Prefer the newest restore point whose database/artifact consistency is proven. Rotate credentials potentially exposed by the incident, keep external scanning paused through verification, and record every enable/clear decision. A restore is complete only after integrity, migrations, queue health, artifact reconciliation, authentication, and privacy-safe telemetry checks pass.
