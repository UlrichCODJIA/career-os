ALTER TABLE source_scans
  DROP CONSTRAINT source_scans_work_job_id_key,
  ADD COLUMN lease_generation bigint,
  ADD COLUMN policy_id uuid REFERENCES source_policies(id),
  ADD COLUMN delivery_hash char(64) NOT NULL DEFAULT repeat('0', 64) CHECK (delivery_hash ~ '^[0-9a-f]{64}$'),
  ADD COLUMN fetch_metadata jsonb NOT NULL DEFAULT '{}',
  ADD COLUMN error_code text,
  ADD COLUMN error_message text;

UPDATE source_scans scan SET
  lease_generation = greatest(job.lease_generation, 1),
  policy_id = source.policy_id
FROM work_jobs job, sources source
WHERE scan.work_job_id = job.id AND scan.source_id = source.id;

UPDATE source_scans SET
  error_code = 'historical_failure',
  error_message = 'Failure recorded before classified scan errors were introduced'
WHERE completeness_state = 'failed';

ALTER TABLE source_scans
  ALTER COLUMN lease_generation SET NOT NULL,
  ALTER COLUMN policy_id SET NOT NULL,
  ALTER COLUMN delivery_hash DROP DEFAULT,
  ADD CONSTRAINT source_scans_lease_generation_positive CHECK (lease_generation > 0),
  ADD CONSTRAINT source_scans_attempt_uq UNIQUE (work_job_id, lease_generation),
  ADD CONSTRAINT source_scans_error_shape CHECK (
    (completeness_state = 'failed' AND error_code IS NOT NULL AND error_message IS NOT NULL)
    OR (completeness_state <> 'failed' AND error_code IS NULL AND error_message IS NULL)
  );

ALTER TABLE source_scans DROP CONSTRAINT source_scans_completeness_reason_check;
ALTER TABLE source_scans ADD CONSTRAINT source_scans_completeness_reason_check CHECK (completeness_reason IN (
  'complete', 'pagination_incomplete', 'schema_invalid', 'suspicious_empty', 'blocked', 'transport_failure', 'limit_exceeded'
));

CREATE TABLE source_scan_artifacts (
  source_scan_id uuid NOT NULL REFERENCES source_scans(id),
  artifact_id uuid NOT NULL REFERENCES artifacts(id),
  response_order integer NOT NULL CHECK (response_order >= 0),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY (source_scan_id, response_order)
);

CREATE INDEX source_scan_artifacts_artifact_idx ON source_scan_artifacts (artifact_id);

CREATE TABLE source_observations (
  id uuid PRIMARY KEY,
  source_scan_id uuid NOT NULL REFERENCES source_scans(id),
  source_listing_id uuid NOT NULL REFERENCES source_listings(id),
  listing_version_id uuid NOT NULL REFERENCES listing_versions(id),
  artifact_id uuid NOT NULL REFERENCES artifacts(id),
  observed_at timestamptz NOT NULL,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  UNIQUE (source_scan_id, source_listing_id)
);

CREATE INDEX source_observations_listing_history_idx
  ON source_observations (source_listing_id, observed_at DESC);

CREATE VIEW source_health AS
SELECT
  source.id AS source_id,
  source.health_state,
  source.consecutive_failures,
  source.last_attempt_at,
  source.last_success_at,
  source.last_complete_at,
  source.last_nonempty_at,
  source.last_job_count,
  latest.completeness_state AS latest_completeness_state,
  latest.completeness_reason AS latest_completeness_reason,
  latest.ended_at AS latest_scan_ended_at
FROM sources source
LEFT JOIN LATERAL (
  SELECT scan.completeness_state, scan.completeness_reason, scan.ended_at
  FROM source_scans scan
  WHERE scan.source_id = source.id AND scan.ended_at IS NOT NULL
  ORDER BY scan.ended_at DESC, scan.id DESC
  LIMIT 1
) latest ON true;

CREATE FUNCTION reject_final_scan_change()
RETURNS trigger
LANGUAGE plpgsql
AS $function$
BEGIN
  IF TG_OP = 'DELETE' OR OLD.ended_at IS NOT NULL THEN
    RAISE EXCEPTION 'source_scans is an immutable completed ledger' USING ERRCODE = '55000';
  END IF;
  RETURN NEW;
END
$function$;

CREATE TRIGGER source_scans_final_immutable
BEFORE UPDATE OR DELETE ON source_scans
FOR EACH ROW EXECUTE FUNCTION reject_final_scan_change();

CREATE TRIGGER source_scan_artifacts_immutable
BEFORE UPDATE OR DELETE ON source_scan_artifacts
FOR EACH ROW EXECUTE FUNCTION reject_immutable_change();

CREATE TRIGGER source_observations_immutable
BEFORE UPDATE OR DELETE ON source_observations
FOR EACH ROW EXECUTE FUNCTION reject_immutable_change();
