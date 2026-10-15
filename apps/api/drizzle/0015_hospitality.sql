CREATE TABLE "hosp_assignments" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"location_id" uuid NOT NULL,
	"reservation_room_id" uuid NOT NULL,
	"room_id" uuid NOT NULL,
	"bed_id" uuid,
	"date" date NOT NULL
);
--> statement-breakpoint
CREATE TABLE "hosp_beds" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"room_id" uuid NOT NULL,
	"label" text NOT NULL,
	"active" boolean DEFAULT true NOT NULL
);
--> statement-breakpoint
CREATE TABLE "hosp_cancellation_policies" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"location_id" uuid NOT NULL,
	"name" text NOT NULL,
	"non_refundable" boolean DEFAULT false NOT NULL,
	"free_until_hours" integer,
	"late_fee" jsonb DEFAULT '{"type":"first_night"}'::jsonb NOT NULL,
	"no_show_fee" jsonb DEFAULT '{"type":"first_night"}'::jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "hosp_channel_exports" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"location_id" uuid NOT NULL,
	"provider" text NOT NULL,
	"kind" text NOT NULL,
	"payload" jsonb NOT NULL,
	"created_by" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "hosp_daily_rates" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"rate_plan_id" uuid NOT NULL,
	"room_type_id" uuid NOT NULL,
	"date" date NOT NULL,
	"amount_minor" bigint,
	"min_stay" integer,
	"max_stay" integer,
	"closed" boolean DEFAULT false NOT NULL,
	"closed_to_arrival" boolean DEFAULT false NOT NULL,
	"closed_to_departure" boolean DEFAULT false NOT NULL
);
--> statement-breakpoint
CREATE TABLE "hosp_folio_lines" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"location_id" uuid NOT NULL,
	"reservation_id" uuid NOT NULL,
	"kind" text NOT NULL,
	"description" text NOT NULL,
	"service_date" date,
	"amount_minor" bigint NOT NULL,
	"currency" char(3) NOT NULL,
	"method" text,
	"source_type" text,
	"source_id" text,
	"reverses_id" uuid,
	"created_by" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "hosp_hk_tasks" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"location_id" uuid NOT NULL,
	"room_id" uuid NOT NULL,
	"date" date NOT NULL,
	"kind" text NOT NULL,
	"status" text DEFAULT 'todo' NOT NULL,
	"priority" integer DEFAULT 0 NOT NULL,
	"assignee_user_id" uuid,
	"reservation_id" uuid,
	"notes" text,
	"created_by" uuid,
	"completed_by" uuid,
	"completed_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "hosp_inventory" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"location_id" uuid NOT NULL,
	"room_type_id" uuid NOT NULL,
	"date" date NOT NULL,
	"total" integer NOT NULL,
	"sold" integer DEFAULT 0 NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "hosp_inventory_sold_ck" CHECK ("hosp_inventory"."sold" >= 0 and "hosp_inventory"."sold" <= "hosp_inventory"."total"),
	CONSTRAINT "hosp_inventory_total_ck" CHECK ("hosp_inventory"."total" >= 0)
);
--> statement-breakpoint
CREATE TABLE "hosp_message_log" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"location_id" uuid,
	"reservation_id" uuid,
	"kind" text NOT NULL,
	"channel" text NOT NULL,
	"status" text NOT NULL,
	"dedupe_key" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "hosp_properties" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"location_id" uuid NOT NULL,
	"kind" text DEFAULT 'hotel' NOT NULL,
	"description" text,
	"amenities" text[] DEFAULT '{}'::text[] NOT NULL,
	"photos" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"check_in_time" text DEFAULT '15:00' NOT NULL,
	"check_out_time" text DEFAULT '11:00' NOT NULL,
	"hold_minutes" integer DEFAULT 15 NOT NULL,
	"require_inspected" boolean DEFAULT false NOT NULL,
	"registration_fields" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"registration_retention_days" integer DEFAULT 365 NOT NULL,
	"pre_arrival_days" integer DEFAULT 2 NOT NULL,
	"house_rules" text,
	"arrival_instructions" text,
	"outlet_enabled" boolean DEFAULT false NOT NULL,
	"outlet_name" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "hosp_properties_location_id_unique" UNIQUE("location_id")
);
--> statement-breakpoint
CREATE TABLE "hosp_rate_plans" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"location_id" uuid NOT NULL,
	"code" text NOT NULL,
	"name" text NOT NULL,
	"kind" text DEFAULT 'bar' NOT NULL,
	"description" text,
	"currency" char(3) NOT NULL,
	"includes_breakfast" boolean DEFAULT false NOT NULL,
	"inclusions" text[] DEFAULT '{}'::text[] NOT NULL,
	"derived_from_id" uuid,
	"adjustment_bps" integer,
	"min_stay" integer,
	"max_stay" integer,
	"deposit_rule" text DEFAULT 'first_night' NOT NULL,
	"deposit_percent_bps" integer,
	"cancellation_policy_id" uuid,
	"bookable_online" boolean DEFAULT true NOT NULL,
	"active" boolean DEFAULT true NOT NULL,
	"sort_order" integer DEFAULT 0 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "hosp_rate_prices" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"rate_plan_id" uuid NOT NULL,
	"room_type_id" uuid NOT NULL,
	"season_id" uuid,
	"currency" char(3) NOT NULL,
	"amount_minor" bigint NOT NULL,
	"weekday_amounts" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"extra_adult_minor" bigint,
	"extra_child_minor" bigint,
	CONSTRAINT "hosp_rate_prices_uq" UNIQUE NULLS NOT DISTINCT("rate_plan_id","room_type_id","season_id"),
	CONSTRAINT "hosp_rate_prices_amount_ck" CHECK ("hosp_rate_prices"."amount_minor" >= 0)
);
--> statement-breakpoint
CREATE TABLE "hosp_reservation_rooms" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"reservation_id" uuid NOT NULL,
	"room_type_id" uuid NOT NULL,
	"rate_plan_id" uuid NOT NULL,
	"adults" integer NOT NULL,
	"children" integer DEFAULT 0 NOT NULL,
	"nights" jsonb NOT NULL,
	"taxes" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"room_total_minor" bigint NOT NULL,
	"tax_added_minor" bigint DEFAULT 0 NOT NULL,
	"total_minor" bigint NOT NULL,
	"room_id" uuid,
	"bed_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "hosp_reservations" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"location_id" uuid NOT NULL,
	"code" text NOT NULL,
	"status" text DEFAULT 'hold' NOT NULL,
	"source" text DEFAULT 'website' NOT NULL,
	"arrival" date NOT NULL,
	"departure" date NOT NULL,
	"adults" integer NOT NULL,
	"children" integer DEFAULT 0 NOT NULL,
	"group_name" text,
	"customer_id" uuid,
	"guest_name" text NOT NULL,
	"guest_email" text,
	"guest_phone" text,
	"arrival_time" text,
	"special_requests" text,
	"currency" char(3) NOT NULL,
	"room_total_minor" bigint NOT NULL,
	"tax_added_minor" bigint DEFAULT 0 NOT NULL,
	"total_minor" bigint NOT NULL,
	"deposit_required_minor" bigint DEFAULT 0 NOT NULL,
	"deposit_paid_minor" bigint DEFAULT 0 NOT NULL,
	"payment_id" uuid,
	"hold_expires_at" timestamp with time zone,
	"cancellation_policy" jsonb NOT NULL,
	"cancelled_at" timestamp with time zone,
	"cancellation_fee_minor" bigint,
	"cancel_reason" text,
	"no_show_at" timestamp with time zone,
	"checked_in_at" timestamp with time zone,
	"checked_out_at" timestamp with time zone,
	"registration" jsonb,
	"registration_erased_at" timestamp with time zone,
	"message_consent" jsonb DEFAULT '{"email":false,"sms":false}'::jsonb NOT NULL,
	"manage_token_hash" text,
	"timeline" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"created_by" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "hosp_reservations_dates_ck" CHECK ("hosp_reservations"."departure" > "hosp_reservations"."arrival")
);
--> statement-breakpoint
CREATE TABLE "hosp_room_blocks" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"location_id" uuid NOT NULL,
	"room_id" uuid NOT NULL,
	"start_date" date NOT NULL,
	"end_date" date NOT NULL,
	"reason" text NOT NULL,
	"active" boolean DEFAULT true NOT NULL,
	"created_by" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "hosp_room_blocks_range_ck" CHECK ("hosp_room_blocks"."end_date" > "hosp_room_blocks"."start_date")
);
--> statement-breakpoint
CREATE TABLE "hosp_room_types" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"location_id" uuid NOT NULL,
	"code" text NOT NULL,
	"name" text NOT NULL,
	"kind" text DEFAULT 'room' NOT NULL,
	"description" text,
	"beds" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"base_occupancy" integer DEFAULT 2 NOT NULL,
	"max_occupancy" integer DEFAULT 2 NOT NULL,
	"max_adults" integer,
	"size_sqm" real,
	"amenities" text[] DEFAULT '{}'::text[] NOT NULL,
	"photos" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"bookable_online" boolean DEFAULT true NOT NULL,
	"active" boolean DEFAULT true NOT NULL,
	"sort_order" integer DEFAULT 0 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "hosp_rooms" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"location_id" uuid NOT NULL,
	"room_type_id" uuid NOT NULL,
	"number" text NOT NULL,
	"floor" text,
	"hk_status" text DEFAULT 'clean' NOT NULL,
	"notes" text,
	"active" boolean DEFAULT true NOT NULL,
	"sort_order" integer DEFAULT 0 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "hosp_seasons" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"location_id" uuid NOT NULL,
	"name" text NOT NULL,
	"start_date" date NOT NULL,
	"end_date" date NOT NULL,
	"min_stay" integer,
	"max_stay" integer,
	"priority" integer DEFAULT 0 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "hosp_seasons_range_ck" CHECK ("hosp_seasons"."end_date" >= "hosp_seasons"."start_date")
);
--> statement-breakpoint
CREATE TABLE "hosp_taxes" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"location_id" uuid NOT NULL,
	"name" text NOT NULL,
	"kind" text NOT NULL,
	"rate_bps" integer,
	"amount_minor" bigint,
	"currency" char(3) NOT NULL,
	"inclusive" boolean DEFAULT false NOT NULL,
	"max_nights" integer,
	"applies_to_children" boolean DEFAULT false NOT NULL,
	"note" text,
	"active" boolean DEFAULT true NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "hosp_assignments" ADD CONSTRAINT "hosp_assignments_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "hosp_assignments" ADD CONSTRAINT "hosp_assignments_location_id_locations_id_fk" FOREIGN KEY ("location_id") REFERENCES "public"."locations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "hosp_assignments" ADD CONSTRAINT "hosp_assignments_reservation_room_id_hosp_reservation_rooms_id_fk" FOREIGN KEY ("reservation_room_id") REFERENCES "public"."hosp_reservation_rooms"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "hosp_assignments" ADD CONSTRAINT "hosp_assignments_room_id_hosp_rooms_id_fk" FOREIGN KEY ("room_id") REFERENCES "public"."hosp_rooms"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "hosp_assignments" ADD CONSTRAINT "hosp_assignments_bed_id_hosp_beds_id_fk" FOREIGN KEY ("bed_id") REFERENCES "public"."hosp_beds"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "hosp_beds" ADD CONSTRAINT "hosp_beds_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "hosp_beds" ADD CONSTRAINT "hosp_beds_room_id_hosp_rooms_id_fk" FOREIGN KEY ("room_id") REFERENCES "public"."hosp_rooms"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "hosp_cancellation_policies" ADD CONSTRAINT "hosp_cancellation_policies_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "hosp_cancellation_policies" ADD CONSTRAINT "hosp_cancellation_policies_location_id_locations_id_fk" FOREIGN KEY ("location_id") REFERENCES "public"."locations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "hosp_channel_exports" ADD CONSTRAINT "hosp_channel_exports_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "hosp_channel_exports" ADD CONSTRAINT "hosp_channel_exports_location_id_locations_id_fk" FOREIGN KEY ("location_id") REFERENCES "public"."locations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "hosp_daily_rates" ADD CONSTRAINT "hosp_daily_rates_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "hosp_daily_rates" ADD CONSTRAINT "hosp_daily_rates_rate_plan_id_hosp_rate_plans_id_fk" FOREIGN KEY ("rate_plan_id") REFERENCES "public"."hosp_rate_plans"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "hosp_daily_rates" ADD CONSTRAINT "hosp_daily_rates_room_type_id_hosp_room_types_id_fk" FOREIGN KEY ("room_type_id") REFERENCES "public"."hosp_room_types"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "hosp_folio_lines" ADD CONSTRAINT "hosp_folio_lines_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "hosp_folio_lines" ADD CONSTRAINT "hosp_folio_lines_location_id_locations_id_fk" FOREIGN KEY ("location_id") REFERENCES "public"."locations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "hosp_folio_lines" ADD CONSTRAINT "hosp_folio_lines_reservation_id_hosp_reservations_id_fk" FOREIGN KEY ("reservation_id") REFERENCES "public"."hosp_reservations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "hosp_hk_tasks" ADD CONSTRAINT "hosp_hk_tasks_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "hosp_hk_tasks" ADD CONSTRAINT "hosp_hk_tasks_location_id_locations_id_fk" FOREIGN KEY ("location_id") REFERENCES "public"."locations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "hosp_hk_tasks" ADD CONSTRAINT "hosp_hk_tasks_room_id_hosp_rooms_id_fk" FOREIGN KEY ("room_id") REFERENCES "public"."hosp_rooms"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "hosp_inventory" ADD CONSTRAINT "hosp_inventory_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "hosp_inventory" ADD CONSTRAINT "hosp_inventory_location_id_locations_id_fk" FOREIGN KEY ("location_id") REFERENCES "public"."locations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "hosp_inventory" ADD CONSTRAINT "hosp_inventory_room_type_id_hosp_room_types_id_fk" FOREIGN KEY ("room_type_id") REFERENCES "public"."hosp_room_types"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "hosp_message_log" ADD CONSTRAINT "hosp_message_log_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "hosp_properties" ADD CONSTRAINT "hosp_properties_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "hosp_properties" ADD CONSTRAINT "hosp_properties_location_id_locations_id_fk" FOREIGN KEY ("location_id") REFERENCES "public"."locations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "hosp_rate_plans" ADD CONSTRAINT "hosp_rate_plans_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "hosp_rate_plans" ADD CONSTRAINT "hosp_rate_plans_location_id_locations_id_fk" FOREIGN KEY ("location_id") REFERENCES "public"."locations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "hosp_rate_plans" ADD CONSTRAINT "hosp_rate_plans_cancellation_policy_id_hosp_cancellation_policies_id_fk" FOREIGN KEY ("cancellation_policy_id") REFERENCES "public"."hosp_cancellation_policies"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "hosp_rate_prices" ADD CONSTRAINT "hosp_rate_prices_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "hosp_rate_prices" ADD CONSTRAINT "hosp_rate_prices_rate_plan_id_hosp_rate_plans_id_fk" FOREIGN KEY ("rate_plan_id") REFERENCES "public"."hosp_rate_plans"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "hosp_rate_prices" ADD CONSTRAINT "hosp_rate_prices_room_type_id_hosp_room_types_id_fk" FOREIGN KEY ("room_type_id") REFERENCES "public"."hosp_room_types"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "hosp_rate_prices" ADD CONSTRAINT "hosp_rate_prices_season_id_hosp_seasons_id_fk" FOREIGN KEY ("season_id") REFERENCES "public"."hosp_seasons"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "hosp_reservation_rooms" ADD CONSTRAINT "hosp_reservation_rooms_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "hosp_reservation_rooms" ADD CONSTRAINT "hosp_reservation_rooms_reservation_id_hosp_reservations_id_fk" FOREIGN KEY ("reservation_id") REFERENCES "public"."hosp_reservations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "hosp_reservation_rooms" ADD CONSTRAINT "hosp_reservation_rooms_room_type_id_hosp_room_types_id_fk" FOREIGN KEY ("room_type_id") REFERENCES "public"."hosp_room_types"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "hosp_reservation_rooms" ADD CONSTRAINT "hosp_reservation_rooms_rate_plan_id_hosp_rate_plans_id_fk" FOREIGN KEY ("rate_plan_id") REFERENCES "public"."hosp_rate_plans"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "hosp_reservation_rooms" ADD CONSTRAINT "hosp_reservation_rooms_room_id_hosp_rooms_id_fk" FOREIGN KEY ("room_id") REFERENCES "public"."hosp_rooms"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "hosp_reservation_rooms" ADD CONSTRAINT "hosp_reservation_rooms_bed_id_hosp_beds_id_fk" FOREIGN KEY ("bed_id") REFERENCES "public"."hosp_beds"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "hosp_reservations" ADD CONSTRAINT "hosp_reservations_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "hosp_reservations" ADD CONSTRAINT "hosp_reservations_location_id_locations_id_fk" FOREIGN KEY ("location_id") REFERENCES "public"."locations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "hosp_reservations" ADD CONSTRAINT "hosp_reservations_customer_id_customers_id_fk" FOREIGN KEY ("customer_id") REFERENCES "public"."customers"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "hosp_room_blocks" ADD CONSTRAINT "hosp_room_blocks_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "hosp_room_blocks" ADD CONSTRAINT "hosp_room_blocks_location_id_locations_id_fk" FOREIGN KEY ("location_id") REFERENCES "public"."locations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "hosp_room_blocks" ADD CONSTRAINT "hosp_room_blocks_room_id_hosp_rooms_id_fk" FOREIGN KEY ("room_id") REFERENCES "public"."hosp_rooms"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "hosp_room_types" ADD CONSTRAINT "hosp_room_types_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "hosp_room_types" ADD CONSTRAINT "hosp_room_types_location_id_locations_id_fk" FOREIGN KEY ("location_id") REFERENCES "public"."locations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "hosp_rooms" ADD CONSTRAINT "hosp_rooms_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "hosp_rooms" ADD CONSTRAINT "hosp_rooms_location_id_locations_id_fk" FOREIGN KEY ("location_id") REFERENCES "public"."locations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "hosp_rooms" ADD CONSTRAINT "hosp_rooms_room_type_id_hosp_room_types_id_fk" FOREIGN KEY ("room_type_id") REFERENCES "public"."hosp_room_types"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "hosp_seasons" ADD CONSTRAINT "hosp_seasons_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "hosp_seasons" ADD CONSTRAINT "hosp_seasons_location_id_locations_id_fk" FOREIGN KEY ("location_id") REFERENCES "public"."locations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "hosp_taxes" ADD CONSTRAINT "hosp_taxes_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "hosp_taxes" ADD CONSTRAINT "hosp_taxes_location_id_locations_id_fk" FOREIGN KEY ("location_id") REFERENCES "public"."locations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "hosp_assignments_room_night_uq" ON "hosp_assignments" USING btree ("room_id","date") WHERE "hosp_assignments"."bed_id" is null;--> statement-breakpoint
