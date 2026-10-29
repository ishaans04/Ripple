CREATE INDEX "traces_host_status_idx" ON "habitat_traces" USING btree ("world_id","channel_id","status");
--> statement-breakpoint
CREATE FUNCTION validate_trace_qualification() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE valid boolean;
BEGIN
 SELECT true INTO valid FROM residencies r JOIN organisms o ON o.world_id=r.world_id AND o.id=r.organism_id
 JOIN rounds b ON b.world_id=r.world_id AND b.id=NEW.qualifying_round_id AND b.channel_id=r.channel_id
 JOIN rulesets s ON s.hash=b.rules_hash
 JOIN round_participants p ON p.world_id=b.world_id AND p.round_id=b.id AND p.organism_id=o.id
 JOIN habitat_traces t ON t.world_id=b.world_id AND t.id=NEW.trace_id
 WHERE r.world_id=NEW.world_id AND r.id=NEW.residency_id AND r.channel_id=NEW.channel_id
 AND r.organism_id=NEW.emitter_id AND o.lineage_id=NEW.lineage_id AND o.parent_id IS NOT NULL AND o.status='ALIVE'
 AND r.ended_at IS NULL AND r.role IN ('resident','visitor') AND r.arrival_snapshot IS NOT NULL AND NOT r.trace_qualified
 AND r.completed_valid_rounds >= (s.canonical::jsonb->'traces'->>'qualifyingRounds')::integer
 AND p.resolution->>'outcome'='applied' AND t.emitter_id=o.id AND t.channel_id=r.channel_id AND t.qualifying_round_id=b.id;
 IF valid IS DISTINCT FROM true THEN RAISE EXCEPTION 'trace qualification requires a surviving raid-origin participant and matched host round' USING ERRCODE='23514'; END IF;
 RETURN NEW;
END; $$;
--> statement-breakpoint
CREATE TRIGGER trace_qualification_inputs_valid BEFORE INSERT ON trace_qualifications FOR EACH ROW EXECUTE FUNCTION validate_trace_qualification();
--> statement-breakpoint
CREATE OR REPLACE FUNCTION preserve_trace_provenance() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN
 IF OLD.status='pending' AND NEW.status='active' AND NOT EXISTS (
 SELECT 1 FROM trace_qualifications q JOIN rounds b ON b.world_id=q.world_id AND b.channel_id=q.channel_id
 WHERE q.world_id=OLD.world_id AND q.trace_id=OLD.id AND b.id=(NEW.decision->>'roundId')::uuid
 AND b.kind='TRACE' AND b.phase='VOTING' AND b.completed_at IS NULL
 AND b.checkpoint->'specialBallot'->'traceOffer'->>'id'=OLD.id::text
 AND (b.checkpoint->'specialBallot'->'traceOffer'->>'version')::integer=OLD.version
 AND NEW.decision->>'choice'='keep' AND (NEW.decision->'counts')=(b.checkpoint->'counts')
 AND (NEW.decision->'counts'->>0)::integer>0 AND (NEW.decision->'counts'->>0)::integer>=(NEW.decision->'counts'->>1)::integer
 ) THEN RAISE EXCEPTION 'trace activation requires its earned qualification and recorded Keep ballot' USING ERRCODE='23514'; END IF;
 IF ROW(NEW.world_id,NEW.id,NEW.channel_id,NEW.emitter_id,NEW.template,NEW.provenance,NEW.qualifying_round_id)
 IS DISTINCT FROM ROW(OLD.world_id,OLD.id,OLD.channel_id,OLD.emitter_id,OLD.template,OLD.provenance,OLD.qualifying_round_id)
 OR NEW.version<>OLD.version+1 OR OLD.status NOT IN ('pending','active')
 OR (OLD.status='active' AND NEW.status NOT IN ('active','cleared','expired','replaced'))
 OR (OLD.status='pending' AND NEW.status NOT IN ('pending','active','cleared','expired','rejected'))
 OR (NOT (OLD.status='pending' AND NEW.status='active') AND
 (NEW.remaining_rounds>OLD.remaining_rounds OR NOT ((NEW.lifetime->'countedRoundIds') @> (OLD.lifetime->'countedRoundIds'))))
 OR (OLD.decision ? 'choice' AND (NEW.decision->'choice') IS DISTINCT FROM (OLD.decision->'choice'))
 OR (OLD.decision ? 'counts' AND (NEW.decision->'counts') IS DISTINCT FROM (OLD.decision->'counts')) THEN
 RAISE EXCEPTION 'trace provenance, decision, consumed lifetime and terminal state are immutable' USING ERRCODE='23514'; END IF;
 RETURN NEW;
END; $$;
