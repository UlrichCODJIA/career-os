ALTER TABLE source_candidates
  ADD COLUMN candidate_fingerprint char(64),
  ADD COLUMN verified_company_id uuid REFERENCES companies(id),
  ADD COLUMN verified_source_id uuid;

UPDATE source_candidates
SET candidate_fingerprint = md5(concat_ws('|',
  lower(coalesce(raw_company_name, '')),
  lower(coalesce(raw_domain, '')),
  lower(coalesce(raw_careers_url, '')),
  lower(coalesce(raw_ats_url, ''))
)) || md5(concat_ws('|',
  lower(coalesce(raw_ats_url, '')),
  lower(coalesce(raw_careers_url, '')),
  lower(coalesce(raw_domain, '')),
  lower(coalesce(raw_company_name, ''))
));

ALTER TABLE source_candidates ALTER COLUMN candidate_fingerprint SET NOT NULL;

CREATE UNIQUE INDEX source_candidates_fingerprint_uq ON source_candidates (candidate_fingerprint);
CREATE INDEX source_candidates_review_queue_idx ON source_candidates (review_state, first_observed_at);

ALTER TABLE source_policies DROP CONSTRAINT source_policies_access_class_check;
ALTER TABLE source_policies
  ADD CONSTRAINT source_policies_access_class_check CHECK (access_class IN (
    'documented_public_feed',
    'employer_authorized_api',
    'public_employer_html',
    'licensed_ephemeral',
    'user_supplied',
    'blocked'
  )),
  ADD CONSTRAINT source_policies_review_window CHECK (expires_at IS NULL OR expires_at > reviewed_at),
  ADD CONSTRAINT source_policies_approved_has_expiry CHECK (state <> 'approved' OR expires_at IS NOT NULL),
  ADD CONSTRAINT source_policies_host_pattern_shape CHECK (
    host_pattern ~ '^(\*\.)?([a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$'
  );

CREATE TABLE ownership_evidence (
  id uuid PRIMARY KEY,
  source_candidate_id uuid NOT NULL REFERENCES source_candidates(id),
  company_id uuid NOT NULL REFERENCES companies(id),
  source_id uuid NOT NULL REFERENCES sources(id),
  evidence_type text NOT NULL CHECK (evidence_type IN ('employer_domain_link', 'ats_identity', 'operator_confirmation')),
  artifact_id uuid REFERENCES artifacts(id),
  evidence_url text,
  statement text NOT NULL CHECK (length(btrim(statement)) >= 8),
  confidence numeric(5,4) NOT NULL CHECK (confidence BETWEEN 0 AND 1),
  recorded_by text NOT NULL,
  recorded_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  CONSTRAINT ownership_evidence_locator CHECK (artifact_id IS NOT NULL OR evidence_url IS NOT NULL),
  UNIQUE (source_candidate_id, source_id, evidence_type)
);
CREATE INDEX ownership_evidence_source_idx ON ownership_evidence (source_id, confidence DESC);

ALTER TABLE source_candidates
  ADD CONSTRAINT source_candidates_verified_source_fk
  FOREIGN KEY (verified_source_id) REFERENCES sources(id) DEFERRABLE INITIALLY DEFERRED,
  ADD CONSTRAINT source_candidates_verified_links CHECK (
    (review_state = 'verified' AND verified_company_id IS NOT NULL AND verified_source_id IS NOT NULL)
    OR (review_state <> 'verified' AND verified_company_id IS NULL AND verified_source_id IS NULL)
  );

CREATE TABLE idempotency_records (
  id uuid PRIMARY KEY,
  actor_id text NOT NULL,
  operation text NOT NULL,
  idempotency_key text NOT NULL CHECK (idempotency_key ~ '^[A-Za-z0-9._:-]{8,128}$'),
  request_hash char(64) NOT NULL CHECK (request_hash ~ '^[0-9a-f]{64}$'),
  response_json jsonb,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  completed_at timestamptz,
  expires_at timestamptz NOT NULL DEFAULT (clock_timestamp() + interval '24 hours'),
  CONSTRAINT idempotency_records_completion_shape CHECK (
    (response_json IS NULL AND completed_at IS NULL) OR (response_json IS NOT NULL AND completed_at IS NOT NULL)
  ),
  UNIQUE (actor_id, operation, idempotency_key)
);
CREATE INDEX idempotency_records_expiry_idx ON idempotency_records (expires_at);

ALTER TABLE audit_events
  ADD CONSTRAINT audit_events_registry_shape CHECK (
    action NOT LIKE 'registry.%'
    OR (metadata ? 'before' AND metadata ? 'after' AND metadata ? 'idempotencyKey')
  );

CREATE FUNCTION enforce_source_activation()
RETURNS trigger
LANGUAGE plpgsql
AS $function$
BEGIN
  IF NEW.enabled THEN
    IF NEW.policy_review_due_at <= clock_timestamp() OR NOT EXISTS (
      SELECT 1
      FROM source_policies policy
      WHERE policy.id = NEW.policy_id
        AND policy.state = 'approved'
        AND policy.expires_at > clock_timestamp()
    ) THEN
      RAISE EXCEPTION 'source policy is not approved and current' USING ERRCODE = '23514';
    END IF;
    IF NOT EXISTS (
      SELECT 1 FROM ownership_evidence evidence
      WHERE evidence.source_id = NEW.id AND evidence.confidence >= 0.9
    ) THEN
      RAISE EXCEPTION 'source lacks high-confidence ownership evidence' USING ERRCODE = '23514';
    END IF;
  ELSE
    NEW.next_scan_at := NULL;
  END IF;
  RETURN NEW;
END
$function$;

CREATE FUNCTION pause_sources_for_policy()
RETURNS trigger
LANGUAGE plpgsql
AS $function$
BEGIN
  IF NEW.state <> 'approved' OR NEW.expires_at IS NULL OR NEW.expires_at <= clock_timestamp() THEN
    UPDATE sources
    SET enabled = false, next_scan_at = NULL
    WHERE policy_id = NEW.id AND enabled;
  END IF;
  RETURN NEW;
END
$function$;

CREATE TRIGGER sources_activation_guard
BEFORE INSERT OR UPDATE OF enabled, policy_id, policy_review_due_at ON sources
FOR EACH ROW EXECUTE FUNCTION enforce_source_activation();

CREATE TRIGGER source_policies_pause_sources
AFTER UPDATE OF state, expires_at ON source_policies
FOR EACH ROW EXECUTE FUNCTION pause_sources_for_policy();

CREATE TRIGGER ownership_evidence_immutable
BEFORE UPDATE OR DELETE ON ownership_evidence
FOR EACH ROW EXECUTE FUNCTION reject_immutable_change();

CREATE VIEW schedulable_sources AS
SELECT source.*
FROM sources source
JOIN source_policies policy ON policy.id = source.policy_id
WHERE source.enabled
  AND source.next_scan_at IS NOT NULL
  AND source.policy_review_due_at > clock_timestamp()
  AND policy.state = 'approved'
  AND policy.expires_at > clock_timestamp()
  AND EXISTS (
    SELECT 1 FROM ownership_evidence evidence
    WHERE evidence.source_id = source.id AND evidence.confidence >= 0.9
  );
