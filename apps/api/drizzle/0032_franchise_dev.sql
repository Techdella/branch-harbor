CREATE TABLE "agreement_amendments" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"agreement_id" uuid NOT NULL,
	"title" text NOT NULL,
	"summary" text,
	"changes" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"previous" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"effective_date" date NOT NULL,
	"status" text DEFAULT 'draft' NOT NULL,
	"document_id" uuid,
	"counsel_reviewed" boolean DEFAULT false NOT NULL,
	"signed_at" timestamp with time zone,
	"applied_by" uuid,
	"created_by" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "agreement_notices" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"agreement_id" uuid NOT NULL,
	"owner_group_id" uuid,
	"parent_id" uuid,
	"kind" text NOT NULL,
	"reason" text NOT NULL,
	"details" text DEFAULT '' NOT NULL,
	"subject" text NOT NULL,
	"body" text NOT NULL,
	"cure_days" integer,
	"cure_deadline" date,
	"status" text DEFAULT 'draft' NOT NULL,
	"escalation_level" integer DEFAULT 0 NOT NULL,
	"counsel_reviewed" boolean DEFAULT false NOT NULL,
	"counsel_reviewed_by" uuid,
	"counsel_reviewed_at" timestamp with time zone,
	"counsel_note" text,
	"issued_at" timestamp with time zone,
	"issued_by" uuid,
	"delivered_to" text,
	"resolved_at" timestamp with time zone,
	"resolution_note" text,
	"created_by" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "agreement_renewals" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"agreement_id" uuid NOT NULL,
	"window_opens_on" date NOT NULL,
	"window_closes_on" date NOT NULL,
	"status" text DEFAULT 'upcoming' NOT NULL,
	"notice_received_on" date,
	"conditions" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"renewal_fee_minor" bigint DEFAULT 0 NOT NULL,
	"currency" char(3) NOT NULL,
	"new_term_years" integer,
	"new_agreement_id" uuid,
	"decision_note" text,
	"decided_by" uuid,
	"decided_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "agreement_transfers" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"agreement_id" uuid NOT NULL,
	"from_owner_group_id" uuid,
	"to_owner_group_id" uuid,
	"to_prospect_id" uuid,
	"buyer_name" text NOT NULL,
	"status" text DEFAULT 'draft' NOT NULL,
	"steps" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"transfer_fee_minor" bigint DEFAULT 0 NOT NULL,
	"currency" char(3) NOT NULL,
	"fee_paid_at" timestamp with time zone,
	"effective_date" date,
	"reason" text,
	"decided_by" uuid,
	"decided_at" timestamp with time zone,
	"decision_note" text,
	"completed_at" timestamp with time zone,
	"created_by" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "development_agreements" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"owner_group_id" uuid NOT NULL,
	"scope_territory_id" uuid,
	"agreement_id" uuid,
	"name" text NOT NULL,
	"territory_ids" uuid[] DEFAULT '{}'::uuid[] NOT NULL,
	"units_total" integer NOT NULL,
	"start_date" date NOT NULL,
	"status" text DEFAULT 'active' NOT NULL,
	"development_fee_minor" bigint DEFAULT 0 NOT NULL,
	"currency" char(3) NOT NULL,
	"notes" text,
	"created_by" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "development_schedule_items" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"development_agreement_id" uuid NOT NULL,
	"sequence" integer NOT NULL,
	"label" text NOT NULL,
	"territory_id" uuid,
	"sign_by_date" date,
	"open_by_date" date NOT NULL,
	"status" text DEFAULT 'pending' NOT NULL,
	"unit_agreement_id" uuid,
	"location_id" uuid,
	"signed_on" date,
	"opened_on" date,
	"note" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "franchise_survey_actions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"survey_id" uuid NOT NULL,
	"round_id" uuid,
	"theme" text,
	"title" text NOT NULL,
	"description" text,
	"owner_user_id" uuid,
	"due_on" date,
	"status" text DEFAULT 'open' NOT NULL,
	"shared" boolean DEFAULT false NOT NULL,
	"created_by" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "franchise_survey_responses" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"round_id" uuid NOT NULL,
	"respondent_key" text NOT NULL,
	"user_id" uuid,
	"region_id" uuid,
	"owner_group_id" uuid,
	"answers" jsonb NOT NULL,
	"nps_score" integer,
	"submitted_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "franchise_survey_rounds" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"survey_id" uuid NOT NULL,
	"label" text NOT NULL,
	"opens_on" date NOT NULL,
	"closes_on" date NOT NULL,
	"status" text DEFAULT 'open' NOT NULL,
	"invited_count" integer DEFAULT 0 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "franchise_surveys" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"title" text NOT NULL,
	"description" text,
	"questions" jsonb NOT NULL,
	"anonymous" boolean DEFAULT true NOT NULL,
	"min_responses" integer DEFAULT 5 NOT NULL,
	"audience" text DEFAULT 'franchise_owners' NOT NULL,
	"recurrence" text DEFAULT 'once' NOT NULL,
	"open_days" integer DEFAULT 14 NOT NULL,
	"status" text DEFAULT 'draft' NOT NULL,
	"next_run_on" date,
	"created_by" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "franchise_validation_calls" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"prospect_id" uuid NOT NULL,
	"validator_id" uuid NOT NULL,
	"status" text DEFAULT 'requested' NOT NULL,
	"scheduled_at" timestamp with time zone,
	"proposed_times" text,
	"completed_at" timestamp with time zone,
	"sentiment" text,
	"outcome" text,
	"created_by" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "franchise_validation_links" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"prospect_id" uuid NOT NULL,
	"token_hash" text NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"opened_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "franchise_validation_links_token_hash_unique" UNIQUE("token_hash")
);
--> statement-breakpoint
CREATE TABLE "franchise_validators" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"user_id" uuid NOT NULL,
	"owner_group_id" uuid,
	"location_id" uuid,
	"country" text,
	"region" text,
	"active" boolean DEFAULT true NOT NULL,
	"max_calls_per_month" integer DEFAULT 4 NOT NULL,
	"bio" text,
	"scheduling_url" text,
	"phone" text,
	"opted_in_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "master_agreements" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"owner_group_id" uuid NOT NULL,
	"scope_territory_id" uuid,
	"kind" text DEFAULT 'master_franchisee' NOT NULL,
	"name" text NOT NULL,
	"countries" text[] NOT NULL,
	"regions" text[] DEFAULT '{}'::text[] NOT NULL,
	"home_country" text NOT NULL,
	"home_region" text,
	"start_date" date NOT NULL,
	"end_date" date,
	"status" text DEFAULT 'active' NOT NULL,
	"splits" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"payout_method" text DEFAULT 'manual' NOT NULL,
	"stripe_account_id" text,
	"agreement_id" uuid,
	"created_by" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "master_split_statements" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"master_agreement_id" uuid NOT NULL,
	"period_id" uuid NOT NULL,
	"currency" char(3) NOT NULL,
	"number" text NOT NULL,
	"royalty_share_bps" integer NOT NULL,
	"fund_share_bps" integer NOT NULL,
	"lines" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"royalty_minor" bigint DEFAULT 0 NOT NULL,
	"marketing_fund_minor" bigint DEFAULT 0 NOT NULL,
	"master_royalty_minor" bigint DEFAULT 0 NOT NULL,
	"master_fund_minor" bigint DEFAULT 0 NOT NULL,
	"hq_royalty_minor" bigint DEFAULT 0 NOT NULL,
	"hq_fund_minor" bigint DEFAULT 0 NOT NULL,
	"payable_minor" bigint DEFAULT 0 NOT NULL,
	"status" text DEFAULT 'draft' NOT NULL,
	"approved_by" uuid,
	"approved_at" timestamp with time zone,
	"payout_method" text,
	"transfer_id" text,
	"payout_reference" text,
	"paid_at" timestamp with time zone,
	"paid_by" uuid,
	"sandbox" boolean DEFAULT false NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "franchise_prospects" ADD COLUMN "master_agreement_id" uuid;--> statement-breakpoint
