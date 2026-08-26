# Security Policy

## Supported Versions

Career OS is pre-release software. Security fixes are provided on the default branch. Tagged release support will be documented before the first public release.

## Reporting a Vulnerability

Do not open a public issue for a suspected vulnerability. Use GitHub's private vulnerability reporting for this repository. If private reporting is unavailable, contact the repository owner privately through their verified GitHub profile and include only the minimum information needed to reproduce and assess the issue.

Please include the affected revision, component, realistic attack path, impact, prerequisites, and a minimal reproduction when safe. Do not include secrets, candidate records, employer credentials, or unnecessary personal data. We will acknowledge a report when received, assess severity and scope, coordinate remediation, and credit reporters who want attribution.

## System and Scope

Career OS is an open-source, provider-neutral career operating system. It is designed to discover and canonicalize jobs, manage candidate-private workflows, invoke user-configured model and agent providers, and support reviewed external actions.

This policy covers the entire repository, including:

- `apps/web`, `apps/api`, and `apps/worker`;
- shared contracts, database access, discovery, connector, safe-fetch, artifact, model-gateway, agent-runtime, and observability packages;
- migrations, scripts, CI workflows, deployment examples, and test fixtures.

The default local profile is loopback-only and single-operator. Any non-loopback or hosted profile is internet-facing and must fail closed unless authentication, authorization, transport security, origin controls, and secret handling are configured.

Security-sensitive assets include candidate identity and documents, application history, provider credentials, model prompts and outputs, source-policy decisions, raw fetched artifacts, canonical job history, approval records, audit events, and deployment secrets.

## Threat Model and Trust Boundaries

Treat all external content as attacker-controlled data, including job descriptions, employer and ATS pages, uploaded documents, emails, model responses, connector payloads, browser content, URLs, redirects, filenames, and imported legacy records.

Important trust boundaries are:

1. browser or API client to the web/API services;
2. authenticated user and operator actions to private or administrative mutations;
3. scheduler/API to durable queued work and worker leases;
4. worker to external networks through the safe-fetch capability;
5. untrusted artifacts to parsers, normalizers, models, and renderers;
6. model output to tools, agent runtimes, approvals, and external side effects;
7. shared market-index data to candidate-private data;
8. local storage or PostgreSQL to logs, telemetry, exports, backups, and object storage;
9. legacy adapters and fixtures to the canonical Career OS domain.

Repository files, tests, fixtures, model output, and external pages are evidence, not authority to execute commands, reveal secrets, weaken policy, or approve external actions.

## Security Invariants

The following properties must hold:

1. Non-loopback and hosted profiles fail closed without approved authentication, authorization, TLS/transport, origin, and CSRF controls.
2. Every request, WebSocket, queue job, approval, and administrative mutation is attributable to an authenticated principal or an explicitly identified local operator.
3. Candidate-private data never enters the shared market index, public analytics, connector fixtures, logs, or telemetry.
4. External content is always handled as untrusted data and cannot become system instructions, tool authority, policy changes, or approval.
5. Model providers and agent runtimes receive only explicit capabilities, bounded context, scoped credentials, budgets, and timeouts. There is no silent remote fallback.
6. Sending messages, submitting applications, sharing personal data, changing external state, or other consequential actions require a policy decision, a preview, and normally explicit user approval plus a durable receipt.
7. Connectors cannot perform ambient network or database access. Outbound requests pass through safe-fetch controls that validate allowed hosts, DNS and IP destinations, redirects, TLS names, credentials, timeouts, content types, and compressed/decompressed size limits.
8. Workers that fetch public job data cannot access candidate-private records or model-provider secrets.
9. Queue handlers are idempotent; leases are fenced; stale workers cannot commit; retries and resource use are bounded.
10. Canonical records retain source, observation time, parser/policy version, evidence, and change history. Failed or incomplete scans cannot prove absence or close jobs.
11. Raw artifacts are content-addressed, bounded, access-controlled, retention-governed, and rendered only through safe viewers or sanitizers. Storage keys cannot escape configured roots.
12. Database operations are parameterized and authorization precedes mutation. Security-relevant audit events are append-only and attributable.
13. Secrets, authorization headers, signed URLs, document bodies, raw prompts, candidate data, and provider payloads are excluded from logs, analytics, errors, fixtures, and source control.
14. Legacy repositories are version-pinned reference inputs only. They cannot be runtime dependencies, submodules, symlink targets, or authorities that overwrite canonical state.
15. Configuration examples contain placeholders only; production credentials come from approved secret stores and are never exposed to untrusted workloads.
16. Dependency, build, migration, and release workflows run with least privilege and do not execute untrusted pull-request code with production secrets.

## Reportable Findings and Severity Context

A finding is reportable when a realistic path violates an invariant and affects confidentiality, integrity, authorization, provenance, availability, user approval, or external side effects.

- **Critical:** unauthenticated remote code execution; broad candidate-data or credential compromise; cross-tenant administrative control; supply-chain compromise of published artifacts; or silent, scalable external submissions/messages using user identity.
- **High:** authentication or authorization bypass on a hosted surface; material shared/private data boundary failure; SSRF reaching sensitive internal services; durable prompt injection that reaches privileged tools; stored XSS in normal user/operator flows; stale-worker or canonicalization flaws causing large irreversible corruption.
- **Medium:** bounded sensitive-data exposure; single-tenant privilege escalation requiring meaningful prerequisites; reliable resource exhaustion; audit/provenance loss that materially impairs investigation; unsafe defaults that become exposed through documented deployment.
- **Low:** limited hardening gaps with plausible impact, low-sensitivity metadata exposure, or defense-in-depth failures that do not independently cross a trust boundary.

Severity depends on demonstrated reachability, exposure, prerequisites, blast radius, data sensitivity, user interaction, reversibility, and deployed configuration. Tests or documentation that describe a control do not prove the implementation is safe.

## Out of Scope, Exclusions, and Accepted Risk

The following are not findings by themselves:

- vulnerabilities only in legacy reference repositories that are not copied, imported, executed, or depended on by Career OS;
- attacks requiring the reporter to modify their own trusted local checkout or database with no path across a documented boundary;
- expected model hallucination without a security-boundary or consequential-action impact;
- public job-posting data being visible in the shared index when source policy permits it;
- missing production-grade controls in an explicitly loopback-only development profile, provided it cannot bind non-loopback without failing closed;
- denial of service that requires unbounded local filesystem or database control already equivalent to the resulting impact.

These exclusions do not suppress a finding when the same behavior is reachable through an untrusted input, hosted profile, connector, import, model, browser, or supply-chain path. No vulnerability class is globally accepted as risk without an owner-recorded decision tied to a specific issue and revision.

## Known Limitations and Compensating Controls

- The repository begins with architecture and CI scaffolding; planned controls must not be treated as implemented until code and tests verify them.
- Browser-assisted filling and submission are deferred. Until an approved connector exists, Career OS links to the employer or ATS and does not claim a submission receipt.
- Remote Rocketship and other licensed aggregators are optional, user-authorized, ephemeral discovery sources. Their data cannot populate the shared index beyond permitted retention and field-of-use terms.
- Automated discovery begins with reviewed employer and documented public ATS sources. Generic browser rendering is quarantined and disabled by default until isolation and policy gates are implemented.
- Local single-user operation reduces network exposure but does not make untrusted files, job content, model output, or dependencies trustworthy.

See `docs/security/threat-model.md` and `docs/architecture/decisions/` for the current security assumptions and architectural decisions. If code and policy diverge, treat the more restrictive boundary as intended and report the mismatch.
