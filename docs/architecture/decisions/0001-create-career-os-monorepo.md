# ADR-0001: Create a New Career OS Monorepo

**Status:** Accepted

**Decision date:** 2026-08-26

**Owner:** Project owner

## Context

The reference dashboard is coupled to a local AI Job Search checkout, file-backed records, Claude-specific agent sessions, implicit localhost trust, and a single-user operating model. Career OS requires provider-neutral models and runtimes, durable workflows, employer/ATS discovery, provenance, private candidate data, and hosted deployment boundaries.

## Decision

Create `UlrichCODJIA/career-os` as one clean Bun/TypeScript monorepo. Keep the dashboard and upstream AI Job Search repositories as immutable, version-pinned reference inputs. They are not submodules, workspace dependencies, symlink targets, required checkouts, or authorities over canonical state.

Useful behavior may be copied or reimplemented only after reviewing provenance, license, dependencies, tests, and security assumptions. Compatibility is expressed through one-way adapters and frozen contract fixtures; new domain interfaces point inward and legacy adapters depend on them.

## Rejected alternatives

- **Continue in the dashboard:** rejected because legacy runtime and trust assumptions would become the product's dependency direction.
- **Fork and rename:** rejected because it preserves the same architectural center of gravity and obscures selective migration provenance.
- **One repository per service:** rejected because independent versioning and release coordination add cost before boundaries and ownership are stable.

## Consequences

The product begins with clean ownership, provider neutrality, durable-data boundaries and one contributor toolchain. Initial scaffolding and selective migration cost more than modifying the dashboard directly. Existing behavior must be captured deliberately as contracts and fixtures.

## Review trigger

Revisit the monorepo only when measured release cadence, scaling, ownership, or security isolation requires extraction. A superseding ADR must cover contracts, data ownership, deployment, migration and rollback.
