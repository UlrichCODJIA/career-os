CREATE EXTENSION IF NOT EXISTS pg_trgm;

CREATE FUNCTION set_row_version()
RETURNS trigger
LANGUAGE plpgsql
AS $function$
BEGIN
  NEW.updated_at := clock_timestamp();
  NEW.row_version := OLD.row_version + 1;
  RETURN NEW;
END
$function$;

CREATE FUNCTION reject_immutable_change()
RETURNS trigger
LANGUAGE plpgsql
AS $function$
BEGIN
  RAISE EXCEPTION '% is append-only', TG_TABLE_NAME USING ERRCODE = '55000';
END
$function$;

CREATE TABLE companies (
  id uuid PRIMARY KEY,
  legal_name text,
  display_name text NOT NULL CHECK (length(btrim(display_name)) > 0),
  normalized_name text NOT NULL CHECK (length(btrim(normalized_name)) > 0),
  primary_domain text,
  careers_url text,
  logo_url text,
  industry_codes text[] NOT NULL DEFAULT '{}',
  size_band text,
  headquarters_country text CHECK (headquarters_country IS NULL OR headquarters_country ~ '^[A-Z]{2}$'),
  resolution_status text NOT NULL DEFAULT 'pending'
    CHECK (resolution_status IN ('pending', 'verified', 'rejected', 'merged')),
  resolution_confidence numeric(5,4) NOT NULL DEFAULT 0
    CHECK (resolution_confidence BETWEEN 0 AND 1),
  enrichment_json jsonb NOT NULL DEFAULT '{}',
  enrichment_source text,
  enrichment_license text,
  enriched_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  row_version integer NOT NULL DEFAULT 1 CHECK (row_version > 0),
  CONSTRAINT companies_verified_domain_required
    CHECK (resolution_status <> 'verified' OR primary_domain IS NOT NULL)
);

CREATE UNIQUE INDEX companies_verified_primary_domain_uq
  ON companies (lower(primary_domain))
  WHERE resolution_status = 'verified' AND primary_domain IS NOT NULL;
CREATE INDEX companies_normalized_name_trgm_idx ON companies USING gin (normalized_name gin_trgm_ops);

CREATE TABLE company_aliases (
  id uuid PRIMARY KEY,
  company_id uuid NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  alias text NOT NULL CHECK (length(btrim(alias)) > 0),
  normalized_alias text NOT NULL CHECK (length(btrim(normalized_alias)) > 0),
  alias_type text NOT NULL CHECK (alias_type IN ('legal', 'trade', 'former', 'domain', 'other')),
  source text NOT NULL CHECK (length(btrim(source)) > 0),
  verified_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  row_version integer NOT NULL DEFAULT 1 CHECK (row_version > 0),
  UNIQUE (company_id, normalized_alias, alias_type)
);
CREATE INDEX company_aliases_normalized_trgm_idx ON company_aliases USING gin (normalized_alias gin_trgm_ops);

CREATE TABLE source_candidates (
  id uuid PRIMARY KEY,
  raw_company_name text,
  raw_domain text,
  raw_careers_url text,
  raw_ats_url text,
  discovery_provider text NOT NULL,
  discovery_reference text,
  first_observed_at timestamptz NOT NULL,
  last_observed_at timestamptz NOT NULL,
  detection_connector_id text,
  detection_tenant_key text,
  detection_confidence numeric(5,4) CHECK (detection_confidence BETWEEN 0 AND 1),
  review_state text NOT NULL DEFAULT 'pending'
    CHECK (review_state IN ('pending', 'verified', 'rejected', 'duplicate')),
  duplicate_of_id uuid REFERENCES source_candidates(id),
  review_reason text,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  row_version integer NOT NULL DEFAULT 1 CHECK (row_version > 0),
  CONSTRAINT source_candidates_identity_present
    CHECK (num_nonnulls(raw_domain, raw_careers_url, raw_ats_url) > 0),
  CONSTRAINT source_candidates_observation_order CHECK (last_observed_at >= first_observed_at),
  CONSTRAINT source_candidates_duplicate_reference
    CHECK (
      (review_state = 'duplicate') = (duplicate_of_id IS NOT NULL)
      AND (duplicate_of_id IS NULL OR duplicate_of_id <> id)
    )
);

