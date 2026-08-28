# Fixtures

Frozen fixtures are sanitized, license-reviewed, versioned, and paired with expected outputs. `connector-sdk/manifest.json` is the synthetic security contract corpus for valid, empty, partial, malformed, oversized, hostile-HTML, and schema-drift behavior. Connector-specific source captures must record equivalent provenance before being committed.

`greenhouse/manifest.json` is the versioned Greenhouse connector corpus. It covers valid enumeration, valid hostile detail content, a well-formed empty board, source count mismatch, schema drift, and malformed JSON. The samples are synthetic and retain only fields needed to exercise the public Job Board API contract.

`lever/manifest.json` is the versioned Lever Postings API corpus. It covers valid enumeration, hostile detail content, a suspicious first-page empty response, schema drift, and malformed JSON; code-generated tests separately exercise full-page pagination, a terminal page, duplicate IDs, and global/EU identity drift.

`ashby/manifest.json` is the versioned Ashby Public Job Posting API corpus. It covers exact detection, valid enumeration and hostile full-record parsing from the single board response, suspicious emptiness, schema drift, and malformed JSON; generated tests separately exercise unlisted filtering, duplicate/cross-tenant identity drift, exact detail selection, and safe-fetch redirects.
