ALTER TABLE "transfers" ADD COLUMN "claimed_at" timestamp with time zone;
--> statement-breakpoint
CREATE OR REPLACE FUNCTION preserve_transfer_snapshot() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE binding boolean;
BEGIN
 binding := OLD.destination_channel_id IS NULL AND OLD.child_id IS NOT NULL
   AND OLD.outcome='NOT_ENROLLED' AND OLD.claimed_at IS NULL
   AND NEW.destination_channel_id IS NOT NULL AND NEW.destination_channel_id<>OLD.source_channel_id
   AND NEW.claimed_at IS NOT NULL AND NEW.claimed_at>=OLD.created_at AND NEW.claimed_at<OLD.expires_at
   AND NEW.outcome='QUEUED' AND NEW.version=OLD.version+1
   AND EXISTS(SELECT 1 FROM channels c WHERE c.world_id=OLD.world_id AND c.id=NEW.destination_channel_id
     AND lower(coalesce(c.twitch_id,c.id::text))=lower(OLD.destination_twitch_id));
 IF ROW(NEW.world_id,NEW.id,NEW.receipt_id,NEW.source_channel_id,NEW.destination_twitch_id,NEW.source_version,NEW.parent_id,NEW.child_id,NEW.snapshot,NEW.expires_at,NEW.created_at)
 IS DISTINCT FROM ROW(OLD.world_id,OLD.id,OLD.receipt_id,OLD.source_channel_id,OLD.destination_twitch_id,OLD.source_version,OLD.parent_id,OLD.child_id,OLD.snapshot,OLD.expires_at,OLD.created_at) THEN
   RAISE EXCEPTION 'transfer origin and accepted snapshot are immutable' USING ERRCODE='23514';
 END IF;
 IF (NEW.destination_channel_id IS DISTINCT FROM OLD.destination_channel_id OR NEW.claimed_at IS DISTINCT FROM OLD.claimed_at) AND NOT coalesce(binding,false) THEN
   RAISE EXCEPTION 'only the original destination may bind an unexpired retained raid once' USING ERRCODE='23514';
 END IF;
 IF OLD.destination_sequence IS NOT NULL AND NEW.destination_sequence IS DISTINCT FROM OLD.destination_sequence THEN
   RAISE EXCEPTION 'destination receipt is immutable' USING ERRCODE='23514';
 END IF;
 IF NEW.version<OLD.version OR NEW.version>OLD.version+1 THEN
   RAISE EXCEPTION 'invalid transfer version' USING ERRCODE='23514';
 END IF;
 IF (NEW.outcome IS DISTINCT FROM OLD.outcome OR NEW.approved_at IS DISTINCT FROM OLD.approved_at) AND NEW.version<>OLD.version+1 THEN
   RAISE EXCEPTION 'transfer changes require the next version' USING ERRCODE='23514';
 END IF;
 RETURN NEW;
END; $$;
