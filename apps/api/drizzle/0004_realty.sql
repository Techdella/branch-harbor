CREATE TABLE "realty_agents" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"location_id" uuid NOT NULL,
	"user_id" uuid,
	"name" text NOT NULL,
	"email" text,
	"phone" text,
	"title" text,
	"licence_number" text,
	"bio" text,
	"photo_url" text,
	"languages" text[] DEFAULT '{}'::text[] NOT NULL,
	"availability" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"accepts_leads" boolean DEFAULT true NOT NULL,
	"active" boolean DEFAULT true NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "realty_ai_proposals" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"location_id" uuid,
	"listing_id" uuid,
	"user_id" uuid NOT NULL,
	"kind" text NOT NULL,
	"output" jsonb NOT NULL,
	"status" text DEFAULT 'proposed' NOT NULL,
	"model" text,
	"decided_by" uuid,
	"decided_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "realty_alert_deliveries" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"saved_search_id" uuid NOT NULL,
	"listing_id" uuid NOT NULL,
	"sent_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "realty_contacts" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"location_id" uuid NOT NULL,
	"kind" text NOT NULL,
	"name" text NOT NULL,
	"email" text,
	"phone" text,
	"notes" text,
	"customer_id" uuid,
	"owner_agent_id" uuid,
	"erased_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "realty_enquiries" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"location_id" uuid NOT NULL,
	"listing_id" uuid,
	"source" text DEFAULT 'website' NOT NULL,
	"kind" text DEFAULT 'buyer' NOT NULL,
	"name" text NOT NULL,
	"email" text,
	"phone" text,
	"message" text,
	"customer_id" uuid,
	"assigned_agent_id" uuid,
	"routed_by" text NOT NULL,
	"status" text DEFAULT 'new' NOT NULL,
	"first_response_at" timestamp with time zone,
	"external_ref" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "realty_favourites" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"user_id" uuid NOT NULL,
	"listing_id" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "realty_listing_agents" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"listing_id" uuid NOT NULL,
	"agent_id" uuid NOT NULL,
	"role" text DEFAULT 'co' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "realty_listing_history" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"listing_id" uuid NOT NULL,
	"from_status" text,
	"to_status" text NOT NULL,
	"actor_user_id" uuid,
	"note" text,
	"at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "realty_listings" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"location_id" uuid NOT NULL,
	"reference" text NOT NULL,
	"transaction" text NOT NULL,
	"property_type" text NOT NULL,
	"status" text DEFAULT 'draft' NOT NULL,
	"title" text NOT NULL,
	"description" text,
	"address_line1" text NOT NULL,
	"address_line2" text,
	"city" text NOT NULL,
	"region" text,
	"postal_code" text,
	"country" text NOT NULL,
	"hide_street" boolean DEFAULT false NOT NULL,
	"geo" jsonb,
	"price_minor" bigint NOT NULL,
	"currency" char(3) NOT NULL,
	"rent_period" text,
	"bedrooms" integer,
	"bathrooms" real,
	"area_sqm" real,
	"lot_sqm" real,
	"year_built" integer,
	"features" text[] DEFAULT '{}'::text[] NOT NULL,
	"photos" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"floor_plans" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"virtual_tour_url" text,
	"disclosures" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"vendor_contact_id" uuid,
	"approval_status" text DEFAULT 'not_required' NOT NULL,
	"requested_status" text,
	"pending_changes" jsonb,
	"approval_requested_by" uuid,
	"approval_comment" text,
	"approval_decided_by" uuid,
	"approval_decided_at" timestamp with time zone,
	"first_active_at" timestamp with time zone,
	"published_at" timestamp with time zone,
	"closed_at" timestamp with time zone,
	"closed_price_minor" bigint,
	"withdrawn_at" timestamp with time zone,
	"created_by" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "realty_offer_events" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"offer_id" uuid NOT NULL,
	"action" text NOT NULL,
	"party" text NOT NULL,
	"amount_minor" bigint,
	"currency" char(3),
	"conditions" text[],
	"note" text,
	"actor_user_id" uuid,
	"at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "realty_offers" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"location_id" uuid NOT NULL,
	"listing_id" uuid NOT NULL,
	"buyer_contact_id" uuid,
	"buyer_name" text NOT NULL,
	"enquiry_id" uuid,
	"submitted_by_agent_id" uuid,
	"amount_minor" bigint NOT NULL,
	"currency" char(3) NOT NULL,
	"deposit_minor" bigint,
	"conditions" text[] DEFAULT '{}'::text[] NOT NULL,
	"expires_at" timestamp with time zone,
	"status" text DEFAULT 'submitted' NOT NULL,
	"created_by" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "realty_offices" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"location_id" uuid NOT NULL,
	"tier" text DEFAULT 'standard' NOT NULL,
	"area_unit" text NOT NULL,
	"lead_routing" text DEFAULT 'listing_agent' NOT NULL,
	"round_robin_cursor" integer DEFAULT 0 NOT NULL,
	"viewing_minutes" integer DEFAULT 30 NOT NULL,
	"viewing_buffer_minutes" integer DEFAULT 15 NOT NULL,
	"disclosures" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"brokerage_licence" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "realty_offices_location_id_unique" UNIQUE("location_id")
);
--> statement-breakpoint
CREATE TABLE "realty_open_houses" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"location_id" uuid NOT NULL,
	"listing_id" uuid NOT NULL,
	"agent_id" uuid,
	"starts_at" timestamp with time zone NOT NULL,
	"ends_at" timestamp with time zone NOT NULL,
	"status" text DEFAULT 'scheduled' NOT NULL,
	"rsvps" integer DEFAULT 0 NOT NULL,
	"attendees" integer,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "realty_saved_searches" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"email" text NOT NULL,
	"user_id" uuid,
	"name" text,
	"criteria" jsonb NOT NULL,
	"frequency" text DEFAULT 'weekly' NOT NULL,
	"alerts_consent" boolean DEFAULT false NOT NULL,
	"locale" text DEFAULT 'en' NOT NULL,
	"manage_token_hash" text NOT NULL,
	"last_alerted_at" timestamp with time zone,
	"unsubscribed_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "realty_syndication" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"listing_id" uuid NOT NULL,
	"portal" text NOT NULL,
	"opted_in" boolean DEFAULT false NOT NULL,
	"last_status" text DEFAULT 'not_exported' NOT NULL,
	"last_issues" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"last_exported_at" timestamp with time zone,
	"updated_by" uuid,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "realty_viewings" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"location_id" uuid NOT NULL,
	"listing_id" uuid NOT NULL,
	"agent_id" uuid NOT NULL,
	"enquiry_id" uuid,
	"customer_id" uuid,
	"user_id" uuid,
	"contact_name" text NOT NULL,
	"contact_email" text,
	"contact_phone" text,
	"starts_at" timestamp with time zone NOT NULL,
	"ends_at" timestamp with time zone NOT NULL,
	"kind" text DEFAULT 'in_person' NOT NULL,
	"status" text DEFAULT 'requested' NOT NULL,
	"source" text DEFAULT 'website' NOT NULL,
	"manage_token_hash" text,
	"confirmed_at" timestamp with time zone,
	"cancelled_at" timestamp with time zone,
	"cancel_reason" text,
	"reminder_sent_at" timestamp with time zone,
	"interest_level" text,
	"feedback_rating" integer,
	"feedback_notes" text,
	"feedback_at" timestamp with time zone,
	"feedback_by" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "realty_agents" ADD CONSTRAINT "realty_agents_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "realty_agents" ADD CONSTRAINT "realty_agents_location_id_locations_id_fk" FOREIGN KEY ("location_id") REFERENCES "public"."locations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "realty_agents" ADD CONSTRAINT "realty_agents_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "realty_ai_proposals" ADD CONSTRAINT "realty_ai_proposals_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "realty_alert_deliveries" ADD CONSTRAINT "realty_alert_deliveries_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "realty_alert_deliveries" ADD CONSTRAINT "realty_alert_deliveries_saved_search_id_realty_saved_searches_id_fk" FOREIGN KEY ("saved_search_id") REFERENCES "public"."realty_saved_searches"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "realty_alert_deliveries" ADD CONSTRAINT "realty_alert_deliveries_listing_id_realty_listings_id_fk" FOREIGN KEY ("listing_id") REFERENCES "public"."realty_listings"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "realty_contacts" ADD CONSTRAINT "realty_contacts_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "realty_contacts" ADD CONSTRAINT "realty_contacts_location_id_locations_id_fk" FOREIGN KEY ("location_id") REFERENCES "public"."locations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "realty_contacts" ADD CONSTRAINT "realty_contacts_customer_id_customers_id_fk" FOREIGN KEY ("customer_id") REFERENCES "public"."customers"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "realty_contacts" ADD CONSTRAINT "realty_contacts_owner_agent_id_realty_agents_id_fk" FOREIGN KEY ("owner_agent_id") REFERENCES "public"."realty_agents"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "realty_enquiries" ADD CONSTRAINT "realty_enquiries_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "realty_enquiries" ADD CONSTRAINT "realty_enquiries_location_id_locations_id_fk" FOREIGN KEY ("location_id") REFERENCES "public"."locations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "realty_enquiries" ADD CONSTRAINT "realty_enquiries_listing_id_realty_listings_id_fk" FOREIGN KEY ("listing_id") REFERENCES "public"."realty_listings"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "realty_enquiries" ADD CONSTRAINT "realty_enquiries_customer_id_customers_id_fk" FOREIGN KEY ("customer_id") REFERENCES "public"."customers"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "realty_enquiries" ADD CONSTRAINT "realty_enquiries_assigned_agent_id_realty_agents_id_fk" FOREIGN KEY ("assigned_agent_id") REFERENCES "public"."realty_agents"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "realty_favourites" ADD CONSTRAINT "realty_favourites_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "realty_favourites" ADD CONSTRAINT "realty_favourites_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "realty_favourites" ADD CONSTRAINT "realty_favourites_listing_id_realty_listings_id_fk" FOREIGN KEY ("listing_id") REFERENCES "public"."realty_listings"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "realty_listing_agents" ADD CONSTRAINT "realty_listing_agents_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "realty_listing_agents" ADD CONSTRAINT "realty_listing_agents_listing_id_realty_listings_id_fk" FOREIGN KEY ("listing_id") REFERENCES "public"."realty_listings"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "realty_listing_agents" ADD CONSTRAINT "realty_listing_agents_agent_id_realty_agents_id_fk" FOREIGN KEY ("agent_id") REFERENCES "public"."realty_agents"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "realty_listing_history" ADD CONSTRAINT "realty_listing_history_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "realty_listing_history" ADD CONSTRAINT "realty_listing_history_listing_id_realty_listings_id_fk" FOREIGN KEY ("listing_id") REFERENCES "public"."realty_listings"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "realty_listings" ADD CONSTRAINT "realty_listings_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "realty_listings" ADD CONSTRAINT "realty_listings_location_id_locations_id_fk" FOREIGN KEY ("location_id") REFERENCES "public"."locations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "realty_listings" ADD CONSTRAINT "realty_listings_vendor_contact_id_realty_contacts_id_fk" FOREIGN KEY ("vendor_contact_id") REFERENCES "public"."realty_contacts"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "realty_offer_events" ADD CONSTRAINT "realty_offer_events_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "realty_offer_events" ADD CONSTRAINT "realty_offer_events_offer_id_realty_offers_id_fk" FOREIGN KEY ("offer_id") REFERENCES "public"."realty_offers"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "realty_offers" ADD CONSTRAINT "realty_offers_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "realty_offers" ADD CONSTRAINT "realty_offers_location_id_locations_id_fk" FOREIGN KEY ("location_id") REFERENCES "public"."locations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "realty_offers" ADD CONSTRAINT "realty_offers_listing_id_realty_listings_id_fk" FOREIGN KEY ("listing_id") REFERENCES "public"."realty_listings"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "realty_offers" ADD CONSTRAINT "realty_offers_buyer_contact_id_realty_contacts_id_fk" FOREIGN KEY ("buyer_contact_id") REFERENCES "public"."realty_contacts"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "realty_offers" ADD CONSTRAINT "realty_offers_enquiry_id_realty_enquiries_id_fk" FOREIGN KEY ("enquiry_id") REFERENCES "public"."realty_enquiries"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "realty_offers" ADD CONSTRAINT "realty_offers_submitted_by_agent_id_realty_agents_id_fk" FOREIGN KEY ("submitted_by_agent_id") REFERENCES "public"."realty_agents"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "realty_offices" ADD CONSTRAINT "realty_offices_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "realty_offices" ADD CONSTRAINT "realty_offices_location_id_locations_id_fk" FOREIGN KEY ("location_id") REFERENCES "public"."locations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "realty_open_houses" ADD CONSTRAINT "realty_open_houses_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "realty_open_houses" ADD CONSTRAINT "realty_open_houses_location_id_locations_id_fk" FOREIGN KEY ("location_id") REFERENCES "public"."locations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "realty_open_houses" ADD CONSTRAINT "realty_open_houses_listing_id_realty_listings_id_fk" FOREIGN KEY ("listing_id") REFERENCES "public"."realty_listings"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "realty_open_houses" ADD CONSTRAINT "realty_open_houses_agent_id_realty_agents_id_fk" FOREIGN KEY ("agent_id") REFERENCES "public"."realty_agents"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "realty_saved_searches" ADD CONSTRAINT "realty_saved_searches_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "realty_syndication" ADD CONSTRAINT "realty_syndication_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "realty_syndication" ADD CONSTRAINT "realty_syndication_listing_id_realty_listings_id_fk" FOREIGN KEY ("listing_id") REFERENCES "public"."realty_listings"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "realty_viewings" ADD CONSTRAINT "realty_viewings_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "realty_viewings" ADD CONSTRAINT "realty_viewings_location_id_locations_id_fk" FOREIGN KEY ("location_id") REFERENCES "public"."locations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "realty_viewings" ADD CONSTRAINT "realty_viewings_listing_id_realty_listings_id_fk" FOREIGN KEY ("listing_id") REFERENCES "public"."realty_listings"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "realty_viewings" ADD CONSTRAINT "realty_viewings_agent_id_realty_agents_id_fk" FOREIGN KEY ("agent_id") REFERENCES "public"."realty_agents"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "realty_viewings" ADD CONSTRAINT "realty_viewings_enquiry_id_realty_enquiries_id_fk" FOREIGN KEY ("enquiry_id") REFERENCES "public"."realty_enquiries"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "realty_viewings" ADD CONSTRAINT "realty_viewings_customer_id_customers_id_fk" FOREIGN KEY ("customer_id") REFERENCES "public"."customers"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "realty_agents_loc_idx" ON "realty_agents" USING btree ("location_id");--> statement-breakpoint