CREATE UNIQUE INDEX "hosp_assignments_bed_night_uq" ON "hosp_assignments" USING btree ("bed_id","date") WHERE "hosp_assignments"."bed_id" is not null;--> statement-breakpoint
CREATE INDEX "hosp_assignments_loc_date_idx" ON "hosp_assignments" USING btree ("location_id","date");--> statement-breakpoint
CREATE UNIQUE INDEX "hosp_beds_room_label_uq" ON "hosp_beds" USING btree ("room_id","label");--> statement-breakpoint
CREATE UNIQUE INDEX "hosp_daily_rates_uq" ON "hosp_daily_rates" USING btree ("rate_plan_id","room_type_id","date");--> statement-breakpoint
CREATE INDEX "hosp_folio_res_idx" ON "hosp_folio_lines" USING btree ("reservation_id");--> statement-breakpoint
CREATE UNIQUE INDEX "hosp_folio_source_uq" ON "hosp_folio_lines" USING btree ("kind","source_type","source_id") WHERE "hosp_folio_lines"."source_id" is not null;--> statement-breakpoint
CREATE INDEX "hosp_hk_tasks_loc_date_idx" ON "hosp_hk_tasks" USING btree ("location_id","date");--> statement-breakpoint
CREATE UNIQUE INDEX "hosp_hk_tasks_generated_uq" ON "hosp_hk_tasks" USING btree ("room_id","date","kind") WHERE "hosp_hk_tasks"."kind" <> 'maintenance';--> statement-breakpoint
CREATE UNIQUE INDEX "hosp_inventory_type_date_uq" ON "hosp_inventory" USING btree ("room_type_id","date");--> statement-breakpoint
CREATE INDEX "hosp_inventory_loc_date_idx" ON "hosp_inventory" USING btree ("location_id","date");--> statement-breakpoint
CREATE UNIQUE INDEX "hosp_message_dedupe_uq" ON "hosp_message_log" USING btree ("organization_id","dedupe_key");--> statement-breakpoint
CREATE UNIQUE INDEX "hosp_rate_plans_loc_code_uq" ON "hosp_rate_plans" USING btree ("location_id","code");--> statement-breakpoint
CREATE INDEX "hosp_reservation_rooms_res_idx" ON "hosp_reservation_rooms" USING btree ("reservation_id");--> statement-breakpoint
CREATE UNIQUE INDEX "hosp_reservations_org_code_uq" ON "hosp_reservations" USING btree ("organization_id","code");--> statement-breakpoint
CREATE INDEX "hosp_reservations_loc_arrival_idx" ON "hosp_reservations" USING btree ("location_id","arrival");--> statement-breakpoint
CREATE INDEX "hosp_reservations_loc_status_idx" ON "hosp_reservations" USING btree ("location_id","status");--> statement-breakpoint
CREATE INDEX "hosp_room_blocks_room_idx" ON "hosp_room_blocks" USING btree ("room_id");--> statement-breakpoint
CREATE UNIQUE INDEX "hosp_room_types_loc_code_uq" ON "hosp_room_types" USING btree ("location_id","code");--> statement-breakpoint
CREATE UNIQUE INDEX "hosp_rooms_loc_number_uq" ON "hosp_rooms" USING btree ("location_id","number");--> statement-breakpoint
CREATE INDEX "hosp_rooms_type_idx" ON "hosp_rooms" USING btree ("room_type_id");