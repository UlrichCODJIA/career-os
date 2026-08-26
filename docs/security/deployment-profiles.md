# Deployment Security Profiles

Career OS distinguishes the process bind from the externally reachable security boundary. Startup configuration is validated before a server is created.

| Boundary | Intended use | Bind rule | Authentication | Transport and origin rule |
|---|---|---|---|---|
| `loopback` | Host-based local development | Loopback host only | Explicit `local-operator` principal | Public URL and every allowed origin must be loopback |
| `container-loopback` | Local Compose | Container interface allowed only in a non-hosted profile with `LOCAL_ONLY=true` | Generated bearer credential for every non-loopback API bind | Docker must publish only loopback host ports; configured origins remain loopback |
| `remote` | Hosted API | Loopback behind a proxy or a non-loopback bind | Opaque bearer or cookie credentials; operator credential required | HTTPS public URL/origins plus direct TLS files or an exact trusted-proxy IP list |

Only the API supports the `remote` boundary today. Web and worker entry points fail startup if asked to use it; they remain internal or loopback-only until their hosted controls are implemented. Run `bun run local:setup` before Compose; it creates the ignored `.env` credential required by the container API. Health stays public and path-free.

## Required hosted variables

```text
CAREER_OS_PROFILE=hosted
NETWORK_BOUNDARY=remote
LOCAL_ONLY=false
DISCOVERY_PUBLIC_BASE_URL=https://career.example
ALLOWED_ORIGINS=https://career.example
AUTH_MODE=bearer|cookie
AUTH_OPERATOR_TOKEN=<at least 32 random characters>
AUTH_USER_TOKEN=<optional distinct credential>
TRANSPORT_SECURITY=tls|trusted-proxy
```

Cookie mode additionally requires `AUTH_CSRF_SECRET`. Direct TLS requires `TLS_CERT_FILE` and `TLS_KEY_FILE`. Trusted-proxy mode requires `TRUSTED_PROXY_IPS`; `X-Forwarded-Proto: https` is accepted only when the network peer is one of those exact addresses.

Secrets belong in an approved environment secret mount or manager, never `.env.example`, logs, health output, or browser bundles. The health contract is strict and contains only service, status, profile, timestamp, and version.

## Request behavior

- HTTP and WebSocket upgrades call the same authenticator and carry the same principal shape. Browser WebSocket clients should use cookie mode or a future same-origin proxy because browser constructors cannot attach bearer headers.
- Operator routes require the `operator` role.
- Unsafe HTTP requests and every WebSocket upgrade require an exact normalized origin match.
- Cookie-authenticated requests require an origin; cookie mutations additionally require `X-CSRF-Token`, derived from the session credential and server-side CSRF secret.
- CORS preflight responses never use wildcard origins or credentials.
- Approval-boundary requests require an idempotency key. Durable approval and audit persistence are intentionally deferred to their database-backed workstream.
