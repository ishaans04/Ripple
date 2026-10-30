CREATE TABLE "family_digests" (
	"world_id" uuid NOT NULL,
	"channel_id" uuid NOT NULL,
	"captured_at" timestamp with time zone NOT NULL,
	"items" jsonb NOT NULL,
	"remaining" integer NOT NULL,
	CONSTRAINT "family_digests_world_id_channel_id_pk" PRIMARY KEY("world_id","channel_id"),
	CONSTRAINT "family_digests_remaining_nonnegative" CHECK ("family_digests"."remaining" >= 0)
);
--> statement-breakpoint
CREATE TABLE "lineage_updates" (
	"world_id" uuid NOT NULL,
	"lineage_id" uuid NOT NULL,
	"sequence" integer NOT NULL,
	"kind" text NOT NULL,
	"organism_id" uuid NOT NULL,
	"channel_id" uuid,
	"trace_id" uuid,
	CONSTRAINT "lineage_updates_world_id_lineage_id_sequence_pk" PRIMARY KEY("world_id","lineage_id","sequence"),
	CONSTRAINT "lineage_updates_sequence_positive" CHECK ("lineage_updates"."sequence" > 0),
	CONSTRAINT "lineage_updates_kind_valid" CHECK ("lineage_updates"."kind" in ('born','admitted','fossilized','archived','trace_earned'))
);
--> statement-breakpoint
ALTER TABLE "family_digests" ADD CONSTRAINT "family_digests_world_id_channel_id_channels_world_id_id_fk" FOREIGN KEY ("world_id","channel_id") REFERENCES "public"."channels"("world_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "lineage_updates" ADD CONSTRAINT "lineage_updates_world_id_lineage_id_lineages_world_id_id_fk" FOREIGN KEY ("world_id","lineage_id") REFERENCES "public"."lineages"("world_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "lineage_updates" ADD CONSTRAINT "lineage_updates_world_id_organism_id_organisms_world_id_id_fk" FOREIGN KEY ("world_id","organism_id") REFERENCES "public"."organisms"("world_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "lineage_updates" ADD CONSTRAINT "lineage_updates_world_id_channel_id_channels_world_id_id_fk" FOREIGN KEY ("world_id","channel_id") REFERENCES "public"."channels"("world_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE TRIGGER lineage_updates_append_only BEFORE UPDATE OR DELETE ON lineage_updates FOR EACH ROW EXECUTE FUNCTION reject_committed_update();
--> statement-breakpoint
CREATE FUNCTION append_lineage_update(world uuid, lineage uuid, update_kind text, organism uuid, host uuid, trace uuid) RETURNS void LANGUAGE plpgsql AS $$
DECLARE next_sequence integer;
BEGIN
  -- Writers already hold this lineage lock; taking it here keeps the sequence in commit order.
  PERFORM 1 FROM lineages WHERE world_id=world AND id=lineage FOR UPDATE;
  SELECT coalesce(max(sequence),0)+1 INTO next_sequence FROM lineage_updates WHERE world_id=world AND lineage_id=lineage;
  INSERT INTO lineage_updates(world_id,lineage_id,sequence,kind,organism_id,channel_id,trace_id)
    VALUES (world,lineage,next_sequence,update_kind,organism,host,trace);
END;
$$;
--> statement-breakpoint
CREATE FUNCTION record_organism_lineage_update() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE host uuid;
BEGIN
  IF TG_OP='INSERT' THEN
    IF NEW.parent_id IS NOT NULL THEN
      -- A child is born where its parent lives.
      SELECT channel_id INTO host FROM residencies WHERE world_id=NEW.world_id AND organism_id=NEW.parent_id
        AND role IN ('resident','visitor') ORDER BY (ended_at IS NULL) DESC, started_at DESC, id DESC LIMIT 1;
      PERFORM append_lineage_update(NEW.world_id,NEW.lineage_id,'born',NEW.id,host,NULL);
    END IF;
  ELSIF NEW.status IS DISTINCT FROM OLD.status
     AND (NEW.status IN ('FOSSIL','ARCHIVED') OR (OLD.status='HARBOR' AND NEW.status='ALIVE')) THEN
    -- Unclaimed children have no residency, so their destination is never recorded here.
    SELECT channel_id INTO host FROM residencies WHERE world_id=NEW.world_id AND organism_id=NEW.id
      ORDER BY (ended_at IS NULL) DESC, started_at DESC, id DESC LIMIT 1;
    PERFORM append_lineage_update(NEW.world_id,NEW.lineage_id,
      CASE NEW.status WHEN 'FOSSIL' THEN 'fossilized' WHEN 'ARCHIVED' THEN 'archived' ELSE 'admitted' END,
      NEW.id,host,NULL);
  END IF;
  RETURN NULL;
END;
$$;
--> statement-breakpoint
CREATE TRIGGER organisms_lineage_updates AFTER INSERT OR UPDATE OF status ON organisms FOR EACH ROW EXECUTE FUNCTION record_organism_lineage_update();
--> statement-breakpoint
CREATE FUNCTION record_trace_lineage_update() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  PERFORM append_lineage_update(NEW.world_id,NEW.lineage_id,'trace_earned',NEW.emitter_id,NEW.channel_id,NEW.trace_id);
  RETURN NULL;
END;
$$;
--> statement-breakpoint
CREATE TRIGGER trace_qualifications_lineage_updates AFTER INSERT ON trace_qualifications FOR EACH ROW EXECUTE FUNCTION record_trace_lineage_update();
