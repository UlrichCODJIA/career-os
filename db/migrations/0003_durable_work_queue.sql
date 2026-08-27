ALTER TABLE work_jobs
  ADD COLUMN lease_generation bigint NOT NULL DEFAULT 0 CHECK (lease_generation >= 0);

UPDATE work_jobs
SET leased_at = NULL, lease_expires_at = NULL, lease_owner = NULL, lease_token = NULL
WHERE status <> 'leased';

UPDATE work_jobs SET lease_generation = 1 WHERE status = 'leased';

ALTER TABLE work_jobs
  ADD CONSTRAINT work_jobs_lease_fields_cleared CHECK (
    status = 'leased'
    OR (leased_at IS NULL AND lease_expires_at IS NULL AND lease_owner IS NULL AND lease_token IS NULL)
  );

CREATE INDEX work_jobs_lease_expiry_idx
  ON work_jobs (lease_expires_at, id)
  WHERE status = 'leased';

CREATE INDEX work_jobs_claim_idx
  ON work_jobs (scheduled_at, priority DESC, id)
  WHERE status IN ('queued', 'retryable_failed');

CREATE FUNCTION reject_lease_generation_regression()
RETURNS trigger
LANGUAGE plpgsql
AS $function$
BEGIN
  IF NEW.lease_generation < OLD.lease_generation THEN
    RAISE EXCEPTION 'lease generation cannot decrease' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END
$function$;

CREATE TRIGGER work_jobs_lease_generation_guard
BEFORE UPDATE OF lease_generation ON work_jobs
FOR EACH ROW EXECUTE FUNCTION reject_lease_generation_regression();