CREATE TABLE source_policies (
  id uuid PRIMARY KEY,
  source_family text NOT NULL,
  host_pattern text NOT NULL,
  access_class text NOT NULL CHECK (access_class IN ('public_api', 'public_page', 'licensed_ephemeral')),
  robots_review_url text,
  terms_review_url text,
  reviewed_at timestamptz NOT NULL,
  reviewed_by text NOT NULL,
  allowed_methods text[] NOT NULL DEFAULT ARRAY['GET']::text[],
  retention_class text NOT NULL,
  attribution_requirements text,
  max_requests_per_minute integer NOT NULL CHECK (max_requests_per_minute > 0),
  max_concurrency integer NOT NULL CHECK (max_concurrency > 0),
  contact_email text NOT NULL,
  user_agent text NOT NULL,
  state text NOT NULL CHECK (state IN ('approved', 'paused', 'blocked', 'expired')),
  expires_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  row_version integer NOT NULL DEFAULT 1 CHECK (row_version > 0),
  CONSTRAINT source_policies_get_only CHECK (
    cardinality(allowed_methods) > 0 AND allowed_methods <@ ARRAY['GET']::text[]
  ),
  UNIQUE (source_family, host_pattern)
);

CREATE TABLE artifacts (
  id uuid PRIMARY KEY,
  sha256 char(64) NOT NULL CHECK (sha256 ~ '^[0-9a-f]{64}$'),
  byte_length bigint NOT NULL CHECK (byte_length >= 0),
  media_type text NOT NULL,
  compression text,
  storage_uri text NOT NULL,
  canonical_source_url text NOT NULL,
  retrieved_at timestamptz NOT NULL,
  status_code integer CHECK (status_code BETWEEN 100 AND 599),
  response_headers jsonb NOT NULL DEFAULT '{}',
  policy_id uuid REFERENCES source_policies(id),
  retention_class text NOT NULL,
  deletion_due_at timestamptz,
  encryption_key_ref text,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  UNIQUE (sha256),
  UNIQUE (storage_uri)
);

CREATE TABLE sources (
  id uuid PRIMARY KEY,
  company_id uuid NOT NULL REFERENCES companies(id),
  connector_id text NOT NULL,
  tenant_key text NOT NULL,
  board_url text NOT NULL,
  api_base_url text NOT NULL,
  region text NOT NULL DEFAULT 'global' CHECK (region IN ('global', 'eu')),
  verification_method text NOT NULL CHECK (verification_method IN ('employer_link', 'ats_identity', 'human_review')),
  verification_artifact_id uuid REFERENCES artifacts(id),
  verified_at timestamptz NOT NULL,
  enabled boolean NOT NULL DEFAULT false,
  health_state text NOT NULL DEFAULT 'unknown'
    CHECK (health_state IN ('unknown', 'healthy', 'degraded', 'blocked', 'quarantined')),
  cadence_seconds integer NOT NULL DEFAULT 43200 CHECK (cadence_seconds BETWEEN 60 AND 604800),
  next_scan_at timestamptz,
  consecutive_failures integer NOT NULL DEFAULT 0 CHECK (consecutive_failures >= 0),
  consecutive_complete_empty_scans integer NOT NULL DEFAULT 0 CHECK (consecutive_complete_empty_scans >= 0),
  last_attempt_at timestamptz,
  last_success_at timestamptz,
  last_complete_at timestamptz,
  last_nonempty_at timestamptz,
  etag text,
  last_modified text,
  last_board_hash text,
  last_job_count integer CHECK (last_job_count >= 0),
  policy_id uuid NOT NULL REFERENCES source_policies(id),
  policy_review_due_at timestamptz NOT NULL,
  connector_version text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  row_version integer NOT NULL DEFAULT 1 CHECK (row_version > 0),
  UNIQUE (connector_id, region, tenant_key),
  CONSTRAINT sources_enabled_requires_approved_review CHECK (NOT enabled OR policy_review_due_at > verified_at)
);
CREATE INDEX sources_due_idx ON sources (enabled, next_scan_at) WHERE enabled;

