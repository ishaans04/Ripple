CREATE TABLE "mechanics_policies" (
	"hash" text PRIMARY KEY NOT NULL,
	"version" text NOT NULL,
	"canonical" text NOT NULL,
	CONSTRAINT "mechanics_policies_version_unique" UNIQUE("version"),
	CONSTRAINT "mechanics_policy_hash_valid" CHECK (encode(sha256(convert_to("mechanics_policies"."canonical",'UTF8')),'hex')="mechanics_policies"."hash")
);
--> statement-breakpoint
CREATE TABLE "trace_qualifications" (
	"world_id" uuid NOT NULL,
	"lineage_id" uuid NOT NULL,
	"channel_id" uuid NOT NULL,
	"residency_id" uuid NOT NULL,
	"emitter_id" uuid NOT NULL,
	"qualifying_round_id" uuid NOT NULL,
	"trace_id" uuid NOT NULL,
	CONSTRAINT "trace_qualifications_world_id_lineage_id_channel_id_pk" PRIMARY KEY("world_id","lineage_id","channel_id"),
	CONSTRAINT "trace_qualification_offer_unique" UNIQUE("world_id","trace_id")
);
--> statement-breakpoint
CREATE TABLE "world_mechanics_policies" (
	"world_id" uuid PRIMARY KEY NOT NULL,
	"policy_hash" text NOT NULL
);
--> statement-breakpoint
ALTER TABLE "channels" ADD COLUMN "initial_mechanics_version" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "ancestor_trials" ADD COLUMN "rules_hash" text NOT NULL;--> statement-breakpoint
ALTER TABLE "ancestor_trials" ADD COLUMN "engine_version" integer DEFAULT 1 NOT NULL;--> statement-breakpoint
ALTER TABLE "dormant_mutations" ADD COLUMN "lifetime" jsonb NOT NULL;--> statement-breakpoint
ALTER TABLE "dormant_mutations" ADD COLUMN "version" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "dormant_mutations" ADD COLUMN "consumption" jsonb;--> statement-breakpoint
ALTER TABLE "habitat_traces" ADD COLUMN "lifetime" jsonb NOT NULL;--> statement-breakpoint
ALTER TABLE "habitat_traces" ADD COLUMN "qualifying_round_id" uuid NOT NULL;--> statement-breakpoint
ALTER TABLE "channel_play" ADD COLUMN "mechanics_version" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "channel_play" ADD COLUMN "mechanics_requested" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "channel_play" ADD COLUMN "traces_enabled" boolean DEFAULT true NOT NULL;--> statement-breakpoint
ALTER TABLE "trace_qualifications" ADD CONSTRAINT "trace_qualifications_world_id_lineage_id_lineages_world_id_id_fk" FOREIGN KEY ("world_id","lineage_id") REFERENCES "public"."lineages"("world_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "trace_qualifications" ADD CONSTRAINT "trace_qualifications_world_id_channel_id_channels_world_id_id_fk" FOREIGN KEY ("world_id","channel_id") REFERENCES "public"."channels"("world_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "trace_qualifications" ADD CONSTRAINT "trace_qualifications_world_id_residency_id_residencies_world_id_id_fk" FOREIGN KEY ("world_id","residency_id") REFERENCES "public"."residencies"("world_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "trace_qualifications" ADD CONSTRAINT "trace_qualifications_world_id_emitter_id_organisms_world_id_id_fk" FOREIGN KEY ("world_id","emitter_id") REFERENCES "public"."organisms"("world_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "trace_qualifications" ADD CONSTRAINT "trace_qualifications_world_id_qualifying_round_id_rounds_world_id_id_fk" FOREIGN KEY ("world_id","qualifying_round_id") REFERENCES "public"."rounds"("world_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "trace_qualifications" ADD CONSTRAINT "trace_qualifications_world_id_trace_id_habitat_traces_world_id_id_fk" FOREIGN KEY ("world_id","trace_id") REFERENCES "public"."habitat_traces"("world_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "world_mechanics_policies" ADD CONSTRAINT "world_mechanics_policies_world_id_worlds_id_fk" FOREIGN KEY ("world_id") REFERENCES "public"."worlds"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "world_mechanics_policies" ADD CONSTRAINT "world_mechanics_policies_policy_hash_mechanics_policies_hash_fk" FOREIGN KEY ("policy_hash") REFERENCES "public"."mechanics_policies"("hash") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ancestor_trials" ADD CONSTRAINT "ancestor_trials_rules_hash_rulesets_hash_fk" FOREIGN KEY ("rules_hash") REFERENCES "public"."rulesets"("hash") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "habitat_traces" ADD CONSTRAINT "habitat_traces_world_id_qualifying_round_id_rounds_world_id_id_fk" FOREIGN KEY ("world_id","qualifying_round_id") REFERENCES "public"."rounds"("world_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "channels" ADD CONSTRAINT "channel_initial_mechanics_valid" CHECK ("channels"."initial_mechanics_version" in (0,1));--> statement-breakpoint
ALTER TABLE "dormant_mutations" ADD CONSTRAINT "dormant_lifetime_bounds" CHECK ("dormant_mutations"."remaining_rounds"<=3 and "dormant_mutations"."remaining_hops"<=16 and "dormant_mutations"."version">=0);--> statement-breakpoint
ALTER TABLE "habitat_traces" ADD CONSTRAINT "trace_lifetime_bounds" CHECK ("habitat_traces"."remaining_rounds"<=3);--> statement-breakpoint
ALTER TABLE "channel_play" ADD CONSTRAINT "channel_mechanics_version_valid" CHECK ("channel_play"."mechanics_version" in (0,1));
--> statement-breakpoint
INSERT INTO mechanics_policies(hash,version,canonical) VALUES ('c70ee0c3619914e967ef2cb0c27c8cb0166c3fe9a60be8973eaf89bc5a6f54cd','mechanics-policy-1','{"dormantRounds":3,"pendingTraceRounds":3,"traceRounds":3,"version":"mechanics-policy-1"}');
--> statement-breakpoint
INSERT INTO world_mechanics_policies(world_id,policy_hash) SELECT id,'c70ee0c3619914e967ef2cb0c27c8cb0166c3fe9a60be8973eaf89bc5a6f54cd' FROM worlds;
--> statement-breakpoint
CREATE FUNCTION initialize_world_mechanics_policy() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN
 INSERT INTO world_mechanics_policies(world_id,policy_hash) VALUES (NEW.id,'c70ee0c3619914e967ef2cb0c27c8cb0166c3fe9a60be8973eaf89bc5a6f54cd'); RETURN NEW;
END; $$;
--> statement-breakpoint
CREATE TRIGGER worlds_mechanics_policy AFTER INSERT ON worlds FOR EACH ROW EXECUTE FUNCTION initialize_world_mechanics_policy();
--> statement-breakpoint
CREATE TRIGGER mechanics_policy_immutable BEFORE UPDATE OR DELETE ON mechanics_policies FOR EACH ROW EXECUTE FUNCTION reject_committed_update();
--> statement-breakpoint
CREATE TRIGGER world_mechanics_policy_immutable BEFORE UPDATE ON world_mechanics_policies FOR EACH ROW EXECUTE FUNCTION reject_committed_update();
--> statement-breakpoint
CREATE OR REPLACE FUNCTION initialize_channel_play() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN
 INSERT INTO channel_play(world_id,channel_id,mechanics_version) VALUES (NEW.world_id,NEW.id,NEW.initial_mechanics_version); RETURN NEW;
END; $$;
--> statement-breakpoint
CREATE FUNCTION preserve_mechanics_genesis() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN
 IF NEW.initial_mechanics_version IS DISTINCT FROM OLD.initial_mechanics_version THEN
 RAISE EXCEPTION 'channel mechanics genesis is immutable' USING ERRCODE='23514'; END IF;
 RETURN NEW;
END; $$;
--> statement-breakpoint
CREATE TRIGGER channels_mechanics_genesis BEFORE UPDATE ON channels FOR EACH ROW EXECUTE FUNCTION preserve_mechanics_genesis();
--> statement-breakpoint
CREATE FUNCTION valid_mechanic_lifetime(value jsonb, birth uuid, remaining integer) RETURNS boolean LANGUAGE plpgsql IMMUTABLE AS $$
DECLARE seen jsonb; total integer;
BEGIN
 IF jsonb_typeof(value) IS DISTINCT FROM 'object' OR value->>'birthRoundId' IS DISTINCT FROM birth::text
 OR jsonb_typeof(value->'remainingRounds') IS DISTINCT FROM 'number'
 OR (value->>'remainingRounds')::numeric IS DISTINCT FROM remaining::numeric
 OR jsonb_typeof(value->'countedRoundIds') IS DISTINCT FROM 'array' THEN RETURN false; END IF;
 seen:=value->'countedRoundIds'; total:=jsonb_array_length(seen);
 RETURN remaining BETWEEN 0 AND 3 AND total+remaining<=3
 AND (SELECT count(DISTINCT item)=total AND bool_and(jsonb_typeof(item)='string' AND item#>>'{}'<>birth::text AND length(item#>>'{}') BETWEEN 1 AND 128) FROM jsonb_array_elements(seen) item) IS NOT FALSE;
END; $$;
--> statement-breakpoint
ALTER TABLE dormant_mutations ADD CONSTRAINT dormant_lifetime_consistent CHECK (valid_mechanic_lifetime(lifetime,source_round_id,remaining_rounds));
--> statement-breakpoint
ALTER TABLE habitat_traces ADD CONSTRAINT trace_lifetime_consistent CHECK (valid_mechanic_lifetime(lifetime,qualifying_round_id,remaining_rounds));
--> statement-breakpoint
CREATE FUNCTION preserve_dormant_provenance() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN
 IF ROW(NEW.world_id,NEW.id,NEW.organism_id,NEW.source_round_id,NEW.template,NEW.provenance,NEW.remaining_hops)
 IS DISTINCT FROM ROW(OLD.world_id,OLD.id,OLD.organism_id,OLD.source_round_id,OLD.template,OLD.provenance,OLD.remaining_hops)
 OR NEW.remaining_rounds>OLD.remaining_rounds OR NOT ((NEW.lifetime->'countedRoundIds') @> (OLD.lifetime->'countedRoundIds'))
 OR (OLD.offered AND NOT NEW.offered) OR NEW.version<>OLD.version+1
 OR (OLD.consumption IS NOT NULL AND NEW.consumption IS DISTINCT FROM OLD.consumption)
 OR OLD.status<>'active' THEN
 RAISE EXCEPTION 'dormant provenance, consumed lifetime and terminal state are immutable' USING ERRCODE='23514'; END IF;
 RETURN NEW;
END; $$;
--> statement-breakpoint
CREATE TRIGGER dormant_provenance_immutable BEFORE UPDATE ON dormant_mutations FOR EACH ROW EXECUTE FUNCTION preserve_dormant_provenance();
--> statement-breakpoint
CREATE FUNCTION preserve_trace_provenance() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN
 IF ROW(NEW.world_id,NEW.id,NEW.channel_id,NEW.emitter_id,NEW.template,NEW.provenance,NEW.qualifying_round_id)
 IS DISTINCT FROM ROW(OLD.world_id,OLD.id,OLD.channel_id,OLD.emitter_id,OLD.template,OLD.provenance,OLD.qualifying_round_id)
 OR NEW.version<>OLD.version+1 OR OLD.status NOT IN ('pending','active')
 OR (NOT (OLD.status='pending' AND NEW.status='active') AND
 (NEW.remaining_rounds>OLD.remaining_rounds OR NOT ((NEW.lifetime->'countedRoundIds') @> (OLD.lifetime->'countedRoundIds')))) THEN
 RAISE EXCEPTION 'trace provenance, consumed lifetime and terminal state are immutable' USING ERRCODE='23514'; END IF;
 RETURN NEW;
END; $$;
--> statement-breakpoint
CREATE TRIGGER trace_provenance_immutable BEFORE UPDATE ON habitat_traces FOR EACH ROW EXECUTE FUNCTION preserve_trace_provenance();
--> statement-breakpoint
CREATE TRIGGER trace_qualifications_immutable BEFORE UPDATE ON trace_qualifications FOR EACH ROW EXECUTE FUNCTION reject_committed_update();
--> statement-breakpoint
CREATE TRIGGER ancestor_trials_immutable BEFORE UPDATE ON ancestor_trials FOR EACH ROW EXECUTE FUNCTION reject_committed_update();
