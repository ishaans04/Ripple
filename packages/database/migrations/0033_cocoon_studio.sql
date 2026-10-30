CREATE TABLE "appearance_blueprints" (
	"world_id" uuid NOT NULL,
	"hash" text NOT NULL,
	"canonical" text NOT NULL,
	"blueprint" jsonb NOT NULL,
	"renderer_version" text NOT NULL,
	"template" text NOT NULL,
	"session_id" uuid NOT NULL,
	"parent_hash" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "appearance_blueprints_world_id_hash_pk" PRIMARY KEY("world_id","hash"),
	CONSTRAINT "appearance_blueprint_hash_format" CHECK ("appearance_blueprints"."hash" ~ '^[0-9a-f]{64}$'),
	CONSTRAINT "appearance_blueprint_renderer_known" CHECK ("appearance_blueprints"."renderer_version" = 'shell-v1'),
	CONSTRAINT "appearance_blueprint_size" CHECK (octet_length("appearance_blueprints"."canonical") <= 8192)
);
--> statement-breakpoint
CREATE TABLE "artist_sessions" (
	"hash" text PRIMARY KEY NOT NULL,
	"world_id" uuid NOT NULL,
	"artist_key" text NOT NULL,
	"login" text NOT NULL,
	"csrf_hash" text NOT NULL,
	"expires_at" timestamp with time zone NOT NULL
);
--> statement-breakpoint
CREATE TABLE "channel_studio" (
	"world_id" uuid NOT NULL,
	"channel_id" uuid NOT NULL,
	"settings" jsonb NOT NULL,
	"availability" text DEFAULT 'ACTIVE' NOT NULL,
	"availability_source" text,
	"bridge_scene" text,
	"bridge_seen_at" timestamp with time zone,
	"bridge_stale" boolean DEFAULT false NOT NULL,
	CONSTRAINT "channel_studio_world_id_channel_id_pk" PRIMARY KEY("world_id","channel_id"),
	CONSTRAINT "channel_studio_availability_valid" CHECK ("channel_studio"."availability" in ('ACTIVE','REST','UNKNOWN')),
	CONSTRAINT "channel_studio_source_valid" CHECK ("channel_studio"."availability_source" is null or "channel_studio"."availability_source" in ('manual','bridge','stream','integration'))
);
--> statement-breakpoint
CREATE TABLE "pending_adaptations" (
	"world_id" uuid NOT NULL,
	"id" uuid NOT NULL,
	"session_id" uuid NOT NULL,
	"channel_id" uuid NOT NULL,
	"organism_id" uuid NOT NULL,
	"blueprint_hash" text NOT NULL,
	"template" text NOT NULL,
	"target_slot" integer NOT NULL,
	"status" text NOT NULL,
	"approval" jsonb NOT NULL,
	"reason" text,
	"committed_round_id" uuid,
	"created_at" timestamp with time zone NOT NULL,
	"resolved_at" timestamp with time zone,
	CONSTRAINT "pending_adaptations_world_id_id_pk" PRIMARY KEY("world_id","id"),
	CONSTRAINT "pending_adaptation_status_valid" CHECK ("pending_adaptations"."status" in ('pending','committed','released','cancelled','expired')),
	CONSTRAINT "pending_adaptation_slot_positive" CHECK ("pending_adaptations"."target_slot" > 0)
);
--> statement-breakpoint
CREATE TABLE "studio_artist_blocks" (
	"world_id" uuid NOT NULL,
	"channel_id" uuid NOT NULL,
	"artist_key" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "studio_artist_blocks_world_id_channel_id_artist_key_pk" PRIMARY KEY("world_id","channel_id","artist_key")
);
--> statement-breakpoint
CREATE TABLE "studio_bridge_capabilities" (
	"hash" text PRIMARY KEY NOT NULL,
	"world_id" uuid NOT NULL,
	"channel_id" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"revoked_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "studio_proposals" (
	"world_id" uuid NOT NULL,
	"id" uuid NOT NULL,
	"session_id" uuid NOT NULL,
	"artist_key" text NOT NULL,
	"credit" text NOT NULL,
	"credit_opt_in" boolean NOT NULL,
	"revision" integer NOT NULL,
	"blueprint_hash" text NOT NULL,
	"status" text NOT NULL,
	"submitted_sequence" integer NOT NULL,
	"submitted_at" timestamp with time zone NOT NULL,
	"ended_sequence" integer,
	CONSTRAINT "studio_proposals_world_id_id_pk" PRIMARY KEY("world_id","id"),
	CONSTRAINT "studio_proposal_status_valid" CHECK ("studio_proposals"."status" in ('active','replaced','withdrawn','removed')),
	CONSTRAINT "studio_proposal_revision_positive" CHECK ("studio_proposals"."revision" > 0),
	CONSTRAINT "studio_proposal_credit_length" CHECK (length("studio_proposals"."credit") between 1 and 40)
);
--> statement-breakpoint
CREATE TABLE "studio_sessions" (
	"world_id" uuid NOT NULL,
	"id" uuid NOT NULL,
	"channel_id" uuid NOT NULL,
	"organism_id" uuid NOT NULL,
	"phase" text NOT NULL,
	"version" integer DEFAULT 0 NOT NULL,
	"trigger" text NOT NULL,
	"challenge" jsonb NOT NULL,
	"seed" text NOT NULL,
	"settings" jsonb NOT NULL,
	"creation_close_at" timestamp with time zone,
	"voting_close_at" timestamp with time zone,
	"review_expires_at" timestamp with time zone,
	"ballot_round_id" uuid,
	"shortlist" jsonb,
	"selection" jsonb,
	"adaptation_id" uuid,
	"outcome" jsonb,
	"opened_sequence" integer NOT NULL,
	"created_at" timestamp with time zone NOT NULL,
	"ended_at" timestamp with time zone,
	CONSTRAINT "studio_sessions_world_id_id_pk" PRIMARY KEY("world_id","id"),
	CONSTRAINT "studio_session_phase_valid" CHECK ("studio_sessions"."phase" in ('OPENING','CREATING','VOTING','REVIEW','PENDING_HATCH','COMPLETED','CANCELLED','EXPIRED')),
	CONSTRAINT "studio_session_trigger_valid" CHECK ("studio_sessions"."trigger" in ('manual','bridge')),
	CONSTRAINT "studio_session_version_nonnegative" CHECK ("studio_sessions"."version" >= 0),
	CONSTRAINT "studio_session_terminal_ended" CHECK (("studio_sessions"."ended_at" is null) = ("studio_sessions"."phase" in ('OPENING','CREATING','VOTING','REVIEW','PENDING_HATCH')))
);
--> statement-breakpoint
CREATE TABLE "studio_transitions" (
	"world_id" uuid NOT NULL,
	"session_id" uuid NOT NULL,
	"version" integer NOT NULL,
	"from_phase" text,
	"to_phase" text NOT NULL,
	"event" text NOT NULL,
	"sequence" integer NOT NULL,
	"detail" jsonb NOT NULL,
	"at" timestamp with time zone NOT NULL,
	CONSTRAINT "studio_transitions_world_id_session_id_version_pk" PRIMARY KEY("world_id","session_id","version")
);
--> statement-breakpoint
ALTER TABLE "oauth_states" DROP CONSTRAINT "oauth_state_purpose";--> statement-breakpoint
DROP INDEX "rounds_one_open";--> statement-breakpoint
ALTER TABLE "channels" ADD COLUMN "studio_hold" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "organisms" ADD COLUMN "design_version" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "organisms" ADD COLUMN "appearance_hash" text;--> statement-breakpoint
ALTER TABLE "dormant_mutations" ADD COLUMN "blueprint_hash" text;--> statement-breakpoint
ALTER TABLE "channel_studio" ADD CONSTRAINT "channel_studio_world_id_channel_id_channels_world_id_id_fk" FOREIGN KEY ("world_id","channel_id") REFERENCES "public"."channels"("world_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "pending_adaptations" ADD CONSTRAINT "pending_adaptations_world_id_session_id_studio_sessions_world_id_id_fk" FOREIGN KEY ("world_id","session_id") REFERENCES "public"."studio_sessions"("world_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "pending_adaptations" ADD CONSTRAINT "pending_adaptations_world_id_organism_id_organisms_world_id_id_fk" FOREIGN KEY ("world_id","organism_id") REFERENCES "public"."organisms"("world_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "pending_adaptations" ADD CONSTRAINT "pending_adaptations_world_id_blueprint_hash_appearance_blueprints_world_id_hash_fk" FOREIGN KEY ("world_id","blueprint_hash") REFERENCES "public"."appearance_blueprints"("world_id","hash") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "studio_artist_blocks" ADD CONSTRAINT "studio_artist_blocks_world_id_channel_id_channels_world_id_id_fk" FOREIGN KEY ("world_id","channel_id") REFERENCES "public"."channels"("world_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "studio_bridge_capabilities" ADD CONSTRAINT "studio_bridge_capabilities_world_id_channel_id_channels_world_id_id_fk" FOREIGN KEY ("world_id","channel_id") REFERENCES "public"."channels"("world_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "studio_proposals" ADD CONSTRAINT "studio_proposals_world_id_session_id_studio_sessions_world_id_id_fk" FOREIGN KEY ("world_id","session_id") REFERENCES "public"."studio_sessions"("world_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "studio_proposals" ADD CONSTRAINT "studio_proposals_world_id_blueprint_hash_appearance_blueprints_world_id_hash_fk" FOREIGN KEY ("world_id","blueprint_hash") REFERENCES "public"."appearance_blueprints"("world_id","hash") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "studio_sessions" ADD CONSTRAINT "studio_sessions_world_id_channel_id_channels_world_id_id_fk" FOREIGN KEY ("world_id","channel_id") REFERENCES "public"."channels"("world_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "studio_sessions" ADD CONSTRAINT "studio_sessions_world_id_organism_id_organisms_world_id_id_fk" FOREIGN KEY ("world_id","organism_id") REFERENCES "public"."organisms"("world_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "studio_transitions" ADD CONSTRAINT "studio_transitions_world_id_session_id_studio_sessions_world_id_id_fk" FOREIGN KEY ("world_id","session_id") REFERENCES "public"."studio_sessions"("world_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "artist_sessions_expiry_idx" ON "artist_sessions" USING btree ("expires_at");--> statement-breakpoint
CREATE UNIQUE INDEX "pending_adaptation_per_session" ON "pending_adaptations" USING btree ("world_id","session_id");--> statement-breakpoint
CREATE UNIQUE INDEX "pending_adaptation_one_per_organism" ON "pending_adaptations" USING btree ("world_id","organism_id") WHERE "pending_adaptations"."status" = 'pending';--> statement-breakpoint
CREATE UNIQUE INDEX "pending_adaptation_one_commit_per_slot" ON "pending_adaptations" USING btree ("world_id","organism_id","target_slot") WHERE "pending_adaptations"."status" = 'committed';--> statement-breakpoint
CREATE UNIQUE INDEX "studio_bridge_one_active" ON "studio_bridge_capabilities" USING btree ("world_id","channel_id") WHERE "studio_bridge_capabilities"."revoked_at" is null;--> statement-breakpoint
CREATE UNIQUE INDEX "studio_one_active_proposal_per_artist" ON "studio_proposals" USING btree ("world_id","session_id","artist_key") WHERE "studio_proposals"."status" = 'active';--> statement-breakpoint
CREATE INDEX "studio_proposals_session_idx" ON "studio_proposals" USING btree ("world_id","session_id","status");--> statement-breakpoint
CREATE UNIQUE INDEX "studio_one_nonterminal_per_channel" ON "studio_sessions" USING btree ("world_id","channel_id") WHERE phase in ('OPENING','CREATING','VOTING','REVIEW','PENDING_HATCH');--> statement-breakpoint
CREATE INDEX "studio_sessions_channel_idx" ON "studio_sessions" USING btree ("world_id","channel_id","created_at");--> statement-breakpoint
CREATE UNIQUE INDEX "rounds_one_open_studio" ON "rounds" USING btree ("world_id","channel_id") WHERE "rounds"."completed_at" is null and "rounds"."kind" = 'STUDIO_SELECTION';--> statement-breakpoint
CREATE UNIQUE INDEX "rounds_one_open" ON "rounds" USING btree ("world_id","channel_id") WHERE "rounds"."completed_at" is null and "rounds"."kind" <> 'STUDIO_SELECTION';--> statement-breakpoint
ALTER TABLE "organisms" ADD CONSTRAINT "organisms_design_version_nonnegative" CHECK ("organisms"."design_version" >= 0);--> statement-breakpoint
ALTER TABLE "oauth_states" ADD CONSTRAINT "oauth_state_purpose" CHECK ("oauth_states"."purpose" in ('broadcaster','bot','artist'));--> statement-breakpoint
ALTER TABLE "channel_studio" ALTER COLUMN "settings" SET DEFAULT '{"enabled":false,"breakScenes":[],"activeScenes":[],"approval":"review","creationMs":300000,"votingMs":45000,"reviewMs":900000,"returnDuringVoting":"finish","cosmeticPolicy":"offer","maxProposals":50,"replaceCooldownMs":30000}'::jsonb;--> statement-breakpoint
INSERT INTO "channel_studio"("world_id","channel_id") SELECT "world_id","id" FROM "channels" ON CONFLICT DO NOTHING;--> statement-breakpoint
CREATE FUNCTION initialize_channel_studio() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN
 INSERT INTO channel_studio(world_id,channel_id) VALUES (NEW.world_id,NEW.id); RETURN NEW;
END; $$;
--> statement-breakpoint
CREATE TRIGGER channels_studio_settings AFTER INSERT ON channels FOR EACH ROW EXECUTE FUNCTION initialize_channel_studio();
--> statement-breakpoint
ALTER TABLE "organisms" ADD CONSTRAINT "organisms_appearance_blueprint_fk" FOREIGN KEY ("world_id","appearance_hash") REFERENCES "appearance_blueprints"("world_id","hash");--> statement-breakpoint
ALTER TABLE "dormant_mutations" ADD CONSTRAINT "dormant_blueprint_fk" FOREIGN KEY ("world_id","blueprint_hash") REFERENCES "appearance_blueprints"("world_id","hash");--> statement-breakpoint
ALTER TABLE "organisms" ADD CONSTRAINT "organisms_appearance_matches_hash" CHECK (("appearance_hash" is null and "appearance"->>'kind'='founder') or ("appearance_hash" is not null and "appearance"->>'kind'='studio' and "appearance"->>'hash'="appearance_hash"));--> statement-breakpoint
CREATE TRIGGER appearance_blueprints_immutable BEFORE UPDATE OR DELETE ON appearance_blueprints FOR EACH ROW EXECUTE FUNCTION reject_committed_update();
--> statement-breakpoint
CREATE TRIGGER studio_transitions_append_only BEFORE UPDATE OR DELETE ON studio_transitions FOR EACH ROW EXECUTE FUNCTION reject_committed_update();
--> statement-breakpoint
CREATE FUNCTION preserve_studio_session() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN
 IF (NEW.channel_id,NEW.organism_id,NEW.trigger,NEW.challenge,NEW.seed,NEW.settings,NEW.opened_sequence,NEW.created_at)
   IS DISTINCT FROM (OLD.channel_id,OLD.organism_id,OLD.trigger,OLD.challenge,OLD.seed,OLD.settings,OLD.opened_sequence,OLD.created_at) THEN
   RAISE EXCEPTION 'captured studio challenge is immutable' USING ERRCODE='23514'; END IF;
 IF OLD.phase IN ('COMPLETED','CANCELLED','EXPIRED') THEN
   RAISE EXCEPTION 'terminal studio sessions are immutable' USING ERRCODE='23514'; END IF;
 IF NEW.version <= OLD.version THEN
   RAISE EXCEPTION 'studio session changes must advance its version' USING ERRCODE='23514'; END IF;
 IF (OLD.shortlist IS NOT NULL AND NEW.shortlist IS DISTINCT FROM OLD.shortlist)
   OR (OLD.selection IS NOT NULL AND NEW.selection IS DISTINCT FROM OLD.selection)
   OR (OLD.ballot_round_id IS NOT NULL AND NEW.ballot_round_id IS DISTINCT FROM OLD.ballot_round_id)
   OR (OLD.adaptation_id IS NOT NULL AND NEW.adaptation_id IS DISTINCT FROM OLD.adaptation_id) THEN
   RAISE EXCEPTION 'recorded studio shortlist, selection and approval are immutable' USING ERRCODE='23514'; END IF;
 RETURN NEW;
END; $$;
--> statement-breakpoint
CREATE TRIGGER studio_sessions_preserved BEFORE UPDATE ON studio_sessions FOR EACH ROW EXECUTE FUNCTION preserve_studio_session();
--> statement-breakpoint
CREATE FUNCTION preserve_studio_proposal() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN
 IF (NEW.session_id,NEW.artist_key,NEW.credit,NEW.credit_opt_in,NEW.revision,NEW.blueprint_hash,NEW.submitted_sequence,NEW.submitted_at)
   IS DISTINCT FROM (OLD.session_id,OLD.artist_key,OLD.credit,OLD.credit_opt_in,OLD.revision,OLD.blueprint_hash,OLD.submitted_sequence,OLD.submitted_at)
   OR OLD.status <> 'active' THEN
   RAISE EXCEPTION 'accepted studio proposals are immutable' USING ERRCODE='23514'; END IF;
 RETURN NEW;
END; $$;
--> statement-breakpoint
CREATE TRIGGER studio_proposals_preserved BEFORE UPDATE ON studio_proposals FOR EACH ROW EXECUTE FUNCTION preserve_studio_proposal();
--> statement-breakpoint
CREATE FUNCTION preserve_pending_adaptation() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN
 IF (NEW.session_id,NEW.channel_id,NEW.organism_id,NEW.blueprint_hash,NEW.template,NEW.target_slot,NEW.approval,NEW.created_at)
   IS DISTINCT FROM (OLD.session_id,OLD.channel_id,OLD.organism_id,OLD.blueprint_hash,OLD.template,OLD.target_slot,OLD.approval,OLD.created_at)
   OR OLD.status <> 'pending' THEN
   RAISE EXCEPTION 'resolved or approved adaptations are immutable' USING ERRCODE='23514'; END IF;
 RETURN NEW;
END; $$;
--> statement-breakpoint
CREATE TRIGGER pending_adaptations_preserved BEFORE UPDATE ON pending_adaptations FOR EACH ROW EXECUTE FUNCTION preserve_pending_adaptation();
