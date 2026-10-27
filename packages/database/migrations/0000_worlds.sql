CREATE TYPE "public"."world_mode" AS ENUM('live', 'sandbox', 'replay');--> statement-breakpoint
CREATE TABLE "worlds" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"mode" "world_mode" NOT NULL,
	"owner_capability_hash" text,
	"rules_hash" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"expires_at" timestamp with time zone,
	CONSTRAINT "worlds_rules_hash_format" CHECK ("worlds"."rules_hash" ~ '^[0-9a-f]{64}$'),
	CONSTRAINT "worlds_owner_capability_hash_format" CHECK ("worlds"."owner_capability_hash" is null or "worlds"."owner_capability_hash" ~ '^[0-9a-f]{64}$'),
	CONSTRAINT "worlds_sandbox_owned_and_expiring" CHECK ("worlds"."mode" <> 'sandbox' or ("worlds"."owner_capability_hash" is not null and "worlds"."expires_at" is not null))
);