CREATE TABLE work_jobs (
  id uuid PRIMARY KEY,
  type text NOT NULL,
  dedupe_key text NOT NULL,
  payload_json jsonb NOT NULL,
  priority integer NOT NULL DEFAULT 0,
  status text NOT NULL DEFAULT 'queued'
    CHECK (status IN ('queued', 'leased', 'succeeded', 'retryable_failed', 'terminal_failed', 'cancelled')),
  scheduled_at timestamptz NOT NULL,
  leased_at timestamptz,
  lease_expires_at timestamptz,
  lease_owner text,
  lease_token uuid,
  attempt integer NOT NULL DEFAULT 0 CHECK (attempt >= 0),
  max_attempts integer NOT NULL DEFAULT 5 CHECK (max_attempts > 0),
  last_error_code text,
  last_error_message text,
  completed_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  row_version integer NOT NULL DEFAULT 1 CHECK (row_version > 0),
  CONSTRAINT work_jobs_attempt_budget CHECK (attempt <= max_attempts),
  CONSTRAINT work_jobs_lease_shape CHECK (
    (status = 'leased' AND leased_at IS NOT NULL AND lease_expires_at IS NOT NULL AND lease_owner IS NOT NULL AND lease_token IS NOT NULL)
    OR status <> 'leased'
  ),
  CONSTRAINT work_jobs_completion_shape CHECK (
    (status IN ('succeeded', 'terminal_failed', 'cancelled') AND completed_at IS NOT NULL)
    OR status NOT IN ('succeeded', 'terminal_failed', 'cancelled')
  )
);
CREATE UNIQUE INDEX work_jobs_active_dedupe_uq
  ON work_jobs (type, dedupe_key)
  WHERE status IN ('queued', 'leased', 'retryable_failed');
CREATE INDEX work_jobs_queue_idx ON work_jobs (status, scheduled_at, priority DESC);

CREATE TABLE source_scans (
  id uuid PRIMARY KEY,
  source_id uuid NOT NULL REFERENCES sources(id),
  work_job_id uuid NOT NULL REFERENCES work_jobs(id),
  started_at timestamptz NOT NULL,
  ended_at timestamptz,
  http_outcome text,
  response_count integer NOT NULL DEFAULT 0 CHECK (response_count >= 0),
  byte_count bigint NOT NULL DEFAULT 0 CHECK (byte_count >= 0),
  duration_ms integer CHECK (duration_ms >= 0),
  connector_id text NOT NULL,
  connector_version text NOT NULL,
  safe_fetch_policy_version text NOT NULL,
  completeness_state text NOT NULL DEFAULT 'in_progress'
    CHECK (completeness_state IN ('in_progress', 'complete', 'incomplete', 'failed')),
  completeness_reason text CHECK (completeness_reason IN (
    'complete', 'pagination_incomplete', 'schema_invalid', 'suspicious_empty', 'blocked', 'transport_failure'
  )),
  observed_job_count integer CHECK (observed_job_count >= 0),
  board_hash text,
  added_count integer NOT NULL DEFAULT 0 CHECK (added_count >= 0),
  changed_count integer NOT NULL DEFAULT 0 CHECK (changed_count >= 0),
  missing_count integer NOT NULL DEFAULT 0 CHECK (missing_count >= 0),
  reopened_count integer NOT NULL DEFAULT 0 CHECK (reopened_count >= 0),
  closed_count integer NOT NULL DEFAULT 0 CHECK (closed_count >= 0),
  successful_for_absence_inference boolean NOT NULL DEFAULT false,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  row_version integer NOT NULL DEFAULT 1 CHECK (row_version > 0),
  CONSTRAINT source_scans_time_order CHECK (ended_at IS NULL OR ended_at >= started_at),
  CONSTRAINT source_scans_absence_requires_complete
    CHECK (NOT successful_for_absence_inference OR (completeness_state = 'complete' AND completeness_reason = 'complete')),
  UNIQUE (work_job_id)
);
CREATE INDEX source_scans_history_idx ON source_scans (source_id, started_at DESC);

