CREATE FUNCTION validate_ancestor_trial() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE participant round_participants%ROWTYPE; founding jsonb; expected_founder uuid; rule_hash text; engine integer;
BEGIN
 SELECT p.* INTO participant FROM round_participants p WHERE p.world_id=NEW.world_id AND p.round_id=NEW.round_id AND p.organism_id=NEW.organism_id;
 SELECT o.founder_id,f.founding_genome INTO expected_founder,founding FROM organisms o JOIN organisms f ON f.world_id=o.world_id AND f.id=o.founder_id WHERE o.world_id=NEW.world_id AND o.id=NEW.organism_id;
 SELECT r.rules_hash,s.engine_version INTO rule_hash,engine FROM rounds r JOIN rulesets s ON s.hash=r.rules_hash WHERE r.world_id=NEW.world_id AND r.id=NEW.round_id;
 IF participant.resolution->>'outcome' IS DISTINCT FROM 'applied' OR NEW.ancestor_id IS DISTINCT FROM expected_founder
 OR NEW.rules_hash IS DISTINCT FROM rule_hash OR NEW.engine_version IS DISTINCT FROM engine
 OR (NEW.matched_inputs->>'schemaVersion') IS DISTINCT FROM '1'
 OR (NEW.matched_inputs->>'scoringStage') IS DISTINCT FROM 'before-shelter-settlement'
 OR (NEW.matched_inputs->'scoreInput'->'genome') IS DISTINCT FROM participant.genome
 OR (NEW.matched_inputs->'scoreInput'->>'healthBefore') IS DISTINCT FROM participant.health_before::text
 OR (NEW.matched_inputs->'scoreInput'->'profile'->'burst') IS DISTINCT FROM (participant.resolution->'profile'->'burst')
 OR (NEW.matched_inputs->'scoreInput'->'profile'->'steadiness') IS DISTINCT FROM (participant.resolution->'profile'->'steadiness')
 OR (NEW.result->'current') IS DISTINCT FROM (participant.resolution->'score')
 OR (NEW.result->'ancestor'->'genome') IS DISTINCT FROM founding THEN
 RAISE EXCEPTION 'ancestor trial must match the captured participant, founding genome and rules' USING ERRCODE='23514'; END IF;
 RETURN NEW;
END; $$;
--> statement-breakpoint
CREATE TRIGGER ancestor_trials_inputs_valid BEFORE INSERT ON ancestor_trials FOR EACH ROW EXECUTE FUNCTION validate_ancestor_trial();
