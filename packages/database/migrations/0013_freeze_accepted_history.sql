CREATE FUNCTION validate_organism_origin() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE parent organisms%ROWTYPE;
BEGIN
  IF NEW.founding_genome IS DISTINCT FROM jsonb_build_object(
      'pulse',NEW.pulse,'calm',NEW.calm,'grit',NEW.grit,'drift',NEW.drift) THEN
    RAISE EXCEPTION 'founding genome must match the initial committed genome' USING ERRCODE='23514';
  END IF;
  IF NEW.parent_id IS NOT NULL THEN
    SELECT * INTO parent FROM organisms WHERE world_id=NEW.world_id AND id=NEW.parent_id;
    IF NOT FOUND OR parent.status<>'ALIVE' OR NEW.lineage_id<>parent.lineage_id
       OR NEW.founder_id<>parent.founder_id OR NEW.generation<>parent.generation+1
       OR NEW.founding_genome IS DISTINCT FROM jsonb_build_object(
          'pulse',parent.pulse,'calm',parent.calm,'grit',parent.grit,'drift',parent.drift) THEN
      RAISE EXCEPTION 'child must capture its living immediate parent in the same lineage' USING ERRCODE='23514';
    END IF;
  END IF;
  RETURN NEW;
END;
$$;
--> statement-breakpoint
CREATE TRIGGER organisms_origin_valid BEFORE INSERT ON organisms FOR EACH ROW EXECUTE FUNCTION validate_organism_origin();
--> statement-breakpoint
CREATE FUNCTION preserve_channel_genesis() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP='INSERT' THEN
    IF NEW.rules_hash IS DISTINCT FROM (SELECT rules_hash FROM worlds WHERE id=NEW.world_id) THEN
      RAISE EXCEPTION 'channel and world rules must match' USING ERRCODE='23514';
    END IF;
  ELSE
    IF ROW(NEW.world_id,NEW.id,NEW.seed,NEW.rules_hash,NEW.configuration,NEW.initial_online,NEW.initial_healthy,NEW.initial_paused)
       IS DISTINCT FROM ROW(OLD.world_id,OLD.id,OLD.seed,OLD.rules_hash,OLD.configuration,OLD.initial_online,OLD.initial_healthy,OLD.initial_paused) THEN
      RAISE EXCEPTION 'channel genesis is immutable; use a new recorded session' USING ERRCODE='23514';
    END IF;
    IF NEW.intake_sequence<OLD.intake_sequence OR NEW.processed_sequence<OLD.processed_sequence OR NEW.state_version<OLD.state_version THEN
      RAISE EXCEPTION 'channel cursors cannot move backwards' USING ERRCODE='23514';
    END IF;
  END IF;
  RETURN NEW;
END;
$$;
--> statement-breakpoint
CREATE TRIGGER channels_genesis_immutable BEFORE INSERT OR UPDATE ON channels FOR EACH ROW EXECUTE FUNCTION preserve_channel_genesis();
--> statement-breakpoint
CREATE FUNCTION preserve_world_rules() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.rules_hash IS DISTINCT FROM OLD.rules_hash THEN
    RAISE EXCEPTION 'world rules are immutable' USING ERRCODE='23514';
  END IF;
  RETURN NEW;
END;
$$;
--> statement-breakpoint
CREATE TRIGGER worlds_rules_immutable BEFORE UPDATE ON worlds FOR EACH ROW EXECUTE FUNCTION preserve_world_rules();
--> statement-breakpoint
CREATE FUNCTION preserve_accepted_input() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF ROW(NEW.world_id,NEW.channel_id,NEW.sequence,NEW.provider,NEW.message_id,NEW.command,NEW.accepted_at)
     IS DISTINCT FROM ROW(OLD.world_id,OLD.channel_id,OLD.sequence,OLD.provider,OLD.message_id,OLD.command,OLD.accepted_at) THEN
    RAISE EXCEPTION 'accepted input is immutable' USING ERRCODE='23514';
  END IF;
  RETURN NEW;
END;
$$;
--> statement-breakpoint
CREATE TRIGGER inbox_input_immutable BEFORE UPDATE ON inbox FOR EACH ROW EXECUTE FUNCTION preserve_accepted_input();
--> statement-breakpoint
CREATE FUNCTION reject_committed_update() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION '% is append-only', TG_TABLE_NAME USING ERRCODE='23514';
END;
$$;
--> statement-breakpoint
CREATE TRIGGER game_events_append_only BEFORE UPDATE ON game_events FOR EACH ROW EXECUTE FUNCTION reject_committed_update();
--> statement-breakpoint
CREATE TRIGGER public_updates_append_only BEFORE UPDATE ON public_updates FOR EACH ROW EXECUTE FUNCTION reject_committed_update();
--> statement-breakpoint
CREATE TRIGGER lineages_identity_immutable BEFORE UPDATE ON lineages FOR EACH ROW EXECUTE FUNCTION reject_committed_update();
--> statement-breakpoint
CREATE TRIGGER votes_first_choice_immutable BEFORE UPDATE ON votes FOR EACH ROW EXECUTE FUNCTION reject_committed_update();
--> statement-breakpoint
CREATE TRIGGER activity_membership_immutable BEFORE UPDATE ON activity_contributions FOR EACH ROW EXECUTE FUNCTION reject_committed_update();
--> statement-breakpoint
CREATE TRIGGER habitat_baselines_immutable BEFORE UPDATE ON habitat_baselines FOR EACH ROW EXECUTE FUNCTION reject_committed_update();
--> statement-breakpoint
CREATE FUNCTION preserve_completed_round() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF OLD.completed_at IS NOT NULL AND NEW IS DISTINCT FROM OLD THEN
    RAISE EXCEPTION 'completed rounds are immutable' USING ERRCODE='23514';
  END IF;
  RETURN NEW;
END;
$$;
--> statement-breakpoint
CREATE TRIGGER rounds_completed_immutable BEFORE UPDATE ON rounds FOR EACH ROW EXECUTE FUNCTION preserve_completed_round();