CREATE TABLE source_listings (
  id uuid PRIMARY KEY,
  source_id uuid NOT NULL REFERENCES sources(id),
  source_job_id text NOT NULL,
  current_version_id uuid,
  lifecycle_state text NOT NULL DEFAULT 'active' CHECK (lifecycle_state IN ('active', 'possibly_closed', 'closed')),
  canonical_source_url text NOT NULL,
  apply_url text NOT NULL,
  first_seen_at timestamptz NOT NULL,
  last_seen_open_at timestamptz NOT NULL,
  first_missing_at timestamptz,
  closed_at timestamptz,
  reopened_at timestamptz,
  consecutive_complete_misses integer NOT NULL DEFAULT 0 CHECK (consecutive_complete_misses >= 0),
  repost_cycle integer NOT NULL DEFAULT 0 CHECK (repost_cycle >= 0),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  row_version integer NOT NULL DEFAULT 1 CHECK (row_version > 0),
  UNIQUE (source_id, source_job_id),
  CONSTRAINT source_listings_seen_order CHECK (last_seen_open_at >= first_seen_at),
  CONSTRAINT source_listings_closed_shape CHECK ((lifecycle_state = 'closed') = (closed_at IS NOT NULL))
);

CREATE TABLE listing_versions (
  id uuid PRIMARY KEY,
  source_listing_id uuid NOT NULL REFERENCES source_listings(id),
  source_scan_id uuid NOT NULL REFERENCES source_scans(id),
  artifact_id uuid NOT NULL REFERENCES artifacts(id),
  semantic_fingerprint text NOT NULL,
  raw_fingerprint text NOT NULL,
  parsed_source_json jsonb NOT NULL,
  normalized_candidate_json jsonb NOT NULL,
  parser_version text NOT NULL,
  normalizer_version text NOT NULL,
  taxonomy_version text NOT NULL,
  prompt_version text,
  source_posted_at timestamptz,
  source_updated_at timestamptz,
  valid_through timestamptz,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  UNIQUE (source_listing_id, semantic_fingerprint)
);
ALTER TABLE source_listings
  ADD CONSTRAINT source_listings_current_version_fk
  FOREIGN KEY (current_version_id) REFERENCES listing_versions(id) DEFERRABLE INITIALLY DEFERRED;

CREATE TABLE field_assertions (
  id uuid PRIMARY KEY,
  target_type text NOT NULL CHECK (target_type IN ('company', 'source_listing', 'listing_version', 'opportunity')),
  target_id uuid NOT NULL,
  field_path text NOT NULL CHECK (field_path ~ '^/'),
  value_json jsonb NOT NULL,
  origin text NOT NULL CHECK (origin IN ('source_field', 'source_text', 'deterministic_rule', 'model_derived', 'human_review')),
  artifact_id uuid REFERENCES artifacts(id),
  json_pointer text,
  text_span_start integer CHECK (text_span_start >= 0),
  text_span_end integer CHECK (text_span_end >= 0),
  quote_hash text,
  extractor_id text NOT NULL,
  extractor_version text NOT NULL,
  confidence numeric(5,4) NOT NULL CHECK (confidence BETWEEN 0 AND 1),
  review_state text NOT NULL DEFAULT 'unreviewed' CHECK (review_state IN ('unreviewed', 'accepted', 'rejected')),
  selected boolean NOT NULL DEFAULT false,
  superseded_by_id uuid REFERENCES field_assertions(id),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  row_version integer NOT NULL DEFAULT 1 CHECK (row_version > 0),
  CONSTRAINT field_assertions_evidence_locator CHECK (
    origin IN ('deterministic_rule', 'human_review') OR artifact_id IS NOT NULL
  ),
  CONSTRAINT field_assertions_text_span_shape CHECK (
    (text_span_start IS NULL AND text_span_end IS NULL AND quote_hash IS NULL)
    OR (text_span_start IS NOT NULL AND text_span_end IS NOT NULL AND text_span_end >= text_span_start AND quote_hash IS NOT NULL)
  ),
  CONSTRAINT field_assertions_selected_not_superseded CHECK (NOT selected OR superseded_by_id IS NULL)
);
CREATE UNIQUE INDEX field_assertions_selected_uq
  ON field_assertions (target_type, target_id, field_path)
  WHERE selected;

