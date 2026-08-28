# Fixtures

Frozen fixtures are sanitized, license-reviewed, versioned, and paired with expected outputs. `connector-sdk/manifest.json` is the synthetic security contract corpus for valid, empty, partial, malformed, oversized, hostile-HTML, and schema-drift behavior. Connector-specific source captures must record equivalent provenance before being committed.

`greenhouse/manifest.json` is the versioned Greenhouse connector corpus. It covers valid enumeration, valid hostile detail content, a well-formed empty board, source count mismatch, schema drift, and malformed JSON. The samples are synthetic and retain only fields needed to exercise the public Job Board API contract.
