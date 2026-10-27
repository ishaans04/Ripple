CREATE TABLE "runtime_leases" (
	"name" text PRIMARY KEY NOT NULL,
	"owner" uuid NOT NULL,
	"fence" integer NOT NULL,
	"lease_until" timestamp with time zone NOT NULL
);
