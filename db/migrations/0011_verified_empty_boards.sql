ALTER TABLE sources ADD COLUMN inventory_state text NOT NULL DEFAULT 'unknown'
  CHECK (inventory_state IN ('unknown', 'observed_nonempty', 'suspected_empty', 'confirmed_empty'));
UPDATE sources SET inventory_state = CASE WHEN last_job_count > 0 THEN 'observed_nonempty'
  WHEN last_job_count = 0 THEN 'suspected_empty' ELSE 'unknown' END;
ALTER TABLE source_scans ADD COLUMN policy_row_version integer CHECK (policy_row_version > 0);
ALTER TABLE source_scans ADD COLUMN source_identity_hash char(64)
  CHECK (source_identity_hash IS NULL OR source_identity_hash ~ '^[0-9a-f]{64}$');

CREATE TABLE source_empty_reviews (
  id uuid PRIMARY KEY,
  source_id uuid NOT NULL REFERENCES sources(id),
  first_scan_id uuid NOT NULL REFERENCES source_scans(id),
  second_scan_id uuid NOT NULL REFERENCES source_scans(id),
  board_hash char(64) NOT NULL CHECK (board_hash ~ '^[0-9a-f]{64}$'),
  connector_id text NOT NULL,
  connector_version text NOT NULL,
  tenant_key text NOT NULL,
  board_url text NOT NULL,
  api_base_url text NOT NULL,
  region text NOT NULL,
  policy_id uuid NOT NULL REFERENCES source_policies(id),
  policy_row_version integer NOT NULL CHECK (policy_row_version > 0),
  safe_fetch_policy_version text NOT NULL,
  historical_listing_count integer NOT NULL CHECK (historical_listing_count > 0),
  state text NOT NULL DEFAULT 'pending' CHECK (state IN ('pending', 'approved', 'rejected', 'superseded')),
  decided_by text,
  decision_reason text,
  decided_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  CONSTRAINT source_empty_review_scans_distinct CHECK (first_scan_id <> second_scan_id),
  CONSTRAINT source_empty_review_decision_shape CHECK (
    (state = 'pending' AND decided_by IS NULL AND decision_reason IS NULL AND decided_at IS NULL)
    OR (state <> 'pending' AND decided_by IS NOT NULL AND decision_reason IS NOT NULL AND decided_at IS NOT NULL)
  )
);
CREATE UNIQUE INDEX source_empty_reviews_pending_uq ON source_empty_reviews (source_id) WHERE state = 'pending';
CREATE INDEX source_empty_reviews_queue_idx ON source_empty_reviews (state, created_at);
CREATE TRIGGER source_empty_reviews_no_delete BEFORE DELETE ON source_empty_reviews
  FOR EACH ROW EXECUTE FUNCTION reject_immutable_change();

CREATE TABLE source_empty_confirmations (
  id uuid PRIMARY KEY,
  review_id uuid NOT NULL UNIQUE REFERENCES source_empty_reviews(id),
  source_id uuid NOT NULL REFERENCES sources(id),
  first_scan_id uuid NOT NULL REFERENCES source_scans(id),
  second_scan_id uuid NOT NULL REFERENCES source_scans(id),
  board_hash char(64) NOT NULL CHECK (board_hash ~ '^[0-9a-f]{64}$'),
  connector_id text NOT NULL,
  connector_version text NOT NULL,
  tenant_key text NOT NULL,
  board_url text NOT NULL,
  api_base_url text NOT NULL,
  region text NOT NULL,
  policy_id uuid NOT NULL REFERENCES source_policies(id),
  policy_row_version integer NOT NULL CHECK (policy_row_version > 0),
  safe_fetch_policy_version text NOT NULL,
  ownership_evidence_id uuid NOT NULL REFERENCES ownership_evidence(id),
  employer_careers_url text NOT NULL,
  confirmed_by text NOT NULL,
  reason text NOT NULL CHECK (length(btrim(reason)) BETWEEN 8 AND 1000),
  confirmed_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  valid_until timestamptz NOT NULL,
  CONSTRAINT source_empty_confirmation_window CHECK (valid_until > confirmed_at)
);
CREATE INDEX source_empty_confirmations_source_idx ON source_empty_confirmations (source_id, confirmed_at DESC);
CREATE TRIGGER source_empty_confirmations_immutable BEFORE UPDATE OR DELETE ON source_empty_confirmations
  FOR EACH ROW EXECUTE FUNCTION reject_immutable_change();

CREATE TABLE source_empty_confirmation_events (
  id uuid PRIMARY KEY,
  confirmation_id uuid NOT NULL REFERENCES source_empty_confirmations(id),
  event_type text NOT NULL CHECK (event_type IN ('invalidated', 'bulk_closed')),
  source_scan_id uuid REFERENCES source_scans(id),
  actor_type text NOT NULL CHECK (actor_type IN ('system', 'operator')),
  actor_id text,
  reason text NOT NULL CHECK (length(btrim(reason)) >= 8),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  CONSTRAINT source_empty_event_actor CHECK (actor_type <> 'operator' OR actor_id IS NOT NULL)
);
CREATE UNIQUE INDEX source_empty_confirmation_one_invalidation ON source_empty_confirmation_events (confirmation_id)
  WHERE event_type = 'invalidated';
CREATE TRIGGER source_empty_confirmation_events_immutable BEFORE UPDATE OR DELETE ON source_empty_confirmation_events
  FOR EACH ROW EXECUTE FUNCTION reject_immutable_change();

ALTER TABLE source_listings ADD COLUMN closure_hold_confirmation_id uuid REFERENCES source_empty_confirmations(id);
ALTER TABLE source_listings ADD CONSTRAINT source_listings_held_not_closed
  CHECK (closure_hold_confirmation_id IS NULL OR lifecycle_state <> 'closed');
CREATE INDEX source_listings_closure_hold_idx ON source_listings (closure_hold_confirmation_id)
  WHERE closure_hold_confirmation_id IS NOT NULL;

CREATE TABLE source_empty_closure_decisions (
  id uuid PRIMARY KEY,
  confirmation_id uuid NOT NULL REFERENCES source_empty_confirmations(id),
  source_id uuid NOT NULL REFERENCES sources(id),
  first_scan_id uuid NOT NULL REFERENCES source_scans(id),
  second_scan_id uuid NOT NULL REFERENCES source_scans(id),
  expected_listing_count integer NOT NULL CHECK (expected_listing_count >= 0),
  closed_listing_count integer NOT NULL CHECK (closed_listing_count >= 0),
  decided_by text NOT NULL,
  reason text NOT NULL CHECK (length(btrim(reason)) BETWEEN 8 AND 1000),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  CONSTRAINT source_empty_closure_count CHECK (closed_listing_count = expected_listing_count)
);
CREATE TRIGGER source_empty_closure_decisions_immutable BEFORE UPDATE OR DELETE ON source_empty_closure_decisions
  FOR EACH ROW EXECUTE FUNCTION reject_immutable_change();
