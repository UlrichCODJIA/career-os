# Connector SDK and release contract

## Boundary

ATS connectors are pure detection and parsing adapters. The orchestrator owns retrieval, persistence, lifecycle mutation, and activation. It passes each connector an isolated copy of a bounded artifact and validates every returned value with the exported Zod schemas. A connector contract never receives a network client, database handle, artifact-store handle, candidate-private repository, model credential, or lifecycle writer.

The TypeScript interface documents this capability boundary; application composition must enforce it by constructing connectors with no ambient authorities. Connector packages must not import networking, persistence, model, or application modules.

## Versioned contracts

`packages/connector-sdk` exposes strict contracts for:

- connector identity and source descriptors;
- detection results and safe-fetch request plans;
- enumerated source-local listings;
- parsed listings whose required fields carry artifact-backed evidence;
- explicit scan completeness and stable failure reasons.

`complete` and `completenessReason` must agree. Only `{ complete: true, completenessReason: "complete" }` is eligible to prove absence. Partial pagination, schema drift, unexpected empty responses, policy blocks, transport failures, and resource-limit failures may add or update observations, but can never close an absent job.

Enumeration output must identify only artifacts from its response. Parsed evidence must identify only artifacts supplied to that parse invocation. Connector IDs and versions in output must match the active implementation.

## Parsing and display safety

`parseBoundedJson` applies fatal UTF-8 decoding plus byte, depth, node, and string ceilings. `sanitizeUntrustedHtml` strips markup and script/style bodies, then emits plaintext and fully escaped display HTML. Raw permitted bytes remain in the restricted content-addressed artifact store; sanitized derivatives do not replace provenance.

These helpers are the baseline, not permission to parse arbitrary responses. The orchestrator must first validate status, content type, safe-fetch policy, decompressed size, and connector-specific envelope.

## Frozen fixtures

Every connector version ships a manifest and captured artifacts with:

- a fixed fixture-format and connector version;
- source/capture provenance;
- affirmative license review and sanitization declarations;
- normalized repository-relative paths with traversal rejected;
- exact expected result or stable error code per case.

The baseline corpus covers valid, empty, incomplete pagination, malformed, oversized, hostile-HTML, and schema-drift cases. Connector suites add every supported pagination and response-schema variant. Real captures must be minimized, sanitized, and legally reviewed before commit; secrets and candidate-private data are prohibited.

## Release gate

Before activation, a connector version must:

1. pass schemas, frozen fixtures, adversarial fixtures, and the repository check;
2. run in shadow mode against a bounded sample of recent permitted artifacts;
3. record bounded, path-specific diffs without mutating canonical state;
4. receive sampled diff review and explicit activation outside connector code.

Rollback changes the active version and queues bounded reprocessing. It never deletes earlier parser versions, artifacts, observations, or review evidence.
