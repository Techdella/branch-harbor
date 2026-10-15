CREATE TABLE "franchise_activities" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"prospect_id" uuid NOT NULL,
	"kind" text NOT NULL,
	"body" text,
	"metadata" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"actor_user_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "franchise_agreements" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"owner_group_id" uuid,
	"prospect_id" uuid,
	"territory_id" uuid,
	"territory" text,
	"location_ids" uuid[] DEFAULT '{}'::uuid[] NOT NULL,
	"jurisdiction" text,
	"start_date" date NOT NULL,
	"end_date" date NOT NULL,
	"term_years" integer,
	"renewal_option" text,
	"royalty_bps" integer,
	"marketing_fund_bps" integer,
	"terms" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"status" text DEFAULT 'active' NOT NULL,
	"document_id" uuid,
	"reminders_sent" integer[] DEFAULT '{}'::int[] NOT NULL,
	"created_by" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "franchise_cadences" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"stage" text NOT NULL,
	"name" text NOT NULL,
	"steps" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"active" boolean DEFAULT true NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "franchise_deliveries" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"prospect_id" uuid NOT NULL,
	"document_id" uuid NOT NULL,
	"kind" text DEFAULT 'disclosure' NOT NULL,
	"material_change" boolean DEFAULT false NOT NULL,
	"method" text DEFAULT 'email_link' NOT NULL,
	"token_hash" text NOT NULL,
	"delivered_at" timestamp with time zone DEFAULT now() NOT NULL,
	"delivered_by" uuid,
	"opened_at" timestamp with time zone,
	"receipt_signed_at" timestamp with time zone,
	"receipt_name" text,
	"receipt_ip" text,
	"receipt_user_agent" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "franchise_deliveries_token_hash_unique" UNIQUE("token_hash")
);
--> statement-breakpoint
CREATE TABLE "franchise_documents" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"kind" text NOT NULL,
	"title" text NOT NULL,
	"version" text DEFAULT '1' NOT NULL,
	"jurisdictions" text[] DEFAULT '{}'::text[] NOT NULL,
	"status" text DEFAULT 'current' NOT NULL,
	"issued_on" date,
	"file_name" text NOT NULL,
	"content_type" text NOT NULL,
	"size_bytes" integer NOT NULL,
	"sha256" text NOT NULL,
	"content_base64" text NOT NULL,
	"prospect_id" uuid,
	"owner_group_id" uuid,
	"agreement_id" uuid,
	"uploaded_by" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "franchise_email_templates" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"key" text NOT NULL,
	"name" text NOT NULL,
	"subject" text NOT NULL,
	"body" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "franchise_fee_invoices" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"prospect_id" uuid NOT NULL,
	"collect_location_id" uuid NOT NULL,
	"description" text NOT NULL,
	"amount_minor" bigint NOT NULL,
	"currency" char(3) NOT NULL,
	"status" text DEFAULT 'open' NOT NULL,
	"payment_id" uuid,
	"paid_at" timestamp with time zone,
	"created_by" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "franchise_jurisdiction_rules" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid,
	"code" text NOT NULL,
	"country" text NOT NULL,
	"region" text,
	"version" text NOT NULL,
	"effective_from" date NOT NULL,
	"effective_to" date,
	"data" jsonb NOT NULL,
	"reviewed_by_counsel" boolean DEFAULT false NOT NULL,
	"reviewed_by" uuid,
	"reviewed_at" timestamp with time zone,
	"review_note" text,
	"created_by" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "franchise_projects" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"prospect_id" uuid,
	"owner_group_id" uuid,
	"location_id" uuid,
	"template_key" text NOT NULL,
	"name" text NOT NULL,
	"status" text DEFAULT 'active' NOT NULL,
	"hq_owner_user_id" uuid,
	"owner_email" text,
	"owner_invitation_id" uuid,
	"target_open_date" date,
	"started_at" timestamp with time zone DEFAULT now() NOT NULL,
	"approval_id" uuid,
	"opened_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "franchise_prospects" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"name" text NOT NULL,
	"email" text NOT NULL,
	"phone" text,
	"country" text NOT NULL,
	"region" text,
	"city" text,
	"territory_id" uuid,
	"desired_territory" text,
	"liquid_capital_minor" bigint,
	"net_worth_minor" bigint,
	"currency" char(3),
	"units" integer DEFAULT 1 NOT NULL,
	"source" text DEFAULT 'website' NOT NULL,
	"campaign_id" uuid,
	"attribution" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"message" text,
	"stage" text DEFAULT 'enquiry' NOT NULL,
	"stage_entered_at" timestamp with time zone DEFAULT now() NOT NULL,
	"owner_user_id" uuid,
	"lost_reason" text,
	"owner_group_id" uuid,
	"locale" text DEFAULT 'en' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "franchise_registrations" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"jurisdiction" text NOT NULL,
	"status" text DEFAULT 'not_filed' NOT NULL,
	"file_number" text,
	"effective_from" timestamp with time zone,
	"expires_at" timestamp with time zone,
	"notes" text,
	"updated_by" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "franchise_signatures" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"prospect_id" uuid NOT NULL,
	"document_id" uuid NOT NULL,
	"delivery_id" uuid,
	"provider" text DEFAULT 'builtin' NOT NULL,
	"provider_envelope_id" text,
	"status" text DEFAULT 'sent' NOT NULL,
	"token_hash" text,
	"terms" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"sent_at" timestamp with time zone DEFAULT now() NOT NULL,
	"sent_by" uuid,
	"signed_at" timestamp with time zone,
	"signer_name" text,
	"signer_ip" text,
	"signer_user_agent" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "franchise_signatures_token_hash_unique" UNIQUE("token_hash")
);
--> statement-breakpoint
CREATE TABLE "franchise_tasks" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"prospect_id" uuid,
	"project_id" uuid,
	"cadence_id" uuid,
	"source_key" text,
	"section" text,
	"kind" text DEFAULT 'task' NOT NULL,
	"title" text NOT NULL,
	"template_key" text,
	"assignee" text DEFAULT 'hq' NOT NULL,
	"owner_user_id" uuid,
	"gate" boolean DEFAULT false NOT NULL,
	"due_at" timestamp with time zone,
	"status" text DEFAULT 'open' NOT NULL,
	"reminded_at" timestamp with time zone,
	"completed_at" timestamp with time zone,
	"completed_by" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "franchise_territories" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"name" text NOT NULL,
	"country" text NOT NULL,
	"region" text,
	"description" text,
	"status" text DEFAULT 'available' NOT NULL,
	"reserved_for_prospect_id" uuid,
	"owner_group_id" uuid,
	"show_on_site" boolean DEFAULT true NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "franchise_activities" ADD CONSTRAINT "franchise_activities_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "franchise_activities" ADD CONSTRAINT "franchise_activities_prospect_id_franchise_prospects_id_fk" FOREIGN KEY ("prospect_id") REFERENCES "public"."franchise_prospects"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "franchise_agreements" ADD CONSTRAINT "franchise_agreements_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "franchise_agreements" ADD CONSTRAINT "franchise_agreements_owner_group_id_owner_groups_id_fk" FOREIGN KEY ("owner_group_id") REFERENCES "public"."owner_groups"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "franchise_cadences" ADD CONSTRAINT "franchise_cadences_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "franchise_deliveries" ADD CONSTRAINT "franchise_deliveries_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "franchise_deliveries" ADD CONSTRAINT "franchise_deliveries_prospect_id_franchise_prospects_id_fk" FOREIGN KEY ("prospect_id") REFERENCES "public"."franchise_prospects"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "franchise_deliveries" ADD CONSTRAINT "franchise_deliveries_document_id_franchise_documents_id_fk" FOREIGN KEY ("document_id") REFERENCES "public"."franchise_documents"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "franchise_documents" ADD CONSTRAINT "franchise_documents_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "franchise_email_templates" ADD CONSTRAINT "franchise_email_templates_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "franchise_fee_invoices" ADD CONSTRAINT "franchise_fee_invoices_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "franchise_fee_invoices" ADD CONSTRAINT "franchise_fee_invoices_prospect_id_franchise_prospects_id_fk" FOREIGN KEY ("prospect_id") REFERENCES "public"."franchise_prospects"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "franchise_jurisdiction_rules" ADD CONSTRAINT "franchise_jurisdiction_rules_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "franchise_projects" ADD CONSTRAINT "franchise_projects_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "franchise_projects" ADD CONSTRAINT "franchise_projects_prospect_id_franchise_prospects_id_fk" FOREIGN KEY ("prospect_id") REFERENCES "public"."franchise_prospects"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "franchise_projects" ADD CONSTRAINT "franchise_projects_owner_group_id_owner_groups_id_fk" FOREIGN KEY ("owner_group_id") REFERENCES "public"."owner_groups"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "franchise_projects" ADD CONSTRAINT "franchise_projects_location_id_locations_id_fk" FOREIGN KEY ("location_id") REFERENCES "public"."locations"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "franchise_prospects" ADD CONSTRAINT "franchise_prospects_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "franchise_prospects" ADD CONSTRAINT "franchise_prospects_territory_id_franchise_territories_id_fk" FOREIGN KEY ("territory_id") REFERENCES "public"."franchise_territories"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "franchise_prospects" ADD CONSTRAINT "franchise_prospects_owner_group_id_owner_groups_id_fk" FOREIGN KEY ("owner_group_id") REFERENCES "public"."owner_groups"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "franchise_registrations" ADD CONSTRAINT "franchise_registrations_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "franchise_signatures" ADD CONSTRAINT "franchise_signatures_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "franchise_signatures" ADD CONSTRAINT "franchise_signatures_prospect_id_franchise_prospects_id_fk" FOREIGN KEY ("prospect_id") REFERENCES "public"."franchise_prospects"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "franchise_signatures" ADD CONSTRAINT "franchise_signatures_document_id_franchise_documents_id_fk" FOREIGN KEY ("document_id") REFERENCES "public"."franchise_documents"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "franchise_tasks" ADD CONSTRAINT "franchise_tasks_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "franchise_tasks" ADD CONSTRAINT "franchise_tasks_prospect_id_franchise_prospects_id_fk" FOREIGN KEY ("prospect_id") REFERENCES "public"."franchise_prospects"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "franchise_tasks" ADD CONSTRAINT "franchise_tasks_project_id_franchise_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."franchise_projects"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "franchise_territories" ADD CONSTRAINT "franchise_territories_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "franchise_territories" ADD CONSTRAINT "franchise_territories_owner_group_id_owner_groups_id_fk" FOREIGN KEY ("owner_group_id") REFERENCES "public"."owner_groups"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "franchise_activities_prospect_idx" ON "franchise_activities" USING btree ("prospect_id","created_at");--> statement-breakpoint
