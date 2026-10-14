CREATE TABLE "wellness_ai_drafts" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"location_id" uuid,
	"kind" text NOT NULL,
	"target_id" uuid,
	"input" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"output" text NOT NULL,
	"removed_claims" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"sources" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"status" text DEFAULT 'proposed' NOT NULL,
	"model" text,
	"created_by" uuid NOT NULL,
	"decided_by" uuid,
	"decided_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "wellness_appointment_charges" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"location_id" uuid NOT NULL,
	"appointment_id" uuid NOT NULL,
	"kind" text NOT NULL,
	"fee_minor" bigint NOT NULL,
	"currency" char(3) NOT NULL,
	"retained_from_deposit_minor" bigint DEFAULT 0 NOT NULL,
	"retained_from_voucher_minor" bigint DEFAULT 0 NOT NULL,
	"outstanding_minor" bigint DEFAULT 0 NOT NULL,
	"refunded_minor" bigint DEFAULT 0 NOT NULL,
	"status" text NOT NULL,
	"created_by" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "wellness_availability_exceptions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"practitioner_id" uuid NOT NULL,
	"location_id" uuid,
	"starts_at" timestamp with time zone NOT NULL,
	"ends_at" timestamp with time zone NOT NULL,
	"kind" text DEFAULT 'leave' NOT NULL,
	"reason" text,
	"status" text DEFAULT 'active' NOT NULL,
	"created_by" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "wellness_exceptions_range_chk" CHECK ("wellness_availability_exceptions"."ends_at" > "wellness_availability_exceptions"."starts_at")
);
--> statement-breakpoint
CREATE TABLE "wellness_client_notes" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"customer_id" uuid NOT NULL,
	"location_id" uuid NOT NULL,
	"appointment_id" uuid,
	"author_user_id" uuid NOT NULL,
	"body" text NOT NULL,
	"confidential" boolean DEFAULT false NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "wellness_client_packages" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"location_id" uuid NOT NULL,
	"plan_id" uuid NOT NULL,
	"customer_id" uuid NOT NULL,
	"sessions_total" integer NOT NULL,
	"sessions_used" integer DEFAULT 0 NOT NULL,
	"price_minor" bigint NOT NULL,
	"currency" char(3) NOT NULL,
	"purchased_at" timestamp with time zone,
	"expires_at" timestamp with time zone,
	"status" text DEFAULT 'pending_payment' NOT NULL,
	"shared_with_customer_ids" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"payment_id" uuid,
	"paid_via" text,
	"manage_token_hash" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "wellness_client_packages_sessions_chk" CHECK ("wellness_client_packages"."sessions_used" >= 0 AND "wellness_client_packages"."sessions_used" <= "wellness_client_packages"."sessions_total")
);
--> statement-breakpoint
CREATE TABLE "wellness_client_preferences" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"customer_id" uuid NOT NULL,
	"preferred_practitioner_ids" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"preferred_location_id" uuid,
	"preferred_channel" text DEFAULT 'email' NOT NULL,
	"comfort" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"updated_by" uuid,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "wellness_gift_vouchers" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"code" text NOT NULL,
	"location_id" uuid,
	"initial_minor" bigint NOT NULL,
	"balance_minor" bigint NOT NULL,
	"currency" char(3) NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"status" text DEFAULT 'pending_payment' NOT NULL,
	"purchaser_customer_id" uuid,
	"recipient_name" text,
	"recipient_email" text,
	"message" text,
	"payment_id" uuid,
	"manage_token_hash" text,
	"created_by" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "wellness_vouchers_balance_chk" CHECK ("wellness_gift_vouchers"."balance_minor" >= 0 AND "wellness_gift_vouchers"."balance_minor" <= "wellness_gift_vouchers"."initial_minor" AND "wellness_gift_vouchers"."initial_minor" > 0)
);
--> statement-breakpoint
CREATE TABLE "wellness_location_settings" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"location_id" uuid NOT NULL,
	"reminder_hours_before" integer DEFAULT 24 NOT NULL,
	"sms_reminders" boolean DEFAULT true NOT NULL,
	"email_reminders" boolean DEFAULT true NOT NULL,
	"rebook_prompts" boolean DEFAULT true NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "wellness_message_log" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"location_id" uuid,
	"appointment_id" uuid,
	"customer_id" uuid,
	"kind" text NOT NULL,
	"channel" text NOT NULL,
	"status" text NOT NULL,
	"dedupe_key" text,
	"detail" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "wellness_package_plans" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"location_id" uuid,
	"name" text NOT NULL,
	"description" text,
	"service_id" uuid NOT NULL,
	"variant_id" uuid,
	"sessions" integer NOT NULL,
	"price_minor" bigint NOT NULL,
	"currency" char(3) NOT NULL,
	"validity_days" integer DEFAULT 365 NOT NULL,
	"sharing" text DEFAULT 'personal' NOT NULL,
	"max_shared_with" integer DEFAULT 0 NOT NULL,
	"online_purchasable" boolean DEFAULT true NOT NULL,
	"active" boolean DEFAULT true NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "wellness_plans_chk" CHECK ("wellness_package_plans"."sessions" > 0 AND "wellness_package_plans"."price_minor" >= 0 AND "wellness_package_plans"."validity_days" > 0)
);
--> statement-breakpoint
CREATE TABLE "wellness_package_redemptions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"client_package_id" uuid NOT NULL,
	"appointment_id" uuid NOT NULL,
	"customer_id" uuid NOT NULL,
	"redeemed_at" timestamp with time zone DEFAULT now() NOT NULL,
	"reversed_at" timestamp with time zone,
	"reversal_reason" text
);
--> statement-breakpoint
CREATE TABLE "wellness_practitioner_locations" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"practitioner_id" uuid NOT NULL,
	"location_id" uuid NOT NULL,
	"availability" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"active" boolean DEFAULT true NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "wellness_resource_reservations" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"location_id" uuid NOT NULL,
	"resource_id" uuid NOT NULL,
	"appointment_id" uuid NOT NULL,
	"blocked_from" timestamp with time zone NOT NULL,
	"blocked_until" timestamp with time zone NOT NULL,
	"role" text DEFAULT 'room' NOT NULL,
	"active" boolean DEFAULT true NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "wellness_series" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"location_id" uuid NOT NULL,
	"customer_id" uuid NOT NULL,
	"service_id" uuid NOT NULL,
	"variant_id" uuid,
	"practitioner_id" uuid,
	"frequency" text DEFAULT 'weekly' NOT NULL,
	"interval_weeks" integer DEFAULT 1 NOT NULL,
	"occurrences" integer NOT NULL,
	"first_date" text NOT NULL,
	"local_time" text NOT NULL,
	"status" text DEFAULT 'active' NOT NULL,
	"created_by" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "wellness_service_variants" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"service_id" uuid NOT NULL,
	"name" text NOT NULL,
	"duration_minutes" integer NOT NULL,
	"buffer_before_minutes" integer,
	"buffer_after_minutes" integer,
	"sort_order" integer DEFAULT 0 NOT NULL,
	"active" boolean DEFAULT true NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "wellness_variant_prices" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"variant_id" uuid NOT NULL,
	"location_id" uuid NOT NULL,
	"price_minor" bigint NOT NULL,
	"deposit_minor" bigint,
	"currency" char(3) NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "wellness_variant_prices_amount_chk" CHECK ("wellness_variant_prices"."price_minor" >= 0 AND ("wellness_variant_prices"."deposit_minor" IS NULL OR ("wellness_variant_prices"."deposit_minor" >= 0 AND "wellness_variant_prices"."deposit_minor" <= "wellness_variant_prices"."price_minor")))
);
--> statement-breakpoint
CREATE TABLE "wellness_voucher_transactions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"voucher_id" uuid NOT NULL,
	"kind" text NOT NULL,
	"amount_minor" bigint NOT NULL,
	"balance_after_minor" bigint NOT NULL,
	"appointment_id" uuid,
	"actor_user_id" uuid,
	"note" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "wellness_waitlist" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"location_id" uuid NOT NULL,
	"service_id" uuid NOT NULL,
	"variant_id" uuid,
	"practitioner_id" uuid,
	"customer_id" uuid NOT NULL,
	"window_start" timestamp with time zone NOT NULL,
	"window_end" timestamp with time zone NOT NULL,
	"status" text DEFAULT 'waiting' NOT NULL,
	"offered_at" timestamp with time zone,
	"offered_starts_at" timestamp with time zone,
	"offered_practitioner_id" uuid,
	"appointment_id" uuid,
	"manage_token_hash" text,
	"note" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "wellness_waitlist_window_chk" CHECK ("wellness_waitlist"."window_end" > "wellness_waitlist"."window_start")
);
--> statement-breakpoint
ALTER TABLE "appointments" ADD COLUMN "variant_id" uuid;--> statement-breakpoint
ALTER TABLE "appointments" ADD COLUMN "group_id" uuid;--> statement-breakpoint
ALTER TABLE "appointments" ADD COLUMN "series_id" uuid;--> statement-breakpoint
ALTER TABLE "appointments" ADD COLUMN "source" text DEFAULT 'web' NOT NULL;--> statement-breakpoint
ALTER TABLE "appointments" ADD COLUMN "deposit_minor" bigint DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "appointments" ADD COLUMN "voucher_applied_minor" bigint DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "appointments" ADD COLUMN "client_package_id" uuid;--> statement-breakpoint
ALTER TABLE "appointments" ADD COLUMN "checked_in_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "appointments" ADD COLUMN "cancelled_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "appointments" ADD COLUMN "cancellation_kind" text;--> statement-breakpoint
ALTER TABLE "services" ADD COLUMN "category" text;--> statement-breakpoint
ALTER TABLE "services" ADD COLUMN "online_bookable" boolean DEFAULT true NOT NULL;--> statement-breakpoint
ALTER TABLE "services" ADD COLUMN "practitioners_required" integer DEFAULT 1 NOT NULL;--> statement-breakpoint
ALTER TABLE "services" ADD COLUMN "equipment_types" jsonb DEFAULT '[]'::jsonb NOT NULL;--> statement-breakpoint
ALTER TABLE "services" ADD COLUMN "deposit_rule" jsonb;--> statement-breakpoint
ALTER TABLE "services" ADD COLUMN "policy" jsonb;--> statement-breakpoint
ALTER TABLE "services" ADD COLUMN "rebook_after_weeks" integer;--> statement-breakpoint
ALTER TABLE "services" ADD COLUMN "updated_at" timestamp with time zone DEFAULT now() NOT NULL;--> statement-breakpoint
ALTER TABLE "wellness_ai_drafts" ADD CONSTRAINT "wellness_ai_drafts_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "wellness_appointment_charges" ADD CONSTRAINT "wellness_appointment_charges_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "wellness_appointment_charges" ADD CONSTRAINT "wellness_appointment_charges_appointment_id_appointments_id_fk" FOREIGN KEY ("appointment_id") REFERENCES "public"."appointments"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "wellness_availability_exceptions" ADD CONSTRAINT "wellness_availability_exceptions_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "wellness_availability_exceptions" ADD CONSTRAINT "wellness_availability_exceptions_practitioner_id_practitioners_id_fk" FOREIGN KEY ("practitioner_id") REFERENCES "public"."practitioners"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "wellness_availability_exceptions" ADD CONSTRAINT "wellness_availability_exceptions_location_id_locations_id_fk" FOREIGN KEY ("location_id") REFERENCES "public"."locations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "wellness_client_notes" ADD CONSTRAINT "wellness_client_notes_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "wellness_client_notes" ADD CONSTRAINT "wellness_client_notes_customer_id_customers_id_fk" FOREIGN KEY ("customer_id") REFERENCES "public"."customers"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "wellness_client_notes" ADD CONSTRAINT "wellness_client_notes_location_id_locations_id_fk" FOREIGN KEY ("location_id") REFERENCES "public"."locations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "wellness_client_packages" ADD CONSTRAINT "wellness_client_packages_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "wellness_client_packages" ADD CONSTRAINT "wellness_client_packages_location_id_locations_id_fk" FOREIGN KEY ("location_id") REFERENCES "public"."locations"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "wellness_client_packages" ADD CONSTRAINT "wellness_client_packages_plan_id_wellness_package_plans_id_fk" FOREIGN KEY ("plan_id") REFERENCES "public"."wellness_package_plans"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "wellness_client_packages" ADD CONSTRAINT "wellness_client_packages_customer_id_customers_id_fk" FOREIGN KEY ("customer_id") REFERENCES "public"."customers"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "wellness_client_preferences" ADD CONSTRAINT "wellness_client_preferences_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "wellness_client_preferences" ADD CONSTRAINT "wellness_client_preferences_customer_id_customers_id_fk" FOREIGN KEY ("customer_id") REFERENCES "public"."customers"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "wellness_gift_vouchers" ADD CONSTRAINT "wellness_gift_vouchers_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "wellness_gift_vouchers" ADD CONSTRAINT "wellness_gift_vouchers_location_id_locations_id_fk" FOREIGN KEY ("location_id") REFERENCES "public"."locations"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "wellness_location_settings" ADD CONSTRAINT "wellness_location_settings_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "wellness_location_settings" ADD CONSTRAINT "wellness_location_settings_location_id_locations_id_fk" FOREIGN KEY ("location_id") REFERENCES "public"."locations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "wellness_message_log" ADD CONSTRAINT "wellness_message_log_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "wellness_package_plans" ADD CONSTRAINT "wellness_package_plans_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "wellness_package_plans" ADD CONSTRAINT "wellness_package_plans_location_id_locations_id_fk" FOREIGN KEY ("location_id") REFERENCES "public"."locations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "wellness_package_plans" ADD CONSTRAINT "wellness_package_plans_service_id_services_id_fk" FOREIGN KEY ("service_id") REFERENCES "public"."services"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "wellness_package_redemptions" ADD CONSTRAINT "wellness_package_redemptions_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "wellness_package_redemptions" ADD CONSTRAINT "wellness_package_redemptions_client_package_id_wellness_client_packages_id_fk" FOREIGN KEY ("client_package_id") REFERENCES "public"."wellness_client_packages"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "wellness_package_redemptions" ADD CONSTRAINT "wellness_package_redemptions_appointment_id_appointments_id_fk" FOREIGN KEY ("appointment_id") REFERENCES "public"."appointments"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "wellness_practitioner_locations" ADD CONSTRAINT "wellness_practitioner_locations_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "wellness_practitioner_locations" ADD CONSTRAINT "wellness_practitioner_locations_practitioner_id_practitioners_id_fk" FOREIGN KEY ("practitioner_id") REFERENCES "public"."practitioners"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "wellness_practitioner_locations" ADD CONSTRAINT "wellness_practitioner_locations_location_id_locations_id_fk" FOREIGN KEY ("location_id") REFERENCES "public"."locations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "wellness_resource_reservations" ADD CONSTRAINT "wellness_resource_reservations_resource_id_resources_id_fk" FOREIGN KEY ("resource_id") REFERENCES "public"."resources"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "wellness_resource_reservations" ADD CONSTRAINT "wellness_resource_reservations_appointment_id_appointments_id_fk" FOREIGN KEY ("appointment_id") REFERENCES "public"."appointments"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "wellness_series" ADD CONSTRAINT "wellness_series_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "wellness_series" ADD CONSTRAINT "wellness_series_location_id_locations_id_fk" FOREIGN KEY ("location_id") REFERENCES "public"."locations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "wellness_series" ADD CONSTRAINT "wellness_series_customer_id_customers_id_fk" FOREIGN KEY ("customer_id") REFERENCES "public"."customers"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "wellness_series" ADD CONSTRAINT "wellness_series_service_id_services_id_fk" FOREIGN KEY ("service_id") REFERENCES "public"."services"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "wellness_service_variants" ADD CONSTRAINT "wellness_service_variants_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "wellness_service_variants" ADD CONSTRAINT "wellness_service_variants_service_id_services_id_fk" FOREIGN KEY ("service_id") REFERENCES "public"."services"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "wellness_variant_prices" ADD CONSTRAINT "wellness_variant_prices_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "wellness_variant_prices" ADD CONSTRAINT "wellness_variant_prices_variant_id_wellness_service_variants_id_fk" FOREIGN KEY ("variant_id") REFERENCES "public"."wellness_service_variants"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "wellness_variant_prices" ADD CONSTRAINT "wellness_variant_prices_location_id_locations_id_fk" FOREIGN KEY ("location_id") REFERENCES "public"."locations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "wellness_voucher_transactions" ADD CONSTRAINT "wellness_voucher_transactions_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "wellness_voucher_transactions" ADD CONSTRAINT "wellness_voucher_transactions_voucher_id_wellness_gift_vouchers_id_fk" FOREIGN KEY ("voucher_id") REFERENCES "public"."wellness_gift_vouchers"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "wellness_waitlist" ADD CONSTRAINT "wellness_waitlist_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "wellness_waitlist" ADD CONSTRAINT "wellness_waitlist_location_id_locations_id_fk" FOREIGN KEY ("location_id") REFERENCES "public"."locations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "wellness_waitlist" ADD CONSTRAINT "wellness_waitlist_service_id_services_id_fk" FOREIGN KEY ("service_id") REFERENCES "public"."services"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "wellness_waitlist" ADD CONSTRAINT "wellness_waitlist_customer_id_customers_id_fk" FOREIGN KEY ("customer_id") REFERENCES "public"."customers"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "wellness_charges_appt_uq" ON "wellness_appointment_charges" USING btree ("appointment_id");--> statement-breakpoint
CREATE INDEX "wellness_exceptions_prac_idx" ON "wellness_availability_exceptions" USING btree ("practitioner_id","starts_at");--> statement-breakpoint
CREATE INDEX "wellness_notes_customer_idx" ON "wellness_client_notes" USING btree ("customer_id");--> statement-breakpoint
CREATE INDEX "wellness_client_packages_customer_idx" ON "wellness_client_packages" USING btree ("customer_id");--> statement-breakpoint
CREATE UNIQUE INDEX "wellness_prefs_customer_uq" ON "wellness_client_preferences" USING btree ("customer_id");--> statement-breakpoint
CREATE UNIQUE INDEX "wellness_vouchers_code_uq" ON "wellness_gift_vouchers" USING btree ("organization_id","code");--> statement-breakpoint
CREATE UNIQUE INDEX "wellness_location_settings_uq" ON "wellness_location_settings" USING btree ("location_id");--> statement-breakpoint
CREATE UNIQUE INDEX "wellness_message_dedupe_uq" ON "wellness_message_log" USING btree ("organization_id","dedupe_key");--> statement-breakpoint
CREATE INDEX "wellness_message_customer_idx" ON "wellness_message_log" USING btree ("customer_id");--> statement-breakpoint
CREATE UNIQUE INDEX "wellness_redemptions_appt_uq" ON "wellness_package_redemptions" USING btree ("appointment_id");--> statement-breakpoint
CREATE INDEX "wellness_redemptions_pkg_idx" ON "wellness_package_redemptions" USING btree ("client_package_id");--> statement-breakpoint
CREATE UNIQUE INDEX "wellness_prac_loc_uq" ON "wellness_practitioner_locations" USING btree ("practitioner_id","location_id");--> statement-breakpoint
CREATE INDEX "wellness_res_resv_appt_idx" ON "wellness_resource_reservations" USING btree ("appointment_id");--> statement-breakpoint
CREATE INDEX "wellness_res_resv_res_idx" ON "wellness_resource_reservations" USING btree ("resource_id","blocked_from");--> statement-breakpoint
CREATE INDEX "wellness_variants_service_idx" ON "wellness_service_variants" USING btree ("service_id");--> statement-breakpoint
CREATE UNIQUE INDEX "wellness_variant_prices_uq" ON "wellness_variant_prices" USING btree ("variant_id","location_id");--> statement-breakpoint
CREATE INDEX "wellness_voucher_tx_voucher_idx" ON "wellness_voucher_transactions" USING btree ("voucher_id");--> statement-breakpoint
CREATE INDEX "wellness_waitlist_loc_idx" ON "wellness_waitlist" USING btree ("location_id","status","window_start");--> statement-breakpoint
CREATE INDEX "appointments_customer_idx" ON "appointments" USING btree ("customer_id");--> statement-breakpoint
CREATE INDEX "appointments_group_idx" ON "appointments" USING btree ("group_id");