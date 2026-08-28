# Lever connector

The Lever connector implements Lever's public Postings API as a network-free `SourceConnector`. Connector version `1.0.0` supports the documented global and EU instances without credentials or application-submission authority.

## Region and source identity

A source binds one normalized lowercase site name to exactly one region:

- global: `api.lever.co` and `jobs.lever.co`;
- EU: `api.eu.lever.co` and `jobs.eu.lever.co`.

The API base must be `https://{regional-api}/v0/postings/{site}`. A Lever-hosted board URL must use the matching regional host and site root. Custom employer career URLs remain subject to registry ownership evidence rather than automatic Lever detection.

Response artifacts, hosted URLs, and apply URLs must agree on region, site, and UUID posting ID. Credentials, fragments, non-standard ports, unexpected paths, arbitrary queries, cross-region records, and ambiguous artifact sets fail closed. The connector plans only public GET requests; it never calls Lever's candidate application API.

## Pagination and completeness

Enumeration requests JSON explicitly with `mode=json`, `skip`, and a fixed `limit=100`. Parsing requires the full, ordered, contiguous artifact chain beginning at skip zero; a later page cannot claim completeness by itself. Cursors are decimal multiples of 100, and the chain is capped at the SDK's 100-artifact / 10,000-listing boundary. A full final page is `pagination_incomplete` and supplies the next exact skip token. A shorter final page is terminal. An empty first page is `suspicious_empty`; duplicate IDs, missing/out-of-order pages, invalid source identity, schema drift, malformed input, and the cursor ceiling cannot support absence inference.

Lever's UUID posting ID is the stable source ID. The lightweight fingerprint covers title, categories, country, creation time when supplied, hosted/apply URLs, workplace type, and salary range. Detail requests use the same region/site identity and exact posting ID.

## Detail parsing and evidence

The connector validates the detail artifact and embedded hosted/apply URLs before emitting data. Lever's styled description is passed through the SDK allowlist sanitizer; the separately supplied plaintext field is not trusted as a rendering shortcut. Locations, workplace type, commitment, department, team, and structured compensation are normalized deterministically while retaining JSON Pointer evidence to the immutable artifact. Lever's `createdAt`, when present, is recorded only as source publication time because the public contract does not supply an update timestamp.

## Fixture and release contract

`tests/fixtures/lever/manifest.json` contains the sanitized, license-reviewed, synthetic frozen corpus and exact expected output. Tests execute it twice for idempotence, generate a 100-record pagination boundary, verify a terminal page, exercise global/EU drift and duplicate IDs, retain safe-fetch redirect decisions, and compare shadow versions by field path.

Any parsing or normalization change requires a semantic connector version, reviewed fixture changes, and shadow comparison. Network and resource policy remains owned by `@career-os/safe-fetch`.

## Primary reference

- [Official Lever Postings API documentation](https://github.com/lever/postings-api)
