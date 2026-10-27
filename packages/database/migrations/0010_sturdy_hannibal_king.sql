CREATE TABLE "sandbox_clock_steps" (
	"world_id" uuid NOT NULL,
	"channel_id" uuid NOT NULL,
	"operation_id" uuid NOT NULL,
	"delta_ms" integer NOT NULL,
	"from_at" timestamp with time zone NOT NULL,
	"to_at" timestamp with time zone NOT NULL,
	CONSTRAINT "sandbox_clock_steps_world_id_operation_id_pk" PRIMARY KEY("world_id","operation_id"),
	CONSTRAINT "sandbox_clock_step_bounds" CHECK ("sandbox_clock_steps"."delta_ms" between 1 and 300000 and extract(epoch from ("sandbox_clock_steps"."to_at"-"sandbox_clock_steps"."from_at"))*1000="sandbox_clock_steps"."delta_ms")
);
--> statement-breakpoint
ALTER TABLE "sandbox_clock_steps" ADD CONSTRAINT "sandbox_clock_steps_world_id_channel_id_channels_world_id_id_fk" FOREIGN KEY ("world_id","channel_id") REFERENCES "public"."channels"("world_id","id") ON DELETE no action ON UPDATE no action;