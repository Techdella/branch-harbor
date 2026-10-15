CREATE TABLE "ad_campaign_locations" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"campaign_id" uuid NOT NULL,
	"location_id" uuid NOT NULL,
	"budget_minor" bigint NOT NULL,
	"currency" char(3) NOT NULL,
	"radius_km" integer DEFAULT 8 NOT NULL,
	"geo" jsonb,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "ad_campaign_results" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"campaign_id" uuid NOT NULL,
	"location_id" uuid NOT NULL,
	"day" date NOT NULL,
	"spend_minor" bigint DEFAULT 0 NOT NULL,
	"currency" char(3) NOT NULL,
	"impressions" integer DEFAULT 0 NOT NULL,
	"clicks" integer DEFAULT 0 NOT NULL,
	"platform_leads" integer DEFAULT 0 NOT NULL,
	"source" text DEFAULT 'manual' NOT NULL,
	"entered_by" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "ad_campaigns" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"kind" text NOT NULL,
	"name" text NOT NULL,
	"objective" text DEFAULT 'leads' NOT NULL,
	"platforms" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"status" text DEFAULT 'draft' NOT NULL,
	"starts_on" date,
	"ends_on" date,
	"creative" jsonb NOT NULL,
	"coming_soon" jsonb,
	"budget_totals" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"approval_campaign_id" uuid,
	"approval_id" uuid,
	"created_by" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "comms_canned_replies" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"location_id" uuid,
	"title" text NOT NULL,
	"body" text NOT NULL,
	"created_by" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "comms_channel_accounts" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"location_id" uuid,
	"channel" text NOT NULL,
	"address" text NOT NULL,
	"display_name" text NOT NULL,
	"mode" text DEFAULT 'sandbox' NOT NULL,
	"credentials_encrypted" text,
	"active" boolean DEFAULT true NOT NULL,
	"created_by" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "comms_conversations" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"location_id" uuid,
	"channel_account_id" uuid NOT NULL,
	"channel" text NOT NULL,
	"handle" text NOT NULL,
	"contact_name" text,
	"customer_id" uuid,
	"lead_id" uuid,
	"subject" text,
	"status" text DEFAULT 'open' NOT NULL,
	"assigned_user_id" uuid,
	"last_inbound_at" timestamp with time zone,
	"last_message_at" timestamp with time zone DEFAULT now() NOT NULL,
	"last_message_preview" text,
	"unread" integer DEFAULT 0 NOT NULL,
	"reply_due_at" timestamp with time zone,
	"first_reply_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "comms_messages" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"conversation_id" uuid NOT NULL,
	"direction" text NOT NULL,
	"body" text NOT NULL,
	"template_id" uuid,
	"author_user_id" uuid,
	"external_id" text,
	"status" text NOT NULL,
	"error" text,
	"meta" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "comms_opt_outs" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"channel" text NOT NULL,
	"handle" text NOT NULL,
	"source" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "comms_whatsapp_templates" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"name" text NOT NULL,
	"language" text DEFAULT 'en' NOT NULL,
	"category" text DEFAULT 'utility' NOT NULL,
	"body" text NOT NULL,
	"status" text DEFAULT 'pending' NOT NULL,
	"created_by" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "contact_segments" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"location_id" uuid,
	"name" text NOT NULL,
	"rules" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"created_by" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "contact_tags" (
	"organization_id" uuid NOT NULL,
	"customer_id" uuid NOT NULL,
	"tag" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "lead_routing_rules" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"kind" text DEFAULT 'customer' NOT NULL,
	"name" text NOT NULL,
	"position" integer DEFAULT 0 NOT NULL,
	"conditions" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"action" jsonb NOT NULL,
	"cursor" integer DEFAULT 0 NOT NULL,
	"active" boolean DEFAULT true NOT NULL,
	"created_by" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "marketing_fund_spend_events" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"campaign_id" uuid NOT NULL,
	"location_id" uuid NOT NULL,
	"result_id" uuid NOT NULL,
	"amount_minor" bigint NOT NULL,
	"currency" char(3) NOT NULL,
	"occurred_on" date NOT NULL,
	"source" text NOT NULL,
	"consumed_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "sales_activities" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"deal_id" uuid,
	"lead_id" uuid,
	"type" text NOT NULL,
	"body" text NOT NULL,
	"due_at" timestamp with time zone,
	"done_at" timestamp with time zone,
	"assigned_user_id" uuid,
	"created_by" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "sales_deals" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"location_id" uuid NOT NULL,
	"stage_id" uuid NOT NULL,
	"title" text NOT NULL,
	"customer_id" uuid,
	"lead_id" uuid,
	"value_minor" bigint DEFAULT 0 NOT NULL,
	"currency" char(3) NOT NULL,
	"owner_user_id" uuid,
	"expected_close_on" date,
	"closed_at" timestamp with time zone,
	"created_by" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "sales_stages" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"name" text NOT NULL,
	"position" integer NOT NULL,
	"outcome" text DEFAULT 'open' NOT NULL,
	"probability" integer DEFAULT 0 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "social_account_grants" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"account_id" uuid NOT NULL,
	"location_id" uuid NOT NULL,
	"access" text DEFAULT 'post' NOT NULL,
	"granted_by" uuid,
	"granted_at" timestamp with time zone DEFAULT now() NOT NULL,
	"revoked_at" timestamp with time zone,
	"revoked_by" uuid,
	"revoke_reason" text
);
--> statement-breakpoint
CREATE TABLE "social_accounts" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"owner_kind" text DEFAULT 'hq' NOT NULL,
	"location_id" uuid,
	"network" text NOT NULL,
	"handle" text NOT NULL,
	"external_id" text,
	"mode" text DEFAULT 'sandbox' NOT NULL,
	"status" text DEFAULT 'connected' NOT NULL,
	"credentials_encrypted" text,
	"connected_by" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "social_posts" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"location_id" uuid,
	"body" text NOT NULL,
	"media" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"link" text,
	"account_ids" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"scheduled_at" timestamp with time zone,
	"status" text DEFAULT 'draft' NOT NULL,
	"needs_approval" boolean DEFAULT false NOT NULL,
	"decided_by" uuid,
	"decided_at" timestamp with time zone,
	"decision_comment" text,
	"results" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"published_at" timestamp with time zone,
	"author_user_id" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "leads" ADD COLUMN "kind" text DEFAULT 'customer' NOT NULL;--> statement-breakpoint
