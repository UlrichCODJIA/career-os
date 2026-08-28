CREATE TABLE opportunity_resolution_decisions (
  id uuid PRIMARY KEY,
  operation text NOT NULL CHECK (operation IN ('create', 'attach', 'split', 'rebuild')),
  opportunity_id uuid NOT NULL REFERENCES opportunities(id),
  source_listing_id uuid REFERENCES source_listings(id),
  membership_id uuid REFERENCES opportunity_members(id),
  review_id uuid REFERENCES resolution_reviews(id),
  resolver_version text NOT NULL,
  confidence numeric(5,4) NOT NULL CHECK (confidence BETWEEN 0 AND 1),
  decision_json jsonb NOT NULL,
  actor_type text NOT NULL CHECK (actor_type IN ('system', 'operator')),
  actor_id text,
  reason text NOT NULL CHECK (length(btrim(reason)) >= 8),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  CONSTRAINT opportunity_resolution_decisions_actor CHECK (actor_type <> 'operator' OR actor_id IS NOT NULL),
  CONSTRAINT opportunity_resolution_decisions_review CHECK (review_id IS NULL OR actor_type = 'operator')
);
CREATE INDEX opportunity_resolution_decisions_history_idx
  ON opportunity_resolution_decisions (opportunity_id, created_at, id);
CREATE INDEX opportunity_resolution_decisions_listing_idx
  ON opportunity_resolution_decisions (source_listing_id, created_at, id) WHERE source_listing_id IS NOT NULL;

CREATE TABLE opportunity_resolution_fixtures (
  id uuid PRIMARY KEY,
  fixture_key text NOT NULL UNIQUE CHECK (fixture_key ~ '^[a-z0-9][a-z0-9._:-]{7,127}$'),
  input_json jsonb NOT NULL,
  expected_json jsonb NOT NULL,
  decision_id uuid NOT NULL REFERENCES opportunity_resolution_decisions(id),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp()
);

CREATE TABLE opportunity_field_provenance (
  id uuid PRIMARY KEY,
  opportunity_id uuid NOT NULL REFERENCES opportunities(id),
  decision_id uuid NOT NULL REFERENCES opportunity_resolution_decisions(id),
  field_path text NOT NULL CHECK (field_path ~ '^/'),
  selected_source_assertion_id uuid NOT NULL REFERENCES field_assertions(id),
  alternative_source_assertion_ids uuid[] NOT NULL,
  projected_value_json jsonb NOT NULL,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  UNIQUE (decision_id, field_path),
  CONSTRAINT opportunity_field_provenance_selected_retained
    CHECK (selected_source_assertion_id = ANY(alternative_source_assertion_ids)),
  CONSTRAINT opportunity_field_provenance_alternatives_nonempty
    CHECK (cardinality(alternative_source_assertion_ids) > 0)
);
CREATE INDEX opportunity_field_provenance_history_idx
  ON opportunity_field_provenance (opportunity_id, created_at, id);

CREATE TABLE opportunity_field_provenance_alternatives (
  provenance_id uuid NOT NULL REFERENCES opportunity_field_provenance(id),
  source_assertion_id uuid NOT NULL REFERENCES field_assertions(id),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY (provenance_id, source_assertion_id)
);

CREATE TRIGGER opportunity_resolution_decisions_immutable
BEFORE UPDATE OR DELETE ON opportunity_resolution_decisions FOR EACH ROW EXECUTE FUNCTION reject_immutable_change();
CREATE TRIGGER opportunity_resolution_fixtures_immutable
BEFORE UPDATE OR DELETE ON opportunity_resolution_fixtures FOR EACH ROW EXECUTE FUNCTION reject_immutable_change();
CREATE TRIGGER opportunity_field_provenance_immutable
BEFORE UPDATE OR DELETE ON opportunity_field_provenance FOR EACH ROW EXECUTE FUNCTION reject_immutable_change();
CREATE TRIGGER opportunity_field_provenance_alternatives_immutable
BEFORE UPDATE OR DELETE ON opportunity_field_provenance_alternatives FOR EACH ROW EXECUTE FUNCTION reject_immutable_change();
