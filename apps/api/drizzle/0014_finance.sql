CREATE TABLE "external_sales_reports" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"location_id" uuid NOT NULL,
	"frequency" text NOT NULL,
	"period_start" date NOT NULL,
	"currency" char(3) NOT NULL,
	"gross_minor" bigint NOT NULL,
	"refunds_minor" bigint DEFAULT 0 NOT NULL,
	"tax_minor" bigint DEFAULT 0 NOT NULL,
	"note" text,
	"evidence_document_id" uuid NOT NULL,
	"status" text DEFAULT 'submitted' NOT NULL,
	"submitted_by" uuid NOT NULL,
	"reviewed_by" uuid,
	"reviewed_at" timestamp with time zone,
	"review_note" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "finance_balance_transactions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"payout_id" uuid NOT NULL,
	"location_id" uuid NOT NULL,
	"external_id" text NOT NULL,
	"type" text NOT NULL,
	"source_id" text,
	"payment_id" uuid,
	"currency" char(3) NOT NULL,
	"amount_minor" bigint NOT NULL,
	"fee_minor" bigint DEFAULT 0 NOT NULL,
	"net_minor" bigint NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "finance_collection_attempts" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"invoice_id" uuid NOT NULL,
	"attempt" integer NOT NULL,
	"method" text NOT NULL,
	"idempotency_key" text NOT NULL,
	"payment_id" uuid,
	"payment_intent_id" text,
	"amount_minor" bigint NOT NULL,
	"currency" char(3) NOT NULL,
	"status" text NOT NULL,
	"failure_code" text,
	"failure_message" text,
	"reference" text,
	"created_by" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "finance_documents" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"kind" text NOT NULL,
	"location_id" uuid,
	"filename" text NOT NULL,
	"content_type" text NOT NULL,
	"size_bytes" integer NOT NULL,
	"data_base64" text NOT NULL,
	"sha256" text NOT NULL,
	"uploaded_by" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "finance_dunning_events" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"invoice_id" uuid NOT NULL,
	"action" text NOT NULL,
	"day_offset" integer NOT NULL,
	"note" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "finance_invoices" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"statement_id" uuid NOT NULL,
	"location_id" uuid NOT NULL,
	"owner_group_id" uuid,
	"number" text NOT NULL,
	"seq" integer NOT NULL,
	"currency" char(3) NOT NULL,
	"issue_date" date NOT NULL,
	"due_date" date NOT NULL,
	"lines" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"taxes" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"subtotal_minor" bigint NOT NULL,
	"tax_minor" bigint DEFAULT 0 NOT NULL,
	"late_fee_minor" bigint DEFAULT 0 NOT NULL,
	"total_minor" bigint NOT NULL,
	"paid_minor" bigint DEFAULT 0 NOT NULL,
	"marketing_fund_minor" bigint DEFAULT 0 NOT NULL,
	"status" text DEFAULT 'open' NOT NULL,
	"dunning_stage" text DEFAULT 'none' NOT NULL,
	"paid_at" timestamp with time zone,
	"late_fee_applied_at" timestamp with time zone,
	"created_by" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "finance_payment_methods" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"owner_group_id" uuid NOT NULL,
	"currency" char(3) NOT NULL,
	"collection_account_id" text,
	"stripe_customer_id" text NOT NULL,
	"setup_intent_id" text,
	"payment_method_id" text,
	"method_type" text NOT NULL,
	"display" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"mandate_text" text NOT NULL,
	"mandate_accepted_at" timestamp with time zone NOT NULL,
	"mandate_accepted_by" uuid NOT NULL,
	"mandate_ip" text,
	"status" text DEFAULT 'pending' NOT NULL,
	"sandbox" boolean DEFAULT false NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "finance_payouts" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"location_id" uuid NOT NULL,
	"connected_account_id" text NOT NULL,
	"external_id" text NOT NULL,
	"currency" char(3) NOT NULL,
	"amount_minor" bigint NOT NULL,
	"gross_minor" bigint DEFAULT 0 NOT NULL,
	"fees_minor" bigint DEFAULT 0 NOT NULL,
	"refunds_minor" bigint DEFAULT 0 NOT NULL,
	"chargebacks_minor" bigint DEFAULT 0 NOT NULL,
	"other_minor" bigint DEFAULT 0 NOT NULL,
	"status" text NOT NULL,
	"arrival_date" date,
	"sandbox" boolean DEFAULT false NOT NULL,
	"synced_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "finance_settings" (
	"organization_id" uuid PRIMARY KEY NOT NULL,
	"period_frequency" text DEFAULT 'monthly' NOT NULL,
	"week_starts_on" integer DEFAULT 1 NOT NULL,
	"invoice_prefix" text DEFAULT 'INV' NOT NULL,
	"next_invoice_seq" integer DEFAULT 1 NOT NULL,
	"payment_terms_days" integer DEFAULT 10 NOT NULL,
	"tax_lines" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"dunning" jsonb DEFAULT '{"retryDays":[3,7],"reminderDaysBefore":3,"finalNoticeAfterDays":14}'::jsonb NOT NULL,
	"auto_collect" boolean DEFAULT true NOT NULL,
	"collection_account_id" text,
	"issuer_details" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "marketing_fund_campaigns" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"name" text NOT NULL,
	"description" text,
	"status" text DEFAULT 'active' NOT NULL,
	"created_by" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "marketing_fund_entries" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"kind" text NOT NULL,
	"currency" char(3) NOT NULL,
	"amount_minor" bigint NOT NULL,
	"occurred_on" date NOT NULL,
	"description" text NOT NULL,
	"location_id" uuid,
	"owner_group_id" uuid,
	"invoice_id" uuid,
	"campaign_id" uuid,
	"receipt_document_id" uuid,
	"vendor" text,
	"created_by" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "royalty_disputes" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"statement_id" uuid NOT NULL,
	"line_id" uuid,
	"raised_by" uuid NOT NULL,
	"reason" text NOT NULL,
	"status" text DEFAULT 'open' NOT NULL,
	"resolution" text,
	"adjustment_minor" bigint,
	"resolved_by" uuid,
	"resolved_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "royalty_periods" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"frequency" text NOT NULL,
	"start_date" date NOT NULL,
	"end_date" date NOT NULL,
	"status" text DEFAULT 'closed' NOT NULL,
	"closed_at" timestamp with time zone,
	"closed_by" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "royalty_statement_lines" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"statement_id" uuid NOT NULL,
	"kind" text NOT NULL,
	"stream" text,
	"description" text NOT NULL,
	"basis_minor" bigint,
	"rate_bps" integer,
	"amount_minor" bigint NOT NULL,
	"charge" boolean DEFAULT false NOT NULL,
	"manual" boolean DEFAULT false NOT NULL,
	"dispute_id" uuid,
	"created_by" uuid,
	"sort_order" integer DEFAULT 0 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "royalty_statements" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"period_id" uuid NOT NULL,
	"location_id" uuid NOT NULL,
	"owner_group_id" uuid,
	"currency" char(3) NOT NULL,
	"time_zone" text NOT NULL,
	"period_start_at" timestamp with time zone NOT NULL,
	"period_end_at" timestamp with time zone NOT NULL,
	"status" text DEFAULT 'draft' NOT NULL,
	"gross_sales_minor" bigint DEFAULT 0 NOT NULL,
	"refunds_minor" bigint DEFAULT 0 NOT NULL,
	"tax_minor" bigint DEFAULT 0 NOT NULL,
	"tips_minor" bigint DEFAULT 0 NOT NULL,
	"external_sales_minor" bigint DEFAULT 0 NOT NULL,
	"basis_minor" bigint DEFAULT 0 NOT NULL,
	"royalty_minor" bigint DEFAULT 0 NOT NULL,
	"marketing_fund_minor" bigint DEFAULT 0 NOT NULL,
	"technology_fee_minor" bigint DEFAULT 0 NOT NULL,
	"adjustments_minor" bigint DEFAULT 0 NOT NULL,
	"total_minor" bigint DEFAULT 0 NOT NULL,
	"terms" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"terms_source" text,
	"warnings" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"computed_at" timestamp with time zone DEFAULT now() NOT NULL,
	"approved_at" timestamp with time zone,
	"approved_by" uuid,
	"invoice_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "royalty_terms" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"owner_group_id" uuid,
	"currency" char(3) NOT NULL,
	"effective_from" date NOT NULL,
	"effective_to" date,
	"royalty_bps" integer NOT NULL,
	"tiers" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"tier_mode" text DEFAULT 'marginal' NOT NULL,
	"minimum_royalty_minor" bigint DEFAULT 0 NOT NULL,
	"marketing_fund_bps" integer DEFAULT 0 NOT NULL,
	"technology_fee_minor" bigint DEFAULT 0 NOT NULL,
	"basis" jsonb NOT NULL,
	"late_fee" jsonb DEFAULT '{"kind":"none","graceDays":0}'::jsonb NOT NULL,
	"notes" text,
	"created_by" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "royalty_terms_bps_ck" CHECK ("royalty_terms"."royalty_bps" >= 0 and "royalty_terms"."royalty_bps" <= 10000 and "royalty_terms"."marketing_fund_bps" >= 0 and "royalty_terms"."marketing_fund_bps" <= 10000)
);
--> statement-breakpoint
ALTER TABLE "external_sales_reports" ADD CONSTRAINT "external_sales_reports_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "external_sales_reports" ADD CONSTRAINT "external_sales_reports_location_id_locations_id_fk" FOREIGN KEY ("location_id") REFERENCES "public"."locations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "finance_balance_transactions" ADD CONSTRAINT "finance_balance_transactions_payout_id_finance_payouts_id_fk" FOREIGN KEY ("payout_id") REFERENCES "public"."finance_payouts"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "finance_collection_attempts" ADD CONSTRAINT "finance_collection_attempts_invoice_id_finance_invoices_id_fk" FOREIGN KEY ("invoice_id") REFERENCES "public"."finance_invoices"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "finance_documents" ADD CONSTRAINT "finance_documents_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "finance_dunning_events" ADD CONSTRAINT "finance_dunning_events_invoice_id_finance_invoices_id_fk" FOREIGN KEY ("invoice_id") REFERENCES "public"."finance_invoices"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "finance_invoices" ADD CONSTRAINT "finance_invoices_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "finance_invoices" ADD CONSTRAINT "finance_invoices_statement_id_royalty_statements_id_fk" FOREIGN KEY ("statement_id") REFERENCES "public"."royalty_statements"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "finance_payment_methods" ADD CONSTRAINT "finance_payment_methods_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "finance_payment_methods" ADD CONSTRAINT "finance_payment_methods_owner_group_id_owner_groups_id_fk" FOREIGN KEY ("owner_group_id") REFERENCES "public"."owner_groups"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "finance_payouts" ADD CONSTRAINT "finance_payouts_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "finance_settings" ADD CONSTRAINT "finance_settings_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "marketing_fund_campaigns" ADD CONSTRAINT "marketing_fund_campaigns_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "marketing_fund_entries" ADD CONSTRAINT "marketing_fund_entries_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "royalty_disputes" ADD CONSTRAINT "royalty_disputes_statement_id_royalty_statements_id_fk" FOREIGN KEY ("statement_id") REFERENCES "public"."royalty_statements"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "royalty_periods" ADD CONSTRAINT "royalty_periods_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "royalty_statement_lines" ADD CONSTRAINT "royalty_statement_lines_statement_id_royalty_statements_id_fk" FOREIGN KEY ("statement_id") REFERENCES "public"."royalty_statements"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "royalty_statements" ADD CONSTRAINT "royalty_statements_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "royalty_statements" ADD CONSTRAINT "royalty_statements_period_id_royalty_periods_id_fk" FOREIGN KEY ("period_id") REFERENCES "public"."royalty_periods"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "royalty_statements" ADD CONSTRAINT "royalty_statements_location_id_locations_id_fk" FOREIGN KEY ("location_id") REFERENCES "public"."locations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "royalty_terms" ADD CONSTRAINT "royalty_terms_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "royalty_terms" ADD CONSTRAINT "royalty_terms_owner_group_id_owner_groups_id_fk" FOREIGN KEY ("owner_group_id") REFERENCES "public"."owner_groups"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "external_sales_loc_period_uq" ON "external_sales_reports" USING btree ("location_id","frequency","period_start");--> statement-breakpoint
CREATE UNIQUE INDEX "finance_balance_txn_uq" ON "finance_balance_transactions" USING btree ("payout_id","external_id");--> statement-breakpoint
CREATE INDEX "finance_balance_txn_payment_idx" ON "finance_balance_transactions" USING btree ("payment_id");--> statement-breakpoint
CREATE UNIQUE INDEX "finance_collection_attempts_idem_uq" ON "finance_collection_attempts" USING btree ("idempotency_key");--> statement-breakpoint
CREATE INDEX "finance_collection_attempts_invoice_idx" ON "finance_collection_attempts" USING btree ("invoice_id");--> statement-breakpoint
CREATE UNIQUE INDEX "finance_dunning_events_uq" ON "finance_dunning_events" USING btree ("invoice_id","action","day_offset");--> statement-breakpoint
CREATE UNIQUE INDEX "finance_invoices_org_number_uq" ON "finance_invoices" USING btree ("organization_id","number");--> statement-breakpoint
CREATE UNIQUE INDEX "finance_invoices_statement_uq" ON "finance_invoices" USING btree ("statement_id");--> statement-breakpoint
CREATE INDEX "finance_invoices_org_status_idx" ON "finance_invoices" USING btree ("organization_id","status");--> statement-breakpoint
CREATE INDEX "finance_payment_methods_group_idx" ON "finance_payment_methods" USING btree ("owner_group_id","currency","status");--> statement-breakpoint
CREATE UNIQUE INDEX "finance_payouts_ext_uq" ON "finance_payouts" USING btree ("connected_account_id","external_id");--> statement-breakpoint
CREATE INDEX "finance_payouts_loc_idx" ON "finance_payouts" USING btree ("organization_id","location_id");--> statement-breakpoint
CREATE INDEX "marketing_fund_entries_org_idx" ON "marketing_fund_entries" USING btree ("organization_id","currency","occurred_on");--> statement-breakpoint
CREATE UNIQUE INDEX "marketing_fund_entries_invoice_uq" ON "marketing_fund_entries" USING btree ("invoice_id") WHERE "marketing_fund_entries"."kind" = 'contribution';--> statement-breakpoint
CREATE INDEX "royalty_disputes_stmt_idx" ON "royalty_disputes" USING btree ("statement_id");--> statement-breakpoint
CREATE UNIQUE INDEX "royalty_periods_uq" ON "royalty_periods" USING btree ("organization_id","frequency","start_date");--> statement-breakpoint
CREATE INDEX "royalty_statement_lines_stmt_idx" ON "royalty_statement_lines" USING btree ("statement_id");--> statement-breakpoint
CREATE UNIQUE INDEX "royalty_statements_period_loc_uq" ON "royalty_statements" USING btree ("period_id","location_id");--> statement-breakpoint
CREATE INDEX "royalty_statements_org_status_idx" ON "royalty_statements" USING btree ("organization_id","status");--> statement-breakpoint
CREATE INDEX "royalty_terms_lookup_idx" ON "royalty_terms" USING btree ("organization_id","owner_group_id","currency","effective_from");