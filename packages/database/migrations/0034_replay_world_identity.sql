ALTER TABLE "worlds" ADD COLUMN "replay_of" uuid;--> statement-breakpoint
ALTER TABLE "worlds" ADD CONSTRAINT "worlds_replay_source" CHECK ("worlds"."replay_of" is null or "worlds"."mode" = 'replay');