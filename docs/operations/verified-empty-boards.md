# Verified-empty boards and safe soak restart

An ATS board can be reliably fetched while listing zero public jobs. Source `health_state=healthy` means the check succeeded; `inventory_state=confirmed_empty` means the empty inventory was verified. Neither means that unlisted jobs are closed. The operator UI shows both states separately.

## Lifecycle

For a board with any listing history, two complete-shape `suspicious_empty` scan responses must have the same board hash, source identity, connector version, tenant, and policy, and be separated by 30 minutes to 24 hours. A failed, blocked, incomplete, nonempty, or changed intervening scan prevents a review candidate. A board with no listing history retains its two-scan automatic path. Raw scan bodies and sensitive URLs are not placed in ordinary API responses or logs.

An authorized human visits the current employer-owned careers page, follows its link to the exact ATS board, and checks the ownership evidence and two scan IDs in `/operator`. The confirmation request records the employer careers URL, ownership evidence ID, scan IDs, reason, and explicit attestation. The immutable confirmation expires after 14 days. The transaction places historical nonclosed listings in `possibly_closed` with closure holds, projects opportunities from all nonrejected members, and queues one source canary. A matching empty canary is `complete` and restores health, but never qualifies for automatic absence inference. The hold prevents automatic permanent closure. If jobs reappear, observed listings reopen and all holds are removed so ordinary nonempty-scan lifecycle can resume from a fresh miss count.

A rejected review remains visible in the durable decision history. The same unchanged board, policy revision, and connector snapshot will not regenerate an identical pending review; investigate the source identity or policy before retrying.

Permanent bulk closure is a separate operator action. It requires a still-current confirmation and policy, no breaker, two post-approval healthy-empty scans at least 30 minutes apart with no disqualifying intervening scan, the exact expected held-listing count, and a separate reason. This action appends a closure decision and audit events. It is not implied by approval or by repeated automatic scans.

## Deployment sequence for the Azure pilot

1. Keep the soak timer disabled. Freeze a new 40-character release commit after local checks pass; verify the approved 1,000-source manifest and digest have not changed. A changed or stale source identity needs a separately reviewed replacement manifest and new digest.
2. Before altering the VM, stop the worker at a consistency boundary and take fresh PostgreSQL and artifact backups. Verify archive checksums and restoreability, then transfer the backups directly to the local machine over a newly authorized, time-limited private Bastion session. Do not use Blob staging or open public SSH, app, or database ports.
3. Deploy that exact commit, run the forward-only migration, and restart services with the soak timer disabled. Never start the older scanner against databases containing closure holds. On rollback, stop the worker and forward-fix or restore the verified predeployment snapshot.
4. Inspect the pending empty-board queue as a human. Resolve policy or transport failures, confirm only current employer-to-exact-board links, reject stale boards, and allow each approval's bounded canary to complete. Check all 1,000 source health and inventory states and that held-only opportunities are absent from active search.
5. Run `bun run release:check-soak-start` on the VM with the exact `RELEASE_COMMIT`, `REGISTRY_DIGEST`, and approved manifest. Refresh policies or confirmations that will not remain valid for eight days. Start a new seven-day clock only after the command reports `ready: true` and the operator review is complete. Preserve prior evidence without relabelling it.
6. Remove the temporary Bastion host and its dedicated public IP after transfer, deployment, and checks. Record the removal; the VM and Docker volumes remain. Re-establish private access only through a new authorized session.

No automation may attest the employer link on the reviewer's behalf or silently replace an approved registry source.
