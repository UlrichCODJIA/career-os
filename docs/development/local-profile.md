# Local Development Profile

The local profile starts the Career OS web shell, API, worker health surface, PostgreSQL, and a persistent artifact volume. Host ports bind to loopback only.

## Prerequisites

- Bun 1.3.14 for host-based checks.
- Docker Engine with Compose v2 for the complete profile.

## Start and verify

```bash
cp .env.example .env
bun install --frozen-lockfile
bun run check
bun run local:up
```

In another terminal:

```bash
bun run local:smoke
```

Open `http://127.0.0.1:3000`. Stop the profile with `bun run local:down`.

The checked-in `.env.example` contains local-only example values, never deployed credentials. Replace the database password before using a profile outside an isolated development machine. Non-loopback deployment authentication is implemented separately in DSV-003; this profile deliberately publishes only loopback ports.

## Service contract

| Service | Container port | Host binding | Health path |
|---|---:|---|---|
| Web | 3000 | `127.0.0.1:3000` | `/healthz` |
| API | 4100 | `127.0.0.1:4100` | `/healthz` |
| Worker | 4101 | `127.0.0.1:4101` | `/healthz` |
| PostgreSQL | 5432 | internal network only | `pg_isready` |

The `artifacts` and `postgres-data` named volumes survive container restarts. No service imports, mounts, or resolves either legacy repository at runtime.
