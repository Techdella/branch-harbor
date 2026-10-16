CREATE TABLE "benchmark_cohorts" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"period" text NOT NULL,
	"industry" text NOT NULL,
	"region" text NOT NULL,
	"metric" text NOT NULL,
	"currency" text DEFAULT '' NOT NULL,
	"cohort_size" integer NOT NULL,
	"p10" real NOT NULL,
	"p25" real NOT NULL,
	"p50" real NOT NULL,
	"p75" real NOT NULL,
	"p90" real NOT NULL,
	"computed_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "benchmark_contributions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"period" text NOT NULL,
	"industry" text NOT NULL,
	"region" text NOT NULL,
	"metric" text NOT NULL,
	"currency" text DEFAULT '' NOT NULL,
	"value" real NOT NULL,
	"locations" integer NOT NULL,
	"computed_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "bulk_launch_items" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"launch_id" uuid NOT NULL,
	"row_number" integer NOT NULL,
	"name" text NOT NULL,
	"code" text NOT NULL,
	"input" jsonb NOT NULL,
	"status" text DEFAULT 'queued' NOT NULL,
	"steps" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"location_id" uuid,
	"website_id" uuid,
	"page_id" uuid,
	"invitations" integer DEFAULT 0 NOT NULL,
	"error" text,
	"started_at" timestamp with time zone,
	"finished_at" timestamp with time zone,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "bulk_launches" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"name" text NOT NULL,
	"template_id" uuid,
	"site_mode" text DEFAULT 'draft' NOT NULL,
	"location_status" text DEFAULT 'opening_soon' NOT NULL,
	"invite_staff" boolean DEFAULT true NOT NULL,
	"import_batch_id" uuid,
	"status" text DEFAULT 'queued' NOT NULL,
	"total" integer DEFAULT 0 NOT NULL,
	"done" integer DEFAULT 0 NOT NULL,
	"failed" integer DEFAULT 0 NOT NULL,
	"created_by" uuid NOT NULL,
	"started_at" timestamp with time zone,
	"finished_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "daily_sales" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"location_id" uuid NOT NULL,
	"connection_id" uuid,
	"source" text NOT NULL,
	"business_date" date NOT NULL,
	"channel" text DEFAULT 'in_store' NOT NULL,
	"currency" char(3) NOT NULL,
	"gross_minor" bigint DEFAULT 0 NOT NULL,
	"net_minor" bigint DEFAULT 0 NOT NULL,
	"tax_minor" bigint DEFAULT 0 NOT NULL,
	"refunds_minor" bigint DEFAULT 0 NOT NULL,
	"tips_minor" bigint DEFAULT 0 NOT NULL,
	"discounts_minor" bigint DEFAULT 0 NOT NULL,
	"order_count" integer DEFAULT 0 NOT NULL,
	"sandbox" boolean DEFAULT false NOT NULL,
	"content_hash" text NOT NULL,
	"synced_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "import_batch_records" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"batch_id" uuid NOT NULL,
	"row_number" integer NOT NULL,
	"record_type" text NOT NULL,
	"record_id" uuid NOT NULL,
	"action" text NOT NULL,
	"previous" jsonb,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "import_batches" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"entity" text NOT NULL,
	"template_key" text,
	"filename" text NOT NULL,
	"format" text NOT NULL,
	"status" text DEFAULT 'uploaded' NOT NULL,
	"headers" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"rows" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"mapping" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"options" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"dry_run" boolean DEFAULT false NOT NULL,
	"total_rows" integer DEFAULT 0 NOT NULL,
	"valid_rows" integer DEFAULT 0 NOT NULL,
	"error_rows" integer DEFAULT 0 NOT NULL,
	"processed_rows" integer DEFAULT 0 NOT NULL,
	"created_count" integer DEFAULT 0 NOT NULL,
	"updated_count" integer DEFAULT 0 NOT NULL,
	"skipped_count" integer DEFAULT 0 NOT NULL,
	"errors" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"error" text,
	"created_by" uuid NOT NULL,
	"started_at" timestamp with time zone,
	"finished_at" timestamp with time zone,
	"undo_until" timestamp with time zone,
	"rolled_back_at" timestamp with time zone,
	"rolled_back_by" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "location_sales_sources" (
	"location_id" uuid PRIMARY KEY NOT NULL,
	"organization_id" uuid NOT NULL,
	"source" text NOT NULL,
	"connection_id" uuid,
	"variance_threshold_bps" integer DEFAULT 500 NOT NULL,
	"note" text,
	"set_by" uuid,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "sales_connections" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"location_id" uuid NOT NULL,
	"provider" text NOT NULL,
	"status" text DEFAULT 'pending_authorisation' NOT NULL,
	"mode" text DEFAULT 'sandbox' NOT NULL,
	"config" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"credentials_encrypted" text,
	"oauth_state_hash" text,
	"oauth_state_expires_at" timestamp with time zone,
	"external_account_name" text,
	"last_sync_at" timestamp with time zone,
	"last_sync_status" text,
	"last_error" text,
	"last_error_at" timestamp with time zone,
	"created_by" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "sales_sync_runs" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"connection_id" uuid NOT NULL,
	"trigger" text NOT NULL,
	"status" text DEFAULT 'queued' NOT NULL,
	"from_date" date NOT NULL,
	"to_date" date NOT NULL,
	"days_written" integer DEFAULT 0 NOT NULL,
	"days_unchanged" integer DEFAULT 0 NOT NULL,
	"orders_seen" integer DEFAULT 0 NOT NULL,
	"sandbox" boolean DEFAULT false NOT NULL,
	"error" text,
	"requested_by" uuid,
	"started_at" timestamp with time zone,
	"finished_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "benchmark_contributions" ADD CONSTRAINT "benchmark_contributions_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "bulk_launch_items" ADD CONSTRAINT "bulk_launch_items_launch_id_bulk_launches_id_fk" FOREIGN KEY ("launch_id") REFERENCES "public"."bulk_launches"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "bulk_launches" ADD CONSTRAINT "bulk_launches_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "daily_sales" ADD CONSTRAINT "daily_sales_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "daily_sales" ADD CONSTRAINT "daily_sales_location_id_locations_id_fk" FOREIGN KEY ("location_id") REFERENCES "public"."locations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "daily_sales" ADD CONSTRAINT "daily_sales_connection_id_sales_connections_id_fk" FOREIGN KEY ("connection_id") REFERENCES "public"."sales_connections"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "import_batch_records" ADD CONSTRAINT "import_batch_records_batch_id_import_batches_id_fk" FOREIGN KEY ("batch_id") REFERENCES "public"."import_batches"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "import_batches" ADD CONSTRAINT "import_batches_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "location_sales_sources" ADD CONSTRAINT "location_sales_sources_location_id_locations_id_fk" FOREIGN KEY ("location_id") REFERENCES "public"."locations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "location_sales_sources" ADD CONSTRAINT "location_sales_sources_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "location_sales_sources" ADD CONSTRAINT "location_sales_sources_connection_id_sales_connections_id_fk" FOREIGN KEY ("connection_id") REFERENCES "public"."sales_connections"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sales_connections" ADD CONSTRAINT "sales_connections_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sales_connections" ADD CONSTRAINT "sales_connections_location_id_locations_id_fk" FOREIGN KEY ("location_id") REFERENCES "public"."locations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sales_sync_runs" ADD CONSTRAINT "sales_sync_runs_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sales_sync_runs" ADD CONSTRAINT "sales_sync_runs_connection_id_sales_connections_id_fk" FOREIGN KEY ("connection_id") REFERENCES "public"."sales_connections"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "benchmark_cohorts_uq" ON "benchmark_cohorts" USING btree ("period","industry","region","metric","currency");--> statement-breakpoint
CREATE UNIQUE INDEX "benchmark_contrib_uq" ON "benchmark_contributions" USING btree ("organization_id","period","metric","currency");--> statement-breakpoint
CREATE INDEX "bulk_launch_items_launch_idx" ON "bulk_launch_items" USING btree ("launch_id","row_number");--> statement-breakpoint
CREATE INDEX "bulk_launches_org_idx" ON "bulk_launches" USING btree ("organization_id","created_at");--> statement-breakpoint
CREATE UNIQUE INDEX "daily_sales_key_uq" ON "daily_sales" USING btree ("location_id","source","business_date","channel","currency");--> statement-breakpoint
CREATE INDEX "daily_sales_org_date_idx" ON "daily_sales" USING btree ("organization_id","business_date");--> statement-breakpoint
CREATE INDEX "import_batch_records_batch_idx" ON "import_batch_records" USING btree ("batch_id");--> statement-breakpoint
CREATE INDEX "import_batches_org_idx" ON "import_batches" USING btree ("organization_id","created_at");--> statement-breakpoint
CREATE UNIQUE INDEX "sales_connections_loc_provider_uq" ON "sales_connections" USING btree ("location_id","provider");--> statement-breakpoint
CREATE INDEX "sales_connections_org_idx" ON "sales_connections" USING btree ("organization_id");--> statement-breakpoint
CREATE INDEX "sales_sync_runs_conn_idx" ON "sales_sync_runs" USING btree ("connection_id","created_at");