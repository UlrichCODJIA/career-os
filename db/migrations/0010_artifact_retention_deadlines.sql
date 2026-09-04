UPDATE artifacts
SET deletion_due_at = retrieved_at + CASE retention_class
  WHEN 'licensed-ephemeral' THEN interval '1 day'
  WHEN 'verification' THEN interval '1 hour'
  ELSE interval '30 days'
END
WHERE deletion_due_at IS NULL;

ALTER TABLE artifacts
  ALTER COLUMN deletion_due_at SET NOT NULL;
