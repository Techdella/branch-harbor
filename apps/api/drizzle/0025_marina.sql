CREATE EXTENSION IF NOT EXISTS pg_trgm;--> statement-breakpoint
CREATE TABLE "ai_briefings" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"user_id" uuid NOT NULL,
	"date" text NOT NULL,
	"kind" text DEFAULT 'daily' NOT NULL,
	"items" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"summary" text,
	"emailed_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "ai_insights" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"location_id" uuid,
	"kind" text NOT NULL,
	"severity" text DEFAULT 'warning' NOT NULL,
	"title" text NOT NULL,
	"explanation" text NOT NULL,
	"evidence" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"suggested_actions" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"module" text NOT NULL,
	"fingerprint" text NOT NULL,
	"status" text DEFAULT 'open' NOT NULL,
	"currency" text,
	"period_label" text,
	"detected_at" timestamp with time zone DEFAULT now() NOT NULL,
	"decided_by" uuid,
	"decided_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "ai_knowledge_chunks" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"source_id" uuid NOT NULL,
	"position" integer NOT NULL,
	"heading" text,
	"content" text NOT NULL,
	"tsv" "tsvector" GENERATED ALWAYS AS (to_tsvector('simple', coalesce(heading, '') || ' ' || content)) STORED,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "ai_knowledge_sources" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"source_type" text NOT NULL,
	"source_ref" text,
	"title" text NOT NULL,
	"url" text,
	"audiences" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"module" text DEFAULT 'ai.assistant' NOT NULL,
	"hq_only" boolean DEFAULT false NOT NULL,
	"file_name" text,
	"mime_type" text,
	"content_hash" text,
	"chunk_count" integer DEFAULT 0 NOT NULL,
	"status" text DEFAULT 'ready' NOT NULL,
	"error" text,
	"created_by" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "ai_org_settings" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"settings" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"updated_by" uuid,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "ai_org_settings_organization_id_unique" UNIQUE("organization_id")
);
--> statement-breakpoint
CREATE TABLE "ai_tasks" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"user_id" uuid NOT NULL,
	"title" text NOT NULL,
	"note" text,
	"link" text,
	"due_at" timestamp with time zone,
	"remind_at" timestamp with time zone,
	"reminded_at" timestamp with time zone,
	"status" text DEFAULT 'open' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "ai_tool_calls" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"user_id" uuid,
	"conversation_id" uuid,
	"action_id" uuid,
	"tool" text NOT NULL,
	"kind" text NOT NULL,
	"status" text NOT NULL,
	"input" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"summary" text,
	"untrusted" boolean DEFAULT false NOT NULL,
	"duration_ms" integer,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "ai_usage" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"month" text NOT NULL,
	"feature" text NOT NULL,
	"requests" integer DEFAULT 0 NOT NULL,
	"input_tokens" bigint DEFAULT 0 NOT NULL,
	"output_tokens" bigint DEFAULT 0 NOT NULL,
	"cache_read_tokens" bigint DEFAULT 0 NOT NULL,
	"cache_write_tokens" bigint DEFAULT 0 NOT NULL,
	"credits" double precision DEFAULT 0 NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "ai_user_prefs" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"user_id" uuid NOT NULL,
	"briefing_frequency" text DEFAULT 'daily' NOT NULL,
	"briefing_hour" integer DEFAULT 7 NOT NULL,
	"briefing_weekday" integer DEFAULT 1 NOT NULL,
	"briefing_email" boolean DEFAULT true NOT NULL,
	"briefing_in_app" boolean DEFAULT true NOT NULL,
	"sections" text[] DEFAULT '{}' NOT NULL,
	"last_briefing_at" timestamp with time zone,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "ai_proposed_actions" ALTER COLUMN "conversation_id" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "ai_conversations" ADD COLUMN "channel" text DEFAULT 'web' NOT NULL;--> statement-breakpoint
