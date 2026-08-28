# Career OS

Career OS is an open-source, provider-neutral system for the complete journey from job discovery to application, interview, offer, and outcome learning.

> **Status:** executable Discovery foundation. The local profile, durable queue/artifact boundaries, fail-closed API authentication, supply-chain provenance, SSRF-resistant safe-fetch client, versioned connector SDK/fixture harness, and first production-grade Greenhouse connector are available.

## Principles

- User-owned data and provider choice.
- Employer and permitted ATS sources remain authoritative.
- External content is untrusted data, never agent instruction.
- Consequential actions are previewable, attributable, and approval-gated.
- Shared market data and candidate-private data are separate domains.
- Local-first operation is supported; hosted deployments fail closed without authentication and transport controls.

## Repository layout

```text
apps/                    Web, API, and worker runtime boundaries
packages/                Domain and infrastructure libraries
db/                      Reviewed migrations and non-secret fixtures
docs/architecture/       Architecture, module rules, and ADRs
docs/security/           Threat-model baseline
scripts/                 Repository verification
tests/                   Cross-cutting tests and future fixtures
```

DSV-002 turns the repository boundary into executable Bun workspaces and local infrastructure without importing either legacy repository as a runtime dependency. DSV-003 adds explicit loopback, container-loopback, and remote API profiles with one HTTP/WebSocket principal model, role checks, exact-origin validation, cookie-mode CSRF protection, and TLS/trusted-proxy validation. DSV-004 adds secretless pull-request checks, migration and dependency validation, secret scanning, SBOM artifacts, and main-only build attestation. DSV-009 adds policy-scoped HTTPS retrieval with DNS and peer-address pinning, every-redirect revalidation, resource budgets, restricted headers, and redacted per-hop decisions while connectors remain network-free parsers. DSV-010 adds strict detection/enumeration/listing contracts, artifact-backed evidence, fail-closed completeness semantics, bounded parsing and sanitization, versioned frozen fixtures, and shadow diffs. DSV-011 adds Greenhouse detection, complete-board enumeration, detail parsing, stable source identity, pay-transparency extraction, hostile-content sanitization, and explainable shadow-version output.

## Development baseline

Requirements:

- [Bun 1.3.14](https://bun.sh/)
- Git

```bash
bun install --frozen-lockfile
bun run typecheck
bun test
bun run build
```

`bun run check` executes the complete baseline.

For the complete local profile, see [Local development](docs/development/local-profile.md). It starts loopback-bound web, API, and worker health services plus PostgreSQL and persistent artifact storage.

## Architecture and delivery

- [Module boundaries](docs/architecture/module-boundaries.md)
- [Connector SDK and release contract](docs/architecture/connector-sdk.md)
- [Greenhouse connector](docs/architecture/greenhouse-connector.md)
- [Architecture decisions](docs/architecture/decisions/)
- [Reference-source provenance](docs/reference-sources.md)
- [Threat-model baseline](docs/security/threat-model.md)
- [Deployment security profiles](docs/security/deployment-profiles.md)
- [CI and software supply-chain baseline](docs/security/ci-supply-chain.md)
- [Safe-fetch egress boundary](docs/security/safe-fetch.md)
- [Security policy](SECURITY.md)
- [Contributing](CONTRIBUTING.md)

Planning is coordinated in [Notion](https://app.notion.com/p/3c80b77c168c81d79e51d010ec0488cd) and [Linear](https://linear.app/armel-codjia/project/career-os-discovery-mvp-1000-companies-b86d03fc70fb).

## License

Career OS is licensed under the [GNU Affero General Public License v3.0](LICENSE). Package-specific permissive licensing may be introduced only through a reviewed ADR with clear file/package boundaries and provenance.
