CREATE INDEX "organisms_lineage_page_idx" ON "organisms" USING btree ("world_id","lineage_id","generation","id");--> statement-breakpoint
CREATE INDEX "traces_emitter_idx" ON "habitat_traces" USING btree ("world_id","emitter_id");--> statement-breakpoint
CREATE INDEX "trace_qualification_emitter_idx" ON "trace_qualifications" USING btree ("world_id","emitter_id");