# ADR-0004: Separate Local and Hosted Security Profiles

**Status:** Accepted

**Decision date:** 2026-08-26

## Context

A loopback-only single-user tool and an internet-facing service have different authentication, transport and operational requirements. Silent exposure of local assumptions would create a severe security boundary failure.

## Decision

Provide an explicit loopback-only local profile and a separate hosted/non-loopback profile. Startup fails closed when a non-loopback bind lacks approved authentication, authorization, TLS/transport, origin, CSRF, secret-store and audit configuration. HTTP and WebSocket requests share one attributable principal model.

## Rejected alternatives

- **Implicit localhost trust everywhere:** rejected because reverse proxies, containers and bind changes can expose it.
- **Require hosted infrastructure for all users:** rejected because local-first ownership is a product goal.
- **One configuration with permissive defaults:** rejected because unsafe combinations are difficult to reason about and audit.

## Consequences

Local onboarding remains light while remote operation is explicit and testable. Configuration and integration-test matrices become larger, and features must declare which profiles they support.

## Review trigger

Review the profiles when identity ownership, multi-tenancy, managed hosting or desktop packaging introduces a new exposure model. Never weaken fail-closed behavior without a superseding security ADR.
