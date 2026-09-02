# Operator console

The DSV-021 console is available at `/operator`. It is an administrative surface: hosted deployments must authenticate an `operator`; local loopback mode attributes actions to the explicit local operator principal.

## Read surfaces

- `GET /api/v1/admin/overview` returns bounded source-health, pending-review, breaker, and recent-scan counts.
- `GET /api/v1/admin/reviews` returns at most 200 redacted review records and accepts only `pending`, `approved`, or `rejected` state filters.
- `GET /api/v1/admin/reviews/:id` returns one redacted review.
- `GET /api/v1/admin/sources/:id/evidence` returns the source origin, the latest 20 scan summaries, bounded artifact metadata, and breaker history.

The evidence response never includes raw response bytes, stored source URLs, response headers, storage URIs, cookies, or authorization material. `rawArtifactAccess.available` remains `false` until a separately privileged safe-viewer workstream is implemented and reviewed.

## Mutations

- Existing `PATCH /api/v1/admin/sources/:id` pauses or activates scheduling.
- `POST /api/v1/admin/circuit-breakers/:id/clear` clears one reviewed breaker.
- `POST /api/v1/admin/reviews/:id/company-merge` approves a stored company candidate and merges it.
- `POST /api/v1/admin/company-merges/split` reverses an active company merge.
- `POST /api/v1/admin/reviews/:id/opportunity-attach` approves a stored opportunity candidate.
- `POST /api/v1/admin/opportunity-memberships/split` reverses an active opportunity membership.

Every mutation requires an exact allowed origin, the operator role, cookie CSRF evidence when cookie authentication is used, an `Idempotency-Key`, and a reason of 8–1,000 characters. Review mutations bind the selected target back to the original stored review candidates. Domain stores append immutable decisions, fixtures, and audit events; replay with the same key returns the original result, while altered replay is rejected.

There are no delete endpoints or destructive bulk actions.
