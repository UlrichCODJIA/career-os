# Database package

This package owns parameterized Bun SQL access, transaction helpers, and the forward-only migration runner. Reviewed SQL files remain under `db/migrations`; production API and worker roles must not receive schema-altering privileges.
