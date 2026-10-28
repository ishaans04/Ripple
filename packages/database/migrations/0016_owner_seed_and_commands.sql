CREATE TABLE "controller_operations" (
	"world_id" uuid NOT NULL,
	"channel_id" uuid NOT NULL,
	"key" uuid NOT NULL,
	"request_hash" text NOT NULL,
	"sequence" integer NOT NULL,
	CONSTRAINT "controller_operations_world_id_channel_id_key_pk" PRIMARY KEY("world_id","channel_id","key")
);
--> statement-breakpoint
ALTER TABLE "organisms" ADD COLUMN "name" text DEFAULT 'Ripple strain' NOT NULL;--> statement-breakpoint
ALTER TABLE "twitch_channels" ADD COLUMN "seed_cooldown_ms" integer DEFAULT 180000 NOT NULL;--> statement-breakpoint
ALTER TABLE "controller_operations" ADD CONSTRAINT "controller_operations_world_id_channel_id_channels_world_id_id_fk" FOREIGN KEY ("world_id","channel_id") REFERENCES "public"."channels"("world_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "organisms" ADD CONSTRAINT "organisms_name_length" CHECK (length("organisms"."name") between 1 and 40);