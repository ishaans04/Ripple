CREATE TABLE artist_identities (
  world_id uuid NOT NULL REFERENCES worlds(id),
  subject_hash text NOT NULL,
  artist_key text NOT NULL CHECK (artist_key ~ '^[0-9a-f]{64}$'),
  credit_token text NOT NULL CHECK (credit_token ~ '^artist:[0-9a-f]{32}$'),
  login text NOT NULL CHECK (length(login) BETWEEN 1 AND 40),
  expires_at timestamptz NOT NULL DEFAULT (now()+interval '30 days'),
  PRIMARY KEY(world_id,subject_hash),
  UNIQUE(world_id,artist_key),
  UNIQUE(credit_token)
);--> statement-breakpoint
CREATE INDEX artist_identities_expiry ON artist_identities(expires_at);--> statement-breakpoint
-- Existing sign-in cookies expire. Accepted game history is never rewritten.
DELETE FROM artist_sessions;
