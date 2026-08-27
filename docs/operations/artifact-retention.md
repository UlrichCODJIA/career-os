# Artifact storage and retention

Raw source evidence is stored under `ARTIFACT_ROOT` by SHA-256 digest. Object keys have the fixed form `sha256/<first-two-hex>/<64-hex-digest>`; URLs, filenames, tenant keys, and response headers never influence filesystem paths.

## Write and metadata sequence

1. Redact URL credentials and signed query fields and retain only allowlisted response headers.
2. Write bytes to an exclusive, mode-`0600` temporary file inside the digest directory.
3. Flush and atomically rename the file, then verify the committed bytes against the digest.
4. Insert metadata with `artifact://local/...` storage URI. If metadata insertion fails, the aged orphan reconciler removes the unreferenced object after its safety grace period.

Identical bytes reuse one object and one `artifacts.sha256` row. Raw artifacts remain untrusted and must not be rendered directly.

## Retention states

- `present`: object is expected to exist.
- `deleting`: a worker has claimed deletion; stale claims are recoverable after 15 minutes.
- `delete_failed`: object deletion failed and is eligible for retry.
- `deleted`: object is absent and metadata is retained as a tombstone.
- `missing`: metadata expected bytes that reconciliation could not find; investigate storage durability.

The worker checks due retention every five minutes and reconciles at most daily. An absent object during a due deletion is treated as an idempotent success. Orphan objects are deleted only after the configured 24-hour grace period. Metadata is never removed by this worker, preserving auditability and foreign-key history.

## Incident checks

- Alert on `delete_failed`, `missing`, stale `deleting`, disk pressure, and unexpected artifact growth.
- Pause the worker before restoring a volume and database snapshot; restore both from the same recovery point.
- Never manually construct an object path. Use the artifact-store API and verify the digest after restore.
