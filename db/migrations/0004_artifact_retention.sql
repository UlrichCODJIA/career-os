ALTER TABLE artifacts
  ADD COLUMN storage_state text NOT NULL DEFAULT 'present'
    CHECK (storage_state IN ('present', 'deleting', 'delete_failed', 'deleted', 'missing')),
  ADD COLUMN metadata_redaction_version text NOT NULL DEFAULT 'artifact-metadata-v1',
  ADD COLUMN deletion_started_at timestamptz,
  ADD COLUMN deleted_at timestamptz,
  ADD COLUMN deletion_error text,
  ADD COLUMN last_reconciled_at timestamptz;

ALTER TABLE artifacts
  ADD CONSTRAINT artifacts_storage_state_consistency CHECK (
    (storage_state = 'present' AND deletion_started_at IS NULL AND deleted_at IS NULL AND deletion_error IS NULL)
    OR (storage_state = 'deleting' AND deletion_started_at IS NOT NULL AND deleted_at IS NULL AND deletion_error IS NULL)
    OR (storage_state = 'delete_failed' AND deletion_started_at IS NULL AND deleted_at IS NULL AND deletion_error IS NOT NULL)
    OR (storage_state = 'deleted' AND deletion_started_at IS NULL AND deleted_at IS NOT NULL AND deletion_error IS NULL)
    OR (storage_state = 'missing' AND deletion_started_at IS NULL AND deleted_at IS NULL AND deletion_error IS NULL)
  );

CREATE INDEX artifacts_retention_due_idx
  ON artifacts (deletion_due_at, created_at)
  WHERE deletion_due_at IS NOT NULL AND storage_state IN ('present', 'delete_failed', 'deleting');

CREATE INDEX artifacts_present_reconciliation_idx
  ON artifacts (created_at, id)
  WHERE storage_state = 'present';
