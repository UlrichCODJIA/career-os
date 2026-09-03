# Controlled pilot registry

The pilot registry is private operational data. Never commit employer/source manifests, credentials, raw job descriptions, or licensed payloads. The repository contains only the validator, importer, aggregate evidence format, and synthetic tests.

## Manifest review

Place the reviewed manifest at `private/pilot-registry.json`. It must contain exactly 1,000 verified employer/source pairs plus an optional explicit quarantine list. Every verified row needs:

- one unique employer primary domain and an employer-hosted careers URL;
- one unique Greenhouse, Lever, or Ashby region/tenant identity with exact public board and API URLs;
- an employer-domain evidence URL that links the employer to that ATS tenant, confidence of at least `0.9`, an observation timestamp, and a human review reason;
- connector version `1.0.0`, a 43,200-second cadence, source attribution, and a current reviewed policy.

Production manifests use `classification: "production"`. Employer identities must be ICANN registrable domains rather than public suffixes. Dataset generation/review and ownership observations must be no more than seven days old; policy reviews must be no more than 30 days old and may cover at most 90 days. Observation and policy review timestamps cannot postdate the dataset review.

Rows with uncertain ownership, malformed identity, duplicate domain/tenant, weak evidence, or policy ambiguity belong in `quarantine`; never repair them by guessing.

`db/seeds/pilot-registry.example.json` is a one-row `synthetic` schema example only. Verify it with `bun run scripts/pilot-registry.ts verify --manifest db/seeds/pilot-registry.example.json --expected 1`; the operator CLI refuses to apply synthetic manifests.

## Dry run and apply

Run `bun run pilot:verify`. The command emits aggregate counts and a manifest SHA-256, never company domains or tenant keys. Review that report, then set `DATABASE_URL`, `PILOT_REGISTRY_ACTOR`, and `PILOT_REGISTRY_CONFIRM_SHA256` to the exact dry-run digest before running `bun run pilot:apply -- --report private/pilot-apply-report.json`.

Application is resumable and uses deterministic idempotency keys. It creates or verifies exact current policies, imports candidates, records append-only ownership evidence and audit events, activates only verified sources, leaves quarantined rows pending for operator review, and then queries the database for the 1,000 verified companies, 1,000 active twice-daily sources, 1,000 high-confidence evidence records, current policies, zero duplicate tenants, and zero cadence drift. The report is created with exclusive-write semantics so existing evidence is not overwritten.

## Sampling and rollback

Before the pilot starts, sample at least 10 rows from each connector and 10 rows from each discovery stratum. Open the employer evidence URL and verify that it still links to the exact tenant and that the public endpoint represents the same company. Record decisions outside Git in the controlled review system.

To stop the pilot, disable sources or pause their policies through the audited operator API. Do not delete companies, candidates, evidence, policies, audits, scans, or lifecycle history.
