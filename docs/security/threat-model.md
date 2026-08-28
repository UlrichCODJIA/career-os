# Threat-Model Baseline

**Status:** architecture baseline; controls for T01, T02, T09, T16, the connector-SDK portions of T04/T06/T08/T12, and the authentication portion of T11 are implemented and tested, while later-workstream controls remain planned

**Repository scope:** `UlrichCODJIA/career-os`

**Initial reference revision:** GitHub commit created by DSV-001

## Assets

- candidate identity, documents, correspondence, application and interview history;
- LLM/provider credentials, prompts, model outputs, agent approvals and receipts;
- company/source registry, policy evidence, canonical jobs, provenance and lifecycle history;
- raw external artifacts, database state, audit events, backups, logs and telemetry;
- CI identities, release artifacts and dependency integrity.

## Adversaries and untrusted inputs

Relevant adversaries include unauthenticated remote callers to hosted profiles, malicious or compromised employer/ATS pages, hostile uploaded documents, prompt-injection content, poisoned provider responses, compromised dependencies, abusive authenticated users, and accidental operator misconfiguration.

Every URL, redirect, job description, HTML document, upload, email, filename, connector response, model response, browser page and legacy import is untrusted.

## Principal attack paths

| ID | Attack path | Required architectural control |
|---|---|---|
| T01 | URL or redirect reaches loopback, private, link-local, metadata or rebinding destination | Central safe-fetch with DNS/IP and every-hop validation |
| T02 | Hosted API or WebSocket is exposed without effective identity/authorization | Non-loopback fail-closed profile and shared principal enforcement |
| T03 | External content becomes model instruction or privileged tool input | Data/instruction separation, typed outputs, least privilege and approval |
| T04 | Failed/partial scan is interpreted as absence and closes many jobs | Completeness evidence, two-step closure and circuit breakers |
| T05 | Wrong company/domain/ATS ownership poisons the registry | Ownership evidence, exact identifiers and reversible review |
| T06 | Legacy checkout or provider-specific SDK becomes product authority | Inward ports, one-way adapters and dependency tests |
| T07 | Duplicate/stale worker corrupts canonical state | Idempotency, leases, fencing and transactional commits |
| T08 | Unsanitized HTML or evidence creates stored XSS | Raw/rendered separation, sanitization and safe viewers |
| T09 | Artifact path, symlink or retention bug exposes/deletes unintended data | Digest keys, fixed roots, atomic writes and reconciliation |
| T10 | Logs, errors, analytics or URLs leak secrets or candidate data | Schema allowlists, redaction canaries and private/shared isolation |
| T11 | Administrative mutation lacks authorization or attributable audit | Role checks, CSRF/origin controls, idempotency and append-only audit |
| T12 | Oversized, compressed or expensive inputs exhaust resources | Byte/time/query/concurrency budgets and backpressure |
| T13 | Fuzzy resolution merges unrelated companies/opportunities | Exact evidence first, high precision gates and reversible review |
| T14 | Licensed or personal data outlives purpose/terms | Retention class, deletion worker, provenance and reconciliation |
| T15 | Compatibility API leaks private data or makes legacy state authoritative | One-way projection, fixed roots and contract tests |
| T16 | CI/dependency compromise executes with write tokens or secrets | Least-privilege workflows, lockfiles, review and provenance |

## Implemented boundary evidence

DSV-003 implements validated `loopback`, `container-loopback`, and `remote` API profiles. Every non-loopback API bind requires an operator credential, including local containers; the local container credential is generated into ignored configuration rather than checked in. Remote requests use one principal model for HTTP and WebSocket upgrades; operator routes reject ordinary users; unsafe browser requests require an exact allowed origin; cookie mutations require an HMAC-derived CSRF token; trusted-proxy mode accepts secure-forwarding metadata only from exact configured proxy IPs; and remote health output is constrained by a strict path-free response schema.

This does not mark all of T11 complete. Durable domain mutations, idempotency storage, and append-only audit events arrive with their owning database and operator workstreams.

DSV-009 implements T01's application egress boundary in `@career-os/safe-fetch`: policy-owned host allowlists, strict public-address DNS sets, pinned connections, TLS hostname verification, connected-peer checks, manual every-hop redirect validation, and no ambient proxy inheritance. Fixed request, concurrency, timeout, wire-byte, decoded-byte, encoding, and media-type limits cover its T12 scope. Redacted decision schemas and telemetry canaries cover the URL/egress portion of T10. Connectors and their SDK remain pure and cannot import networking or safe-fetch authority. See [Safe fetch boundary](safe-fetch.md).

DSV-010 implements the connector-SDK portions of T04, T06, T08, and T12. Strict runtime contracts bind connector identity/version, completeness, response artifacts, and required listing evidence. Only a fully validated, internally consistent complete enumeration can support absence inference. Parsing applies hard byte/depth/node/string ceilings and fatal UTF-8 decoding; untrusted HTML is reduced to plaintext plus escaped no-active-markup display HTML. Versioned, provenance-reviewed frozen fixtures cover malformed, partial, suspicious-empty, oversized, hostile, and schema-drift inputs, while bounded shadow diffs compare releases without canonical mutation. Application composition, concrete ATS connectors, lifecycle circuit breakers, and safe viewers remain separate delivery gates. See [Connector SDK and release contract](../architecture/connector-sdk.md).

## Release gates

- No validated Critical or High issue remains unresolved without an owner-recorded decision.
- Hosted-profile authentication, SSRF, prompt-injection, XSS, redaction, queue-fencing and closure-safety suites pass.
- Candidate-private fields are absent from shared query, log, fixture and telemetry schemas.
- Restore, rollback and audit reconstruction are demonstrated.

The repository-wide scanner policy is `SECURITY.md`. The detailed planning model is maintained in the linked Notion project until a versioned implementation model supersedes this baseline.
