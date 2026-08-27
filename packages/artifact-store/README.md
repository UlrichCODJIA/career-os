# Artifact-store package

Content-addressed byte storage and retention adapters. Raw content remains untrusted and cannot decide canonical meaning.

The local driver derives every key from a lowercase SHA-256 digest, rejects symbolic-link path components, stages with exclusive permissions, fsyncs, and atomically renames. It never accepts caller-provided paths. Provenance persists only a credential-free URL and allowlisted response headers.

Retention is a two-phase database claim followed by an idempotent object deletion and durable tombstone. Stale `deleting` claims can be reclaimed after a worker crash. Reconciliation removes only aged objects with no metadata and marks missing bytes without deleting their metadata record.
