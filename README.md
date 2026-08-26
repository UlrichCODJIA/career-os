# Career OS

Career OS is an open-source, provider-neutral system for the complete journey from job discovery to application, interview, offer, and outcome learning.

> **Status:** executable security foundation. The local profile, typed package boundaries, and fail-closed API authentication boundary are available; Discovery ingestion features have not been implemented yet.

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

DSV-002 turns the repository boundary into executable Bun workspaces and local infrastructure without importing either legacy repository as a runtime dependency. DSV-003 adds explicit loopback, container-loopback, and remote API profiles with one HTTP/WebSocket principal model, role checks, exact-origin validation, cookie-mode CSRF protection, and TLS/trusted-proxy validation.

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
- [Architecture decisions](docs/architecture/decisions/)
- [Reference-source provenance](docs/reference-sources.md)
- [Threat-model baseline](docs/security/threat-model.md)
- [Deployment security profiles](docs/security/deployment-profiles.md)
- [Security policy](SECURITY.md)
- [Contributing](CONTRIBUTING.md)

Planning is coordinated in [Notion](https://app.notion.com/p/3c80b77c168c81d79e51d010ec0488cd) and [Linear](https://linear.app/armel-codjia/project/career-os-discovery-mvp-1000-companies-b86d03fc70fb).

## License

Career OS is licensed under the [GNU Affero General Public License v3.0](LICENSE). Package-specific permissive licensing may be introduced only through a reviewed ADR with clear file/package boundaries and provenance.