CREATE TABLE opportunities (
  id uuid PRIMARY KEY,
  company_id uuid NOT NULL REFERENCES companies(id),
  display_title text NOT NULL,
  normalized_title text NOT NULL,
  description_text text NOT NULL,
  workplace_type text NOT NULL DEFAULT 'unspecified' CHECK (workplace_type IN ('remote', 'hybrid', 'onsite', 'unspecified')),
  employment_type text,
  seniority text,
  canonical_source_url text NOT NULL,
  apply_url text NOT NULL,
  status text NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'possibly_closed', 'closed')),
  first_seen_at timestamptz NOT NULL,
  source_posted_at timestamptz,
  possibly_closed_at timestamptz,
  closed_at timestamptz,
  canonicalization_version text NOT NULL,
  search_document tsvector GENERATED ALWAYS AS (
    to_tsvector('simple'::regconfig, coalesce(display_title, '') || ' ' || coalesce(description_text, ''))
  ) STORED,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  row_version integer NOT NULL DEFAULT 1 CHECK (row_version > 0),
  CONSTRAINT opportunities_status_timestamps CHECK (
    (status = 'active' AND closed_at IS NULL)
    OR (status = 'possibly_closed' AND possibly_closed_at IS NOT NULL AND closed_at IS NULL)
    OR (status = 'closed' AND closed_at IS NOT NULL)
  )
);
CREATE INDEX opportunities_search_idx ON opportunities USING gin (search_document);
CREATE INDEX opportunities_title_trgm_idx ON opportunities USING gin (normalized_title gin_trgm_ops);
CREATE INDEX opportunities_active_status_idx ON opportunities (status) WHERE status <> 'closed';
CREATE INDEX opportunities_active_first_seen_idx ON opportunities (first_seen_at DESC) WHERE status <> 'closed';
CREATE INDEX opportunities_active_workplace_idx ON opportunities (workplace_type) WHERE status <> 'closed';
CREATE INDEX opportunities_active_company_idx ON opportunities (company_id) WHERE status <> 'closed';
CREATE INDEX opportunities_active_employment_idx ON opportunities (employment_type) WHERE status <> 'closed';
CREATE INDEX opportunities_active_posted_idx ON opportunities (source_posted_at DESC) WHERE status <> 'closed';

CREATE TABLE opportunity_members (
  id uuid PRIMARY KEY,
  opportunity_id uuid NOT NULL REFERENCES opportunities(id) ON DELETE CASCADE,
  source_listing_id uuid NOT NULL REFERENCES source_listings(id),
  membership_reason text NOT NULL,
  resolver_version text NOT NULL,
  confidence numeric(5,4) NOT NULL CHECK (confidence BETWEEN 0 AND 1),
  state text NOT NULL CHECK (state IN ('automatic', 'human_confirmed', 'human_rejected')),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  row_version integer NOT NULL DEFAULT 1 CHECK (row_version > 0),
  UNIQUE (opportunity_id, source_listing_id)
);
CREATE UNIQUE INDEX opportunity_members_accepted_listing_uq
  ON opportunity_members (source_listing_id)
  WHERE state <> 'human_rejected';

