CREATE TABLE "choice_replays" (
	"world_id" uuid NOT NULL,
	"round_id" uuid NOT NULL,
	"organism_id" uuid NOT NULL,
	"rules_hash" text NOT NULL,
	"engine_version" integer NOT NULL,
	"confidence" text NOT NULL,
	"inputs" jsonb NOT NULL,
	"result" jsonb NOT NULL,
	CONSTRAINT "choice_replays_world_id_round_id_organism_id_pk" PRIMARY KEY("world_id","round_id","organism_id"),
	CONSTRAINT "choice_replay_confidence_valid" CHECK ("choice_replays"."confidence" in ('confident','limited'))
);
--> statement-breakpoint
ALTER TABLE "choice_replays" ADD CONSTRAINT "choice_replays_rules_hash_rulesets_hash_fk" FOREIGN KEY ("rules_hash") REFERENCES "public"."rulesets"("hash") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "choice_replays" ADD CONSTRAINT "choice_replays_world_id_round_id_rounds_world_id_id_fk" FOREIGN KEY ("world_id","round_id") REFERENCES "public"."rounds"("world_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "choice_replays" ADD CONSTRAINT "choice_replays_world_id_organism_id_organisms_world_id_id_fk" FOREIGN KEY ("world_id","organism_id") REFERENCES "public"."organisms"("world_id","id") ON DELETE no action ON UPDATE no action;
--> statement-breakpoint
CREATE TRIGGER choice_replays_immutable BEFORE UPDATE ON choice_replays FOR EACH ROW EXECUTE FUNCTION reject_committed_update();
--> statement-breakpoint
CREATE FUNCTION validate_choice_replay() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE captured round_participants%ROWTYPE; ballot rounds%ROWTYPE; engine integer;
BEGIN
 SELECT * INTO captured FROM round_participants WHERE world_id=NEW.world_id AND round_id=NEW.round_id AND organism_id=NEW.organism_id;
 SELECT * INTO ballot FROM rounds WHERE world_id=NEW.world_id AND id=NEW.round_id;
 SELECT engine_version INTO engine FROM rulesets WHERE hash=ballot.rules_hash;
 IF ballot.kind IS DISTINCT FROM 'MUTATION' OR ballot.organism_id IS DISTINCT FROM NEW.organism_id
 OR captured.resolution->>'outcome' NOT IN ('applied','limited') OR captured.resolution IS NULL
 OR NEW.confidence IS DISTINCT FROM (captured.resolution->'profile'->>'confidence')
 OR NEW.rules_hash IS DISTINCT FROM ballot.rules_hash OR NEW.engine_version IS DISTINCT FROM engine
 OR (NEW.inputs->'genomeBefore') IS DISTINCT FROM (ballot.checkpoint->'genomeBefore')
 OR (NEW.inputs->'candidates') IS DISTINCT FROM (ballot.checkpoint->'candidates')
 OR NOT (NEW.inputs ? 'selectedId') OR NOT (ballot.checkpoint ? 'mutationSelection')
 OR (NEW.inputs->'selectedId') IS DISTINCT FROM (ballot.checkpoint->'mutationSelection'->'choiceId')
 OR (NEW.inputs->'actual'->'genome') IS DISTINCT FROM captured.genome
 OR (NEW.inputs->'actual'->>'healthBefore') IS DISTINCT FROM captured.health_before::text
 OR (NEW.inputs->>'actualOutcome') IS DISTINCT FROM (captured.resolution->>'outcome')
 OR (NEW.inputs->'actualHealthAfter') IS DISTINCT FROM (captured.resolution->'healthAfter')
 OR (NEW.result->'actual') IS DISTINCT FROM coalesce(captured.resolution->'score',captured.resolution->'estimate') THEN
 RAISE EXCEPTION 'choice replay must match the recorded ballot and actual scored inputs' USING ERRCODE='23514'; END IF;
 RETURN NEW;
END; $$;
--> statement-breakpoint
CREATE TRIGGER choice_replay_inputs_valid BEFORE INSERT ON choice_replays FOR EACH ROW EXECUTE FUNCTION validate_choice_replay();
