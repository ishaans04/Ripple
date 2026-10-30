ALTER TABLE "organisms" ADD COLUMN "appearance_mapping" smallint DEFAULT 1 NOT NULL;--> statement-breakpoint
ALTER TABLE "organisms" ADD CONSTRAINT "organisms_appearance_mapping_known" CHECK ("organisms"."appearance_mapping" = 1);--> statement-breakpoint
CREATE OR REPLACE FUNCTION preserve_organism_ancestry() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF ROW(NEW.world_id, NEW.id, NEW.lineage_id, NEW.parent_id, NEW.founder_id,
         NEW.generation, NEW.founding_genome, NEW.appearance_mapping)
     IS DISTINCT FROM
     ROW(OLD.world_id, OLD.id, OLD.lineage_id, OLD.parent_id, OLD.founder_id,
         OLD.generation, OLD.founding_genome, OLD.appearance_mapping) THEN
    RAISE EXCEPTION 'organism ancestry and appearance mapping are immutable' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$$;