CREATE TABLE opportunity_locations (
  id uuid PRIMARY KEY,
  opportunity_id uuid NOT NULL REFERENCES opportunities(id) ON DELETE CASCADE,
  country_code text CHECK (country_code IS NULL OR country_code ~ '^[A-Z]{2}$'),
  region text,
  locality text,
  remote_eligible boolean NOT NULL DEFAULT false,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  row_version integer NOT NULL DEFAULT 1 CHECK (row_version > 0),
  UNIQUE NULLS NOT DISTINCT (opportunity_id, country_code, region, locality)
);
CREATE INDEX opportunity_locations_country_idx ON opportunity_locations (country_code, opportunity_id);

CREATE TABLE opportunity_compensation (
  id uuid PRIMARY KEY,
  opportunity_id uuid NOT NULL REFERENCES opportunities(id) ON DELETE CASCADE,
  currency char(3) NOT NULL CHECK (currency ~ '^[A-Z]{3}$'),
  period text NOT NULL CHECK (period IN ('hour', 'day', 'week', 'month', 'year')),
  minimum numeric(16,2),
  maximum numeric(16,2),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  row_version integer NOT NULL DEFAULT 1 CHECK (row_version > 0),
  CONSTRAINT opportunity_compensation_range CHECK (
    (minimum IS NOT NULL OR maximum IS NOT NULL) AND (minimum IS NULL OR maximum IS NULL OR maximum >= minimum)
  )
);
CREATE INDEX opportunity_compensation_filter_idx ON opportunity_compensation (currency, period, minimum, maximum);

CREATE TABLE opportunity_skills (
  opportunity_id uuid NOT NULL REFERENCES opportunities(id) ON DELETE CASCADE,
  skill text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY (opportunity_id, skill)
);
CREATE INDEX opportunity_skills_filter_idx ON opportunity_skills (skill, opportunity_id);

CREATE TABLE opportunity_languages (
  opportunity_id uuid NOT NULL REFERENCES opportunities(id) ON DELETE CASCADE,
  language_code text NOT NULL,
  proficiency text,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY (opportunity_id, language_code)
);
CREATE INDEX opportunity_languages_filter_idx ON opportunity_languages (language_code, opportunity_id);

CREATE TABLE resolution_reviews (
  id uuid PRIMARY KEY,
  review_type text NOT NULL CHECK (review_type IN ('company_identity', 'opportunity_membership', 'field_assertion')),
  target_type text NOT NULL,
  target_id uuid NOT NULL,
  candidate_json jsonb NOT NULL,
  state text NOT NULL DEFAULT 'pending' CHECK (state IN ('pending', 'approved', 'rejected', 'superseded')),
  priority integer NOT NULL DEFAULT 0,
  decision_reason text,
  decided_by text,
  decided_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  row_version integer NOT NULL DEFAULT 1 CHECK (row_version > 0),
  CONSTRAINT resolution_reviews_decision_shape CHECK (
    (state = 'pending' AND decision_reason IS NULL AND decided_by IS NULL AND decided_at IS NULL)
    OR (state <> 'pending' AND decision_reason IS NOT NULL AND decided_by IS NOT NULL AND decided_at IS NOT NULL)
  )
);
CREATE UNIQUE INDEX resolution_reviews_pending_uq
  ON resolution_reviews (review_type, target_type, target_id)
  WHERE state = 'pending';
CREATE INDEX resolution_reviews_queue_idx ON resolution_reviews (state, priority DESC, created_at);

CREATE TABLE lifecycle_events (
  id uuid PRIMARY KEY,
  aggregate_type text NOT NULL CHECK (aggregate_type IN ('source_listing', 'opportunity')),
  aggregate_id uuid NOT NULL,
  sequence bigint NOT NULL CHECK (sequence > 0),
  event_type text NOT NULL,
  occurred_at timestamptz NOT NULL,
  source_scan_id uuid REFERENCES source_scans(id),
  source_listing_id uuid REFERENCES source_listings(id),
  listing_version_id uuid REFERENCES listing_versions(id),
  reason_code text NOT NULL,
  actor_type text NOT NULL CHECK (actor_type IN ('system', 'operator')),
  actor_id text,
  metadata jsonb NOT NULL DEFAULT '{}',
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  UNIQUE (aggregate_type, aggregate_id, sequence)
);
CREATE INDEX lifecycle_events_history_idx ON lifecycle_events (aggregate_type, aggregate_id, sequence);

