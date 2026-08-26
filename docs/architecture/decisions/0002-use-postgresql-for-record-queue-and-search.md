# ADR-0002: Use PostgreSQL for Record, Pilot Queue, and Search

**Status:** Accepted

**Decision date:** 2026-08-26

## Context

The pilot targets 1,000 sources scanned approximately twice daily. Introducing separate databases, Redis and a search engine would add consistency, operations and contributor overhead before load requires them.

## Decision

Use PostgreSQL as system of record, pilot durable queue and initial structured/full-text search engine. Queue claims use transactions and `FOR UPDATE SKIP LOCKED`; scheduling uses advisory-lock election; jobs have deterministic dedupe keys, bounded retries, expiring leases and fencing generations. Search is a rebuildable projection, never canonical authority.

## Rejected alternatives

- **Redis queue now:** rejected because the pilot does not justify a second durable system.
- **Dedicated workflow engine now:** rejected until workflows require long-running orchestration beyond bounded jobs.
- **OpenSearch/Meilisearch now:** rejected until measured PostgreSQL search performance fails after indexing and query tuning.

## Consequences

Transactions can atomically relate work, evidence and canonical changes, and local operation remains simpler. Queue and search load must be isolated through indexes, timeouts, bounded queries and observability.

## Review trigger

Review queue extraction if p95 claim latency exceeds 250 ms under target load, leases cause sustained contention, or workflows require complex orchestration. Review search extraction if p95 exceeds 300 ms after PostgreSQL tuning at forecast active-record volume.
