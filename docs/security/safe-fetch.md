# Safe Fetch Boundary

`@career-os/safe-fetch` is the only approved primitive for retrieving employer and ATS artifacts. Connectors remain pure parsers: a worker resolves a reviewed source policy, invokes safe fetch, stores the bounded artifact, and then passes an artifact view to a connector.

The package exports the policy client and injectable transport *types*, but not its concrete network transport. Application code therefore cannot import a raw outbound implementation from the package entry point and bypass policy validation.

## Policy contract

Each source policy has a stable identifier and explicit exact or `*.` subdomain host rules. It also fixes accepted media types, requests per minute, concurrent requests, redirects, whole-operation timeout, compressed-wire bytes, decoded bytes, and a non-secret user agent. Library-owned hard ceilings remain in force even if trusted configuration is mistaken. Callers can supply only `Accept`, `If-None-Match`, and `If-Modified-Since`; authorization, cookie, proxy, forwarding, and arbitrary headers are not part of the port.

Policies must be registry-owned configuration. Do not construct host allowlists from a URL, job document, connector response, user prompt, or model output.

## Enforcement sequence

For the initial URL and every redirect, the client:

1. requires HTTPS on port 443 and rejects credentials, fragments, and literal IP hosts;
2. checks the normalized hostname against the policy allowlist;
3. resolves all DNS answers and rejects the hop if any answer is loopback, private, link-local, metadata-adjacent, documentation, multicast, reserved, or otherwise non-public;
4. deterministically selects one validated address and pins the socket lookup to it;
5. retains the original hostname for TLS SNI and certificate hostname verification, then confirms the connected peer is the pinned address;
6. follows redirects manually so the complete sequence repeats;
7. enforces the whole-call deadline across DNS and network I/O plus compressed and decoded byte ceilings; and
8. accepts only policy media types (with an explicit bodyless `304` path for conditional rechecks).

The Node transport directly uses `node:https` and does not inherit `HTTP_PROXY`, `HTTPS_PROXY`, or `ALL_PROXY`. Production deployments must not wrap it in an ambient proxy-aware agent. If an explicit egress proxy is introduced later, it needs a separate adapter and ADR preserving destination validation and TLS identity.

## Decision records

Every attempted hop creates an allowlisted decision record with policy ID, hop, timestamp, scheme, hostname, port, a one-way pathname hash, resolved and selected addresses, response status, outcome, and stable reason code. It never records URL credentials, query strings, raw paths, request/response bodies, response locations, cookies, authorization values, or exception messages. Observability failures cannot change policy outcomes.

## Runtime isolation

The current local Compose worker has only database and artifact capabilities, no candidate-private repository or model-provider secret, and remains attached solely to the internal backend network. External egress stays disabled until a discovery handler composes an approved registry policy with this client; enabling worker egress without that composition is not permitted.

## Verification

`tests/safe-fetch.test.ts` covers literal and encoded IPs, IPv4/IPv6 special-use ranges, mixed public/private DNS answers, address pinning, redirect revalidation, credentialed URLs, proxy-environment canaries, content type and decompression controls, timeouts, concurrency, conditional rechecks, telemetry canaries, and the connector ambient-network boundary.

These controls mitigate threat-model paths T01, T10, and T12. Network policy and application policy are complementary: infrastructure should further restrict worker egress where the deployment platform supports domain-aware or proxy-mediated controls.
