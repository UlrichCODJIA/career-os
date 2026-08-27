# Source onboarding runbook

The source registry is a reviewed intake boundary. Imports create candidates only; they never create active discovery sources.

## Reviewed flow

1. Import at most 1,000 candidate rows through `POST /api/v1/admin/source-candidates/import`. Each row needs a company name and at least one primary domain, careers URL, or ATS URL.
2. Create or select a reviewed source policy. Approved policies require a future expiry, contact address, identified user agent, GET-only access, request rate, concurrency limit, retention class, and review evidence links when available.
3. Verify ownership using an employer-domain link, a matching ATS identity, or an explicit operator confirmation with a durable artifact or HTTPS evidence URL. Name-only matching is not evidence. Automatic evidence below 0.9 confidence stays in review.
4. Verification creates a company and disabled source. Activate it separately only after checking the resulting tenant, connector, region, cadence, policy, and ownership record.
5. Pause or block a policy immediately when terms, robots guidance, authorization, or ownership becomes disputed. The database disables associated sources and clears their next scan time while preserving all history.

Every mutation must include an operator reason and an `Idempotency-Key` of 8–128 URL-safe characters. Retrying the same request with the same key returns its original response; using that key for different content is rejected.

## Scheduling invariant

Workers must claim discovery work only from the `schedulable_sources` view. It excludes disabled sources, missing scan times, expired reviews, non-approved policies, expired policies, and sources without ownership evidence at or above 0.9 confidence. Reading the base `sources` table for scheduling is unsupported.

## Incident handling

Do not delete candidates, sources, ownership evidence, audit events, or lifecycle history. Pause the policy or disable the source, record the reason, and investigate from the immutable audit trail. If two companies claim one connector/region/tenant identity, leave the second candidate pending and resolve ownership before making any change.