CREATE TABLE audit_events (
  id uuid PRIMARY KEY,
  sequence bigint GENERATED ALWAYS AS IDENTITY UNIQUE,
  occurred_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  actor_type text NOT NULL CHECK (actor_type IN ('system', 'operator')),
  actor_id text,
  action text NOT NULL,
  target_type text NOT NULL,
  target_id uuid,
  reason text NOT NULL,
  correlation_id uuid NOT NULL,
  metadata jsonb NOT NULL DEFAULT '{}',
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  CONSTRAINT audit_events_operator_identity CHECK (actor_type <> 'operator' OR actor_id IS NOT NULL)
);
CREATE INDEX audit_events_target_idx ON audit_events (target_type, target_id, sequence DESC);
CREATE INDEX audit_events_correlation_idx ON audit_events (correlation_id);

CREATE TRIGGER companies_row_version BEFORE UPDATE ON companies FOR EACH ROW EXECUTE FUNCTION set_row_version();
CREATE TRIGGER company_aliases_row_version BEFORE UPDATE ON company_aliases FOR EACH ROW EXECUTE FUNCTION set_row_version();
CREATE TRIGGER source_candidates_row_version BEFORE UPDATE ON source_candidates FOR EACH ROW EXECUTE FUNCTION set_row_version();
CREATE TRIGGER source_policies_row_version BEFORE UPDATE ON source_policies FOR EACH ROW EXECUTE FUNCTION set_row_version();
CREATE TRIGGER sources_row_version BEFORE UPDATE ON sources FOR EACH ROW EXECUTE FUNCTION set_row_version();
CREATE TRIGGER work_jobs_row_version BEFORE UPDATE ON work_jobs FOR EACH ROW EXECUTE FUNCTION set_row_version();
CREATE TRIGGER source_scans_row_version BEFORE UPDATE ON source_scans FOR EACH ROW EXECUTE FUNCTION set_row_version();
CREATE TRIGGER source_listings_row_version BEFORE UPDATE ON source_listings FOR EACH ROW EXECUTE FUNCTION set_row_version();
CREATE TRIGGER field_assertions_row_version BEFORE UPDATE ON field_assertions FOR EACH ROW EXECUTE FUNCTION set_row_version();
CREATE TRIGGER opportunities_row_version BEFORE UPDATE ON opportunities FOR EACH ROW EXECUTE FUNCTION set_row_version();
CREATE TRIGGER opportunity_members_row_version BEFORE UPDATE ON opportunity_members FOR EACH ROW EXECUTE FUNCTION set_row_version();
CREATE TRIGGER opportunity_locations_row_version BEFORE UPDATE ON opportunity_locations FOR EACH ROW EXECUTE FUNCTION set_row_version();
CREATE TRIGGER opportunity_compensation_row_version BEFORE UPDATE ON opportunity_compensation FOR EACH ROW EXECUTE FUNCTION set_row_version();
CREATE TRIGGER resolution_reviews_row_version BEFORE UPDATE ON resolution_reviews FOR EACH ROW EXECUTE FUNCTION set_row_version();

CREATE TRIGGER listing_versions_immutable BEFORE UPDATE OR DELETE ON listing_versions FOR EACH ROW EXECUTE FUNCTION reject_immutable_change();
CREATE TRIGGER lifecycle_events_immutable BEFORE UPDATE OR DELETE ON lifecycle_events FOR EACH ROW EXECUTE FUNCTION reject_immutable_change();
CREATE TRIGGER audit_events_immutable BEFORE UPDATE OR DELETE ON audit_events FOR EACH ROW EXECUTE FUNCTION reject_immutable_change();
