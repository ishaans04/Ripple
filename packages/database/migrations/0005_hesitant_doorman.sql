CREATE TABLE "activity_contributions" (
	"world_id" uuid NOT NULL,
	"round_id" uuid NOT NULL,
	"observation_epoch" integer NOT NULL,
	"bucket" integer NOT NULL,
	"actor_key" text NOT NULL,
	"accepted_sequence" integer NOT NULL,
	CONSTRAINT "activity_contributions_world_id_round_id_observation_epoch_bucket_actor_key_pk" PRIMARY KEY("world_id","round_id","observation_epoch","bucket","actor_key"),
	CONSTRAINT "activity_bucket_bounds" CHECK ("activity_contributions"."bucket" between 0 and 11 and "activity_contributions"."observation_epoch" >= 0)
);
--> statement-breakpoint
CREATE TABLE "habitat_baselines" (
	"world_id" uuid NOT NULL,
	"channel_id" uuid NOT NULL,
	"round_id" uuid NOT NULL,
	"contributions" integer NOT NULL,
	"burst" integer NOT NULL,
	"frozen" jsonb NOT NULL,
	"completed_at" timestamp with time zone NOT NULL,
	CONSTRAINT "habitat_baselines_world_id_round_id_pk" PRIMARY KEY("world_id","round_id"),
	CONSTRAINT "baselines_counts_valid" CHECK ("habitat_baselines"."contributions" >= 0 and "habitat_baselines"."burst" between 0 and 1000)
);
--> statement-breakpoint
CREATE TABLE "rounds" (
	"world_id" uuid NOT NULL,
	"id" uuid NOT NULL,
	"channel_id" uuid NOT NULL,
	"organism_id" uuid NOT NULL,
	"number" integer NOT NULL,
	"kind" text NOT NULL,
	"phase" text NOT NULL,
	"rules_hash" text NOT NULL,
	"seed" text NOT NULL,
	"checkpoint" jsonb NOT NULL,
	"close_sequence" integer,
	"vote_count" integer DEFAULT 0 NOT NULL,
	"contributions" integer DEFAULT 0 NOT NULL,
	"distinct_accounts" integer DEFAULT 0 NOT NULL,
	"burst" integer,
	"confidence" text,
	"resolution" jsonb,
	"explanation" jsonb,
	"opened_at" timestamp with time zone NOT NULL,
	"completed_at" timestamp with time zone,
	CONSTRAINT "rounds_world_id_id_pk" PRIMARY KEY("world_id","id"),
	CONSTRAINT "rounds_world_id_channel_unique" UNIQUE("world_id","id","channel_id"),
	CONSTRAINT "rounds_number_positive" CHECK ("rounds"."number" > 0),
	CONSTRAINT "rounds_kind_valid" CHECK ("rounds"."kind" in ('MUTATION','WELCOME','TRACE','PREPARATION','STUDIO_SELECTION')),
	CONSTRAINT "rounds_phase_valid" CHECK ("rounds"."phase" in ('VOTING','OBSERVING','REVEAL','INTERRUPTED','COMPLETE')),
	CONSTRAINT "rounds_confidence_valid" CHECK ("rounds"."confidence" is null or "rounds"."confidence" in ('confident','limited','interrupted')),
	CONSTRAINT "rounds_counts_nonnegative" CHECK ("rounds"."vote_count" >= 0 and "rounds"."contributions" >= 0 and "rounds"."distinct_accounts" >= 0),
	CONSTRAINT "rounds_burst_bounds" CHECK ("rounds"."burst" is null or "rounds"."burst" between 0 and 1000)
);
--> statement-breakpoint
CREATE TABLE "votes" (
	"world_id" uuid NOT NULL,
	"channel_id" uuid NOT NULL,
	"round_id" uuid NOT NULL,
	"actor_key" text NOT NULL,
	"choice" integer NOT NULL,
	"accepted_sequence" integer NOT NULL,
	CONSTRAINT "votes_world_id_round_id_actor_key_pk" PRIMARY KEY("world_id","round_id","actor_key"),
	CONSTRAINT "votes_choice_bounds" CHECK ("votes"."choice" between 1 and 3),
	CONSTRAINT "votes_sequence_positive" CHECK ("votes"."accepted_sequence" > 0)
);
--> statement-breakpoint
CREATE TABLE "deadlines" (
	"world_id" uuid NOT NULL,
	"channel_id" uuid NOT NULL,
	"id" uuid NOT NULL,
	"job_key" text NOT NULL,
	"command" jsonb NOT NULL,
	"due_at" timestamp with time zone NOT NULL,
	"remaining_ms" integer NOT NULL,
	"status" text DEFAULT 'pending' NOT NULL,
	"lease_owner" uuid,
	"lease_until" timestamp with time zone,
	"attempts" integer DEFAULT 0 NOT NULL,
	CONSTRAINT "deadlines_world_id_id_pk" PRIMARY KEY("world_id","id"),
	CONSTRAINT "deadlines_job_unique" UNIQUE("world_id","channel_id","job_key"),
	CONSTRAINT "deadlines_status_valid" CHECK ("deadlines"."status" in ('pending','leased','delivered','cancelled')),
	CONSTRAINT "deadlines_counts_nonnegative" CHECK ("deadlines"."remaining_ms" >= 0 and "deadlines"."attempts" >= 0)
);
--> statement-breakpoint
CREATE TABLE "game_events" (
	"world_id" uuid NOT NULL,
	"channel_id" uuid NOT NULL,
	"sequence" integer NOT NULL,
	"id" uuid NOT NULL,
	"operation_id" text NOT NULL,
	"engine_version" integer NOT NULL,
	"rules_hash" text NOT NULL,
	"accepted_at" timestamp with time zone NOT NULL,
	"command" jsonb NOT NULL,
	"result" jsonb NOT NULL,
	"dependencies" jsonb NOT NULL,
	"previous_checksum" text NOT NULL,
	"checksum" text NOT NULL,
	CONSTRAINT "game_events_world_id_channel_id_sequence_pk" PRIMARY KEY("world_id","channel_id","sequence"),
	CONSTRAINT "game_events_world_id_unique" UNIQUE("world_id","id"),
	CONSTRAINT "game_events_operation_unique" UNIQUE("world_id","channel_id","operation_id"),
	CONSTRAINT "game_events_checksums_format" CHECK ("game_events"."previous_checksum" ~ '^[0-9a-f]{64}$' and "game_events"."checksum" ~ '^[0-9a-f]{64}$')
);
--> statement-breakpoint
CREATE TABLE "gateway_tickets" (
	"hash" text PRIMARY KEY NOT NULL,
	"world_id" uuid NOT NULL,
	"channel_id" uuid NOT NULL,
	"expires_at" timestamp with time zone NOT NULL
);
--> statement-breakpoint
CREATE TABLE "inbox" (
	"world_id" uuid NOT NULL,
	"channel_id" uuid NOT NULL,
	"sequence" integer NOT NULL,
	"provider" text NOT NULL,
	"message_id" text NOT NULL,
	"command" jsonb NOT NULL,
	"accepted_at" timestamp with time zone NOT NULL,
	"processed_at" timestamp with time zone,
	"attempts" integer DEFAULT 0 NOT NULL,
	"error_code" text,
	CONSTRAINT "inbox_world_id_channel_id_sequence_pk" PRIMARY KEY("world_id","channel_id","sequence"),
	CONSTRAINT "inbox_receipt_unique" UNIQUE("world_id","provider","message_id"),
	CONSTRAINT "inbox_sequence_positive" CHECK ("inbox"."sequence" > 0 and "inbox"."attempts" >= 0)
);
--> statement-breakpoint
CREATE TABLE "public_updates" (
	"world_id" uuid NOT NULL,
	"channel_id" uuid NOT NULL,
	"version" integer NOT NULL,
	"event_id" uuid NOT NULL,
	"type" text NOT NULL,
	"payload" jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "public_updates_world_id_channel_id_version_pk" PRIMARY KEY("world_id","channel_id","version"),
	CONSTRAINT "public_updates_event_unique" UNIQUE("world_id","event_id"),
	CONSTRAINT "public_updates_version_positive" CHECK ("public_updates"."version" > 0)
);
--> statement-breakpoint
ALTER TABLE "activity_contributions" ADD CONSTRAINT "activity_contributions_world_id_round_id_rounds_world_id_id_fk" FOREIGN KEY ("world_id","round_id") REFERENCES "public"."rounds"("world_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "habitat_baselines" ADD CONSTRAINT "habitat_baselines_world_id_round_id_channel_id_rounds_world_id_id_channel_id_fk" FOREIGN KEY ("world_id","round_id","channel_id") REFERENCES "public"."rounds"("world_id","id","channel_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "rounds" ADD CONSTRAINT "rounds_rules_hash_rulesets_hash_fk" FOREIGN KEY ("rules_hash") REFERENCES "public"."rulesets"("hash") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "rounds" ADD CONSTRAINT "rounds_world_id_channel_id_channels_world_id_id_fk" FOREIGN KEY ("world_id","channel_id") REFERENCES "public"."channels"("world_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "rounds" ADD CONSTRAINT "rounds_world_id_organism_id_organisms_world_id_id_fk" FOREIGN KEY ("world_id","organism_id") REFERENCES "public"."organisms"("world_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "votes" ADD CONSTRAINT "votes_world_id_round_id_channel_id_rounds_world_id_id_channel_id_fk" FOREIGN KEY ("world_id","round_id","channel_id") REFERENCES "public"."rounds"("world_id","id","channel_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "deadlines" ADD CONSTRAINT "deadlines_world_id_channel_id_channels_world_id_id_fk" FOREIGN KEY ("world_id","channel_id") REFERENCES "public"."channels"("world_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "game_events" ADD CONSTRAINT "game_events_world_id_channel_id_sequence_inbox_world_id_channel_id_sequence_fk" FOREIGN KEY ("world_id","channel_id","sequence") REFERENCES "public"."inbox"("world_id","channel_id","sequence") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "gateway_tickets" ADD CONSTRAINT "gateway_tickets_world_id_channel_id_channels_world_id_id_fk" FOREIGN KEY ("world_id","channel_id") REFERENCES "public"."channels"("world_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "inbox" ADD CONSTRAINT "inbox_world_id_channel_id_channels_world_id_id_fk" FOREIGN KEY ("world_id","channel_id") REFERENCES "public"."channels"("world_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "public_updates" ADD CONSTRAINT "public_updates_world_id_channel_id_channels_world_id_id_fk" FOREIGN KEY ("world_id","channel_id") REFERENCES "public"."channels"("world_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "activity_actor_idx" ON "activity_contributions" USING btree ("world_id","round_id","observation_epoch","actor_key");--> statement-breakpoint
CREATE INDEX "baselines_recent_idx" ON "habitat_baselines" USING btree ("world_id","channel_id","completed_at");--> statement-breakpoint
CREATE UNIQUE INDEX "rounds_channel_number" ON "rounds" USING btree ("world_id","channel_id","number");--> statement-breakpoint
CREATE UNIQUE INDEX "rounds_one_open" ON "rounds" USING btree ("world_id","channel_id") WHERE "rounds"."completed_at" is null;--> statement-breakpoint
CREATE INDEX "deadlines_due_idx" ON "deadlines" USING btree ("status","due_at","lease_until");--> statement-breakpoint
CREATE INDEX "gateway_tickets_expiry_idx" ON "gateway_tickets" USING btree ("expires_at");--> statement-breakpoint
CREATE INDEX "inbox_pending_idx" ON "inbox" USING btree ("world_id","channel_id","sequence") WHERE "inbox"."processed_at" is null;