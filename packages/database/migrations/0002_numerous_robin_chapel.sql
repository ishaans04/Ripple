CREATE TABLE "channels" (
	"world_id" uuid NOT NULL,
	"id" uuid NOT NULL,
	"twitch_id" text,
	"label" text NOT NULL,
	"rules_hash" text NOT NULL,
	"seed" text NOT NULL,
	"configuration" jsonb NOT NULL,
	"online" boolean DEFAULT false NOT NULL,
	"healthy" boolean DEFAULT false NOT NULL,
	"paused" boolean DEFAULT false NOT NULL,
	"intake_sequence" integer DEFAULT 0 NOT NULL,
	"processed_sequence" integer DEFAULT 0 NOT NULL,
	"state_version" integer DEFAULT 0 NOT NULL,
	"last_accepted_at" timestamp with time zone,
	"checksum" text DEFAULT '0000000000000000000000000000000000000000000000000000000000000000' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "channels_world_id_id_pk" PRIMARY KEY("world_id","id"),
	CONSTRAINT "channels_world_twitch_unique" UNIQUE("world_id","twitch_id"),
	CONSTRAINT "channels_cursor_order" CHECK (0 <= "channels"."processed_sequence" and "channels"."processed_sequence" <= "channels"."intake_sequence"),
	CONSTRAINT "channels_version_nonnegative" CHECK ("channels"."state_version" >= 0),
	CONSTRAINT "channels_label_length" CHECK (length("channels"."label") between 1 and 80)
);
--> statement-breakpoint
CREATE TABLE "lineages" (
	"world_id" uuid NOT NULL,
	"id" uuid NOT NULL,
	"origin_channel_id" uuid NOT NULL,
	"rules_hash" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "lineages_world_id_id_pk" PRIMARY KEY("world_id","id")
);
--> statement-breakpoint
CREATE TABLE "organisms" (
	"world_id" uuid NOT NULL,
	"id" uuid NOT NULL,
	"lineage_id" uuid NOT NULL,
	"parent_id" uuid,
	"founder_id" uuid NOT NULL,
	"generation" integer NOT NULL,
	"founding_genome" jsonb NOT NULL,
	"pulse" integer NOT NULL,
	"calm" integer NOT NULL,
	"grit" integer NOT NULL,
	"drift" integer NOT NULL,
	"health" integer NOT NULL,
	"status" text NOT NULL,
	"version" integer DEFAULT 0 NOT NULL,
	"appearance" jsonb NOT NULL,
	"mutation_slots" jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "organisms_world_id_id_pk" PRIMARY KEY("world_id","id"),
	CONSTRAINT "organisms_genome_legal" CHECK ("organisms"."pulse" between 0 and 15 and "organisms"."calm" between 0 and 15 and "organisms"."grit" between 0 and 15 and "organisms"."drift" between 0 and 15 and "organisms"."pulse"+"organisms"."calm"+"organisms"."grit"+"organisms"."drift"=24),
	CONSTRAINT "organisms_health_bounds" CHECK ("organisms"."health" between 0 and 100),
	CONSTRAINT "organisms_status_valid" CHECK ("organisms"."status" in ('ALIVE','HARBOR','FOSSIL','ARCHIVED')),
	CONSTRAINT "organisms_generation_bounds" CHECK ("organisms"."generation" between 0 and 16 and ("organisms"."parent_id" is not null or "organisms"."generation"=0)),
	CONSTRAINT "organisms_version_nonnegative" CHECK ("organisms"."version" >= 0)
);
--> statement-breakpoint
CREATE TABLE "residencies" (
	"world_id" uuid NOT NULL,
	"id" uuid NOT NULL,
	"channel_id" uuid NOT NULL,
	"organism_id" uuid NOT NULL,
	"role" text NOT NULL,
	"arrival_snapshot" jsonb,
	"completed_valid_rounds" integer DEFAULT 0 NOT NULL,
	"trace_qualified" boolean DEFAULT false NOT NULL,
	"started_at" timestamp with time zone DEFAULT now() NOT NULL,
	"ended_at" timestamp with time zone,
	CONSTRAINT "residencies_world_id_id_pk" PRIMARY KEY("world_id","id"),
	CONSTRAINT "residencies_role_valid" CHECK ("residencies"."role" in ('resident','visitor','harbor')),
	CONSTRAINT "residencies_rounds_nonnegative" CHECK ("residencies"."completed_valid_rounds" >= 0)
);
--> statement-breakpoint
CREATE TABLE "rulesets" (
	"hash" text PRIMARY KEY NOT NULL,
	"version" text NOT NULL,
	"engine_version" integer NOT NULL,
	"canonical" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "rulesets_version_unique" UNIQUE("version"),
	CONSTRAINT "rulesets_hash_format" CHECK ("rulesets"."hash" ~ '^[0-9a-f]{64}$'),
	CONSTRAINT "rulesets_engine_positive" CHECK ("rulesets"."engine_version" > 0)
);
--> statement-breakpoint
ALTER TABLE "channels" ADD CONSTRAINT "channels_world_id_worlds_id_fk" FOREIGN KEY ("world_id") REFERENCES "public"."worlds"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "channels" ADD CONSTRAINT "channels_rules_hash_rulesets_hash_fk" FOREIGN KEY ("rules_hash") REFERENCES "public"."rulesets"("hash") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "lineages" ADD CONSTRAINT "lineages_rules_hash_rulesets_hash_fk" FOREIGN KEY ("rules_hash") REFERENCES "public"."rulesets"("hash") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "lineages" ADD CONSTRAINT "lineages_world_id_origin_channel_id_channels_world_id_id_fk" FOREIGN KEY ("world_id","origin_channel_id") REFERENCES "public"."channels"("world_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "organisms" ADD CONSTRAINT "organisms_world_id_lineage_id_lineages_world_id_id_fk" FOREIGN KEY ("world_id","lineage_id") REFERENCES "public"."lineages"("world_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "residencies" ADD CONSTRAINT "residencies_world_id_channel_id_channels_world_id_id_fk" FOREIGN KEY ("world_id","channel_id") REFERENCES "public"."channels"("world_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "residencies" ADD CONSTRAINT "residencies_world_id_organism_id_organisms_world_id_id_fk" FOREIGN KEY ("world_id","organism_id") REFERENCES "public"."organisms"("world_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "channels_pending_idx" ON "channels" USING btree ("world_id","id") WHERE "channels"."processed_sequence" < "channels"."intake_sequence";--> statement-breakpoint
CREATE INDEX "organisms_parent_idx" ON "organisms" USING btree ("world_id","parent_id");--> statement-breakpoint
CREATE INDEX "organisms_lineage_idx" ON "organisms" USING btree ("world_id","lineage_id","status");--> statement-breakpoint
CREATE UNIQUE INDEX "residencies_active_organism" ON "residencies" USING btree ("world_id","organism_id") WHERE "residencies"."ended_at" is null;--> statement-breakpoint
CREATE UNIQUE INDEX "residencies_active_role" ON "residencies" USING btree ("world_id","channel_id","role") WHERE "residencies"."ended_at" is null and "residencies"."role" in ('resident','visitor');