CREATE UNIQUE INDEX "realty_agents_user_loc_uq" ON "realty_agents" USING btree ("user_id","location_id");--> statement-breakpoint
CREATE INDEX "realty_ai_proposals_org_idx" ON "realty_ai_proposals" USING btree ("organization_id","created_at");--> statement-breakpoint
CREATE UNIQUE INDEX "realty_alert_deliveries_uq" ON "realty_alert_deliveries" USING btree ("saved_search_id","listing_id");--> statement-breakpoint
CREATE INDEX "realty_contacts_loc_idx" ON "realty_contacts" USING btree ("location_id");--> statement-breakpoint
CREATE INDEX "realty_enquiries_loc_created_idx" ON "realty_enquiries" USING btree ("location_id","created_at");--> statement-breakpoint
CREATE UNIQUE INDEX "realty_enquiries_ext_uq" ON "realty_enquiries" USING btree ("organization_id","source","external_ref") WHERE external_ref is not null;--> statement-breakpoint
CREATE UNIQUE INDEX "realty_favourites_uq" ON "realty_favourites" USING btree ("user_id","listing_id");--> statement-breakpoint
CREATE UNIQUE INDEX "realty_listing_agents_uq" ON "realty_listing_agents" USING btree ("listing_id","agent_id");--> statement-breakpoint
CREATE UNIQUE INDEX "realty_listing_lead_uq" ON "realty_listing_agents" USING btree ("listing_id") WHERE role = 'lead';--> statement-breakpoint
CREATE INDEX "realty_listing_history_listing_idx" ON "realty_listing_history" USING btree ("listing_id","at");--> statement-breakpoint
CREATE INDEX "realty_listings_loc_status_idx" ON "realty_listings" USING btree ("location_id","status");--> statement-breakpoint
CREATE UNIQUE INDEX "realty_listings_org_ref_uq" ON "realty_listings" USING btree ("organization_id","reference");--> statement-breakpoint
CREATE INDEX "realty_offer_events_offer_idx" ON "realty_offer_events" USING btree ("offer_id","at");--> statement-breakpoint
CREATE INDEX "realty_offers_listing_idx" ON "realty_offers" USING btree ("listing_id");--> statement-breakpoint
CREATE UNIQUE INDEX "realty_offers_accepted_uq" ON "realty_offers" USING btree ("listing_id") WHERE status = 'accepted';--> statement-breakpoint
CREATE INDEX "realty_open_houses_listing_idx" ON "realty_open_houses" USING btree ("listing_id","starts_at");--> statement-breakpoint
CREATE INDEX "realty_saved_searches_org_idx" ON "realty_saved_searches" USING btree ("organization_id");--> statement-breakpoint
CREATE INDEX "realty_saved_searches_email_idx" ON "realty_saved_searches" USING btree ("email");--> statement-breakpoint
CREATE UNIQUE INDEX "realty_syndication_uq" ON "realty_syndication" USING btree ("listing_id","portal");--> statement-breakpoint
CREATE INDEX "realty_viewings_agent_start_idx" ON "realty_viewings" USING btree ("agent_id","starts_at");--> statement-breakpoint
CREATE INDEX "realty_viewings_listing_idx" ON "realty_viewings" USING btree ("listing_id");