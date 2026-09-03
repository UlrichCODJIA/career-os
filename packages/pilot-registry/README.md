# Pilot registry

This package validates a private, operator-reviewed 1,000-company pilot manifest before any database write. It enforces exact connector tenant URLs, bounded policy and evidence freshness, ICANN registrable employer identities, unique employer domains and ATS identities, employer-domain ownership evidence, twice-daily cadence, and explicit quarantine records.

Production manifests do not belong in Git. Use `private/pilot-registry.json`, run `bun run pilot:verify`, then apply only after reviewing the aggregate report with `bun run pilot:apply`.
