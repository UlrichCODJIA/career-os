# Module Boundaries

## Rule

**Dependencies point inward:** runtime composition depends on application/domain ports, and adapters implement those ports. Domain packages never import an app, framework route, concrete provider, connector, database driver, or legacy checkout.

```text
apps/*
  -> application composition
    -> domain contracts and ports
      <- infrastructure adapters
```

## Ownership map

| Path | Owns | May depend on | Must not depend on |
|---|---|---|---|
| `apps/web` | User and operator presentation | `contracts` | DB, connector internals, worker internals, legacy checkout |
| `apps/api` | Validation, authn/authz, pagination, orchestration APIs | `contracts`, `discovery-domain`, interfaces from infrastructure packages | Connector network access, long-running scans, legacy files as authority |
| `apps/worker` | Scheduler composition and durable handlers | Domain ports plus approved adapters | Web UI, candidate-private services when scanning shared sources |
| `packages/contracts` | Versioned request, event, and portable domain shapes | Schema/standard-library dependencies only | Apps, DB, providers, connectors |
| `packages/auth` | Deployment-boundary authentication, request origin/CSRF policy and role authorization | `contracts`, standard cryptography | Apps, persistence, provider or connector capabilities |
| `packages/discovery-domain` | Identity, normalization, provenance, lifecycle policy | `contracts` | Network, filesystem, database driver, model SDK |
| `packages/db` | Parameterized SQL, transactions, migrations, row mapping | Domain/contracts ports; artifact retention metadata port | HTTP routes, UI, connector parsing |
| `packages/connector-sdk` | Detection/enumeration/parsing ports and fixture harness | `contracts` | Ambient network, database, model or filesystem authority |
| `packages/connectors` | ATS-specific pure detection/parsing adapters | `connector-sdk`, `contracts` | Database, candidate data, arbitrary fetch, model secrets |
| `packages/safe-fetch` | Egress policy, DNS/IP/redirect/TLS/size enforcement | Standard networking and explicit policy types | Candidate-private data, connector interpretation, models |
| `packages/artifact-store` | Content-addressed bytes and retention adapters | Explicit storage ports | Canonical identity, lifecycle, prompts |
| `packages/model-gateway` | Provider-neutral deterministic model calls | `contracts` | Agent tool execution, database authority, silent fallback |
| `packages/agent-runtime` | Capability-scoped agent adapters and approvals | `model-gateway`, explicit tool ports | Unscoped OS/network access, implicit approval |
| `packages/observability` | Redacted logs, metrics, traces, correlation | Approved event contracts | Raw documents, prompts, credentials, signed URLs |

## Data boundaries

- Shared market-index modules and candidate-private modules use separate contracts, repositories, authorization policies, and telemetry schemas.
- A worker scanning public sources receives no candidate repository or model-provider secret capability.
- Licensed ephemeral discovery is isolated from the shared index; permitted facts become durable only after verifying the employer/ATS source.
- Compatibility adapters are one-way projections from canonical state. Legacy imports enter validation and provenance pipelines and cannot overwrite canonical state directly.

## Composition rules

1. Only app entry points construct concrete adapters and pass them to domain/application services.
2. Connector code receives a bounded artifact and parse context, not a general `fetch`, SQL client, or filesystem root.
3. Model and agent packages consume delimited untrusted data and typed outputs. External content cannot grant capabilities.
4. Cross-package imports use public exports; deep imports and circular workspace dependencies fail CI once workspace packages are executable.
5. New dependency directions require an ADR and a repository-boundary test.

## Review trigger

Revisit these boundaries when measured independent scaling, release cadence, ownership, or isolation requirements justify extracting a component. Extraction requires a superseding ADR covering contracts, data ownership, authentication, deployment, migration, and rollback.
