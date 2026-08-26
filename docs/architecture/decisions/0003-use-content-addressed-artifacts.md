# ADR-0003: Use Content-Addressed Artifact Storage

**Status:** Accepted

**Decision date:** 2026-08-26

## Context

Discovery needs reproducible raw evidence without storing identical responses repeatedly. Raw bytes are untrusted, may contain personal or licensed data, and must obey bounded retention.

## Decision

Store permitted raw bytes by cryptographic digest behind an `ArtifactStore` port. The local profile uses an atomic fixed-root filesystem driver; hosted profiles may use an S3-compatible driver. Metadata records source policy, content type, byte length, fetch time, retention class and redacted request provenance. Rendering and parsing never treat raw artifacts as safe.

## Rejected alternatives

- **Database byte columns:** rejected for large raw evidence and independent retention/backup concerns.
- **URL-named files:** rejected because URLs may contain credentials, enable path mistakes and do not deduplicate content.
- **S3-only:** rejected because local-first operation must not require a cloud service.

## Consequences

Artifacts deduplicate and support reproducible parsers, but metadata/object reconciliation, quotas, safe viewers and deletion workers are required. Storage keys are derived only from validated digests.

## Review trigger

Make object storage the default when deployments become multi-machine, artifact volume exceeds local backup objectives, or measured durability requirements exceed the filesystem profile.
