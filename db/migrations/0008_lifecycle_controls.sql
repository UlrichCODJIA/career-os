CREATE TABLE lifecycle_circuit_breakers (
  id uuid PRIMARY KEY,
  scope_type text NOT NULL CHECK (scope_type IN ('source', 'connector_version')),
  source_id uuid REFERENCES sources(id),
  connector_id text NOT NULL,
  connector_version text NOT NULL,
  trigger_scan_id uuid NOT NULL REFERENCES source_scans(id),
  reason text NOT NULL CHECK (reason IN ('suspicious_empty', 'count_collapse', 'closure_spike')),
  baseline_count integer NOT NULL CHECK (baseline_count >= 0),
  observed_count integer NOT NULL CHECK (observed_count >= 0),
  anomaly_ratio numeric(5,4) NOT NULL CHECK (anomaly_ratio BETWEEN 0 AND 1),
  state text NOT NULL DEFAULT 'tripped' CHECK (state IN ('tripped', 'cleared')),
  cleared_by text,
  cleared_reason text,
  cleared_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  row_version integer NOT NULL DEFAULT 1 CHECK (row_version > 0),
  CONSTRAINT lifecycle_circuit_breakers_clear_shape CHECK (
    (state = 'tripped' AND cleared_by IS NULL AND cleared_reason IS NULL AND cleared_at IS NULL)
    OR (state = 'cleared' AND cleared_by IS NOT NULL AND length(btrim(cleared_reason)) >= 8 AND cleared_at IS NOT NULL)
  ),
  CONSTRAINT lifecycle_circuit_breakers_scope_shape CHECK (
    (scope_type = 'source' AND source_id IS NOT NULL) OR (scope_type = 'connector_version' AND source_id IS NULL)
  )
);
CREATE UNIQUE INDEX lifecycle_circuit_breakers_active_source_uq ON lifecycle_circuit_breakers (source_id) WHERE state = 'tripped' AND scope_type = 'source';
CREATE UNIQUE INDEX lifecycle_circuit_breakers_active_connector_uq ON lifecycle_circuit_breakers (connector_id, connector_version)
  WHERE state = 'tripped' AND scope_type = 'connector_version';
CREATE INDEX lifecycle_circuit_breakers_history_idx ON lifecycle_circuit_breakers (source_id, created_at, id);

CREATE TABLE lifecycle_circuit_breaker_events (
  id uuid PRIMARY KEY,
  circuit_breaker_id uuid NOT NULL REFERENCES lifecycle_circuit_breakers(id),
  event_type text NOT NULL CHECK (event_type IN ('tripped', 'cleared')),
  actor_type text NOT NULL CHECK (actor_type IN ('system', 'operator')),
  actor_id text,
  reason text NOT NULL CHECK (length(btrim(reason)) >= 8),
  metadata jsonb NOT NULL DEFAULT '{}',
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  CONSTRAINT lifecycle_circuit_breaker_events_actor CHECK (actor_type <> 'operator' OR actor_id IS NOT NULL)
);
CREATE INDEX lifecycle_circuit_breaker_events_history_idx ON lifecycle_circuit_breaker_events (circuit_breaker_id, created_at, id);
CREATE FUNCTION guard_lifecycle_circuit_breaker_update()
RETURNS trigger LANGUAGE plpgsql AS $function$
BEGIN
  IF OLD.state <> 'tripped' OR NEW.state <> 'cleared'
    OR NEW.id <> OLD.id OR NEW.scope_type <> OLD.scope_type OR NEW.source_id IS DISTINCT FROM OLD.source_id
    OR NEW.connector_id <> OLD.connector_id OR NEW.connector_version <> OLD.connector_version
    OR NEW.trigger_scan_id <> OLD.trigger_scan_id OR NEW.reason <> OLD.reason
    OR NEW.baseline_count <> OLD.baseline_count OR NEW.observed_count <> OLD.observed_count
    OR NEW.anomaly_ratio <> OLD.anomaly_ratio OR NEW.created_at <> OLD.created_at THEN
    RAISE EXCEPTION 'invalid lifecycle circuit-breaker transition' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END
$function$;
CREATE TRIGGER lifecycle_circuit_breakers_row_version BEFORE UPDATE ON lifecycle_circuit_breakers FOR EACH ROW EXECUTE FUNCTION set_row_version();
CREATE TRIGGER lifecycle_circuit_breakers_transition_guard BEFORE UPDATE ON lifecycle_circuit_breakers
FOR EACH ROW EXECUTE FUNCTION guard_lifecycle_circuit_breaker_update();
CREATE TRIGGER lifecycle_circuit_breakers_no_delete BEFORE DELETE ON lifecycle_circuit_breakers
FOR EACH ROW EXECUTE FUNCTION reject_immutable_change();
CREATE TRIGGER lifecycle_circuit_breaker_events_immutable BEFORE UPDATE OR DELETE ON lifecycle_circuit_breaker_events FOR EACH ROW EXECUTE FUNCTION reject_immutable_change();
