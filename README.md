# Career OS

Career OS is an open-source, provider-neutral system for the complete journey from job discovery to application, interview, offer, and outcome learning.

> **Status:** architecture foundation. Product features have not been implemented yet. The first milestone establishes trustworthy discovery and canonicalization before any application automation.

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

The directories are intentionally skeletal in DSV-001. DSV-002 adds executable workspace packages and local infrastructure without importing either legacy repository as a runtime dependency.

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

## Architecture and delivery

- [Module boundaries](docs/architecture/module-boundaries.md)
- [Architecture decisions](docs/architecture/decisions/)
- [Reference-source provenance](docs/reference-sources.md)
- [Threat-model baseline](docs/security/threat-model.md)
- [Security policy](SECURITY.md)
- [Contributing](CONTRIBUTING.md)

Planning is coordinated in [Notion](https://app.notion.com/p/3c80b77c168c81d79e51d010ec0488cd) and [Linear](https://linear.app/armel-codjia/project/career-os-discovery-mvp-1000-companies-b86d03fc70fb).

## License

Career OS is licensed under the [GNU Affero General Public License v3.0](LICENSE). Package-specific permissive licensing may be introduced only through a reviewed ADR with clear file/package boundaries and provenance.
