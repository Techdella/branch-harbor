CREATE TABLE "class_series" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"location_id" uuid NOT NULL,
	"class_type_id" uuid NOT NULL,
	"status" text DEFAULT 'draft' NOT NULL,
	"recurrence" jsonb NOT NULL,
	"time_zone" text NOT NULL,
	"duration_minutes" integer NOT NULL,
	"instructor_user_id" uuid,
	"instructor_name" text,
	"room_id" uuid,
	"room_name" text,
	"capacity" integer NOT NULL,
	"price_minor" bigint DEFAULT 0 NOT NULL,
	"currency" char(3) NOT NULL,
	"credit_cost" integer DEFAULT 1 NOT NULL,
	"allow_credits" boolean DEFAULT true NOT NULL,
	"allow_membership" boolean DEFAULT true NOT NULL,
	"online" boolean DEFAULT false NOT NULL,
	"split_from_id" uuid,
	"created_by" uuid,
	"published_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "instructor_availability" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"location_id" uuid,
	"user_id" uuid NOT NULL,
	"kind" text DEFAULT 'available' NOT NULL,
	"weekday" integer,
	"on_date" date,
	"start_time" text NOT NULL,
	"end_time" text NOT NULL,
	"time_zone" text NOT NULL,
	"note" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "membership_invoices" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"membership_id" uuid NOT NULL,
	"period_start" timestamp with time zone NOT NULL,
	"period_end" timestamp with time zone NOT NULL,
	"amount_minor" bigint NOT NULL,
	"currency" char(3) NOT NULL,
	"status" text DEFAULT 'open' NOT NULL,
	"attempts" integer DEFAULT 0 NOT NULL,
	"payment_id" uuid,
	"external_id" text,
	"failure_reason" text,
	"paid_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "online_access_grants" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"content_id" uuid NOT NULL,
	"customer_id" uuid NOT NULL,
	"kind" text NOT NULL,
	"basis" text NOT NULL,
	"purchase_id" uuid,
	"joined_at" timestamp with time zone,
	"revoked_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "online_content" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"location_id" uuid,
	"kind" text NOT NULL,
	"title" text NOT NULL,
	"description" text,
	"class_type_id" uuid,
	"occurrence_id" uuid,
	"instructor_name" text,
	"provider" text NOT NULL,
	"provider_url" text NOT NULL,
	"starts_at" timestamp with time zone,
	"duration_minutes" integer,
	"allow_members" boolean DEFAULT true NOT NULL,
	"allow_pack_holders" boolean DEFAULT false NOT NULL,
	"prices" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"allow_free" boolean DEFAULT false NOT NULL,
	"status" text DEFAULT 'draft' NOT NULL,
	"published_at" timestamp with time zone,
	"created_by" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "studio_ai_proposals" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"location_id" uuid,
	"kind" text NOT NULL,
	"title" text NOT NULL,
	"payload" jsonb NOT NULL,
	"source" text NOT NULL,
	"status" text DEFAULT 'proposed' NOT NULL,
	"created_by" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "studio_customer_notifications" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"location_id" uuid NOT NULL,
	"customer_id" uuid NOT NULL,
	"occurrence_id" uuid,
	"series_id" uuid,
	"kind" text NOT NULL,
	"channel" text NOT NULL,
	"subject" text NOT NULL,
	"body" text NOT NULL,
	"status" text DEFAULT 'queued' NOT NULL,
	"batch_id" uuid,
	"sent_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "studio_fees" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"location_id" uuid NOT NULL,
	"customer_id" uuid NOT NULL,
	"booking_id" uuid NOT NULL,
	"kind" text NOT NULL,
	"amount_minor" bigint NOT NULL,
	"currency" char(3) NOT NULL,
	"status" text DEFAULT 'due' NOT NULL,
	"purchase_id" uuid,
	"waived_by" uuid,
	"waive_reason" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "studio_membership_plans" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"location_id" uuid,
	"name" text NOT NULL,
	"description" text,
	"classes_per_period" integer,
	"prices" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"access_policy" text DEFAULT 'home_only' NOT NULL,
	"allowed_location_ids" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"notice_days" integer DEFAULT 30 NOT NULL,
	"max_pause_days" integer DEFAULT 60 NOT NULL,
	"grace_days" integer DEFAULT 7 NOT NULL,
	"status" text DEFAULT 'active' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "studio_pack_products" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"location_id" uuid,
	"name" text NOT NULL,
	"description" text,
	"credits" integer NOT NULL,
	"validity_days" integer NOT NULL,
	"prices" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"transfer_policy" text DEFAULT 'home_only' NOT NULL,
	"allowed_location_ids" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"class_type_ids" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"status" text DEFAULT 'active' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "studio_policies" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"location_id" uuid,
	"late_cancel_minutes" integer DEFAULT 720 NOT NULL,
	"late_cancel_fee" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"no_show_fee" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"forfeit_credit_on_late_cancel" boolean DEFAULT true NOT NULL,
	"refund_paid_on_late_cancel" boolean DEFAULT false NOT NULL,
	"fees_apply_to_members" boolean DEFAULT true NOT NULL,
	"booking_window_days" integer DEFAULT 30 NOT NULL,
	"updated_by" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "studio_portal_tokens" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"customer_id" uuid NOT NULL,
	"kind" text NOT NULL,
	"token_hash" text NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"used_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "studio_portal_tokens_token_hash_unique" UNIQUE("token_hash")
);
--> statement-breakpoint
CREATE TABLE "studio_purchases" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"location_id" uuid NOT NULL,
	"customer_id" uuid NOT NULL,
	"kind" text NOT NULL,
	"product_id" uuid,
	"offer_id" uuid,
	"name" text NOT NULL,
	"list_price_minor" bigint NOT NULL,
	"discount_minor" bigint DEFAULT 0 NOT NULL,
	"amount_minor" bigint NOT NULL,
	"currency" char(3) NOT NULL,
	"status" text DEFAULT 'pending' NOT NULL,
	"payment_id" uuid,
	"result_id" uuid,
	"source" text DEFAULT 'web' NOT NULL,
	"created_by" uuid,
	"paid_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "studio_rooms" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"location_id" uuid NOT NULL,
	"name" text NOT NULL,
	"capacity" integer NOT NULL,
	"features" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"active" boolean DEFAULT true NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "class_bookings" ADD COLUMN "payment_method" text DEFAULT 'pay_per_class' NOT NULL;--> statement-breakpoint
