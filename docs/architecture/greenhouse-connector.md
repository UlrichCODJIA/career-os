# Greenhouse connector

The Greenhouse connector implements the public Greenhouse Job Board API as a network-free `SourceConnector`. It is enabled as connector version `1.0.0` and is intentionally limited to approved, token-scoped public job boards.

## Source identity and ownership

A source binds one normalized lowercase Greenhouse board token to the fixed API base `https://boards-api.greenhouse.io/v1/boards/{token}`. Detection recognizes the current hosted board (`job-boards.greenhouse.io`), the legacy hosted board (`boards.greenhouse.io`), and the public API path. Arbitrary employer career domains are not detected as Greenhouse; registry onboarding must establish their ownership separately.

Hosted Greenhouse URLs embedded in responses must carry the same token. API response artifacts must match the exact planned host, path, and query. Tenant mismatch, credentials, fragments, unexpected endpoints, ambiguous artifact sets, and invalid source IDs fail closed.

## Enumeration and completeness

Enumeration plans exactly one `GET /v1/boards/{token}/jobs` request. The documented endpoint returns the complete public board without a pagination cursor. A caller-supplied cursor is rejected rather than interpreted.

A scan is complete only when the response satisfies the bounded schema, `meta.total` equals the raw job-array length, every hosted URL remains in the source tenant, every source ID is unique, and at least one job is present. A valid zero-job response is `suspicious_empty`; count mismatches, cross-tenant records, duplicate IDs, malformed JSON, and schema drift are incomplete. Therefore an incomplete response cannot be used as evidence that previously observed jobs closed.

Each enumerated record uses Greenhouse's numeric job ID as the stable source ID. Its lightweight fingerprint is a SHA-256 digest of stable source fields. Detail requests use the same fixed API base and add only `pay_transparency=true`.

## Detail parsing and evidence

Detail parsing checks the artifact endpoint, Greenhouse job ID, canonical hosted URL, and source tenant before emitting a listing. Every extracted value points to the immutable response artifact with a JSON Pointer, connector ID, connector version, origin, and confidence.

Greenhouse content is entity-decoded with a two-layer bound and then passed through the connector SDK's allowlist sanitizer. Applicant questions are never requested, avoiding collection of application fields, demographic questions, and compliance data. A single public pay range is normalized to decimal major currency units while retaining `period: unknown`; ambiguous multiple ranges remain unnormalized.

## Fixture and release contract

`tests/fixtures/greenhouse/manifest.json` records the sanitized, license-reviewed frozen corpus and exact expected outputs. The suite executes the corpus twice to prove deterministic idempotence, exercises safe-fetch redirect receipts, and checks that a shadow connector release yields field-path-specific diffs without mutating production output.

Any schema or normalization change requires a new semantic connector version, reviewed fixture expectations, and shadow comparison before activation. Network policy stays in `@career-os/safe-fetch`; the connector never performs I/O itself.

## Primary references

- [Greenhouse Job Board API](https://developers.greenhouse.io/job-board.html)
- [Greenhouse embedded and hosted job boards](https://support.greenhouse.io/hc/en-us/articles/200721090-Create-a-job-board-URL)