ALTER TABLE "ai_conversations" ADD COLUMN "context" jsonb DEFAULT '{}'::jsonb NOT NULL;--> statement-breakpoint
ALTER TABLE "ai_conversations" ADD COLUMN "archived_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "ai_messages" ADD COLUMN "cache_read_tokens" integer;--> statement-breakpoint
ALTER TABLE "ai_messages" ADD COLUMN "cache_write_tokens" integer;--> statement-breakpoint
ALTER TABLE "ai_messages" ADD COLUMN "blocks" jsonb DEFAULT '[]'::jsonb NOT NULL;--> statement-breakpoint
ALTER TABLE "ai_messages" ADD COLUMN "citations" jsonb DEFAULT '[]'::jsonb NOT NULL;--> statement-breakpoint
ALTER TABLE "ai_messages" ADD COLUMN "meta" jsonb DEFAULT '{}'::jsonb NOT NULL;--> statement-breakpoint
ALTER TABLE "ai_proposed_actions" ADD COLUMN "title" text;--> statement-breakpoint
ALTER TABLE "ai_proposed_actions" ADD COLUMN "details" jsonb DEFAULT '[]'::jsonb NOT NULL;--> statement-breakpoint
ALTER TABLE "ai_proposed_actions" ADD COLUMN "editable" jsonb DEFAULT '[]'::jsonb NOT NULL;--> statement-breakpoint
ALTER TABLE "ai_proposed_actions" ADD COLUMN "risk" text DEFAULT 'change' NOT NULL;--> statement-breakpoint
ALTER TABLE "ai_proposed_actions" ADD COLUMN "from_untrusted" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "ai_proposed_actions" ADD COLUMN "source" text DEFAULT 'chat' NOT NULL;--> statement-breakpoint
ALTER TABLE "ai_proposed_actions" ADD COLUMN "link" text;--> statement-breakpoint
ALTER TABLE "ai_proposed_actions" ADD COLUMN "confirmed_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "ai_proposed_actions" ADD COLUMN "approved_by" uuid;--> statement-breakpoint
ALTER TABLE "ai_briefings" ADD CONSTRAINT "ai_briefings_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ai_briefings" ADD CONSTRAINT "ai_briefings_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ai_insights" ADD CONSTRAINT "ai_insights_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ai_insights" ADD CONSTRAINT "ai_insights_location_id_locations_id_fk" FOREIGN KEY ("location_id") REFERENCES "public"."locations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ai_knowledge_chunks" ADD CONSTRAINT "ai_knowledge_chunks_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ai_knowledge_chunks" ADD CONSTRAINT "ai_knowledge_chunks_source_id_ai_knowledge_sources_id_fk" FOREIGN KEY ("source_id") REFERENCES "public"."ai_knowledge_sources"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ai_knowledge_sources" ADD CONSTRAINT "ai_knowledge_sources_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ai_org_settings" ADD CONSTRAINT "ai_org_settings_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ai_tasks" ADD CONSTRAINT "ai_tasks_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ai_tasks" ADD CONSTRAINT "ai_tasks_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ai_tool_calls" ADD CONSTRAINT "ai_tool_calls_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ai_usage" ADD CONSTRAINT "ai_usage_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ai_user_prefs" ADD CONSTRAINT "ai_user_prefs_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ai_user_prefs" ADD CONSTRAINT "ai_user_prefs_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "ai_briefings_uq" ON "ai_briefings" USING btree ("organization_id","user_id","date");--> statement-breakpoint
CREATE UNIQUE INDEX "ai_insights_uq" ON "ai_insights" USING btree ("organization_id","fingerprint");--> statement-breakpoint
CREATE INDEX "ai_insights_org_idx" ON "ai_insights" USING btree ("organization_id","status","detected_at");--> statement-breakpoint
CREATE INDEX "ai_knowledge_chunks_source_idx" ON "ai_knowledge_chunks" USING btree ("source_id","position");--> statement-breakpoint
CREATE INDEX "ai_knowledge_chunks_tsv_idx" ON "ai_knowledge_chunks" USING gin ("tsv");--> statement-breakpoint
CREATE INDEX "ai_knowledge_chunks_trgm_idx" ON "ai_knowledge_chunks" USING gin ("content" gin_trgm_ops);--> statement-breakpoint
CREATE UNIQUE INDEX "ai_knowledge_sources_ref_uq" ON "ai_knowledge_sources" USING btree ("organization_id","source_type","source_ref");--> statement-breakpoint
CREATE INDEX "ai_tasks_user_idx" ON "ai_tasks" USING btree ("organization_id","user_id","status");--> statement-breakpoint
CREATE INDEX "ai_tasks_remind_idx" ON "ai_tasks" USING btree ("remind_at");--> statement-breakpoint
CREATE INDEX "ai_tool_calls_org_idx" ON "ai_tool_calls" USING btree ("organization_id","created_at");--> statement-breakpoint
CREATE UNIQUE INDEX "ai_usage_uq" ON "ai_usage" USING btree ("organization_id","month","feature");--> statement-breakpoint
CREATE UNIQUE INDEX "ai_user_prefs_uq" ON "ai_user_prefs" USING btree ("organization_id","user_id");--> statement-breakpoint
CREATE INDEX "ai_conversations_user_idx" ON "ai_conversations" USING btree ("organization_id","user_id","updated_at");--> statement-breakpoint
CREATE INDEX "ai_proposed_actions_org_idx" ON "ai_proposed_actions" USING btree ("organization_id","status");