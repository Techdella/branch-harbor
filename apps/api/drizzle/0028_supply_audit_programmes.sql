CREATE TABLE "audit_schedules" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"name" text NOT NULL,
	"template_id" uuid NOT NULL,
	"target" jsonb NOT NULL,
	"frequency" text NOT NULL,
	"interval" integer DEFAULT 1 NOT NULL,
	"anchor_date" date NOT NULL,
	"lead_days" integer DEFAULT 14 NOT NULL,
	"auditor_rule" text DEFAULT 'field_consultant' NOT NULL,
	"auditor_user_id" uuid,
	"active" boolean DEFAULT true NOT NULL,
	"last_run_at" timestamp with time zone,
	"created_by" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "self_check_runs" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"schedule_id" uuid NOT NULL,
	"location_id" uuid NOT NULL,
	"date" date NOT NULL,
	"due_at" timestamp with time zone NOT NULL,
	"checklist" jsonb NOT NULL,
	"status" text DEFAULT 'due' NOT NULL,
	"answers" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"score_tenths" integer,
	"passed" boolean,
	"critical_failed" boolean,
	"failed_items" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"note" text,
	"completed_by" uuid,
	"completed_at" timestamp with time zone,
	"reminded_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "self_check_schedules" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"name" text NOT NULL,
	"template_id" uuid NOT NULL,
	"kind" text DEFAULT 'other' NOT NULL,
	"target" jsonb NOT NULL,
	"weekdays" jsonb NOT NULL,
	"due_time" text DEFAULT '10:00' NOT NULL,
	"remind_minutes_before" integer DEFAULT 30 NOT NULL,
	"active" boolean DEFAULT true NOT NULL,
	"created_by" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "supply_catalogue_items" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"supplier_id" uuid NOT NULL,
	"sku" text NOT NULL,
	"name" text NOT NULL,
	"category" text DEFAULT '' NOT NULL,
	"pack_label" text DEFAULT '' NOT NULL,
	"units_per_pack" integer DEFAULT 1 NOT NULL,
	"prices" jsonb NOT NULL,
	"moq" integer DEFAULT 1 NOT NULL,
	"lead_time_days" integer DEFAULT 2 NOT NULL,
	"active" boolean DEFAULT true NOT NULL,
	"variant_id" uuid,
	"ingredient_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "supply_off_contract" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"location_id" uuid NOT NULL,
	"vendor_name" text NOT NULL,
	"description" text NOT NULL,
	"category" text DEFAULT '' NOT NULL,
	"amount_minor" bigint NOT NULL,
	"currency" char(3) NOT NULL,
	"purchased_on" date NOT NULL,
	"reason" text NOT NULL,
	"note" text DEFAULT '' NOT NULL,
	"receipt_file_id" uuid,
	"status" text DEFAULT 'flagged' NOT NULL,
	"review_note" text,
	"reviewed_by" uuid,
	"reviewed_at" timestamp with time zone,
	"suggested_supplier_id" uuid,
	"created_by" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "supply_purchase_orders" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"location_id" uuid NOT NULL,
	"supplier_id" uuid NOT NULL,
	"number" text NOT NULL,
	"status" text DEFAULT 'draft' NOT NULL,
	"currency" char(3) NOT NULL,
	"lines" jsonb NOT NULL,
	"total_minor" bigint NOT NULL,
	"requested_delivery_date" date,
	"expected_delivery_date" date,
	"notes" text DEFAULT '' NOT NULL,
	"approval" jsonb DEFAULT '{"required":false,"thresholdMinor":null}'::jsonb NOT NULL,
	"confirm_token_hash" text,
	"confirm_token_expires_at" timestamp with time zone,
	"sent_at" timestamp with time zone,
	"sent_to" text,
	"supplier_viewed_at" timestamp with time zone,
	"confirmed_at" timestamp with time zone,
	"supplier_note" text,
	"supplier_reference" text,
	"first_delivery_on" date,
	"received_at" timestamp with time zone,
	"closed_short" boolean DEFAULT false NOT NULL,
	"history" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"created_by" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "supply_rebate_claims" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"programme_id" uuid NOT NULL,
	"supplier_id" uuid NOT NULL,
	"number" text NOT NULL,
	"period_start" date NOT NULL,
	"period_end" date NOT NULL,
	"period_label" text NOT NULL,
	"currency" char(3) NOT NULL,
	"spend_minor" bigint NOT NULL,
	"units" integer NOT NULL,
	"tier_index" integer NOT NULL,
	"rate" integer NOT NULL,
	"amount_minor" bigint NOT NULL,
	"lines" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"status" text DEFAULT 'draft' NOT NULL,
	"submitted_at" timestamp with time zone,
	"received_at" timestamp with time zone,
	"received_minor" bigint,
	"fund_share_minor" bigint,
	"fund_entry_id" uuid,
	"note" text DEFAULT '' NOT NULL,
	"created_by" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "supply_rebate_programmes" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"supplier_id" uuid NOT NULL,
	"name" text NOT NULL,
	"basis" text NOT NULL,
	"measure" text DEFAULT 'spend' NOT NULL,
	"currency" char(3) NOT NULL,
	"tiers" jsonb NOT NULL,
	"period" text DEFAULT 'quarter' NOT NULL,
	"starts_on" date NOT NULL,
	"ends_on" date,
	"item_ids" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"fund_share_pct" integer DEFAULT 0 NOT NULL,
	"active" boolean DEFAULT true NOT NULL,
	"created_by" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "supply_receipts" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"purchase_order_id" uuid NOT NULL,
	"location_id" uuid NOT NULL,
	"received_on" date NOT NULL,
	"lines" jsonb NOT NULL,
	"issues" integer DEFAULT 0 NOT NULL,
	"note" text DEFAULT '' NOT NULL,
	"inventory" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"received_by" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "supply_settings" (
	"organization_id" uuid PRIMARY KEY NOT NULL,
	"approval_thresholds" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"updated_by" uuid,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "supply_supplier_certifications" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"supplier_id" uuid NOT NULL,
	"name" text NOT NULL,
	"required" boolean DEFAULT true NOT NULL,
	"compliance_document_id" uuid,
	"file_id" uuid,
	"issuer" text,
	"reference" text,
	"expires_on" date,
	"created_by" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "supply_suppliers" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"name" text NOT NULL,
	"code" text DEFAULT '' NOT NULL,
	"status" text DEFAULT 'active' NOT NULL,
	"countries" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"region_ids" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"contacts" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"order_email" text,
	"order_format" text DEFAULT 'pdf' NOT NULL,
	"currency" char(3) NOT NULL,
	"contract" jsonb,
	"notes" text DEFAULT '' NOT NULL,
	"created_by" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "audit_actions" ADD COLUMN "training_course_id" uuid;--> statement-breakpoint
ALTER TABLE "audit_actions" ADD COLUMN "training_assignment_id" uuid;--> statement-breakpoint
ALTER TABLE "audits" ADD COLUMN "schedule_id" uuid;--> statement-breakpoint
ALTER TABLE "audit_schedules" ADD CONSTRAINT "audit_schedules_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "audit_schedules" ADD CONSTRAINT "audit_schedules_template_id_audit_templates_id_fk" FOREIGN KEY ("template_id") REFERENCES "public"."audit_templates"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "self_check_runs" ADD CONSTRAINT "self_check_runs_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "self_check_runs" ADD CONSTRAINT "self_check_runs_schedule_id_self_check_schedules_id_fk" FOREIGN KEY ("schedule_id") REFERENCES "public"."self_check_schedules"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "self_check_runs" ADD CONSTRAINT "self_check_runs_location_id_locations_id_fk" FOREIGN KEY ("location_id") REFERENCES "public"."locations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "self_check_schedules" ADD CONSTRAINT "self_check_schedules_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "self_check_schedules" ADD CONSTRAINT "self_check_schedules_template_id_audit_templates_id_fk" FOREIGN KEY ("template_id") REFERENCES "public"."audit_templates"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "supply_catalogue_items" ADD CONSTRAINT "supply_catalogue_items_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "supply_catalogue_items" ADD CONSTRAINT "supply_catalogue_items_supplier_id_supply_suppliers_id_fk" FOREIGN KEY ("supplier_id") REFERENCES "public"."supply_suppliers"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "supply_off_contract" ADD CONSTRAINT "supply_off_contract_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "supply_off_contract" ADD CONSTRAINT "supply_off_contract_location_id_locations_id_fk" FOREIGN KEY ("location_id") REFERENCES "public"."locations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "supply_off_contract" ADD CONSTRAINT "supply_off_contract_receipt_file_id_ops_files_id_fk" FOREIGN KEY ("receipt_file_id") REFERENCES "public"."ops_files"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "supply_off_contract" ADD CONSTRAINT "supply_off_contract_suggested_supplier_id_supply_suppliers_id_fk" FOREIGN KEY ("suggested_supplier_id") REFERENCES "public"."supply_suppliers"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "supply_purchase_orders" ADD CONSTRAINT "supply_purchase_orders_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "supply_purchase_orders" ADD CONSTRAINT "supply_purchase_orders_location_id_locations_id_fk" FOREIGN KEY ("location_id") REFERENCES "public"."locations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "supply_purchase_orders" ADD CONSTRAINT "supply_purchase_orders_supplier_id_supply_suppliers_id_fk" FOREIGN KEY ("supplier_id") REFERENCES "public"."supply_suppliers"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "supply_rebate_claims" ADD CONSTRAINT "supply_rebate_claims_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "supply_rebate_claims" ADD CONSTRAINT "supply_rebate_claims_programme_id_supply_rebate_programmes_id_fk" FOREIGN KEY ("programme_id") REFERENCES "public"."supply_rebate_programmes"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "supply_rebate_claims" ADD CONSTRAINT "supply_rebate_claims_supplier_id_supply_suppliers_id_fk" FOREIGN KEY ("supplier_id") REFERENCES "public"."supply_suppliers"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "supply_rebate_programmes" ADD CONSTRAINT "supply_rebate_programmes_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "supply_rebate_programmes" ADD CONSTRAINT "supply_rebate_programmes_supplier_id_supply_suppliers_id_fk" FOREIGN KEY ("supplier_id") REFERENCES "public"."supply_suppliers"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "supply_receipts" ADD CONSTRAINT "supply_receipts_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "supply_receipts" ADD CONSTRAINT "supply_receipts_purchase_order_id_supply_purchase_orders_id_fk" FOREIGN KEY ("purchase_order_id") REFERENCES "public"."supply_purchase_orders"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "supply_receipts" ADD CONSTRAINT "supply_receipts_location_id_locations_id_fk" FOREIGN KEY ("location_id") REFERENCES "public"."locations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "supply_settings" ADD CONSTRAINT "supply_settings_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "supply_supplier_certifications" ADD CONSTRAINT "supply_supplier_certifications_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "supply_supplier_certifications" ADD CONSTRAINT "supply_supplier_certifications_supplier_id_supply_suppliers_id_fk" FOREIGN KEY ("supplier_id") REFERENCES "public"."supply_suppliers"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "supply_supplier_certifications" ADD CONSTRAINT "supply_supplier_certifications_compliance_document_id_compliance_documents_id_fk" FOREIGN KEY ("compliance_document_id") REFERENCES "public"."compliance_documents"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "supply_supplier_certifications" ADD CONSTRAINT "supply_supplier_certifications_file_id_ops_files_id_fk" FOREIGN KEY ("file_id") REFERENCES "public"."ops_files"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "supply_suppliers" ADD CONSTRAINT "supply_suppliers_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "audit_schedules_org_idx" ON "audit_schedules" USING btree ("organization_id","active");--> statement-breakpoint
CREATE UNIQUE INDEX "self_check_runs_uq" ON "self_check_runs" USING btree ("schedule_id","location_id","date");--> statement-breakpoint
CREATE INDEX "self_check_runs_loc_idx" ON "self_check_runs" USING btree ("organization_id","location_id","date");--> statement-breakpoint
CREATE INDEX "self_check_schedules_org_idx" ON "self_check_schedules" USING btree ("organization_id","active");--> statement-breakpoint
CREATE UNIQUE INDEX "supply_catalogue_sku_uq" ON "supply_catalogue_items" USING btree ("supplier_id","sku");--> statement-breakpoint
CREATE INDEX "supply_catalogue_org_idx" ON "supply_catalogue_items" USING btree ("organization_id","active");--> statement-breakpoint
CREATE INDEX "supply_off_contract_org_idx" ON "supply_off_contract" USING btree ("organization_id","status","purchased_on");--> statement-breakpoint
CREATE UNIQUE INDEX "supply_po_number_uq" ON "supply_purchase_orders" USING btree ("organization_id","number");--> statement-breakpoint
CREATE UNIQUE INDEX "supply_po_token_uq" ON "supply_purchase_orders" USING btree ("confirm_token_hash");--> statement-breakpoint
CREATE INDEX "supply_po_org_status_idx" ON "supply_purchase_orders" USING btree ("organization_id","status");--> statement-breakpoint
CREATE INDEX "supply_po_loc_idx" ON "supply_purchase_orders" USING btree ("location_id");--> statement-breakpoint
CREATE INDEX "supply_po_supplier_idx" ON "supply_purchase_orders" USING btree ("supplier_id","created_at");--> statement-breakpoint
CREATE UNIQUE INDEX "supply_rebate_claims_number_uq" ON "supply_rebate_claims" USING btree ("organization_id","number");--> statement-breakpoint
CREATE UNIQUE INDEX "supply_rebate_claims_period_uq" ON "supply_rebate_claims" USING btree ("programme_id","period_start") WHERE "supply_rebate_claims"."status" <> 'void';--> statement-breakpoint
CREATE INDEX "supply_rebate_programmes_org_idx" ON "supply_rebate_programmes" USING btree ("organization_id","active");--> statement-breakpoint
CREATE INDEX "supply_receipts_po_idx" ON "supply_receipts" USING btree ("purchase_order_id");--> statement-breakpoint
CREATE INDEX "supply_supplier_certs_supplier_idx" ON "supply_supplier_certifications" USING btree ("supplier_id");--> statement-breakpoint
CREATE INDEX "supply_suppliers_org_idx" ON "supply_suppliers" USING btree ("organization_id","status");--> statement-breakpoint
CREATE UNIQUE INDEX "audits_schedule_due_uq" ON "audits" USING btree ("schedule_id","location_id","due_date");