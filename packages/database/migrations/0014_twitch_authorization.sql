CREATE TABLE "bot_messages" (
	"world_id" uuid NOT NULL,
	"channel_id" uuid NOT NULL,
	"key" text NOT NULL,
	"message" text NOT NULL,
	"status" text DEFAULT 'pending' NOT NULL,
	"attempt_at" timestamp with time zone,
	"error_code" text,
	CONSTRAINT "bot_messages_world_id_channel_id_key_pk" PRIMARY KEY("world_id","channel_id","key"),
	CONSTRAINT "bot_message_bounds" CHECK (length("bot_messages"."message") between 1 and 500),
	CONSTRAINT "bot_message_status" CHECK ("bot_messages"."status" in ('pending','sending','sent','uncertain','failed'))
);
--> statement-breakpoint
CREATE TABLE "oauth_states" (
	"hash" text PRIMARY KEY NOT NULL,
	"browser_hash" text NOT NULL,
	"world_id" uuid NOT NULL,
	"purpose" text NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	CONSTRAINT "oauth_state_purpose" CHECK ("oauth_states"."purpose" in ('broadcaster','bot'))
);
--> statement-breakpoint
CREATE TABLE "twitch_channels" (
	"world_id" uuid NOT NULL,
	"channel_id" uuid NOT NULL,
	"category_id" text,
	"lifecycle_at" timestamp with time zone,
	"category_at" timestamp with time zone,
	"input_error" text,
	"visitor_policy" text DEFAULT 'ask' NOT NULL,
	"last_seed_at" timestamp with time zone,
	CONSTRAINT "twitch_channels_world_id_channel_id_pk" PRIMARY KEY("world_id","channel_id"),
	CONSTRAINT "twitch_visitor_policy" CHECK ("twitch_channels"."visitor_policy" in ('ask','accept','reject'))
);
--> statement-breakpoint
CREATE TABLE "twitch_installations" (
	"client_id" text PRIMARY KEY NOT NULL,
	"world_id" uuid NOT NULL,
	"actor_key_fingerprint" text NOT NULL,
	CONSTRAINT "twitch_installations_world_id_unique" UNIQUE("world_id")
);
--> statement-breakpoint
CREATE TABLE "twitch_receipts" (
	"message_id" text PRIMARY KEY NOT NULL,
	"payload_hash" text NOT NULL,
	"received_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "twitch_subscriptions" (
	"world_id" uuid NOT NULL,
	"channel_id" uuid NOT NULL,
	"type" text NOT NULL,
	"version" text NOT NULL,
	"provider_id" text,
	"condition" jsonb NOT NULL,
	"status" text NOT NULL,
	"cost" integer DEFAULT 0 NOT NULL,
	"attempt_at" timestamp with time zone,
	"verified_at" timestamp with time zone,
	CONSTRAINT "twitch_subscriptions_world_id_channel_id_type_pk" PRIMARY KEY("world_id","channel_id","type"),
	CONSTRAINT "twitch_subscriptions_provider_id_unique" UNIQUE("provider_id"),
	CONSTRAINT "twitch_subscription_cost" CHECK ("twitch_subscriptions"."cost">=0)
);
--> statement-breakpoint
ALTER TABLE "oauth_grants" DROP CONSTRAINT "oauth_grants_world_id_channel_id_purpose_pk";--> statement-breakpoint
ALTER TABLE "oauth_grants" ALTER COLUMN "channel_id" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "oauth_grants" ADD CONSTRAINT "oauth_grants_world_id_purpose_subject_pk" PRIMARY KEY("world_id","purpose","subject");--> statement-breakpoint
ALTER TABLE "oauth_grants" ADD COLUMN "refresh_owner" uuid;--> statement-breakpoint
ALTER TABLE "oauth_grants" ADD COLUMN "refresh_until" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "bot_messages" ADD CONSTRAINT "bot_messages_world_id_channel_id_channels_world_id_id_fk" FOREIGN KEY ("world_id","channel_id") REFERENCES "public"."channels"("world_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "oauth_states" ADD CONSTRAINT "oauth_states_world_id_worlds_id_fk" FOREIGN KEY ("world_id") REFERENCES "public"."worlds"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "twitch_channels" ADD CONSTRAINT "twitch_channels_world_id_channel_id_channels_world_id_id_fk" FOREIGN KEY ("world_id","channel_id") REFERENCES "public"."channels"("world_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "twitch_installations" ADD CONSTRAINT "twitch_installations_world_id_worlds_id_fk" FOREIGN KEY ("world_id") REFERENCES "public"."worlds"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "twitch_subscriptions" ADD CONSTRAINT "twitch_subscriptions_world_id_channel_id_channels_world_id_id_fk" FOREIGN KEY ("world_id","channel_id") REFERENCES "public"."channels"("world_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "oauth_states_expiry_idx" ON "oauth_states" USING btree ("expires_at");--> statement-breakpoint
CREATE UNIQUE INDEX "oauth_broadcaster_channel_unique" ON "oauth_grants" USING btree ("world_id","channel_id") WHERE "oauth_grants"."purpose"='broadcaster';--> statement-breakpoint
CREATE UNIQUE INDEX "oauth_one_bot_per_world" ON "oauth_grants" USING btree ("world_id") WHERE "oauth_grants"."purpose"='bot';--> statement-breakpoint
ALTER TABLE "oauth_grants" ADD CONSTRAINT "oauth_grants_scope_valid" CHECK (("oauth_grants"."purpose"='bot' and "oauth_grants"."channel_id" is null) or ("oauth_grants"."purpose"='broadcaster' and "oauth_grants"."channel_id" is not null));