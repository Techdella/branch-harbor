CREATE TABLE "food_catering_enquiries" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"location_id" uuid NOT NULL,
	"customer_id" uuid,
	"reference" text NOT NULL,
	"contact" jsonb NOT NULL,
	"event_date" text NOT NULL,
	"event_time" text,
	"guests" integer NOT NULL,
	"package_id" uuid,
	"fulfilment" text DEFAULT 'pickup' NOT NULL,
	"address" jsonb,
	"notes" text,
	"dietary_notes" text,
	"status" text DEFAULT 'new' NOT NULL,
	"quote" jsonb,
	"currency" char(3) NOT NULL,
	"deposit_payment_id" uuid,
	"accepted_at" timestamp with time zone,
	"deposit_paid_at" timestamp with time zone,
	"confirmed_at" timestamp with time zone,
	"declined_reason" text,
	"token_hash" text NOT NULL,
	"status_history" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "food_catering_packages" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"name" text NOT NULL,
	"description" text,
	"translations" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"prices_per_guest" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"min_guests" integer DEFAULT 10 NOT NULL,
	"max_guests" integer,
	"lead_days" integer DEFAULT 3 NOT NULL,
	"includes" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"dietary" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"allergens" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"allergens_declared" boolean DEFAULT false NOT NULL,
	"location_ids" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"active" boolean DEFAULT true NOT NULL,
	"sort_order" integer DEFAULT 0 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "food_day_parts" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"name" text NOT NULL,
	"translations" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"windows" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"sort_order" integer DEFAULT 0 NOT NULL,
	"active" boolean DEFAULT true NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "food_day_parts_uq" UNIQUE("organization_id","name")
);
--> statement-breakpoint
CREATE TABLE "food_deliveries" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"location_id" uuid NOT NULL,
	"order_id" uuid NOT NULL,
	"provider" text DEFAULT 'own' NOT NULL,
	"driver_id" uuid,
	"external_id" text,
	"status" text DEFAULT 'pending' NOT NULL,
	"tracking_url" text,
	"fee_quote_minor" bigint,
	"currency" char(3) NOT NULL,
	"sandbox" boolean DEFAULT false NOT NULL,
	"events" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "food_deliveries_order_id_unique" UNIQUE("order_id")
);
--> statement-breakpoint
CREATE TABLE "food_delivery_slots" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"location_id" uuid NOT NULL,
	"starts_at" timestamp with time zone NOT NULL,
	"ends_at" timestamp with time zone NOT NULL,
	"capacity" integer NOT NULL,
	"booked" integer DEFAULT 0 NOT NULL,
	"cutoff_at" timestamp with time zone NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "food_delivery_zones" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"location_id" uuid NOT NULL,
	"name" text NOT NULL,
	"kind" text NOT NULL,
	"radius_meters" integer,
	"postcodes" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"fee_minor" bigint DEFAULT 0 NOT NULL,
	"minimum_order_minor" bigint DEFAULT 0 NOT NULL,
	"free_delivery_above_minor" bigint,
	"currency" char(3) NOT NULL,
	"active" boolean DEFAULT true NOT NULL,
	"sort_order" integer DEFAULT 0 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "food_drivers" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"location_id" uuid NOT NULL,
	"user_id" uuid,
	"name" text NOT NULL,
	"phone" text,
	"active" boolean DEFAULT true NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "food_ingredient_movements" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"location_id" uuid NOT NULL,
	"ingredient_id" uuid NOT NULL,
	"delta" integer NOT NULL,
	"reason" text NOT NULL,
	"order_id" uuid,
	"balance_after" integer NOT NULL,
	"note" text,
	"created_by" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "food_ingredient_stock" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"location_id" uuid NOT NULL,
	"ingredient_id" uuid NOT NULL,
	"on_hand" integer DEFAULT 0 NOT NULL,
	"low_stock_threshold" integer DEFAULT 0 NOT NULL,
	"auto_sold_out" boolean DEFAULT false NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "food_ingredient_stock_uq" UNIQUE("location_id","ingredient_id")
);
--> statement-breakpoint
CREATE TABLE "food_ingredients" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"name" text NOT NULL,
	"unit" text NOT NULL,
	"sku" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "food_ingredients_uq" UNIQUE("organization_id","name")
);
--> statement-breakpoint
CREATE TABLE "food_kds_tickets" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"location_id" uuid NOT NULL,
	"order_id" uuid NOT NULL,
	"station_id" uuid NOT NULL,
	"lines" jsonb NOT NULL,
	"status" text DEFAULT 'queued' NOT NULL,
	"target_at" timestamp with time zone NOT NULL,
	"started_at" timestamp with time zone,
	"bumped_at" timestamp with time zone,
	"recalled_count" integer DEFAULT 0 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "food_kds_tickets_uq" UNIQUE("order_id","station_id")
);
--> statement-breakpoint
CREATE TABLE "food_location_settings" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"location_id" uuid NOT NULL,
	"config" jsonb NOT NULL,
	"updated_by" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "food_location_settings_location_id_unique" UNIQUE("location_id")
);
--> statement-breakpoint
CREATE TABLE "food_meal_plan_boxes" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"location_id" uuid NOT NULL,
	"subscription_id" uuid NOT NULL,
	"week_start" text NOT NULL,
	"fulfilment_date" text NOT NULL,
	"status" text DEFAULT 'scheduled' NOT NULL,
	"food_order_id" uuid,
	"items" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "food_meal_plan_boxes_uq" UNIQUE("subscription_id","week_start")
);
--> statement-breakpoint
CREATE TABLE "food_meal_plan_subscriptions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"location_id" uuid NOT NULL,
	"plan_id" uuid NOT NULL,
	"customer_id" uuid,
	"contact" jsonb NOT NULL,
	"status" text DEFAULT 'pending_payment' NOT NULL,
	"provider" text DEFAULT 'stripe' NOT NULL,
	"external_id" text,
	"sandbox" boolean DEFAULT false NOT NULL,
	"price_minor" bigint NOT NULL,
	"currency" char(3) NOT NULL,
	"start_week" text NOT NULL,
	"skipped_weeks" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"address" jsonb,
	"zone_id" uuid,
	"token_hash" text NOT NULL,
	"cancelled_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "food_meal_plans" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"name" text NOT NULL,
	"description" text,
	"translations" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"meals_per_box" integer DEFAULT 5 NOT NULL,
	"prices_per_week" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"fulfilment" text DEFAULT 'pickup' NOT NULL,
	"fulfilment_weekday" integer DEFAULT 1 NOT NULL,
	"cutoff_days_before" integer DEFAULT 3 NOT NULL,
	"cutoff_time" text DEFAULT '18:00' NOT NULL,
	"menu_item_ids" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"location_ids" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"active" boolean DEFAULT true NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "food_menu_categories" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"menu_id" uuid NOT NULL,
	"name" text NOT NULL,
	"description" text,
	"translations" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"day_part_ids" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"sort_order" integer DEFAULT 0 NOT NULL,
	"active" boolean DEFAULT true NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "food_menu_categories_uq" UNIQUE("menu_id","name")
);
--> statement-breakpoint
CREATE TABLE "food_menu_publications" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"menu_id" uuid NOT NULL,
	"location_id" uuid NOT NULL,
	"status" text NOT NULL,
	"detail" jsonb NOT NULL,
	"published_by" uuid,
	"published_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "food_production_dates" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"location_id" uuid NOT NULL,
	"date" text NOT NULL,
	"menu_id" uuid,
	"cutoff_at" timestamp with time zone NOT NULL,
	"collection_windows" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"capacity" integer NOT NULL,
	"booked" integer DEFAULT 0 NOT NULL,
	"status" text DEFAULT 'open' NOT NULL,
	"note" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "food_production_dates_uq" UNIQUE("location_id","date")
);
--> statement-breakpoint
CREATE TABLE "food_recipe_lines" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"menu_item_id" uuid NOT NULL,
	"modifier_id" uuid,
	"ingredient_id" uuid NOT NULL,
	"quantity" integer NOT NULL,
	CONSTRAINT "food_recipe_lines_uq" UNIQUE NULLS NOT DISTINCT("menu_item_id","modifier_id","ingredient_id")
);
--> statement-breakpoint
CREATE TABLE "food_sold_out_events" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"location_id" uuid NOT NULL,
	"menu_item_id" uuid,
	"modifier_id" uuid,
	"source" text NOT NULL,
	"started_at" timestamp with time zone DEFAULT now() NOT NULL,
	"ended_at" timestamp with time zone,
	"created_by" uuid
);
--> statement-breakpoint
CREATE TABLE "food_stations" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"location_id" uuid NOT NULL,
	"key" text NOT NULL,
	"name" text NOT NULL,
	"prep_target_minutes" integer DEFAULT 12 NOT NULL,
	"is_expo" boolean DEFAULT false NOT NULL,
	"sort_order" integer DEFAULT 0 NOT NULL,
	"active" boolean DEFAULT true NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "food_stations_uq" UNIQUE("location_id","key")
);
--> statement-breakpoint
CREATE TABLE "food_tables" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"location_id" uuid NOT NULL,
	"label" text NOT NULL,
	"code" text NOT NULL,
	"seats" integer DEFAULT 2 NOT NULL,
	"area" text,
	"active" boolean DEFAULT true NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "food_tables_code_unique" UNIQUE("code"),
	CONSTRAINT "food_tables_label_uq" UNIQUE("location_id","label")
);
--> statement-breakpoint
CREATE TABLE "food_tabs" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"location_id" uuid NOT NULL,
	"table_id" uuid NOT NULL,
	"status" text DEFAULT 'open' NOT NULL,
	"guest_name" text,
	"token_hash" text NOT NULL,
	"currency" char(3) NOT NULL,
	"tip_minor" bigint DEFAULT 0 NOT NULL,
	"payment_id" uuid,
	"paid_via" text,
	"opened_at" timestamp with time zone DEFAULT now() NOT NULL,
	"closed_at" timestamp with time zone
);
--> statement-breakpoint
ALTER TABLE "food_orders" ADD COLUMN "channel" text DEFAULT 'pickup' NOT NULL;--> statement-breakpoint
ALTER TABLE "food_orders" ADD COLUMN "fulfilment" jsonb DEFAULT '{}'::jsonb NOT NULL;--> statement-breakpoint
ALTER TABLE "food_orders" ADD COLUMN "tip_minor" bigint DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "food_orders" ADD COLUMN "delivery_fee_minor" bigint DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "menu_items" ADD COLUMN "category_id" uuid;--> statement-breakpoint
ALTER TABLE "menu_items" ADD COLUMN "translations" jsonb DEFAULT '{}'::jsonb NOT NULL;--> statement-breakpoint
ALTER TABLE "menu_items" ADD COLUMN "allergens_declared" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "menu_items" ADD COLUMN "day_part_ids" jsonb DEFAULT '[]'::jsonb NOT NULL;--> statement-breakpoint
ALTER TABLE "menu_items" ADD COLUMN "station_key" text;--> statement-breakpoint
ALTER TABLE "menu_items" ADD COLUMN "prep_minutes" integer;--> statement-breakpoint
ALTER TABLE "menu_items" ADD COLUMN "images" jsonb DEFAULT '[]'::jsonb NOT NULL;--> statement-breakpoint
ALTER TABLE "menus" ADD COLUMN "kind" text DEFAULT 'standard' NOT NULL;--> statement-breakpoint
ALTER TABLE "menus" ADD COLUMN "description" text;--> statement-breakpoint
ALTER TABLE "menus" ADD COLUMN "day_part_ids" jsonb DEFAULT '[]'::jsonb NOT NULL;--> statement-breakpoint
ALTER TABLE "modifier_groups" ADD COLUMN "translations" jsonb DEFAULT '{}'::jsonb NOT NULL;--> statement-breakpoint
ALTER TABLE "modifier_groups" ADD COLUMN "sort_order" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "modifiers" ADD COLUMN "translations" jsonb DEFAULT '{}'::jsonb NOT NULL;--> statement-breakpoint
ALTER TABLE "modifiers" ADD COLUMN "allergens" jsonb DEFAULT '[]'::jsonb NOT NULL;--> statement-breakpoint
ALTER TABLE "modifiers" ADD COLUMN "sort_order" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "food_catering_enquiries" ADD CONSTRAINT "food_catering_enquiries_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "food_catering_enquiries" ADD CONSTRAINT "food_catering_enquiries_location_id_locations_id_fk" FOREIGN KEY ("location_id") REFERENCES "public"."locations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "food_catering_enquiries" ADD CONSTRAINT "food_catering_enquiries_package_id_food_catering_packages_id_fk" FOREIGN KEY ("package_id") REFERENCES "public"."food_catering_packages"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "food_catering_packages" ADD CONSTRAINT "food_catering_packages_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "food_day_parts" ADD CONSTRAINT "food_day_parts_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "food_deliveries" ADD CONSTRAINT "food_deliveries_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "food_deliveries" ADD CONSTRAINT "food_deliveries_location_id_locations_id_fk" FOREIGN KEY ("location_id") REFERENCES "public"."locations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "food_deliveries" ADD CONSTRAINT "food_deliveries_order_id_food_orders_id_fk" FOREIGN KEY ("order_id") REFERENCES "public"."food_orders"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "food_deliveries" ADD CONSTRAINT "food_deliveries_driver_id_food_drivers_id_fk" FOREIGN KEY ("driver_id") REFERENCES "public"."food_drivers"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "food_delivery_slots" ADD CONSTRAINT "food_delivery_slots_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "food_delivery_slots" ADD CONSTRAINT "food_delivery_slots_location_id_locations_id_fk" FOREIGN KEY ("location_id") REFERENCES "public"."locations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "food_delivery_zones" ADD CONSTRAINT "food_delivery_zones_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "food_delivery_zones" ADD CONSTRAINT "food_delivery_zones_location_id_locations_id_fk" FOREIGN KEY ("location_id") REFERENCES "public"."locations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "food_drivers" ADD CONSTRAINT "food_drivers_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "food_drivers" ADD CONSTRAINT "food_drivers_location_id_locations_id_fk" FOREIGN KEY ("location_id") REFERENCES "public"."locations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "food_ingredient_movements" ADD CONSTRAINT "food_ingredient_movements_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "food_ingredient_movements" ADD CONSTRAINT "food_ingredient_movements_location_id_locations_id_fk" FOREIGN KEY ("location_id") REFERENCES "public"."locations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "food_ingredient_movements" ADD CONSTRAINT "food_ingredient_movements_ingredient_id_food_ingredients_id_fk" FOREIGN KEY ("ingredient_id") REFERENCES "public"."food_ingredients"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "food_ingredient_stock" ADD CONSTRAINT "food_ingredient_stock_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "food_ingredient_stock" ADD CONSTRAINT "food_ingredient_stock_location_id_locations_id_fk" FOREIGN KEY ("location_id") REFERENCES "public"."locations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "food_ingredient_stock" ADD CONSTRAINT "food_ingredient_stock_ingredient_id_food_ingredients_id_fk" FOREIGN KEY ("ingredient_id") REFERENCES "public"."food_ingredients"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "food_ingredients" ADD CONSTRAINT "food_ingredients_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "food_kds_tickets" ADD CONSTRAINT "food_kds_tickets_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "food_kds_tickets" ADD CONSTRAINT "food_kds_tickets_location_id_locations_id_fk" FOREIGN KEY ("location_id") REFERENCES "public"."locations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "food_kds_tickets" ADD CONSTRAINT "food_kds_tickets_order_id_food_orders_id_fk" FOREIGN KEY ("order_id") REFERENCES "public"."food_orders"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "food_kds_tickets" ADD CONSTRAINT "food_kds_tickets_station_id_food_stations_id_fk" FOREIGN KEY ("station_id") REFERENCES "public"."food_stations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "food_location_settings" ADD CONSTRAINT "food_location_settings_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "food_location_settings" ADD CONSTRAINT "food_location_settings_location_id_locations_id_fk" FOREIGN KEY ("location_id") REFERENCES "public"."locations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "food_meal_plan_boxes" ADD CONSTRAINT "food_meal_plan_boxes_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "food_meal_plan_boxes" ADD CONSTRAINT "food_meal_plan_boxes_location_id_locations_id_fk" FOREIGN KEY ("location_id") REFERENCES "public"."locations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "food_meal_plan_boxes" ADD CONSTRAINT "food_meal_plan_boxes_subscription_id_food_meal_plan_subscriptions_id_fk" FOREIGN KEY ("subscription_id") REFERENCES "public"."food_meal_plan_subscriptions"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "food_meal_plan_subscriptions" ADD CONSTRAINT "food_meal_plan_subscriptions_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "food_meal_plan_subscriptions" ADD CONSTRAINT "food_meal_plan_subscriptions_location_id_locations_id_fk" FOREIGN KEY ("location_id") REFERENCES "public"."locations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "food_meal_plan_subscriptions" ADD CONSTRAINT "food_meal_plan_subscriptions_plan_id_food_meal_plans_id_fk" FOREIGN KEY ("plan_id") REFERENCES "public"."food_meal_plans"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "food_meal_plans" ADD CONSTRAINT "food_meal_plans_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "food_menu_categories" ADD CONSTRAINT "food_menu_categories_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "food_menu_categories" ADD CONSTRAINT "food_menu_categories_menu_id_menus_id_fk" FOREIGN KEY ("menu_id") REFERENCES "public"."menus"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "food_menu_publications" ADD CONSTRAINT "food_menu_publications_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "food_menu_publications" ADD CONSTRAINT "food_menu_publications_menu_id_menus_id_fk" FOREIGN KEY ("menu_id") REFERENCES "public"."menus"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "food_menu_publications" ADD CONSTRAINT "food_menu_publications_location_id_locations_id_fk" FOREIGN KEY ("location_id") REFERENCES "public"."locations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "food_production_dates" ADD CONSTRAINT "food_production_dates_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "food_production_dates" ADD CONSTRAINT "food_production_dates_location_id_locations_id_fk" FOREIGN KEY ("location_id") REFERENCES "public"."locations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "food_production_dates" ADD CONSTRAINT "food_production_dates_menu_id_menus_id_fk" FOREIGN KEY ("menu_id") REFERENCES "public"."menus"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "food_recipe_lines" ADD CONSTRAINT "food_recipe_lines_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "food_recipe_lines" ADD CONSTRAINT "food_recipe_lines_menu_item_id_menu_items_id_fk" FOREIGN KEY ("menu_item_id") REFERENCES "public"."menu_items"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "food_recipe_lines" ADD CONSTRAINT "food_recipe_lines_modifier_id_modifiers_id_fk" FOREIGN KEY ("modifier_id") REFERENCES "public"."modifiers"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "food_recipe_lines" ADD CONSTRAINT "food_recipe_lines_ingredient_id_food_ingredients_id_fk" FOREIGN KEY ("ingredient_id") REFERENCES "public"."food_ingredients"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "food_sold_out_events" ADD CONSTRAINT "food_sold_out_events_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "food_sold_out_events" ADD CONSTRAINT "food_sold_out_events_location_id_locations_id_fk" FOREIGN KEY ("location_id") REFERENCES "public"."locations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "food_sold_out_events" ADD CONSTRAINT "food_sold_out_events_menu_item_id_menu_items_id_fk" FOREIGN KEY ("menu_item_id") REFERENCES "public"."menu_items"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "food_sold_out_events" ADD CONSTRAINT "food_sold_out_events_modifier_id_modifiers_id_fk" FOREIGN KEY ("modifier_id") REFERENCES "public"."modifiers"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "food_stations" ADD CONSTRAINT "food_stations_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "food_stations" ADD CONSTRAINT "food_stations_location_id_locations_id_fk" FOREIGN KEY ("location_id") REFERENCES "public"."locations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "food_tables" ADD CONSTRAINT "food_tables_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "food_tables" ADD CONSTRAINT "food_tables_location_id_locations_id_fk" FOREIGN KEY ("location_id") REFERENCES "public"."locations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "food_tabs" ADD CONSTRAINT "food_tabs_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "food_tabs" ADD CONSTRAINT "food_tabs_location_id_locations_id_fk" FOREIGN KEY ("location_id") REFERENCES "public"."locations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "food_tabs" ADD CONSTRAINT "food_tabs_table_id_food_tables_id_fk" FOREIGN KEY ("table_id") REFERENCES "public"."food_tables"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "food_catering_enquiries_idx" ON "food_catering_enquiries" USING btree ("organization_id","status","event_date");--> statement-breakpoint
CREATE UNIQUE INDEX "food_delivery_slots_uq" ON "food_delivery_slots" USING btree ("location_id","starts_at");--> statement-breakpoint
CREATE INDEX "food_delivery_zones_loc_idx" ON "food_delivery_zones" USING btree ("location_id");--> statement-breakpoint
CREATE INDEX "food_ingredient_movements_idx" ON "food_ingredient_movements" USING btree ("location_id","ingredient_id","created_at");--> statement-breakpoint
CREATE INDEX "food_kds_tickets_station_idx" ON "food_kds_tickets" USING btree ("station_id","status");--> statement-breakpoint
CREATE INDEX "food_meal_plan_subs_idx" ON "food_meal_plan_subscriptions" USING btree ("organization_id","status");--> statement-breakpoint
CREATE INDEX "food_menu_publications_idx" ON "food_menu_publications" USING btree ("menu_id","location_id","published_at");--> statement-breakpoint
CREATE INDEX "food_sold_out_events_idx" ON "food_sold_out_events" USING btree ("location_id","started_at");--> statement-breakpoint
CREATE UNIQUE INDEX "food_tabs_one_open" ON "food_tabs" USING btree ("table_id") WHERE "food_tabs"."status" = 'open';