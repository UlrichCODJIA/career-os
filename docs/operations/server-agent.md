# Career OS Codex on the Azure VM

The target is a laptop-independent Linux Codex workspace: connect privately over SSH, run `codex` interactively, work on this repository, and inspect server-owned scheduled progress in the terminal. An authorized agent may deploy after the repository's backup, release-subject, migration, and safety checks. Employer-to-board attestation, registry replacement approval, and final release sign-off remain human decisions.

## Current state and limits

As of 2026-09-29, Codex CLI 0.157.1 is installed and ChatGPT-authenticated under the private `codexagent` account. One read-only `codex exec --ephemeral` run succeeded. That account has no login shell, sudo, or Docker access and cannot serve as the requested interactive SSH/deployment user. A separate checkout at `27694e6b5beb5eb8b3399b3dba3af103ce71f7ad` and a sanitized handoff exist under `/home/codexagent`. Do not copy its `auth.json` to another user or into Git. The same verified standalone CLI binary is now available to `azureuser` at `/usr/local/bin/codex`, but `azureuser` must complete its own device login.

The VM's public SSH, API, and database ports remain closed. The temporary Azure Bastion and dedicated IP were removed. Tailscale is joined to the operator's tailnet. A persistent VM firewall guard permits only the operator laptop's pinned Tailscale address to reach TCP/22 and drops other inbound tailnet traffic, including forwarded traffic. OpenSSH still requires the existing key and disables password authentication; Tailscale SSH is not enabled. Key-authenticated `ssh career-os-soak-01` from the laptop succeeded against the host key saved during the Bastion migration. If the laptop's Tailscale IP changes or the firewall guard fails, access must fail closed and be repaired through an authorized management path. Neither a server soak-monitor timer nor a server Codex-work timer is enabled. `SOAK_STARTED_AT` remains unset. The existing release start gate also expects `.git` inside a deployed image that lacks it; fix and verify that mismatch before starting a new seven-day soak.

The installed CLI uses the user's ChatGPT sign-in and normal usage limits, not a separate OpenAI API key. A new Unix user must sign in separately; the server does not inherit this laptop's auth, Chrome state, plugins, or Scheduled UI. [Codex CLI](https://learn.chatgpt.com/docs/codex/cli) and [non-interactive mode](https://learn.chatgpt.com/docs/non-interactive-mode) describe interactive and scheduled CLI use.

## Private access and interactive work

1. Keep the Azure NSG closed to public SSH; do not publish the Codex app server, API, or PostgreSQL. The laptop's SSH config contains the concrete `career-os-soak-01` alias with the verified VM host key and Azure private key. The VM guard is `/etc/career-os/tailnet-guard.nft` with the required `career-os-tailnet-guard.service` dependency on `tailscaled.service`. Recheck both after any tailnet, address, or network change.
2. The ordinary `azureuser` account has a writable development checkout at `/home/azureuser/career-os-dev`, separate from production `/opt/career-os`. On that account, run `codex login --device-auth` and verify `codex login status`. Do not share passwords, device codes, API keys, or another account's auth file in commands or logs.
3. Test `ssh career-os-soak-01` from the laptop, then `cd /home/azureuser/career-os-dev && codex`. Verify source edits, tests, Git operations, and a bounded deployment dry run separately. `azureuser` already has passwordless sudo, which is effectively production-admin access; preserve the documented backup and release gates.
4. In the desktop app, add the SSH host and save the same Git repository on it. Use the app's host handoff to transfer the existing chat and Git state. A chat cannot hand itself off while running; perform the handoff from its footer after this turn or from a different chat. Verify that the handed-off chat can also be resumed in the server terminal before promising CLI transcript continuity. [Remote connections](https://learn.chatgpt.com/docs/remote-connections)

The desktop app may be used to initiate a handoff, but the interactive server CLI and server timers must work with the laptop shut down. The CLI does **not** provide the desktop Scheduled management screen. Use `systemctl` and `journalctl` for the server-owned job status; see [Scheduled tasks](https://learn.chatgpt.com/docs/automations).

## Independent scheduling and deployment

The deterministic [soak monitor](server-soak-monitor.md) is separate from a Codex coding session. First deploy and validate its aggregate preflight under a new release commit, then enable its VM timer and observe two runs. Before the soak starts it performs a read-only aggregate check; after the full start gate and a fresh timestamp it captures immutable evidence. It never starts the clock, approves empty boards, or closes held listings.

For recurring Codex work, define a bounded prompt, working checkout, timeout, output location, and systemd service/timer. Test `codex exec` manually with saved ChatGPT auth before enabling a schedule. The task may prepare code and a deployment when the requested task, backup, and gates warrant it, but it must not claim human review or silently change the approved registry. Keep the schedule disabled on auth failure, repeated errors, missing live status, or usage exhaustion. The first successful server run and its journal record are the acceptance test; creating unit files alone is not completion.

Terminal checks after installation:

```sh
systemctl list-timers 'career-os-*'
systemctl status career-os-soak-monitor.timer career-os-soak-monitor.service
journalctl -u career-os-soak-monitor.service -n 100 --no-pager
```

This account may use Docker and deployment credentials only when intentionally configured for that role. No scheduled agent may bypass `release:check-soak-start`, the backup/restore requirement, or the authorized human operator decisions in [verified-empty board operations](verified-empty-boards.md).
