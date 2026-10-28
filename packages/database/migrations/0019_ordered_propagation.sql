CREATE TABLE "channel_play" (
	"world_id" uuid NOT NULL,
	"channel_id" uuid NOT NULL,
	"preparation" text DEFAULT 'neutral' NOT NULL,
	"preparation_requested" boolean DEFAULT false NOT NULL,
	"non_mutation_rounds" integer DEFAULT 0 NOT NULL,
	"rules_compatible" boolean DEFAULT true NOT NULL,
	CONSTRAINT "channel_play_world_id_channel_id_pk" PRIMARY KEY("world_id","channel_id"),
	CONSTRAINT "channel_preparation_valid" CHECK ("channel_play"."preparation" in ('shield','reserve','neutral')),
	CONSTRAINT "non_mutation_rounds_valid" CHECK ("channel_play"."non_mutation_rounds">=0)
);
--> statement-breakpoint
CREATE TABLE "raid_policies" (
	"hash" text PRIMARY KEY NOT NULL,
	"version" text NOT NULL,
	"canonical" text NOT NULL,
	CONSTRAINT "raid_policies_version_unique" UNIQUE("version"),
	CONSTRAINT "raid_policy_hash_valid" CHECK (encode(sha256(convert_to("raid_policies"."canonical",'UTF8')),'hex')="raid_policies"."hash")
);
--> statement-breakpoint
CREATE TABLE "round_participants" (
	"world_id" uuid NOT NULL,
	"round_id" uuid NOT NULL,
	"organism_id" uuid NOT NULL,
	"role" text NOT NULL,
	"genome" jsonb NOT NULL,
	"health_before" integer NOT NULL,
	"resolution" jsonb,
	"explanation" jsonb,
	CONSTRAINT "round_participants_world_id_round_id_organism_id_pk" PRIMARY KEY("world_id","round_id","organism_id"),
	CONSTRAINT "participant_role_valid" CHECK ("round_participants"."role" in ('resident','visitor')),
	CONSTRAINT "participant_health_valid" CHECK ("round_participants"."health_before" between 1 and 100)
);
--> statement-breakpoint
CREATE TABLE "source_blocks" (
	"world_id" uuid NOT NULL,
	"channel_id" uuid NOT NULL,
	"source_channel_id" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "source_blocks_world_id_channel_id_source_channel_id_pk" PRIMARY KEY("world_id","channel_id","source_channel_id")
);
--> statement-breakpoint
CREATE TABLE "transfer_transitions" (
	"world_id" uuid NOT NULL,
	"transfer_id" uuid NOT NULL,
	"version" integer NOT NULL,
	"outcome" text NOT NULL,
	"at" timestamp with time zone NOT NULL,
	"channel_id" uuid NOT NULL,
	"sequence" integer NOT NULL,
	"detail" jsonb NOT NULL,
	CONSTRAINT "transfer_transitions_world_id_transfer_id_version_pk" PRIMARY KEY("world_id","transfer_id","version")
);
--> statement-breakpoint
CREATE TABLE "visitor_state" (
	"world_id" uuid NOT NULL,
	"organism_id" uuid NOT NULL,
	"channel_id" uuid NOT NULL,
	"transfer_id" uuid NOT NULL,
	"welcomed" boolean DEFAULT false NOT NULL,
	"arrival_pending" boolean DEFAULT true NOT NULL,
	"shock_reduction" integer DEFAULT 0 NOT NULL,
	"shelter_pending" boolean DEFAULT false NOT NULL,
	CONSTRAINT "visitor_state_world_id_organism_id_pk" PRIMARY KEY("world_id","organism_id"),
	CONSTRAINT "visitor_reduction_valid" CHECK ("visitor_state"."shock_reduction" between 0 and 4)
);
--> statement-breakpoint
CREATE TABLE "world_raid_policies" (
	"world_id" uuid PRIMARY KEY NOT NULL,
	"policy_hash" text NOT NULL
);
--> statement-breakpoint
ALTER TABLE "transfers" ALTER COLUMN "parent_id" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "transfers" ADD COLUMN "version" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "transfers" ADD COLUMN "destination_sequence" integer;--> statement-breakpoint
ALTER TABLE "transfers" ADD COLUMN "approved_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "channel_play" ADD CONSTRAINT "channel_play_world_id_channel_id_channels_world_id_id_fk" FOREIGN KEY ("world_id","channel_id") REFERENCES "public"."channels"("world_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "round_participants" ADD CONSTRAINT "round_participants_world_id_round_id_rounds_world_id_id_fk" FOREIGN KEY ("world_id","round_id") REFERENCES "public"."rounds"("world_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "round_participants" ADD CONSTRAINT "round_participants_world_id_organism_id_organisms_world_id_id_fk" FOREIGN KEY ("world_id","organism_id") REFERENCES "public"."organisms"("world_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "source_blocks" ADD CONSTRAINT "source_blocks_world_id_channel_id_channels_world_id_id_fk" FOREIGN KEY ("world_id","channel_id") REFERENCES "public"."channels"("world_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "source_blocks" ADD CONSTRAINT "source_blocks_world_id_source_channel_id_channels_world_id_id_fk" FOREIGN KEY ("world_id","source_channel_id") REFERENCES "public"."channels"("world_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "transfer_transitions" ADD CONSTRAINT "transfer_transitions_world_id_transfer_id_transfers_world_id_id_fk" FOREIGN KEY ("world_id","transfer_id") REFERENCES "public"."transfers"("world_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "transfer_transitions" ADD CONSTRAINT "transfer_transitions_world_id_channel_id_channels_world_id_id_fk" FOREIGN KEY ("world_id","channel_id") REFERENCES "public"."channels"("world_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "visitor_state" ADD CONSTRAINT "visitor_state_world_id_organism_id_organisms_world_id_id_fk" FOREIGN KEY ("world_id","organism_id") REFERENCES "public"."organisms"("world_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "visitor_state" ADD CONSTRAINT "visitor_state_world_id_channel_id_channels_world_id_id_fk" FOREIGN KEY ("world_id","channel_id") REFERENCES "public"."channels"("world_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "visitor_state" ADD CONSTRAINT "visitor_state_world_id_transfer_id_transfers_world_id_id_fk" FOREIGN KEY ("world_id","transfer_id") REFERENCES "public"."transfers"("world_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "world_raid_policies" ADD CONSTRAINT "world_raid_policies_world_id_worlds_id_fk" FOREIGN KEY ("world_id") REFERENCES "public"."worlds"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "world_raid_policies" ADD CONSTRAINT "world_raid_policies_policy_hash_raid_policies_hash_fk" FOREIGN KEY ("policy_hash") REFERENCES "public"."raid_policies"("hash") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "transfer_transition_channel_idx" ON "transfer_transitions" USING btree ("world_id","channel_id","sequence");
--> statement-breakpoint
INSERT INTO raid_policies(hash,version,canonical) VALUES ('4a998bdde4e0137241220bad871e0de3eee995e600217e3331bee046cc8dd444','raid-policy-1','{"acclimateCost":4,"acclimateShockReduction":1,"admissionTtlMs":86400000,"forkCooldownMs":1800000,"generationCap":16,"harborCap":3,"livingLineageCap":12,"maxNonMutationRounds":2,"shelterMinHealth":50,"shelterTransfer":5,"shieldCost":4,"shieldShockReduction":2,"version":"raid-policy-1"}');
--> statement-breakpoint
INSERT INTO world_raid_policies(world_id,policy_hash) SELECT id,'4a998bdde4e0137241220bad871e0de3eee995e600217e3331bee046cc8dd444' FROM worlds;
--> statement-breakpoint
INSERT INTO channel_play(world_id,channel_id) SELECT world_id,id FROM channels;
--> statement-breakpoint
CREATE FUNCTION initialize_world_raid_policy() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN
  INSERT INTO world_raid_policies(world_id,policy_hash) VALUES (NEW.id,'4a998bdde4e0137241220bad871e0de3eee995e600217e3331bee046cc8dd444'); RETURN NEW;
END; $$;
--> statement-breakpoint
CREATE TRIGGER worlds_raid_policy AFTER INSERT ON worlds FOR EACH ROW EXECUTE FUNCTION initialize_world_raid_policy();
--> statement-breakpoint
CREATE FUNCTION initialize_channel_play() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN
  INSERT INTO channel_play(world_id,channel_id) VALUES (NEW.world_id,NEW.id); RETURN NEW;
END; $$;
--> statement-breakpoint
CREATE TRIGGER channels_play_state AFTER INSERT ON channels FOR EACH ROW EXECUTE FUNCTION initialize_channel_play();
--> statement-breakpoint
CREATE TRIGGER raid_policy_immutable BEFORE UPDATE ON raid_policies FOR EACH ROW EXECUTE FUNCTION reject_committed_update();
--> statement-breakpoint
CREATE TRIGGER world_raid_policy_immutable BEFORE UPDATE ON world_raid_policies FOR EACH ROW EXECUTE FUNCTION reject_committed_update();
--> statement-breakpoint
CREATE TRIGGER transfer_history_immutable BEFORE UPDATE ON transfer_transitions FOR EACH ROW EXECUTE FUNCTION reject_committed_update();
--> statement-breakpoint
CREATE FUNCTION preserve_transfer_snapshot() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN
 IF ROW(NEW.world_id,NEW.id,NEW.receipt_id,NEW.source_channel_id,NEW.destination_channel_id,NEW.destination_twitch_id,NEW.source_version,NEW.parent_id,NEW.child_id,NEW.snapshot,NEW.expires_at,NEW.created_at)
 IS DISTINCT FROM ROW(OLD.world_id,OLD.id,OLD.receipt_id,OLD.source_channel_id,OLD.destination_channel_id,OLD.destination_twitch_id,OLD.source_version,OLD.parent_id,OLD.child_id,OLD.snapshot,OLD.expires_at,OLD.created_at) THEN
 RAISE EXCEPTION 'transfer origin and accepted snapshot are immutable' USING ERRCODE='23514'; END IF;
 IF OLD.destination_sequence IS NOT NULL AND NEW.destination_sequence IS DISTINCT FROM OLD.destination_sequence THEN RAISE EXCEPTION 'destination receipt is immutable' USING ERRCODE='23514'; END IF;
 IF NEW.version<OLD.version OR NEW.version>OLD.version+1 THEN RAISE EXCEPTION 'invalid transfer version' USING ERRCODE='23514'; END IF;
 IF (NEW.outcome IS DISTINCT FROM OLD.outcome OR NEW.approved_at IS DISTINCT FROM OLD.approved_at) AND NEW.version<>OLD.version+1 THEN RAISE EXCEPTION 'transfer changes require the next version' USING ERRCODE='23514'; END IF;
 RETURN NEW;
END; $$;
--> statement-breakpoint
CREATE TRIGGER transfers_snapshot_immutable BEFORE UPDATE ON transfers FOR EACH ROW EXECUTE FUNCTION preserve_transfer_snapshot();
--> statement-breakpoint
CREATE FUNCTION preserve_round_participant() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN
 IF ROW(NEW.world_id,NEW.round_id,NEW.organism_id,NEW.role,NEW.genome,NEW.health_before) IS DISTINCT FROM ROW(OLD.world_id,OLD.round_id,OLD.organism_id,OLD.role,OLD.genome,OLD.health_before)
 OR (OLD.resolution IS NOT NULL AND NEW IS DISTINCT FROM OLD) THEN RAISE EXCEPTION 'captured round participant is immutable' USING ERRCODE='23514'; END IF;
 RETURN NEW;
END; $$;
--> statement-breakpoint
CREATE TRIGGER round_participants_immutable BEFORE UPDATE ON round_participants FOR EACH ROW EXECUTE FUNCTION preserve_round_participant();
