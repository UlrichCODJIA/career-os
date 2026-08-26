# ADR-0005: Separate Shared Market and Candidate-Private Data

**Status:** Accepted

**Decision date:** 2026-08-26

## Context

Employer job facts can support a shared index, while resumes, correspondence, applications, preferences, evaluations and outcomes are private. Mixing them raises authorization, analytics, retention and breach blast-radius risk.

## Decision

Use separate domain contracts, repositories, authorization policies, telemetry schemas and service capabilities for shared market data and candidate-private data. Discovery workers that fetch public sources receive no candidate repository or model-provider-secret capability. Any cross-domain projection is explicit, minimal, attributable and tested for private-field absence.

## Rejected alternatives

- **Single generic entity store:** rejected because accidental joins and broad service identities become normal.
- **Rely only on UI filtering:** rejected because access control must hold below presentation.
- **Anonymize after collection:** rejected because unnecessary collection and logging still create exposure.

## Consequences

The architecture requires more contracts and explicit joins, but least privilege, deletion, exports, telemetry review and future shared-index operation become tractable.

## Review trigger

Review separation when multi-user collaboration or employer accounts are introduced. Any shared/private bridge requires a data-flow and authorization review plus negative leakage tests.
