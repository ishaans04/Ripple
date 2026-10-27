ALTER TABLE "channels" ADD COLUMN "initial_online" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "channels" ADD COLUMN "initial_healthy" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "channels" ADD COLUMN "initial_paused" boolean DEFAULT false NOT NULL;
--> statement-breakpoint
-- Before genesis flags were explicit, only the synthetic adapter created ready
-- channels; live channels start offline. Preserve that documented initial state.
UPDATE channels c SET initial_online=true, initial_healthy=true
FROM worlds w WHERE w.id=c.world_id AND w.mode='sandbox';
