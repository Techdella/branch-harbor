CREATE TABLE "audit_actions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"audit_id" uuid NOT NULL,
	"location_id" uuid NOT NULL,
	"question_id" text NOT NULL,
	"section_title" text NOT NULL,
	"title" text NOT NULL,
	"reason" text NOT NULL,
	"critical" boolean DEFAULT false NOT NULL,
	"auditor_note" text,
	"due_date" date NOT NULL,
	"status" text DEFAULT 'open' NOT NULL,
	"response_note" text,
	"evidence_file_ids" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"submitted_by" uuid,
	"submitted_at" timestamp with time zone,
	"verified_by" uuid,
	"verified_at" timestamp with time zone,
	"review_note" text,
	"reopened_count" integer DEFAULT 0 NOT NULL,
	"reminded_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "audit_templates" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"name" text NOT NULL,
	"description" text DEFAULT '' NOT NULL,
	"starter_key" text,
	"sections" jsonb NOT NULL,
	"pass_threshold" integer DEFAULT 80 NOT NULL,
	"reaudit_days" integer DEFAULT 30 NOT NULL,
	"corrective_days" integer DEFAULT 14 NOT NULL,
	"status" text DEFAULT 'active' NOT NULL,
	"version" integer DEFAULT 1 NOT NULL,
	"created_by" uuid,
	"updated_by" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "audits" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"location_id" uuid NOT NULL,
	"template_id" uuid,
	"checklist" jsonb NOT NULL,
	"purpose" text DEFAULT 'routine' NOT NULL,
	"status" text DEFAULT 'scheduled' NOT NULL,
	"due_date" date NOT NULL,
	"auditor_user_id" uuid,
	"scheduled_by" uuid,
	"parent_audit_id" uuid,
	"project_id" uuid,
	"answers" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"revision" integer DEFAULT 0 NOT NULL,
	"started_at" timestamp with time zone,
	"completed_at" timestamp with time zone,
	"score_tenths" integer,
	"passed" boolean,
	"critical_failed" boolean,
	"summary" text,
	"reaudit_due_date" date,
	"reminded_at" timestamp with time zone,
	"cancel_reason" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "compliance_documents" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"requirement_id" uuid,
	"location_id" uuid,
	"owner_group_id" uuid,
	"category" text NOT NULL,
	"title" text NOT NULL,
	"issuer" text,
	"reference" text,
	"coverage_type" text,
	"coverage_amount_minor" bigint,
	"currency" char(3),
	"issued_on" date,
	"expires_on" date,
	"file_id" uuid,
	"status" text DEFAULT 'pending' NOT NULL,
	"review_note" text,
	"reviewed_by" uuid,
	"reviewed_at" timestamp with time zone,
	"uploaded_by" uuid,
	"reminders_sent" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"escalated_at" timestamp with time zone,
	"superseded_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "compliance_requirements" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"name" text NOT NULL,
	"category" text NOT NULL,
	"description" text DEFAULT '' NOT NULL,
	"coverage_type" text,
	"min_amount_minor" bigint,
	"currency" char(3),
	"applies_to" text DEFAULT 'location' NOT NULL,
	"jurisdictions" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"requires_expiry" boolean DEFAULT true NOT NULL,
	"active" boolean DEFAULT true NOT NULL,
	"created_by" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "ops_files" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"location_id" uuid,
	"owner_group_id" uuid,
	"purpose" text NOT NULL,
	"name" text NOT NULL,
	"mime" text NOT NULL,
	"size" integer NOT NULL,
	"sha256" text NOT NULL,
	"storage" text NOT NULL,
	"storage_key" text NOT NULL,
	"data" "bytea",
	"uploaded_by" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "franchise_projects" ADD COLUMN "pre_opening_template_id" uuid;--> statement-breakpoint
ALTER TABLE "audit_actions" ADD CONSTRAINT "audit_actions_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "audit_actions" ADD CONSTRAINT "audit_actions_audit_id_audits_id_fk" FOREIGN KEY ("audit_id") REFERENCES "public"."audits"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "audit_actions" ADD CONSTRAINT "audit_actions_location_id_locations_id_fk" FOREIGN KEY ("location_id") REFERENCES "public"."locations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "audit_templates" ADD CONSTRAINT "audit_templates_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "audits" ADD CONSTRAINT "audits_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "audits" ADD CONSTRAINT "audits_location_id_locations_id_fk" FOREIGN KEY ("location_id") REFERENCES "public"."locations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "audits" ADD CONSTRAINT "audits_template_id_audit_templates_id_fk" FOREIGN KEY ("template_id") REFERENCES "public"."audit_templates"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "compliance_documents" ADD CONSTRAINT "compliance_documents_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "compliance_documents" ADD CONSTRAINT "compliance_documents_requirement_id_compliance_requirements_id_fk" FOREIGN KEY ("requirement_id") REFERENCES "public"."compliance_requirements"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "compliance_documents" ADD CONSTRAINT "compliance_documents_location_id_locations_id_fk" FOREIGN KEY ("location_id") REFERENCES "public"."locations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "compliance_documents" ADD CONSTRAINT "compliance_documents_owner_group_id_owner_groups_id_fk" FOREIGN KEY ("owner_group_id") REFERENCES "public"."owner_groups"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "compliance_documents" ADD CONSTRAINT "compliance_documents_file_id_ops_files_id_fk" FOREIGN KEY ("file_id") REFERENCES "public"."ops_files"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "compliance_requirements" ADD CONSTRAINT "compliance_requirements_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ops_files" ADD CONSTRAINT "ops_files_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ops_files" ADD CONSTRAINT "ops_files_location_id_locations_id_fk" FOREIGN KEY ("location_id") REFERENCES "public"."locations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ops_files" ADD CONSTRAINT "ops_files_owner_group_id_owner_groups_id_fk" FOREIGN KEY ("owner_group_id") REFERENCES "public"."owner_groups"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "audit_actions_audit_question_uq" ON "audit_actions" USING btree ("audit_id","question_id");--> statement-breakpoint
CREATE INDEX "audit_actions_org_status_idx" ON "audit_actions" USING btree ("organization_id","status","due_date");--> statement-breakpoint
CREATE INDEX "audit_templates_org_idx" ON "audit_templates" USING btree ("organization_id","status");--> statement-breakpoint
CREATE INDEX "audits_org_loc_idx" ON "audits" USING btree ("organization_id","location_id","status");--> statement-breakpoint
CREATE INDEX "audits_org_auditor_idx" ON "audits" USING btree ("organization_id","auditor_user_id");--> statement-breakpoint
CREATE INDEX "audits_project_idx" ON "audits" USING btree ("project_id");--> statement-breakpoint
CREATE INDEX "compliance_documents_org_idx" ON "compliance_documents" USING btree ("organization_id","status");--> statement-breakpoint
CREATE INDEX "compliance_documents_loc_idx" ON "compliance_documents" USING btree ("location_id");--> statement-breakpoint
CREATE INDEX "compliance_documents_group_idx" ON "compliance_documents" USING btree ("owner_group_id");--> statement-breakpoint
CREATE INDEX "compliance_documents_expiry_idx" ON "compliance_documents" USING btree ("organization_id","expires_on");--> statement-breakpoint
CREATE INDEX "compliance_requirements_org_idx" ON "compliance_requirements" USING btree ("organization_id","active");--> statement-breakpoint
CREATE INDEX "ops_files_org_idx" ON "ops_files" USING btree ("organization_id","purpose");