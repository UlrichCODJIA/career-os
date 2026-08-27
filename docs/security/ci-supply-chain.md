# CI and Software Supply-Chain Baseline

DSV-004 establishes the minimum delivery controls for Career OS. It does not claim that later database, connector, deployment, or release gates are already implemented.

## Pull-request boundary

The `CI` workflow runs with `contents: read` and does not consume repository, deployment, or production secrets. It never uses `pull_request_target`. Five independently visible checks cover:

- the frozen install, typecheck, tests, build, and repository policy;
- forward-migration naming, sequence, file-type, and prohibited-SQL validation;
- full-history secret scanning with comments and result uploads disabled;
- dependency-change review at moderate-or-higher severity across runtime, development, and unknown scopes;
- SPDX JSON SBOM generation and a short-retention review artifact.

Every external action reference is pinned to a full commit SHA. Dependabot may propose action and Bun dependency updates, but the resulting lockfile and workflow diffs remain ordinary reviewed pull-request changes.

## Post-merge provenance boundary

The `Build provenance` workflow runs only on `main` pushes or explicit manual dispatch. It alone receives `id-token: write` and `attestations: write`, builds from a frozen lockfile, creates an SPDX SBOM, archives the build output, and publishes a GitHub/Sigstore attestation binding that archive to the SBOM. It uses the ephemeral GitHub token and no production credentials.

## Migration baseline

DSV-004 validates the migration directory even though DSV-005 owns the first production schema. Future migrations must be regular, non-symlink SQL files named `NNNN_descriptive_name.sql`, use one contiguous sequence beginning at `0001`, contain nonempty SQL, and avoid process execution or database/server-level administration. DSV-005 will add empty-database application and schema assertion tests.

## Required checks and review

The protected `main` branch should require these pull-request checks:

- `Validate repository baseline`
- `Validate migrations`
- `Scan repository secrets`
- `Review dependency changes`
- `Generate SBOM`

Require branches to be current, resolve review conversations, use linear history, and disallow bypass, force-push, and deletion. `bun.lock`, package manifests, workflows, and security documentation have explicit owners so their changes are visible to the maintainer. Enable required code-owner approval when a second eligible maintainer exists; GitHub does not allow the author to approve their own pull request, so enabling it for the current single-maintainer repository would deadlock delivery rather than add an independent review.

## Failure behavior

- A noncontiguous, malformed, symlinked, empty, or administratively unsafe migration fails `verify:migrations`.
- A mutable action tag, repository-secret expression, `pull_request_target`, missing CI check, or PR-triggered provenance workflow fails `verify:workflows`.
- A detected secret, newly vulnerable dependency, failed build, or missing SBOM fails its owning GitHub check.
- No provenance claim is produced until the code has landed on protected `main`.
