CREATE FUNCTION reject_ruleset_change() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'rulesets are immutable; insert a new version' USING ERRCODE = '23514';
END;
$$;
--> statement-breakpoint
CREATE TRIGGER rulesets_immutable BEFORE UPDATE OR DELETE ON rulesets
FOR EACH ROW EXECUTE FUNCTION reject_ruleset_change();
--> statement-breakpoint
CREATE FUNCTION preserve_organism_ancestry() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF ROW(NEW.world_id, NEW.id, NEW.lineage_id, NEW.parent_id, NEW.founder_id,
         NEW.generation, NEW.founding_genome)
     IS DISTINCT FROM
     ROW(OLD.world_id, OLD.id, OLD.lineage_id, OLD.parent_id, OLD.founder_id,
         OLD.generation, OLD.founding_genome) THEN
    RAISE EXCEPTION 'organism ancestry is immutable' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$$;
--> statement-breakpoint
CREATE TRIGGER organisms_ancestry_immutable BEFORE UPDATE ON organisms
FOR EACH ROW EXECUTE FUNCTION preserve_organism_ancestry();