ALTER TABLE "franchise_territories" ADD COLUMN "geometry" jsonb;--> statement-breakpoint
ALTER TABLE "franchise_territories" ADD COLUMN "postcodes" text[] DEFAULT '{}'::text[] NOT NULL;--> statement-breakpoint
ALTER TABLE "franchise_territories" ADD COLUMN "exclusivity" text DEFAULT 'exclusive' NOT NULL;--> statement-breakpoint
ALTER TABLE "franchise_territories" ADD COLUMN "centroid" jsonb;--> statement-breakpoint
ALTER TABLE "franchise_territories" ADD COLUMN "demographics" jsonb;--> statement-breakpoint
ALTER TABLE "franchise_territories" ADD COLUMN "score" integer;--> statement-breakpoint
ALTER TABLE "franchise_territories" ADD COLUMN "score_parts" jsonb;--> statement-breakpoint
ALTER TABLE "franchise_territories" ADD COLUMN "agreement_id" uuid;--> statement-breakpoint
ALTER TABLE "franchise_territories" ADD COLUMN "master_agreement_id" uuid;--> statement-breakpoint
ALTER TABLE "franchise_territories" ADD COLUMN "status_changed_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "agreement_amendments" ADD CONSTRAINT "agreement_amendments_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "agreement_amendments" ADD CONSTRAINT "agreement_amendments_agreement_id_franchise_agreements_id_fk" FOREIGN KEY ("agreement_id") REFERENCES "public"."franchise_agreements"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "agreement_notices" ADD CONSTRAINT "agreement_notices_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "agreement_notices" ADD CONSTRAINT "agreement_notices_agreement_id_franchise_agreements_id_fk" FOREIGN KEY ("agreement_id") REFERENCES "public"."franchise_agreements"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "agreement_notices" ADD CONSTRAINT "agreement_notices_owner_group_id_owner_groups_id_fk" FOREIGN KEY ("owner_group_id") REFERENCES "public"."owner_groups"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "agreement_renewals" ADD CONSTRAINT "agreement_renewals_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "agreement_renewals" ADD CONSTRAINT "agreement_renewals_agreement_id_franchise_agreements_id_fk" FOREIGN KEY ("agreement_id") REFERENCES "public"."franchise_agreements"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "agreement_transfers" ADD CONSTRAINT "agreement_transfers_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "agreement_transfers" ADD CONSTRAINT "agreement_transfers_agreement_id_franchise_agreements_id_fk" FOREIGN KEY ("agreement_id") REFERENCES "public"."franchise_agreements"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "agreement_transfers" ADD CONSTRAINT "agreement_transfers_from_owner_group_id_owner_groups_id_fk" FOREIGN KEY ("from_owner_group_id") REFERENCES "public"."owner_groups"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "agreement_transfers" ADD CONSTRAINT "agreement_transfers_to_owner_group_id_owner_groups_id_fk" FOREIGN KEY ("to_owner_group_id") REFERENCES "public"."owner_groups"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "agreement_transfers" ADD CONSTRAINT "agreement_transfers_to_prospect_id_franchise_prospects_id_fk" FOREIGN KEY ("to_prospect_id") REFERENCES "public"."franchise_prospects"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "development_agreements" ADD CONSTRAINT "development_agreements_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "development_agreements" ADD CONSTRAINT "development_agreements_owner_group_id_owner_groups_id_fk" FOREIGN KEY ("owner_group_id") REFERENCES "public"."owner_groups"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "development_agreements" ADD CONSTRAINT "development_agreements_scope_territory_id_territories_id_fk" FOREIGN KEY ("scope_territory_id") REFERENCES "public"."territories"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "development_agreements" ADD CONSTRAINT "development_agreements_agreement_id_franchise_agreements_id_fk" FOREIGN KEY ("agreement_id") REFERENCES "public"."franchise_agreements"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "development_schedule_items" ADD CONSTRAINT "development_schedule_items_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "development_schedule_items" ADD CONSTRAINT "development_schedule_items_development_agreement_id_development_agreements_id_fk" FOREIGN KEY ("development_agreement_id") REFERENCES "public"."development_agreements"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "development_schedule_items" ADD CONSTRAINT "development_schedule_items_location_id_locations_id_fk" FOREIGN KEY ("location_id") REFERENCES "public"."locations"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "franchise_survey_actions" ADD CONSTRAINT "franchise_survey_actions_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "franchise_survey_actions" ADD CONSTRAINT "franchise_survey_actions_survey_id_franchise_surveys_id_fk" FOREIGN KEY ("survey_id") REFERENCES "public"."franchise_surveys"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "franchise_survey_actions" ADD CONSTRAINT "franchise_survey_actions_round_id_franchise_survey_rounds_id_fk" FOREIGN KEY ("round_id") REFERENCES "public"."franchise_survey_rounds"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "franchise_survey_responses" ADD CONSTRAINT "franchise_survey_responses_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "franchise_survey_responses" ADD CONSTRAINT "franchise_survey_responses_round_id_franchise_survey_rounds_id_fk" FOREIGN KEY ("round_id") REFERENCES "public"."franchise_survey_rounds"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "franchise_survey_responses" ADD CONSTRAINT "franchise_survey_responses_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "franchise_survey_responses" ADD CONSTRAINT "franchise_survey_responses_region_id_regions_id_fk" FOREIGN KEY ("region_id") REFERENCES "public"."regions"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "franchise_survey_responses" ADD CONSTRAINT "franchise_survey_responses_owner_group_id_owner_groups_id_fk" FOREIGN KEY ("owner_group_id") REFERENCES "public"."owner_groups"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "franchise_survey_rounds" ADD CONSTRAINT "franchise_survey_rounds_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "franchise_survey_rounds" ADD CONSTRAINT "franchise_survey_rounds_survey_id_franchise_surveys_id_fk" FOREIGN KEY ("survey_id") REFERENCES "public"."franchise_surveys"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "franchise_surveys" ADD CONSTRAINT "franchise_surveys_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "franchise_validation_calls" ADD CONSTRAINT "franchise_validation_calls_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "franchise_validation_calls" ADD CONSTRAINT "franchise_validation_calls_prospect_id_franchise_prospects_id_fk" FOREIGN KEY ("prospect_id") REFERENCES "public"."franchise_prospects"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "franchise_validation_calls" ADD CONSTRAINT "franchise_validation_calls_validator_id_franchise_validators_id_fk" FOREIGN KEY ("validator_id") REFERENCES "public"."franchise_validators"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "franchise_validation_links" ADD CONSTRAINT "franchise_validation_links_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "franchise_validation_links" ADD CONSTRAINT "franchise_validation_links_prospect_id_franchise_prospects_id_fk" FOREIGN KEY ("prospect_id") REFERENCES "public"."franchise_prospects"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "franchise_validators" ADD CONSTRAINT "franchise_validators_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "franchise_validators" ADD CONSTRAINT "franchise_validators_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "franchise_validators" ADD CONSTRAINT "franchise_validators_owner_group_id_owner_groups_id_fk" FOREIGN KEY ("owner_group_id") REFERENCES "public"."owner_groups"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "franchise_validators" ADD CONSTRAINT "franchise_validators_location_id_locations_id_fk" FOREIGN KEY ("location_id") REFERENCES "public"."locations"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "master_agreements" ADD CONSTRAINT "master_agreements_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "master_agreements" ADD CONSTRAINT "master_agreements_owner_group_id_owner_groups_id_fk" FOREIGN KEY ("owner_group_id") REFERENCES "public"."owner_groups"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "master_agreements" ADD CONSTRAINT "master_agreements_scope_territory_id_territories_id_fk" FOREIGN KEY ("scope_territory_id") REFERENCES "public"."territories"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "master_split_statements" ADD CONSTRAINT "master_split_statements_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "master_split_statements" ADD CONSTRAINT "master_split_statements_master_agreement_id_master_agreements_id_fk" FOREIGN KEY ("master_agreement_id") REFERENCES "public"."master_agreements"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "master_split_statements" ADD CONSTRAINT "master_split_statements_period_id_royalty_periods_id_fk" FOREIGN KEY ("period_id") REFERENCES "public"."royalty_periods"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "agreement_amendments_agreement_idx" ON "agreement_amendments" USING btree ("agreement_id");--> statement-breakpoint
CREATE INDEX "agreement_notices_org_idx" ON "agreement_notices" USING btree ("organization_id","status");--> statement-breakpoint
CREATE INDEX "agreement_notices_agreement_idx" ON "agreement_notices" USING btree ("agreement_id");--> statement-breakpoint
CREATE UNIQUE INDEX "agreement_renewals_agreement_uq" ON "agreement_renewals" USING btree ("agreement_id");--> statement-breakpoint
CREATE INDEX "agreement_transfers_org_idx" ON "agreement_transfers" USING btree ("organization_id","status");--> statement-breakpoint
CREATE INDEX "development_agreements_org_idx" ON "development_agreements" USING btree ("organization_id");--> statement-breakpoint
CREATE UNIQUE INDEX "development_schedule_items_uq" ON "development_schedule_items" USING btree ("development_agreement_id","sequence");--> statement-breakpoint
CREATE INDEX "franchise_survey_actions_survey_idx" ON "franchise_survey_actions" USING btree ("survey_id");--> statement-breakpoint
CREATE UNIQUE INDEX "franchise_survey_responses_uq" ON "franchise_survey_responses" USING btree ("round_id","respondent_key");--> statement-breakpoint
CREATE INDEX "franchise_survey_responses_round_idx" ON "franchise_survey_responses" USING btree ("round_id");--> statement-breakpoint
CREATE UNIQUE INDEX "franchise_survey_rounds_uq" ON "franchise_survey_rounds" USING btree ("survey_id","opens_on");--> statement-breakpoint
CREATE INDEX "franchise_surveys_org_idx" ON "franchise_surveys" USING btree ("organization_id","status");--> statement-breakpoint
CREATE INDEX "franchise_validation_calls_prospect_idx" ON "franchise_validation_calls" USING btree ("prospect_id");--> statement-breakpoint
CREATE INDEX "franchise_validation_calls_validator_idx" ON "franchise_validation_calls" USING btree ("validator_id","created_at");--> statement-breakpoint
CREATE UNIQUE INDEX "franchise_validators_user_uq" ON "franchise_validators" USING btree ("organization_id","user_id");--> statement-breakpoint
CREATE INDEX "master_agreements_org_idx" ON "master_agreements" USING btree ("organization_id");--> statement-breakpoint
CREATE INDEX "master_agreements_group_idx" ON "master_agreements" USING btree ("owner_group_id");--> statement-breakpoint
CREATE UNIQUE INDEX "master_split_statements_uq" ON "master_split_statements" USING btree ("master_agreement_id","period_id","currency");--> statement-breakpoint
CREATE INDEX "master_split_statements_org_idx" ON "master_split_statements" USING btree ("organization_id","status");