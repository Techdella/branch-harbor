CREATE TABLE "partner_sync_log" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"connection_id" uuid,
	"provider" text NOT NULL,
	"location_id" uuid,
	"action" text NOT NULL,
	"target_type" text,
	"target_id" text,
	"status" text NOT NULL,
	"http_status" integer,
	"message" text,
	"detail" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "partner_webhook_events" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"provider" text NOT NULL,
	"event_key" text NOT NULL,
	"organization_id" uuid,
	"connection_id" uuid,
	"kind" text NOT NULL,
	"outcome" text DEFAULT 'processed' NOT NULL,
	"detail" text,
	"payload" jsonb NOT NULL,
	"received_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "realty_listing_portal_fields" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"listing_id" uuid NOT NULL,
	"price_qualifier" text,
	"tenure" text,
	"council_tax_band" text,
	"energy_rating" text,
	"available_from" text,
	"remote_ids" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"updated_by" uuid,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "realty_listing_portal_fields_listing_id_unique" UNIQUE("listing_id")
);
--> statement-breakpoint
ALTER TABLE "partner_sync_log" ADD CONSTRAINT "partner_sync_log_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "partner_sync_log" ADD CONSTRAINT "partner_sync_log_connection_id_connections_id_fk" FOREIGN KEY ("connection_id") REFERENCES "public"."connections"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "partner_webhook_events" ADD CONSTRAINT "partner_webhook_events_connection_id_connections_id_fk" FOREIGN KEY ("connection_id") REFERENCES "public"."connections"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "realty_listing_portal_fields" ADD CONSTRAINT "realty_listing_portal_fields_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "realty_listing_portal_fields" ADD CONSTRAINT "realty_listing_portal_fields_listing_id_realty_listings_id_fk" FOREIGN KEY ("listing_id") REFERENCES "public"."realty_listings"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "partner_sync_log_conn_idx" ON "partner_sync_log" USING btree ("connection_id","created_at");--> statement-breakpoint
CREATE INDEX "partner_sync_log_org_idx" ON "partner_sync_log" USING btree ("organization_id","provider","created_at");--> statement-breakpoint
CREATE UNIQUE INDEX "partner_webhook_events_uq" ON "partner_webhook_events" USING btree ("provider","event_key");--> statement-breakpoint
-- Custom: rename the old sandbox portal ids to the real portal ids (realtor_ca_style and zillow_style both map to reso_xml).
DELETE FROM "realty_syndication" a USING "realty_syndication" b WHERE a."portal" = 'realtor_ca_style' AND b."portal" = 'zillow_style' AND a."listing_id" = b."listing_id";--> statement-breakpoint
UPDATE "realty_syndication" SET "portal" = CASE "portal" WHEN 'rightmove_style' THEN 'rightmove' WHEN 'idealista_style' THEN 'idealista' ELSE 'reso_xml' END WHERE "portal" IN ('rightmove_style', 'idealista_style', 'zillow_style', 'realtor_ca_style');
