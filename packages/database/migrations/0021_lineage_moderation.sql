CREATE TABLE "lineage_blocks" (
	"world_id" uuid NOT NULL,
	"channel_id" uuid NOT NULL,
	"lineage_id" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "lineage_blocks_world_id_channel_id_lineage_id_pk" PRIMARY KEY("world_id","channel_id","lineage_id")
);
--> statement-breakpoint
ALTER TABLE "lineage_blocks" ADD CONSTRAINT "lineage_blocks_world_id_channel_id_channels_world_id_id_fk" FOREIGN KEY ("world_id","channel_id") REFERENCES "public"."channels"("world_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "lineage_blocks" ADD CONSTRAINT "lineage_blocks_world_id_lineage_id_lineages_world_id_id_fk" FOREIGN KEY ("world_id","lineage_id") REFERENCES "public"."lineages"("world_id","id") ON DELETE no action ON UPDATE no action;