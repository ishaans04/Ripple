-- A world's mode is fixed at creation: live, sandbox, and replay state must never be
-- reclassified, because sandbox actions are only authorized by a server-side mode check.
CREATE FUNCTION "ripple_worlds_mode_immutable"() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF NEW."mode" IS DISTINCT FROM OLD."mode" THEN
    RAISE EXCEPTION 'world % mode is immutable', OLD."id" USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END;
$$;
--> statement-breakpoint
CREATE TRIGGER "worlds_mode_immutable"
BEFORE UPDATE OF "mode" ON "worlds"
FOR EACH ROW EXECUTE FUNCTION "ripple_worlds_mode_immutable"();