ALTER TABLE "class_bookings" ADD COLUMN "membership_id" uuid;--> statement-breakpoint
ALTER TABLE "class_bookings" ADD COLUMN "credits_used" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "class_bookings" ADD COLUMN "credit_returned" boolean;--> statement-breakpoint
ALTER TABLE "class_bookings" ADD COLUMN "late_cancel" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "class_bookings" ADD COLUMN "checked_in_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "class_bookings" ADD COLUMN "checked_in_by" uuid;--> statement-breakpoint
ALTER TABLE "class_bookings" ADD COLUMN "check_in_source" text;--> statement-breakpoint
ALTER TABLE "class_occurrences" ADD COLUMN "room_id" uuid;--> statement-breakpoint
ALTER TABLE "class_occurrences" ADD COLUMN "credit_cost" integer;--> statement-breakpoint
ALTER TABLE "class_occurrences" ADD COLUMN "series_slot_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "class_occurrences" ADD COLUMN "detached" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "class_occurrences" ADD COLUMN "cancel_reason" text;--> statement-breakpoint
ALTER TABLE "class_occurrences" ADD COLUMN "updated_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "class_types" ADD COLUMN "category" text;--> statement-breakpoint
ALTER TABLE "class_types" ADD COLUMN "level" text;--> statement-breakpoint
ALTER TABLE "class_types" ADD COLUMN "archived_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "cover_requests" ADD COLUMN "customers_notified" integer;--> statement-breakpoint
ALTER TABLE "memberships" ADD COLUMN "plan_id" uuid;--> statement-breakpoint
ALTER TABLE "memberships" ADD COLUMN "offer_id" uuid;--> statement-breakpoint
ALTER TABLE "memberships" ADD COLUMN "classes_per_period" integer;--> statement-breakpoint
ALTER TABLE "memberships" ADD COLUMN "access_policy" text DEFAULT 'home_only' NOT NULL;--> statement-breakpoint
ALTER TABLE "memberships" ADD COLUMN "allowed_location_ids" jsonb DEFAULT '[]'::jsonb NOT NULL;--> statement-breakpoint
ALTER TABLE "memberships" ADD COLUMN "recurring" boolean DEFAULT true NOT NULL;--> statement-breakpoint
ALTER TABLE "memberships" ADD COLUMN "current_period_start" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "memberships" ADD COLUMN "current_period_end" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "memberships" ADD COLUMN "paused_from" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "memberships" ADD COLUMN "paused_until" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "memberships" ADD COLUMN "pause_reason" text;--> statement-breakpoint
ALTER TABLE "memberships" ADD COLUMN "cancel_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "memberships" ADD COLUMN "cancel_requested_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "memberships" ADD COLUMN "grace_until" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "memberships" ADD COLUMN "failed_payment_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "memberships" ADD COLUMN "failed_attempts" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "memberships" ADD COLUMN "stripe_customer_id" text;--> statement-breakpoint
ALTER TABLE "memberships" ADD COLUMN "stripe_subscription_id" text;--> statement-breakpoint
ALTER TABLE "memberships" ADD COLUMN "purchase_id" uuid;--> statement-breakpoint
ALTER TABLE "memberships" ADD COLUMN "updated_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "packs" ADD COLUMN "product_id" uuid;--> statement-breakpoint
ALTER TABLE "packs" ADD COLUMN "offer_id" uuid;--> statement-breakpoint
ALTER TABLE "packs" ADD COLUMN "status" text DEFAULT 'active' NOT NULL;--> statement-breakpoint
ALTER TABLE "packs" ADD COLUMN "transfer_policy" text DEFAULT 'home_only' NOT NULL;--> statement-breakpoint
ALTER TABLE "packs" ADD COLUMN "allowed_location_ids" jsonb DEFAULT '[]'::jsonb NOT NULL;--> statement-breakpoint
ALTER TABLE "packs" ADD COLUMN "purchase_id" uuid;--> statement-breakpoint
ALTER TABLE "packs" ADD COLUMN "source" text DEFAULT 'purchase' NOT NULL;--> statement-breakpoint
ALTER TABLE "packs" ADD COLUMN "updated_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "class_series" ADD CONSTRAINT "class_series_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "class_series" ADD CONSTRAINT "class_series_location_id_locations_id_fk" FOREIGN KEY ("location_id") REFERENCES "public"."locations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "class_series" ADD CONSTRAINT "class_series_class_type_id_class_types_id_fk" FOREIGN KEY ("class_type_id") REFERENCES "public"."class_types"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "instructor_availability" ADD CONSTRAINT "instructor_availability_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "instructor_availability" ADD CONSTRAINT "instructor_availability_location_id_locations_id_fk" FOREIGN KEY ("location_id") REFERENCES "public"."locations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "membership_invoices" ADD CONSTRAINT "membership_invoices_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "online_access_grants" ADD CONSTRAINT "online_access_grants_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "online_access_grants" ADD CONSTRAINT "online_access_grants_content_id_online_content_id_fk" FOREIGN KEY ("content_id") REFERENCES "public"."online_content"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "online_access_grants" ADD CONSTRAINT "online_access_grants_customer_id_customers_id_fk" FOREIGN KEY ("customer_id") REFERENCES "public"."customers"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "online_content" ADD CONSTRAINT "online_content_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "online_content" ADD CONSTRAINT "online_content_location_id_locations_id_fk" FOREIGN KEY ("location_id") REFERENCES "public"."locations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "online_content" ADD CONSTRAINT "online_content_occurrence_id_class_occurrences_id_fk" FOREIGN KEY ("occurrence_id") REFERENCES "public"."class_occurrences"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "studio_ai_proposals" ADD CONSTRAINT "studio_ai_proposals_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "studio_ai_proposals" ADD CONSTRAINT "studio_ai_proposals_location_id_locations_id_fk" FOREIGN KEY ("location_id") REFERENCES "public"."locations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "studio_customer_notifications" ADD CONSTRAINT "studio_customer_notifications_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "studio_customer_notifications" ADD CONSTRAINT "studio_customer_notifications_location_id_locations_id_fk" FOREIGN KEY ("location_id") REFERENCES "public"."locations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "studio_customer_notifications" ADD CONSTRAINT "studio_customer_notifications_customer_id_customers_id_fk" FOREIGN KEY ("customer_id") REFERENCES "public"."customers"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "studio_fees" ADD CONSTRAINT "studio_fees_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "studio_fees" ADD CONSTRAINT "studio_fees_location_id_locations_id_fk" FOREIGN KEY ("location_id") REFERENCES "public"."locations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "studio_fees" ADD CONSTRAINT "studio_fees_customer_id_customers_id_fk" FOREIGN KEY ("customer_id") REFERENCES "public"."customers"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "studio_membership_plans" ADD CONSTRAINT "studio_membership_plans_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "studio_membership_plans" ADD CONSTRAINT "studio_membership_plans_location_id_locations_id_fk" FOREIGN KEY ("location_id") REFERENCES "public"."locations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "studio_pack_products" ADD CONSTRAINT "studio_pack_products_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "studio_pack_products" ADD CONSTRAINT "studio_pack_products_location_id_locations_id_fk" FOREIGN KEY ("location_id") REFERENCES "public"."locations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "studio_policies" ADD CONSTRAINT "studio_policies_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "studio_policies" ADD CONSTRAINT "studio_policies_location_id_locations_id_fk" FOREIGN KEY ("location_id") REFERENCES "public"."locations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "studio_portal_tokens" ADD CONSTRAINT "studio_portal_tokens_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "studio_portal_tokens" ADD CONSTRAINT "studio_portal_tokens_customer_id_customers_id_fk" FOREIGN KEY ("customer_id") REFERENCES "public"."customers"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "studio_purchases" ADD CONSTRAINT "studio_purchases_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "studio_purchases" ADD CONSTRAINT "studio_purchases_location_id_locations_id_fk" FOREIGN KEY ("location_id") REFERENCES "public"."locations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "studio_purchases" ADD CONSTRAINT "studio_purchases_customer_id_customers_id_fk" FOREIGN KEY ("customer_id") REFERENCES "public"."customers"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "studio_rooms" ADD CONSTRAINT "studio_rooms_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "studio_rooms" ADD CONSTRAINT "studio_rooms_location_id_locations_id_fk" FOREIGN KEY ("location_id") REFERENCES "public"."locations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "class_series_loc_idx" ON "class_series" USING btree ("location_id");--> statement-breakpoint
CREATE INDEX "instructor_availability_user_idx" ON "instructor_availability" USING btree ("user_id");--> statement-breakpoint
CREATE UNIQUE INDEX "membership_invoices_period_uq" ON "membership_invoices" USING btree ("membership_id","period_start");--> statement-breakpoint
CREATE UNIQUE INDEX "membership_invoices_ext_uq" ON "membership_invoices" USING btree ("external_id");--> statement-breakpoint
CREATE UNIQUE INDEX "online_grants_active_uq" ON "online_access_grants" USING btree ("content_id","customer_id") WHERE revoked_at is null;--> statement-breakpoint
CREATE INDEX "online_content_org_idx" ON "online_content" USING btree ("organization_id");--> statement-breakpoint
CREATE INDEX "studio_notifications_occ_idx" ON "studio_customer_notifications" USING btree ("occurrence_id");--> statement-breakpoint
CREATE INDEX "studio_notifications_status_idx" ON "studio_customer_notifications" USING btree ("status");--> statement-breakpoint
CREATE UNIQUE INDEX "studio_fees_booking_kind_uq" ON "studio_fees" USING btree ("booking_id","kind");--> statement-breakpoint
CREATE UNIQUE INDEX "studio_policies_scope_uq" ON "studio_policies" USING btree ("organization_id",coalesce("location_id", '00000000-0000-0000-0000-000000000000'::uuid));--> statement-breakpoint
CREATE INDEX "studio_purchases_customer_idx" ON "studio_purchases" USING btree ("customer_id");--> statement-breakpoint
CREATE UNIQUE INDEX "studio_rooms_loc_name_uq" ON "studio_rooms" USING btree ("location_id",lower("name"));--> statement-breakpoint
CREATE INDEX "class_occ_series_idx" ON "class_occurrences" USING btree ("series_id");--> statement-breakpoint
CREATE UNIQUE INDEX "class_occ_series_slot_uq" ON "class_occurrences" USING btree ("series_id","series_slot_at");--> statement-breakpoint
CREATE INDEX "memberships_customer_idx" ON "memberships" USING btree ("customer_id");--> statement-breakpoint
CREATE INDEX "packs_customer_idx" ON "packs" USING btree ("customer_id");