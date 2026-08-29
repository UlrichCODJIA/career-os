CREATE TABLE opportunity_problem_reports (
  id uuid PRIMARY KEY,
  opportunity_id uuid NOT NULL REFERENCES opportunities(id),
  reporter_actor_id text NOT NULL CHECK (length(btrim(reporter_actor_id)) BETWEEN 1 AND 200),
  report_kind text NOT NULL CHECK (report_kind IN ('closed', 'wrong_company', 'wrong_location', 'wrong_salary', 'duplicate', 'broken_link', 'other')),
  detail text CHECK (detail IS NULL OR length(btrim(detail)) BETWEEN 3 AND 2000),
  duplicate_opportunity_id uuid REFERENCES opportunities(id),
  state text NOT NULL DEFAULT 'pending' CHECK (state IN ('pending', 'accepted', 'rejected', 'superseded')),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  CONSTRAINT opportunity_problem_reports_duplicate_shape CHECK (
    (report_kind = 'duplicate') = (duplicate_opportunity_id IS NOT NULL)
    AND duplicate_opportunity_id IS DISTINCT FROM opportunity_id
  )
);
CREATE INDEX opportunity_problem_reports_queue_idx
  ON opportunity_problem_reports (state, created_at, id);
CREATE INDEX opportunity_problem_reports_opportunity_idx
  ON opportunity_problem_reports (opportunity_id, created_at, id);
CREATE TRIGGER opportunity_problem_reports_immutable
BEFORE UPDATE OR DELETE ON opportunity_problem_reports FOR EACH ROW EXECUTE FUNCTION reject_immutable_change();
