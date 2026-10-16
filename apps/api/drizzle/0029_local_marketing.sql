CREATE TABLE "coop_allowances" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"location_id" uuid,
	"period" text DEFAULT 'quarter' NOT NULL,
	"basis" text DEFAULT 'fund_percent' NOT NULL,
	"percent_bps" integer DEFAULT 0 NOT NULL,
	"fixed_minor" bigint DEFAULT 0 NOT NULL,
	"match_ratio_bps" integer DEFAULT 5000 NOT NULL,
	"active" boolean DEFAULT true NOT NULL,
	"updated_by" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "coop_claims" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"request_id" uuid NOT NULL,
	"location_id" uuid NOT NULL,
	"spent_minor" bigint NOT NULL,
	"currency" char(3) NOT NULL,
	"invoice_document_id" uuid NOT NULL,
	"proof_document_ids" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"proof_notes" text DEFAULT '' NOT NULL,
	"performance" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"reimbursable_minor" bigint,
	"status" text DEFAULT 'submitted' NOT NULL,
	"decided_by" uuid,
	"decided_at" timestamp with time zone,
	"decision_note" text,
	"fund_entry_id" uuid,
	"payout_method" text,
	"payout_reference" text,
	"paid_at" timestamp with time zone,
	"paid_by" uuid,
	"submitted_by" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "coop_requests" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"location_id" uuid NOT NULL,
	"kind" text NOT NULL,
	"title" text NOT NULL,
	"description" text DEFAULT '' NOT NULL,
	"vendor" text,
	"starts_on" date NOT NULL,
	"ends_on" date,
	"budget_minor" bigint NOT NULL,
	"currency" char(3) NOT NULL,
	"period_key" text NOT NULL,
	"creative" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"status" text DEFAULT 'submitted' NOT NULL,
	"checklist" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"approved_minor" bigint,
	"decided_by" uuid,
	"decided_at" timestamp with time zone,
	"decision_note" text,
	"requested_by" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "holiday_hour_sets" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"name" text NOT NULL,
	"entries" jsonb NOT NULL,
	"location_ids" jsonb NOT NULL,
	"skipped_location_ids" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"created_by" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "listing_change_requests" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"location_id" uuid NOT NULL,
	"changes" jsonb NOT NULL,
	"status" text DEFAULT 'pending' NOT NULL,
	"note" text,
	"requested_by" uuid NOT NULL,
	"decided_by" uuid,
	"decision_note" text,
	"decided_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "listing_connections" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"provider" text NOT NULL,
	"mode" text DEFAULT 'sandbox' NOT NULL,
	"status" text DEFAULT 'connected' NOT NULL,
	"account_name" text,
	"credentials_encrypted" text,
	"last_error" text,
	"connected_by" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "listing_drifts" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"location_id" uuid NOT NULL,
	"provider" text NOT NULL,
	"field" text NOT NULL,
	"our_value" jsonb,
	"their_value" jsonb,
	"status" text DEFAULT 'open' NOT NULL,
	"detected_at" timestamp with time zone DEFAULT now() NOT NULL,
	"alerted_at" timestamp with time zone,
	"resolved_by" uuid,
	"resolved_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "listing_profiles" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"location_id" uuid NOT NULL,
	"primary_category" text,
	"additional_categories" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"description" text,
	"photos" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"website_url" text,
	"booking_url" text,
	"attributes" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"updated_by" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "listing_syncs" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"location_id" uuid NOT NULL,
	"provider" text NOT NULL,
	"connection_id" uuid,
	"external_id" text,
	"mode" text DEFAULT 'sandbox' NOT NULL,
	"status" text DEFAULT 'pending' NOT NULL,
	"last_pushed_at" timestamp with time zone,
	"pushed_snapshot" jsonb,
	"last_checked_at" timestamp with time zone,
	"remote_snapshot" jsonb,
	"last_error" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "local_asset_templates" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"name" text NOT NULL,
	"kind" text NOT NULL,
	"base_asset_id" uuid,
	"base_url" text,
	"width" integer DEFAULT 1080 NOT NULL,
	"height" integer DEFAULT 1080 NOT NULL,
	"fields" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"status" text DEFAULT 'draft' NOT NULL,
	"created_by" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "local_asset_versions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"template_id" uuid NOT NULL,
	"location_id" uuid NOT NULL,
	"values" jsonb NOT NULL,
	"created_by" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "local_marketing_settings" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"settings" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"updated_by" uuid,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "review_reply_templates" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"location_id" uuid,
	"name" text NOT NULL,
	"min_rating" integer DEFAULT 1 NOT NULL,
	"max_rating" integer DEFAULT 5 NOT NULL,
	"locale" text,
	"body" text NOT NULL,
	"created_by" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "social_calendar_adoptions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"item_id" uuid NOT NULL,
	"location_id" uuid NOT NULL,
	"post_id" uuid,
	"status" text DEFAULT 'scheduled' NOT NULL,
	"adopted_by" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "social_calendar_items" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"title" text NOT NULL,
	"body" text NOT NULL,
	"media" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"link" text,
	"networks" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"suggested_at" timestamp with time zone NOT NULL,
	"allow_edits" boolean DEFAULT false NOT NULL,
	"audience" text DEFAULT 'all' NOT NULL,
	"location_ids" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"status" text DEFAULT 'draft' NOT NULL,
	"published_at" timestamp with time zone,
	"created_by" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "tracked_calls" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"location_id" uuid NOT NULL,
	"tracking_number_id" uuid NOT NULL,
	"campaign_id" uuid,
	"source" text NOT NULL,
	"caller_number" text NOT NULL,
	"caller_name" text,
	"caller_city" text,
	"external_sid" text NOT NULL,
	"status" text DEFAULT 'ringing' NOT NULL,
	"started_at" timestamp with time zone NOT NULL,
	"duration_seconds" integer DEFAULT 0 NOT NULL,
	"recorded" boolean DEFAULT false NOT NULL,
	"recording_url" text,
	"sandbox" boolean DEFAULT false NOT NULL,
	"lead_id" uuid,
	"customer_id" uuid,
	"first_time_caller" boolean DEFAULT true NOT NULL,
	"notes" text,
	"followed_up_at" timestamp with time zone,
	"followed_up_by" uuid,
	"missed_alerted_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "tracking_numbers" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"location_id" uuid NOT NULL,
	"campaign_id" uuid,
	"label" text NOT NULL,
	"source" text DEFAULT 'website' NOT NULL,
	"number" text NOT NULL,
	"provider" text DEFAULT 'twilio' NOT NULL,
	"mode" text DEFAULT 'sandbox' NOT NULL,
	"external_sid" text,
	"forward_to" text NOT NULL,
	"record_calls" boolean DEFAULT false NOT NULL,
	"dni_match" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"is_default" boolean DEFAULT false NOT NULL,
	"status" text DEFAULT 'active' NOT NULL,
	"created_by" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"released_at" timestamp with time zone
);
--> statement-breakpoint
ALTER TABLE "coop_allowances" ADD CONSTRAINT "coop_allowances_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "coop_allowances" ADD CONSTRAINT "coop_allowances_location_id_locations_id_fk" FOREIGN KEY ("location_id") REFERENCES "public"."locations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "coop_claims" ADD CONSTRAINT "coop_claims_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "coop_claims" ADD CONSTRAINT "coop_claims_request_id_coop_requests_id_fk" FOREIGN KEY ("request_id") REFERENCES "public"."coop_requests"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "coop_claims" ADD CONSTRAINT "coop_claims_location_id_locations_id_fk" FOREIGN KEY ("location_id") REFERENCES "public"."locations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "coop_requests" ADD CONSTRAINT "coop_requests_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "coop_requests" ADD CONSTRAINT "coop_requests_location_id_locations_id_fk" FOREIGN KEY ("location_id") REFERENCES "public"."locations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "holiday_hour_sets" ADD CONSTRAINT "holiday_hour_sets_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "listing_change_requests" ADD CONSTRAINT "listing_change_requests_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "listing_change_requests" ADD CONSTRAINT "listing_change_requests_location_id_locations_id_fk" FOREIGN KEY ("location_id") REFERENCES "public"."locations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "listing_connections" ADD CONSTRAINT "listing_connections_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "listing_drifts" ADD CONSTRAINT "listing_drifts_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "listing_drifts" ADD CONSTRAINT "listing_drifts_location_id_locations_id_fk" FOREIGN KEY ("location_id") REFERENCES "public"."locations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "listing_profiles" ADD CONSTRAINT "listing_profiles_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "listing_profiles" ADD CONSTRAINT "listing_profiles_location_id_locations_id_fk" FOREIGN KEY ("location_id") REFERENCES "public"."locations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "listing_syncs" ADD CONSTRAINT "listing_syncs_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "listing_syncs" ADD CONSTRAINT "listing_syncs_location_id_locations_id_fk" FOREIGN KEY ("location_id") REFERENCES "public"."locations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "local_asset_templates" ADD CONSTRAINT "local_asset_templates_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "local_asset_versions" ADD CONSTRAINT "local_asset_versions_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "local_asset_versions" ADD CONSTRAINT "local_asset_versions_template_id_local_asset_templates_id_fk" FOREIGN KEY ("template_id") REFERENCES "public"."local_asset_templates"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "local_asset_versions" ADD CONSTRAINT "local_asset_versions_location_id_locations_id_fk" FOREIGN KEY ("location_id") REFERENCES "public"."locations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "local_marketing_settings" ADD CONSTRAINT "local_marketing_settings_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "review_reply_templates" ADD CONSTRAINT "review_reply_templates_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "review_reply_templates" ADD CONSTRAINT "review_reply_templates_location_id_locations_id_fk" FOREIGN KEY ("location_id") REFERENCES "public"."locations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "social_calendar_adoptions" ADD CONSTRAINT "social_calendar_adoptions_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "social_calendar_adoptions" ADD CONSTRAINT "social_calendar_adoptions_item_id_social_calendar_items_id_fk" FOREIGN KEY ("item_id") REFERENCES "public"."social_calendar_items"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "social_calendar_adoptions" ADD CONSTRAINT "social_calendar_adoptions_location_id_locations_id_fk" FOREIGN KEY ("location_id") REFERENCES "public"."locations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "social_calendar_items" ADD CONSTRAINT "social_calendar_items_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "tracked_calls" ADD CONSTRAINT "tracked_calls_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "tracked_calls" ADD CONSTRAINT "tracked_calls_location_id_locations_id_fk" FOREIGN KEY ("location_id") REFERENCES "public"."locations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "tracked_calls" ADD CONSTRAINT "tracked_calls_tracking_number_id_tracking_numbers_id_fk" FOREIGN KEY ("tracking_number_id") REFERENCES "public"."tracking_numbers"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "tracking_numbers" ADD CONSTRAINT "tracking_numbers_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "tracking_numbers" ADD CONSTRAINT "tracking_numbers_location_id_locations_id_fk" FOREIGN KEY ("location_id") REFERENCES "public"."locations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "coop_allowances_org_uq" ON "coop_allowances" USING btree ("organization_id") WHERE "coop_allowances"."location_id" is null;--> statement-breakpoint
CREATE UNIQUE INDEX "coop_allowances_loc_uq" ON "coop_allowances" USING btree ("location_id") WHERE "coop_allowances"."location_id" is not null;--> statement-breakpoint
CREATE UNIQUE INDEX "coop_claims_request_uq" ON "coop_claims" USING btree ("request_id") WHERE "coop_claims"."status" <> 'rejected';--> statement-breakpoint
CREATE INDEX "coop_claims_org_idx" ON "coop_claims" USING btree ("organization_id","status");--> statement-breakpoint
CREATE INDEX "coop_requests_org_idx" ON "coop_requests" USING btree ("organization_id","status");--> statement-breakpoint
CREATE INDEX "coop_requests_loc_idx" ON "coop_requests" USING btree ("location_id","period_key");--> statement-breakpoint
CREATE INDEX "holiday_hour_sets_org_idx" ON "holiday_hour_sets" USING btree ("organization_id","created_at");--> statement-breakpoint
CREATE INDEX "listing_change_requests_org_idx" ON "listing_change_requests" USING btree ("organization_id","status");--> statement-breakpoint
CREATE INDEX "listing_connections_org_idx" ON "listing_connections" USING btree ("organization_id");--> statement-breakpoint
CREATE UNIQUE INDEX "listing_drifts_open_uq" ON "listing_drifts" USING btree ("location_id","provider","field") WHERE "listing_drifts"."status" = 'open';--> statement-breakpoint
CREATE INDEX "listing_drifts_org_idx" ON "listing_drifts" USING btree ("organization_id","status");--> statement-breakpoint
CREATE UNIQUE INDEX "listing_profiles_loc_uq" ON "listing_profiles" USING btree ("location_id");--> statement-breakpoint
CREATE UNIQUE INDEX "listing_syncs_loc_provider_uq" ON "listing_syncs" USING btree ("location_id","provider");--> statement-breakpoint
CREATE INDEX "listing_syncs_org_idx" ON "listing_syncs" USING btree ("organization_id","status");--> statement-breakpoint
CREATE INDEX "local_asset_templates_org_idx" ON "local_asset_templates" USING btree ("organization_id","status");--> statement-breakpoint
CREATE INDEX "local_asset_versions_loc_idx" ON "local_asset_versions" USING btree ("location_id","template_id");--> statement-breakpoint
CREATE UNIQUE INDEX "local_marketing_settings_org_uq" ON "local_marketing_settings" USING btree ("organization_id");--> statement-breakpoint
CREATE INDEX "review_reply_templates_org_idx" ON "review_reply_templates" USING btree ("organization_id");--> statement-breakpoint
CREATE UNIQUE INDEX "social_calendar_adoptions_uq" ON "social_calendar_adoptions" USING btree ("item_id","location_id");--> statement-breakpoint
CREATE INDEX "social_calendar_items_org_idx" ON "social_calendar_items" USING btree ("organization_id","suggested_at");--> statement-breakpoint
CREATE UNIQUE INDEX "tracked_calls_sid_uq" ON "tracked_calls" USING btree ("external_sid");--> statement-breakpoint
CREATE INDEX "tracked_calls_org_time_idx" ON "tracked_calls" USING btree ("organization_id","location_id","started_at");--> statement-breakpoint
CREATE INDEX "tracked_calls_campaign_idx" ON "tracked_calls" USING btree ("campaign_id");--> statement-breakpoint
CREATE UNIQUE INDEX "tracking_numbers_number_uq" ON "tracking_numbers" USING btree ("number") WHERE "tracking_numbers"."status" = 'active';--> statement-breakpoint
CREATE INDEX "tracking_numbers_org_idx" ON "tracking_numbers" USING btree ("organization_id","location_id");