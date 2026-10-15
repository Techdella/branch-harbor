CREATE TABLE "franchisee_statements" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"period_id" uuid NOT NULL,
	"owner_group_id" uuid NOT NULL,
	"currency" char(3) NOT NULL,
	"number" text NOT NULL,
	"lines" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"gross_sales_minor" bigint DEFAULT 0 NOT NULL,
	"royalty_minor" bigint DEFAULT 0 NOT NULL,
	"marketing_fund_minor" bigint DEFAULT 0 NOT NULL,
	"adjustments_minor" bigint DEFAULT 0 NOT NULL,
	"fees_minor" bigint DEFAULT 0 NOT NULL,
	"tax_minor" bigint DEFAULT 0 NOT NULL,
	"total_minor" bigint DEFAULT 0 NOT NULL,
	"collected_minor" bigint DEFAULT 0 NOT NULL,
	"collection_fee_minor" bigint DEFAULT 0 NOT NULL,
	"payment_method" jsonb,
	"issued_at" timestamp with time zone DEFAULT now() NOT NULL,
	"issued_by" uuid,
	"emailed_at" timestamp with time zone,
	"emailed_to" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "review_connections" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"provider" text DEFAULT 'google' NOT NULL,
	"owner_kind" text NOT NULL,
	"location_id" uuid,
	"account_name" text,
	"account_email" text,
	"mode" text DEFAULT 'sandbox' NOT NULL,
	"status" text DEFAULT 'connected' NOT NULL,
	"credentials_encrypted" text,
	"last_sync_at" timestamp with time zone,
	"last_error" text,
	"connected_by" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "review_listings" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"connection_id" uuid NOT NULL,
	"location_id" uuid NOT NULL,
	"provider" text DEFAULT 'google' NOT NULL,
	"external_location_name" text NOT NULL,
	"title" text,
	"review_url" text,
	"last_fetched_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "review_requests" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"location_id" uuid NOT NULL,
	"customer_id" uuid,
	"contact" jsonb NOT NULL,
	"channel" text NOT NULL,
	"source" text NOT NULL,
	"source_id" uuid,
	"trigger_key" text NOT NULL,
	"status" text DEFAULT 'scheduled' NOT NULL,
	"skip_reason" text,
	"error" text,
	"token_hash" text NOT NULL,
	"locale" text,
	"send_at" timestamp with time zone NOT NULL,
	"sent_at" timestamp with time zone,
	"opened_at" timestamp with time zone,
	"completed_at" timestamp with time zone,
	"automation_run_id" uuid,
	"created_by" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "review_settings" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"location_id" uuid,
	"settings" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"enabled_at" timestamp with time zone,
	"updated_by" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "reviews" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"location_id" uuid NOT NULL,
	"source" text NOT NULL,
	"external_id" text,
	"request_id" uuid,
	"customer_id" uuid,
	"author_name" text,
	"rating" integer NOT NULL,
	"comment" text,
	"language" text,
	"reviewed_at" timestamp with time zone NOT NULL,
	"conversation_id" uuid,
	"links_opened" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"reply_status" text DEFAULT 'none' NOT NULL,
	"reply_text" text,
	"reply_ai_suggested" boolean DEFAULT false NOT NULL,
	"reply_by" uuid,
	"reply_submitted_at" timestamp with time zone,
	"reply_decided_by" uuid,
	"reply_decision_note" text,
	"replied_at" timestamp with time zone,
	"reply_error" text,
	"reply_external" boolean DEFAULT false NOT NULL,
	"alerted_at" timestamp with time zone,
	"sandbox" boolean DEFAULT false NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "reviews_rating_ck" CHECK ("reviews"."rating" between 1 and 5)
);
--> statement-breakpoint
ALTER TABLE "finance_collection_attempts" ADD COLUMN "method_type" text;--> statement-breakpoint
ALTER TABLE "finance_collection_attempts" ADD COLUMN "platform_fee_minor" bigint DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "finance_collection_attempts" ADD COLUMN "fee_month" text;--> statement-breakpoint
ALTER TABLE "finance_collection_attempts" ADD COLUMN "settled_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "finance_collection_attempts" ADD COLUMN "failure_notified_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "finance_payment_methods" ADD COLUMN "mandate_id" text;--> statement-breakpoint
ALTER TABLE "finance_payment_methods" ADD COLUMN "verification_url" text;--> statement-breakpoint
ALTER TABLE "finance_payment_methods" ADD COLUMN "mandate_locale" text;--> statement-breakpoint
ALTER TABLE "finance_payment_methods" ADD COLUMN "failure_reason" text;--> statement-breakpoint
ALTER TABLE "franchisee_statements" ADD CONSTRAINT "franchisee_statements_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "franchisee_statements" ADD CONSTRAINT "franchisee_statements_period_id_royalty_periods_id_fk" FOREIGN KEY ("period_id") REFERENCES "public"."royalty_periods"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "franchisee_statements" ADD CONSTRAINT "franchisee_statements_owner_group_id_owner_groups_id_fk" FOREIGN KEY ("owner_group_id") REFERENCES "public"."owner_groups"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "review_connections" ADD CONSTRAINT "review_connections_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "review_connections" ADD CONSTRAINT "review_connections_location_id_locations_id_fk" FOREIGN KEY ("location_id") REFERENCES "public"."locations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "review_listings" ADD CONSTRAINT "review_listings_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "review_listings" ADD CONSTRAINT "review_listings_connection_id_review_connections_id_fk" FOREIGN KEY ("connection_id") REFERENCES "public"."review_connections"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "review_listings" ADD CONSTRAINT "review_listings_location_id_locations_id_fk" FOREIGN KEY ("location_id") REFERENCES "public"."locations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "review_requests" ADD CONSTRAINT "review_requests_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "review_requests" ADD CONSTRAINT "review_requests_location_id_locations_id_fk" FOREIGN KEY ("location_id") REFERENCES "public"."locations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "review_settings" ADD CONSTRAINT "review_settings_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "review_settings" ADD CONSTRAINT "review_settings_location_id_locations_id_fk" FOREIGN KEY ("location_id") REFERENCES "public"."locations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "reviews" ADD CONSTRAINT "reviews_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "reviews" ADD CONSTRAINT "reviews_location_id_locations_id_fk" FOREIGN KEY ("location_id") REFERENCES "public"."locations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "franchisee_statements_uq" ON "franchisee_statements" USING btree ("period_id","owner_group_id","currency");--> statement-breakpoint
CREATE INDEX "franchisee_statements_group_idx" ON "franchisee_statements" USING btree ("organization_id","owner_group_id");--> statement-breakpoint
CREATE INDEX "review_connections_org_idx" ON "review_connections" USING btree ("organization_id");--> statement-breakpoint
CREATE UNIQUE INDEX "review_listings_loc_uq" ON "review_listings" USING btree ("location_id","provider");--> statement-breakpoint
CREATE UNIQUE INDEX "review_requests_trigger_uq" ON "review_requests" USING btree ("organization_id","trigger_key");--> statement-breakpoint
CREATE UNIQUE INDEX "review_requests_token_uq" ON "review_requests" USING btree ("token_hash");--> statement-breakpoint
CREATE INDEX "review_requests_due_idx" ON "review_requests" USING btree ("status","send_at");--> statement-breakpoint
CREATE INDEX "review_requests_customer_idx" ON "review_requests" USING btree ("organization_id","customer_id","sent_at");--> statement-breakpoint
CREATE INDEX "review_requests_loc_idx" ON "review_requests" USING btree ("organization_id","location_id","created_at");--> statement-breakpoint
CREATE UNIQUE INDEX "review_settings_org_uq" ON "review_settings" USING btree ("organization_id") WHERE "review_settings"."location_id" is null;--> statement-breakpoint
CREATE UNIQUE INDEX "review_settings_loc_uq" ON "review_settings" USING btree ("location_id") WHERE "review_settings"."location_id" is not null;--> statement-breakpoint
CREATE UNIQUE INDEX "reviews_external_uq" ON "reviews" USING btree ("organization_id","source","external_id") WHERE "reviews"."external_id" is not null;--> statement-breakpoint
CREATE UNIQUE INDEX "reviews_request_uq" ON "reviews" USING btree ("request_id") WHERE "reviews"."request_id" is not null;--> statement-breakpoint
CREATE INDEX "reviews_loc_time_idx" ON "reviews" USING btree ("organization_id","location_id","reviewed_at");