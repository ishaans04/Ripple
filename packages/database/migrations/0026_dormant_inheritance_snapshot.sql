CREATE FUNCTION validate_dormant_inheritance() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE parent dormant_mutations%ROWTYPE;
BEGIN
 IF NEW.provenance ? 'inheritedFrom' THEN
 SELECT d.* INTO parent FROM dormant_mutations d JOIN organisms child ON child.world_id=d.world_id AND child.parent_id=d.organism_id
 WHERE d.world_id=NEW.world_id AND child.id=NEW.organism_id AND d.id=(NEW.provenance->'inheritedFrom'->>'dormantId')::uuid
 AND d.organism_id=(NEW.provenance->'inheritedFrom'->>'organismId')::uuid
 AND d.version=(NEW.provenance->'inheritedFrom'->>'version')::integer AND d.status='active';
 IF parent.id IS NULL OR NEW.source_round_id IS DISTINCT FROM parent.source_round_id OR NEW.template IS DISTINCT FROM parent.template
 OR NEW.lifetime IS DISTINCT FROM parent.lifetime OR NEW.remaining_rounds IS DISTINCT FROM parent.remaining_rounds
 OR NEW.remaining_hops IS DISTINCT FROM parent.remaining_hops-1 OR NEW.offered IS DISTINCT FROM parent.offered
 OR (NEW.provenance-'inheritedFrom') IS DISTINCT FROM (parent.provenance-'inheritedFrom') THEN
 RAISE EXCEPTION 'inherited dormant state must exactly capture its immediate parent without renewing lifetime or offers' USING ERRCODE='23514'; END IF;
 END IF;
 RETURN NEW;
END; $$;
--> statement-breakpoint
CREATE TRIGGER dormant_inheritance_valid BEFORE INSERT ON dormant_mutations FOR EACH ROW EXECUTE FUNCTION validate_dormant_inheritance();
