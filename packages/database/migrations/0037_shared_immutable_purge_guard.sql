CREATE OR REPLACE FUNCTION reject_committed_update() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF TG_OP='DELETE'
 AND current_setting('ripple.purge_world',true)=to_jsonb(OLD)->>'world_id'
 AND EXISTS(SELECT 1 FROM worlds WHERE id=(to_jsonb(OLD)->>'world_id')::uuid AND expires_at<=clock_timestamp()) THEN RETURN OLD; END IF;
 RAISE EXCEPTION '% is append-only', TG_TABLE_NAME USING ERRCODE='23514';
END; $$;
