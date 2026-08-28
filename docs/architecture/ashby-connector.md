# Ashby connector

The Ashby connector implements Ashby's unauthenticated Public Job Posting API as a network-free `SourceConnector`. Connector version `1.0.0` supports approved global boards, retrieves compensation when the employer publishes it, and introduces no browser or application-submission authority.

## Source and tenant identity

A source binds one case-preserving Ashby jobs-page name to `https://api.ashbyhq.com/posting-api/job-board/{name}` and the global region. Detection recognizes exact `jobs.ashbyhq.com/{name}` board/posting/application paths and the documented public API path. A custom employer careers URL remains an onboarding claim that requires registry ownership evidence; it is not automatically detected as Ashby.

The only planned request is `GET .../{name}?includeCompensation=true`. Artifacts must use that exact host, path, and query. Every returned `jobUrl` and `applyUrl` must agree on the jobs-page name and UUID posting identity, and an optional response `id` must match that UUID. Credentials, fragments, ports, arbitrary query parameters, encoded or malformed tenants, cross-tenant records, duplicates, and ambiguous artifact sets fail closed.

## Enumeration and completeness

Ashby's official public contract returns all currently published postings and does not define pagination. A single schema-valid response with at least one unique listed job is complete. Empty or all-unlisted responses are `suspicious_empty`; malformed/schema-drifted responses, duplicate identities, and mixed tenants are incomplete and cannot support closure inference. Records explicitly marked `isListed: false` are validated for tenant integrity but excluded from public discovery.

Ashby's UUID posting path segment is the stable source ID. Because the board response already includes the full description and metadata, detail planning re-fetches the same bounded JSON endpoint and selects exactly one still-listed UUID. This avoids executing the hosted React application and avoids undocumented GraphQL or candidate-application endpoints.

## Parsing and evidence

Description HTML is untrusted and passes through the SDK allowlist sanitizer; the separately supplied plaintext description is not used as a rendering shortcut. Title, publication time, locations, workplace/employment types, department, team, hosted/apply URLs, and an unambiguous salary summary are emitted with JSON Pointer evidence to the immutable board artifact. Compensation minimum/maximum/currency are normalized only when one salary summary component is present.

## Fixture and release contract

`tests/fixtures/ashby/manifest.json` is a sanitized, license-reviewed synthetic frozen corpus. The suite executes exact outputs twice for idempotence, checks shadow-version field paths, filters unlisted postings, rejects duplicate and cross-tenant identities, sanitizes hostile HTML, exercises safe-fetch redirect receipts, and proves that only the public API host is contacted.

Any parsing or normalization change requires a semantic connector version, reviewed fixture expectations, and a shadow comparison. Network and resource policy remains owned by `@career-os/safe-fetch`.

## Primary references

- [Ashby Public Job Posting API](https://developers.ashbyhq.com/docs/public-job-posting-api)
- [Ashby lightweight job posting API guidance](https://docs.ashbyhq.com/using-the-lightweight-job-posting-api-to-list-openings-on-your-site)