CREATE INDEX "franchise_agreements_org_idx" ON "franchise_agreements" USING btree ("organization_id","end_date");--> statement-breakpoint
CREATE INDEX "franchise_cadences_org_stage_idx" ON "franchise_cadences" USING btree ("organization_id","stage");--> statement-breakpoint
CREATE INDEX "franchise_deliveries_prospect_idx" ON "franchise_deliveries" USING btree ("prospect_id");--> statement-breakpoint
CREATE INDEX "franchise_documents_org_kind_idx" ON "franchise_documents" USING btree ("organization_id","kind");--> statement-breakpoint
CREATE UNIQUE INDEX "franchise_email_templates_uq" ON "franchise_email_templates" USING btree ("organization_id","key");--> statement-breakpoint
CREATE UNIQUE INDEX "franchise_rules_platform_uq" ON "franchise_jurisdiction_rules" USING btree ("code","version") WHERE "franchise_jurisdiction_rules"."organization_id" is null;--> statement-breakpoint
CREATE UNIQUE INDEX "franchise_rules_org_uq" ON "franchise_jurisdiction_rules" USING btree ("organization_id","code","version") WHERE "franchise_jurisdiction_rules"."organization_id" is not null;--> statement-breakpoint
CREATE INDEX "franchise_projects_org_idx" ON "franchise_projects" USING btree ("organization_id","status");--> statement-breakpoint
CREATE INDEX "franchise_prospects_org_stage_idx" ON "franchise_prospects" USING btree ("organization_id","stage");--> statement-breakpoint
CREATE UNIQUE INDEX "franchise_registrations_uq" ON "franchise_registrations" USING btree ("organization_id","jurisdiction");--> statement-breakpoint
CREATE INDEX "franchise_tasks_org_due_idx" ON "franchise_tasks" USING btree ("organization_id","status","due_at");--> statement-breakpoint
CREATE UNIQUE INDEX "franchise_tasks_source_uq" ON "franchise_tasks" USING btree ("organization_id","source_key");--> statement-breakpoint
CREATE INDEX "franchise_territories_org_idx" ON "franchise_territories" USING btree ("organization_id");