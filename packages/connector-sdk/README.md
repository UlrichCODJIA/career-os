# Connector SDK package

Capability-restricted, versioned connector contracts and a frozen-fixture/shadow-diff harness. Connectors receive isolated bounded artifact copies, not ambient network, database, filesystem, artifact-store, model, or lifecycle-write capabilities.

The SDK validates connector outputs at the boundary. Required listing fields carry an artifact-backed JSON pointer or text span. Enumeration exposes a reason enum; only `complete` derives `successfulForAbsenceInference=true`, so partial, blocked, suspicious, invalid, failed, or limited responses cannot close jobs.

Use `parseBoundedJson` for JSON artifacts and `sanitizeUntrustedHtml` for a conservative text/no-active-markup display derivative. Original bytes stay in the restricted artifact store. Every connector release must run versioned frozen fixtures and a bounded shadow diff before activation.
