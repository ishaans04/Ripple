CREATE TABLE "controller_sessions" (
	"hash" text PRIMARY KEY NOT NULL,
	"world_id" uuid NOT NULL,
	"channel_id" uuid NOT NULL,
	"subject" text NOT NULL,
	"csrf_hash" text NOT NULL,
	"expires_at" timestamp with time zone NOT NULL
);
--> statement-breakpoint
CREATE TABLE "oauth_grants" (
	"world_id" uuid NOT NULL,
	"channel_id" uuid NOT NULL,
	"subject" text NOT NULL,
	"purpose" text NOT NULL,
	"scopes" text[] NOT NULL,
	"encrypted_tokens" jsonb NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"validated_at" timestamp with time zone,
	"revoked_at" timestamp with time zone,
	CONSTRAINT "oauth_grants_world_id_channel_id_purpose_pk" PRIMARY KEY("world_id","channel_id","purpose"),
	CONSTRAINT "oauth_grants_purpose_valid" CHECK ("oauth_grants"."purpose" in ('broadcaster','bot'))
);
--> statement-breakpoint
CREATE TABLE "overlay_capabilities" (
	"hash" text PRIMARY KEY NOT NULL,
	"world_id" uuid NOT NULL,
	"channel_id" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"revoked_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "analytics_events" (
	"world_id" uuid NOT NULL,
	"channel_id" uuid NOT NULL,
	"id" uuid NOT NULL,
	"type" text NOT NULL,
	"aggregates" jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "analytics_events_world_id_id_pk" PRIMARY KEY("world_id","id")
);
--> statement-breakpoint
CREATE TABLE "ancestor_trials" (
	"world_id" uuid NOT NULL,
	"round_id" uuid NOT NULL,
	"organism_id" uuid NOT NULL,
	"ancestor_id" uuid NOT NULL,
	"matched_inputs" jsonb NOT NULL,
	"result" jsonb NOT NULL,
	CONSTRAINT "ancestor_trials_world_id_round_id_organism_id_pk" PRIMARY KEY("world_id","round_id","organism_id")
);
--> statement-breakpoint
CREATE TABLE "descendant_cursors" (
	"world_id" uuid NOT NULL,
	"channel_id" uuid NOT NULL,
	"lineage_id" uuid NOT NULL,
	"version" integer NOT NULL,
	CONSTRAINT "descendant_cursors_world_id_channel_id_lineage_id_pk" PRIMARY KEY("world_id","channel_id","lineage_id"),
	CONSTRAINT "descendant_cursors_nonnegative" CHECK ("descendant_cursors"."version" >= 0)
);
--> statement-breakpoint
CREATE TABLE "dormant_mutations" (
	"world_id" uuid NOT NULL,
	"id" uuid NOT NULL,
	"organism_id" uuid NOT NULL,
	"source_round_id" uuid NOT NULL,
	"template" jsonb NOT NULL,
	"provenance" jsonb NOT NULL,
	"remaining_hops" integer NOT NULL,
	"remaining_rounds" integer NOT NULL,
	"status" text NOT NULL,
	"offered" boolean DEFAULT false NOT NULL,
	CONSTRAINT "dormant_mutations_world_id_id_pk" PRIMARY KEY("world_id","id"),
	CONSTRAINT "dormant_lifetime_nonnegative" CHECK ("dormant_mutations"."remaining_hops" >= 0 and "dormant_mutations"."remaining_rounds" >= 0),
	CONSTRAINT "dormant_status_valid" CHECK ("dormant_mutations"."status" in ('active','consumed','expired','replaced'))
);
--> statement-breakpoint
CREATE TABLE "habitat_traces" (
	"world_id" uuid NOT NULL,
	"id" uuid NOT NULL,
	"channel_id" uuid NOT NULL,
	"emitter_id" uuid NOT NULL,
	"template" text NOT NULL,
	"status" text NOT NULL,
	"remaining_rounds" integer NOT NULL,
	"version" integer NOT NULL,
	"decision" jsonb NOT NULL,
	"provenance" jsonb NOT NULL,
	CONSTRAINT "habitat_traces_world_id_id_pk" PRIMARY KEY("world_id","id"),
	CONSTRAINT "traces_template_valid" CHECK ("habitat_traces"."template" in ('charged','recovery','shelter')),
	CONSTRAINT "traces_status_valid" CHECK ("habitat_traces"."status" in ('pending','active','cleared','expired','replaced','rejected')),
	CONSTRAINT "traces_counts_nonnegative" CHECK ("habitat_traces"."remaining_rounds" >= 0 and "habitat_traces"."version" >= 0)
);
--> statement-breakpoint
CREATE TABLE "transfers" (
	"world_id" uuid NOT NULL,
	"id" uuid NOT NULL,
	"receipt_id" text NOT NULL,
	"source_channel_id" uuid NOT NULL,
	"destination_channel_id" uuid,
	"destination_twitch_id" text NOT NULL,
	"source_version" integer NOT NULL,
	"parent_id" uuid NOT NULL,
	"child_id" uuid,
	"outcome" text NOT NULL,
	"snapshot" jsonb NOT NULL,
	"expires_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "transfers_world_id_id_pk" PRIMARY KEY("world_id","id"),
	CONSTRAINT "transfers_receipt_unique" UNIQUE("world_id","receipt_id"),
	CONSTRAINT "transfers_version_nonnegative" CHECK ("transfers"."source_version" >= 0)
);
--> statement-breakpoint
ALTER TABLE "controller_sessions" ADD CONSTRAINT "controller_sessions_world_id_channel_id_channels_world_id_id_fk" FOREIGN KEY ("world_id","channel_id") REFERENCES "public"."channels"("world_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "oauth_grants" ADD CONSTRAINT "oauth_grants_world_id_channel_id_channels_world_id_id_fk" FOREIGN KEY ("world_id","channel_id") REFERENCES "public"."channels"("world_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "overlay_capabilities" ADD CONSTRAINT "overlay_capabilities_world_id_channel_id_channels_world_id_id_fk" FOREIGN KEY ("world_id","channel_id") REFERENCES "public"."channels"("world_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "analytics_events" ADD CONSTRAINT "analytics_events_world_id_channel_id_channels_world_id_id_fk" FOREIGN KEY ("world_id","channel_id") REFERENCES "public"."channels"("world_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ancestor_trials" ADD CONSTRAINT "ancestor_trials_world_id_round_id_rounds_world_id_id_fk" FOREIGN KEY ("world_id","round_id") REFERENCES "public"."rounds"("world_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ancestor_trials" ADD CONSTRAINT "ancestor_trials_world_id_organism_id_organisms_world_id_id_fk" FOREIGN KEY ("world_id","organism_id") REFERENCES "public"."organisms"("world_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ancestor_trials" ADD CONSTRAINT "ancestor_trials_world_id_ancestor_id_organisms_world_id_id_fk" FOREIGN KEY ("world_id","ancestor_id") REFERENCES "public"."organisms"("world_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "descendant_cursors" ADD CONSTRAINT "descendant_cursors_world_id_channel_id_channels_world_id_id_fk" FOREIGN KEY ("world_id","channel_id") REFERENCES "public"."channels"("world_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "descendant_cursors" ADD CONSTRAINT "descendant_cursors_world_id_lineage_id_lineages_world_id_id_fk" FOREIGN KEY ("world_id","lineage_id") REFERENCES "public"."lineages"("world_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "dormant_mutations" ADD CONSTRAINT "dormant_mutations_world_id_organism_id_organisms_world_id_id_fk" FOREIGN KEY ("world_id","organism_id") REFERENCES "public"."organisms"("world_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "dormant_mutations" ADD CONSTRAINT "dormant_mutations_world_id_source_round_id_rounds_world_id_id_fk" FOREIGN KEY ("world_id","source_round_id") REFERENCES "public"."rounds"("world_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "habitat_traces" ADD CONSTRAINT "habitat_traces_world_id_channel_id_channels_world_id_id_fk" FOREIGN KEY ("world_id","channel_id") REFERENCES "public"."channels"("world_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "habitat_traces" ADD CONSTRAINT "habitat_traces_world_id_emitter_id_organisms_world_id_id_fk" FOREIGN KEY ("world_id","emitter_id") REFERENCES "public"."organisms"("world_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "transfers" ADD CONSTRAINT "transfers_world_id_source_channel_id_channels_world_id_id_fk" FOREIGN KEY ("world_id","source_channel_id") REFERENCES "public"."channels"("world_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "transfers" ADD CONSTRAINT "transfers_world_id_destination_channel_id_channels_world_id_id_fk" FOREIGN KEY ("world_id","destination_channel_id") REFERENCES "public"."channels"("world_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "transfers" ADD CONSTRAINT "transfers_world_id_parent_id_organisms_world_id_id_fk" FOREIGN KEY ("world_id","parent_id") REFERENCES "public"."organisms"("world_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "transfers" ADD CONSTRAINT "transfers_world_id_child_id_organisms_world_id_id_fk" FOREIGN KEY ("world_id","child_id") REFERENCES "public"."organisms"("world_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "controller_sessions_expiry_idx" ON "controller_sessions" USING btree ("expires_at");--> statement-breakpoint
CREATE INDEX "analytics_type_time_idx" ON "analytics_events" USING btree ("world_id","type","created_at");--> statement-breakpoint
CREATE UNIQUE INDEX "dormant_one_active" ON "dormant_mutations" USING btree ("world_id","organism_id") WHERE "dormant_mutations"."status"='active';--> statement-breakpoint
CREATE UNIQUE INDEX "traces_one_active" ON "habitat_traces" USING btree ("world_id","channel_id") WHERE "habitat_traces"."status"='active';--> statement-breakpoint
CREATE INDEX "transfers_pending_idx" ON "transfers" USING btree ("world_id","destination_channel_id","outcome","expires_at");