# Migrations

Migrations are reviewed, forward-only SQL files named `NNNN_descriptive_name.sql`.

Run them with `DATABASE_URL=... bun run db:migrate`. The runner:

- validates a contiguous migration sequence and rejects transaction-control or privileged SQL;
- serializes concurrent callers with a PostgreSQL transaction advisory lock;
- applies pending files and records their SHA-256 checksums in the same transaction;
- refuses edited, missing, or unknown applied migrations.

Never edit an applied migration. Add the next numbered migration to correct or extend the schema.
