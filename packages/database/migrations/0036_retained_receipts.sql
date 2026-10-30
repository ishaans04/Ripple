CREATE TABLE input_receipts (
 world_id uuid NOT NULL, channel_id uuid NOT NULL, provider text NOT NULL, message_id text NOT NULL,
 sequence integer NOT NULL, accepted_at timestamptz NOT NULL, command_hash text NOT NULL,
 PRIMARY KEY(world_id,provider,message_id), UNIQUE(world_id,channel_id,sequence),
 FOREIGN KEY(world_id,channel_id) REFERENCES channels(world_id,id)
);--> statement-breakpoint
INSERT INTO input_receipts(world_id,channel_id,provider,message_id,sequence,accepted_at,command_hash)
 SELECT world_id,channel_id,provider,message_id,sequence,accepted_at,encode(sha256(convert_to(command::text,'UTF8')),'hex') FROM inbox;--> statement-breakpoint
ALTER TABLE game_events DROP CONSTRAINT "game_events_world_id_channel_id_sequence_inbox_world_id_channel_id_sequence_fk";--> statement-breakpoint
ALTER TABLE game_events ADD CONSTRAINT game_events_receipt_fk FOREIGN KEY(world_id,channel_id,sequence) REFERENCES input_receipts(world_id,channel_id,sequence);--> statement-breakpoint
CREATE TABLE privacy_erasures (
 world_id uuid NOT NULL REFERENCES worlds(id), artist_key text NOT NULL,
 requested_at timestamptz NOT NULL DEFAULT now(), PRIMARY KEY(world_id,artist_key)
);--> statement-breakpoint
CREATE OR REPLACE FUNCTION reject_committed_update() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF TG_OP='DELETE' AND current_setting('ripple.purge_world',true)=OLD.world_id::text
 AND EXISTS(SELECT 1 FROM worlds WHERE id=OLD.world_id AND expires_at<=clock_timestamp()) THEN RETURN OLD; END IF;
 RAISE EXCEPTION '% is append-only', TG_TABLE_NAME USING ERRCODE='23514';
END; $$;
