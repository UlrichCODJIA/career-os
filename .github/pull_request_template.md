## Outcome

Describe the user or system outcome, not only the files changed.

## Tracking and architecture

- Linear/GitHub issue:
- Specification sections:
- ADRs:
- Threat IDs:

## Verification

- [ ] `bun install --frozen-lockfile`
- [ ] `bun run typecheck`
- [ ] `bun test`
- [ ] `bun run build`
- [ ] `bun run verify:migrations`
- [ ] Security/privacy boundary reviewed
- [ ] Dependency or action changes are reflected in `bun.lock` and use immutable action SHAs
- [ ] Generated SBOM artifact and provenance impact reviewed when dependencies or build outputs change
- [ ] Migration, rollback, or forward-fix notes included when applicable
- [ ] Screenshots included for user-interface work

## Data and provenance

- External inputs introduced:
- Data retention/license implications:
- Copied/adapted code or fixtures and source revision:

## Consequential actions

Does this change send, submit, publish, share private data, or mutate an external system? If yes, document policy, preview, approval, idempotency, and receipt behavior.
