CREATE TABLE company_identity_claims (
  id uuid PRIMARY KEY,
  company_id uuid NOT NULL REFERENCES companies(id),
  claim_type text NOT NULL CHECK (claim_type IN ('verified_domain', 'ats_tenant', 'legal_name', 'trade_name', 'alias')),
  claim_value text NOT NULL CHECK (length(btrim(claim_value)) > 0),
  normalized_value text NOT NULL CHECK (length(btrim(normalized_value)) > 0),
  evidence_type text NOT NULL,
  artifact_id uuid REFERENCES artifacts(id),
  evidence_url text,
  confidence numeric(5,4) NOT NULL CHECK (confidence BETWEEN 0 AND 1),
  recorded_by text NOT NULL,
  recorded_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  CONSTRAINT company_identity_claims_evidence CHECK (artifact_id IS NOT NULL OR evidence_url IS NOT NULL)
);
CREATE UNIQUE INDEX company_identity_claims_exact_uq
  ON company_identity_claims (claim_type, normalized_value)
  WHERE claim_type IN ('verified_domain', 'ats_tenant') AND confidence >= 0.9;
CREATE INDEX company_identity_claims_company_idx ON company_identity_claims (company_id, claim_type);

INSERT INTO company_identity_claims (
  id, company_id, claim_type, claim_value, normalized_value, evidence_type, evidence_url,
  confidence, recorded_by, recorded_at
)
SELECT
  md5('verified-domain|' || company.id::text)::uuid,
  company.id,
  'verified_domain',
  company.primary_domain,
  lower(rtrim(company.primary_domain, '.')),
  'verified_company_domain',
  'https://' || lower(rtrim(company.primary_domain, '.')) || '/',
  company.resolution_confidence,
  'migration:0006',
  company.updated_at
FROM companies company
WHERE company.resolution_status = 'verified'
  AND company.primary_domain IS NOT NULL
  AND company.resolution_confidence >= 0.9;

INSERT INTO company_identity_claims (
  id, company_id, claim_type, claim_value, normalized_value, evidence_type, artifact_id,
  evidence_url, confidence, recorded_by, recorded_at
)
SELECT
  md5('ats-tenant|' || source.id::text)::uuid,
  source.company_id,
  'ats_tenant',
  source.connector_id || ':' || source.region || ':' || source.tenant_key,
  lower(source.connector_id || ':' || source.region || ':' || source.tenant_key),
  evidence.evidence_type,
  evidence.artifact_id,
  evidence.evidence_url,
  evidence.confidence,
  evidence.recorded_by,
  evidence.recorded_at
FROM sources source
JOIN LATERAL (
  SELECT ownership.*
  FROM ownership_evidence ownership
  WHERE ownership.source_id = source.id AND ownership.confidence >= 0.9
  ORDER BY ownership.confidence DESC, ownership.recorded_at, ownership.id
  LIMIT 1
) evidence ON true;

CREATE TABLE company_resolution_decisions (
  id uuid PRIMARY KEY,
  operation text NOT NULL CHECK (operation IN ('confirm', 'merge', 'split', 'reject')),
  subject_company_id uuid NOT NULL REFERENCES companies(id),
  canonical_company_id uuid REFERENCES companies(id),
  review_id uuid REFERENCES resolution_reviews(id),
  resolver_version text NOT NULL,
  confidence numeric(5,4) NOT NULL CHECK (confidence BETWEEN 0 AND 1),
  decision_json jsonb NOT NULL,
  actor_type text NOT NULL CHECK (actor_type IN ('system', 'operator')),
  actor_id text,
  reason text NOT NULL CHECK (length(btrim(reason)) >= 8),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  CONSTRAINT company_resolution_decisions_actor CHECK (actor_type <> 'operator' OR actor_id IS NOT NULL),
  CONSTRAINT company_resolution_decisions_merge_review CHECK (operation <> 'merge' OR review_id IS NOT NULL),
  CONSTRAINT company_resolution_decisions_target CHECK (
    (operation IN ('confirm', 'reject') AND canonical_company_id IS NULL)
    OR (operation IN ('merge', 'split') AND canonical_company_id IS NOT NULL AND canonical_company_id <> subject_company_id)
  )
);
CREATE INDEX company_resolution_decisions_history_idx ON company_resolution_decisions (subject_company_id, created_at, id);

CREATE TABLE company_merge_memberships (
  id uuid PRIMARY KEY,
  source_company_id uuid NOT NULL REFERENCES companies(id),
  canonical_company_id uuid NOT NULL REFERENCES companies(id),
  merge_decision_id uuid NOT NULL UNIQUE REFERENCES company_resolution_decisions(id),
  split_decision_id uuid UNIQUE REFERENCES company_resolution_decisions(id),
  previous_status text NOT NULL CHECK (previous_status IN ('pending', 'verified', 'rejected')),
  previous_confidence numeric(5,4) NOT NULL CHECK (previous_confidence BETWEEN 0 AND 1),
  merged_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  split_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  row_version integer NOT NULL DEFAULT 1 CHECK (row_version > 0),
  CONSTRAINT company_merge_memberships_distinct CHECK (source_company_id <> canonical_company_id),
  CONSTRAINT company_merge_memberships_split_shape CHECK ((split_decision_id IS NULL) = (split_at IS NULL))
);
CREATE UNIQUE INDEX company_merge_memberships_active_source_uq ON company_merge_memberships (source_company_id) WHERE split_at IS NULL;
CREATE INDEX company_merge_memberships_canonical_idx ON company_merge_memberships (canonical_company_id) WHERE split_at IS NULL;

CREATE TABLE company_resolution_fixtures (
  id uuid PRIMARY KEY,
  fixture_key text NOT NULL UNIQUE CHECK (fixture_key ~ '^[a-z0-9][a-z0-9._:-]{7,127}$'),
  input_json jsonb NOT NULL,
  expected_json jsonb NOT NULL,
  decision_id uuid NOT NULL REFERENCES company_resolution_decisions(id),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp()
);

CREATE VIEW canonical_company_resolution AS
SELECT
  company.id AS source_company_id,
  coalesce(membership.canonical_company_id, company.id) AS canonical_company_id,
  (membership.id IS NOT NULL) AS is_merged,
  membership.merge_decision_id
FROM companies company
LEFT JOIN company_merge_memberships membership
  ON membership.source_company_id = company.id AND membership.split_at IS NULL;

CREATE TRIGGER company_merge_memberships_row_version
BEFORE UPDATE ON company_merge_memberships FOR EACH ROW EXECUTE FUNCTION set_row_version();
CREATE TRIGGER company_identity_claims_immutable
BEFORE UPDATE OR DELETE ON company_identity_claims FOR EACH ROW EXECUTE FUNCTION reject_immutable_change();
CREATE TRIGGER company_resolution_decisions_immutable
BEFORE UPDATE OR DELETE ON company_resolution_decisions FOR EACH ROW EXECUTE FUNCTION reject_immutable_change();
CREATE TRIGGER company_resolution_fixtures_immutable
BEFORE UPDATE OR DELETE ON company_resolution_fixtures FOR EACH ROW EXECUTE FUNCTION reject_immutable_change();
