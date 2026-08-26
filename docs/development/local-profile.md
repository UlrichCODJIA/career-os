# Local Development Profile

The local profile starts the Career OS web shell, API, worker health surface, PostgreSQL, and a persistent artifact volume. Host ports bind to loopback only.

## Prerequisites

- Bun 1.3.14 for host-based checks.
- Docker Engine with Compose v2 for the complete profile.

## Start and verify

```bash
cp .env.example .env
bun run local:setup
bun install --frozen-lockfile
bun run check
bun run local:up
```

In another terminal:

```bash
bun run local:smoke
```

Open `http://127.0.0.1:3000`. Stop the profile with `bun run local:down`.

The checked-in `.env.example` contains no API credential. `bun run local:setup` generates a random one in the ignored `.env` file and preserves it on later runs. Replace the example database password before using a profile outside an isolated development machine.

Compose uses the explicit `container-loopback` boundary because each process listens on its container interface while Docker publishes web and API ports only to host loopback. The API still requires the generated bearer credential: environment labels cannot prove Docker isolation, and startup rejects every unauthenticated non-loopback API bind. Web and worker remain limited to their non-privileged shell/health surfaces.

Browser-sensitive requests still require an exact configured `Origin`. True host-loopback mode attributes accepted API and WebSocket requests to `local-operator`; container API requests use the generated credential. Neither mode is a remotely deployable hosted profile.

## Service contract

| Service | Container port | Host binding | Health path |
|---|---:|---|---|
| Web | 3000 | `127.0.0.1:3000` | `/healthz` |
| API | 4100 | `127.0.0.1:4100` | `/healthz` |
| Worker | 4101 | `127.0.0.1:4101` | `/healthz` |
| PostgreSQL | 5432 | internal network only | `pg_isready` |

The `artifacts` and `postgres-data` named volumes survive container restarts. No service imports, mounts, or resolves either legacy repository at runtime.
