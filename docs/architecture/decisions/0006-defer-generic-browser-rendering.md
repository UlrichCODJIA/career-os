# ADR-0006: Defer Generic Browser Rendering for Discovery

**Status:** Accepted

**Decision date:** 2026-08-26

## Context

Browser rendering expands attack surface, resource cost and policy complexity. The pilot can achieve useful coverage through employer pages and documented public Greenhouse, Lever and Ashby interfaces.

## Decision

Begin with documented feeds and bounded HTTP/HTML parsing through safe-fetch. Generic browser-rendering workers are absent and disabled by default. A browser connector may be introduced only for a reviewed high-value source family with no structured path, explicit policy, isolated runtime, resource limits, artifact handling and fixtures.

This decision does not prevent user-controlled browser assistance later in the application pipeline; that is a separate consequential-action boundary.

## Rejected alternatives

- **Headless browser for every source:** rejected because it is expensive, fragile and unnecessarily privileged.
- **Third-party scraping service as authority:** rejected because provenance, terms, retention and canonical accuracy must remain source-aware.
- **Never support rendering:** rejected because measured coverage may justify a narrow isolated connector later.

## Consequences

Initial coverage is intentionally narrower and more trustworthy. Connectors remain deterministic and fixture-friendly. Some JavaScript-only sites will stay unsupported until their value justifies isolation work.

## Review trigger

Review when a documented coverage analysis identifies a high-value source family with no structured alternative. Approval requires threat modeling, policy evidence, cost limits, sandboxing and a rollback/quarantine plan.