ALTER TABLE "leads" ADD COLUMN "ad_campaign_id" uuid;--> statement-breakpoint
ALTER TABLE "leads" ADD COLUMN "assigned_user_id" uuid;--> statement-breakpoint
ALTER TABLE "leads" ADD COLUMN "routing_rule_id" uuid;--> statement-breakpoint
ALTER TABLE "leads" ADD COLUMN "country" text;--> statement-breakpoint
ALTER TABLE "leads" ADD COLUMN "postal_code" text;--> statement-breakpoint
ALTER TABLE "leads" ADD COLUMN "course_id" uuid;--> statement-breakpoint
ALTER TABLE "leads" ADD COLUMN "enrolment_id" uuid;--> statement-breakpoint
ALTER TABLE "leads" ADD COLUMN "campaign" text;--> statement-breakpoint
ALTER TABLE "leads" ADD COLUMN "utm" jsonb DEFAULT '{}'::jsonb NOT NULL;--> statement-breakpoint
ALTER TABLE "leads" ADD COLUMN "notes" text;--> statement-breakpoint
ALTER TABLE "leads" ADD COLUMN "marketing_consent" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "leads" ADD COLUMN "updated_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "ad_campaign_locations" ADD CONSTRAINT "ad_campaign_locations_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ad_campaign_locations" ADD CONSTRAINT "ad_campaign_locations_campaign_id_ad_campaigns_id_fk" FOREIGN KEY ("campaign_id") REFERENCES "public"."ad_campaigns"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ad_campaign_locations" ADD CONSTRAINT "ad_campaign_locations_location_id_locations_id_fk" FOREIGN KEY ("location_id") REFERENCES "public"."locations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ad_campaign_results" ADD CONSTRAINT "ad_campaign_results_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ad_campaign_results" ADD CONSTRAINT "ad_campaign_results_campaign_id_ad_campaigns_id_fk" FOREIGN KEY ("campaign_id") REFERENCES "public"."ad_campaigns"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ad_campaign_results" ADD CONSTRAINT "ad_campaign_results_location_id_locations_id_fk" FOREIGN KEY ("location_id") REFERENCES "public"."locations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ad_campaigns" ADD CONSTRAINT "ad_campaigns_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "comms_canned_replies" ADD CONSTRAINT "comms_canned_replies_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "comms_canned_replies" ADD CONSTRAINT "comms_canned_replies_location_id_locations_id_fk" FOREIGN KEY ("location_id") REFERENCES "public"."locations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "comms_channel_accounts" ADD CONSTRAINT "comms_channel_accounts_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "comms_channel_accounts" ADD CONSTRAINT "comms_channel_accounts_location_id_locations_id_fk" FOREIGN KEY ("location_id") REFERENCES "public"."locations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "comms_conversations" ADD CONSTRAINT "comms_conversations_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "comms_conversations" ADD CONSTRAINT "comms_conversations_location_id_locations_id_fk" FOREIGN KEY ("location_id") REFERENCES "public"."locations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "comms_conversations" ADD CONSTRAINT "comms_conversations_channel_account_id_comms_channel_accounts_id_fk" FOREIGN KEY ("channel_account_id") REFERENCES "public"."comms_channel_accounts"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "comms_conversations" ADD CONSTRAINT "comms_conversations_customer_id_customers_id_fk" FOREIGN KEY ("customer_id") REFERENCES "public"."customers"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "comms_conversations" ADD CONSTRAINT "comms_conversations_assigned_user_id_users_id_fk" FOREIGN KEY ("assigned_user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "comms_messages" ADD CONSTRAINT "comms_messages_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "comms_messages" ADD CONSTRAINT "comms_messages_conversation_id_comms_conversations_id_fk" FOREIGN KEY ("conversation_id") REFERENCES "public"."comms_conversations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "comms_opt_outs" ADD CONSTRAINT "comms_opt_outs_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "comms_whatsapp_templates" ADD CONSTRAINT "comms_whatsapp_templates_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "contact_segments" ADD CONSTRAINT "contact_segments_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "contact_segments" ADD CONSTRAINT "contact_segments_location_id_locations_id_fk" FOREIGN KEY ("location_id") REFERENCES "public"."locations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "contact_tags" ADD CONSTRAINT "contact_tags_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "contact_tags" ADD CONSTRAINT "contact_tags_customer_id_customers_id_fk" FOREIGN KEY ("customer_id") REFERENCES "public"."customers"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "lead_routing_rules" ADD CONSTRAINT "lead_routing_rules_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "marketing_fund_spend_events" ADD CONSTRAINT "marketing_fund_spend_events_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sales_activities" ADD CONSTRAINT "sales_activities_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sales_activities" ADD CONSTRAINT "sales_activities_deal_id_sales_deals_id_fk" FOREIGN KEY ("deal_id") REFERENCES "public"."sales_deals"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sales_deals" ADD CONSTRAINT "sales_deals_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sales_deals" ADD CONSTRAINT "sales_deals_location_id_locations_id_fk" FOREIGN KEY ("location_id") REFERENCES "public"."locations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sales_deals" ADD CONSTRAINT "sales_deals_stage_id_sales_stages_id_fk" FOREIGN KEY ("stage_id") REFERENCES "public"."sales_stages"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sales_deals" ADD CONSTRAINT "sales_deals_customer_id_customers_id_fk" FOREIGN KEY ("customer_id") REFERENCES "public"."customers"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sales_deals" ADD CONSTRAINT "sales_deals_owner_user_id_users_id_fk" FOREIGN KEY ("owner_user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sales_stages" ADD CONSTRAINT "sales_stages_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "social_account_grants" ADD CONSTRAINT "social_account_grants_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "social_account_grants" ADD CONSTRAINT "social_account_grants_account_id_social_accounts_id_fk" FOREIGN KEY ("account_id") REFERENCES "public"."social_accounts"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "social_account_grants" ADD CONSTRAINT "social_account_grants_location_id_locations_id_fk" FOREIGN KEY ("location_id") REFERENCES "public"."locations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "social_accounts" ADD CONSTRAINT "social_accounts_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "social_accounts" ADD CONSTRAINT "social_accounts_location_id_locations_id_fk" FOREIGN KEY ("location_id") REFERENCES "public"."locations"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "social_posts" ADD CONSTRAINT "social_posts_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "social_posts" ADD CONSTRAINT "social_posts_location_id_locations_id_fk" FOREIGN KEY ("location_id") REFERENCES "public"."locations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "ad_campaign_locations_uq" ON "ad_campaign_locations" USING btree ("campaign_id","location_id");--> statement-breakpoint
CREATE UNIQUE INDEX "ad_campaign_results_uq" ON "ad_campaign_results" USING btree ("campaign_id","location_id","day","source");--> statement-breakpoint
CREATE INDEX "ad_campaigns_org_idx" ON "ad_campaigns" USING btree ("organization_id","kind");--> statement-breakpoint
CREATE UNIQUE INDEX "comms_channel_accounts_addr_uq" ON "comms_channel_accounts" USING btree ("channel","address");--> statement-breakpoint
CREATE INDEX "comms_channel_accounts_org_idx" ON "comms_channel_accounts" USING btree ("organization_id");--> statement-breakpoint
CREATE UNIQUE INDEX "comms_conversations_thread_uq" ON "comms_conversations" USING btree ("channel_account_id","handle");--> statement-breakpoint
CREATE INDEX "comms_conversations_org_loc_idx" ON "comms_conversations" USING btree ("organization_id","location_id","last_message_at");--> statement-breakpoint
CREATE INDEX "comms_messages_conv_idx" ON "comms_messages" USING btree ("conversation_id","created_at");--> statement-breakpoint
CREATE UNIQUE INDEX "comms_opt_outs_uq" ON "comms_opt_outs" USING btree ("organization_id","channel","handle");--> statement-breakpoint
CREATE UNIQUE INDEX "comms_wa_templates_uq" ON "comms_whatsapp_templates" USING btree ("organization_id","name","language");--> statement-breakpoint
CREATE UNIQUE INDEX "contact_tags_uq" ON "contact_tags" USING btree ("customer_id","tag");--> statement-breakpoint
CREATE INDEX "contact_tags_org_tag_idx" ON "contact_tags" USING btree ("organization_id","tag");--> statement-breakpoint
CREATE INDEX "lead_routing_rules_org_idx" ON "lead_routing_rules" USING btree ("organization_id","kind","position");--> statement-breakpoint
CREATE INDEX "mf_spend_events_org_idx" ON "marketing_fund_spend_events" USING btree ("organization_id","consumed_at");--> statement-breakpoint
CREATE INDEX "sales_activities_deal_idx" ON "sales_activities" USING btree ("deal_id");--> statement-breakpoint
CREATE INDEX "sales_activities_lead_idx" ON "sales_activities" USING btree ("lead_id");--> statement-breakpoint
CREATE INDEX "sales_deals_org_stage_idx" ON "sales_deals" USING btree ("organization_id","stage_id");--> statement-breakpoint
CREATE INDEX "sales_stages_org_idx" ON "sales_stages" USING btree ("organization_id","position");--> statement-breakpoint
CREATE UNIQUE INDEX "social_grants_active_uq" ON "social_account_grants" USING btree ("account_id","location_id") WHERE revoked_at is null;--> statement-breakpoint
CREATE INDEX "social_accounts_org_idx" ON "social_accounts" USING btree ("organization_id");--> statement-breakpoint
CREATE INDEX "social_posts_org_sched_idx" ON "social_posts" USING btree ("organization_id","scheduled_at");--> statement-breakpoint
CREATE INDEX "social_posts_status_idx" ON "social_posts" USING btree ("status","scheduled_at");--> statement-breakpoint
CREATE INDEX "leads_ad_campaign_idx" ON "leads" USING btree ("ad_campaign_id");