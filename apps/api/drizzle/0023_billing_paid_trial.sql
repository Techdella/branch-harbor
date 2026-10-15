CREATE TABLE "billing_invoices" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"payer" text DEFAULT 'hq' NOT NULL,
	"franchisee_account_id" uuid,
	"kind" text NOT NULL,
	"number" text NOT NULL,
	"currency" char(3) NOT NULL,
	"subtotal_minor" bigint NOT NULL,
	"tax_minor" bigint DEFAULT 0 NOT NULL,
	"total_minor" bigint NOT NULL,
	"status" text NOT NULL,
	"description" text,
	"lines" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"period_start" timestamp with time zone,
	"period_end" timestamp with time zone,
	"stripe_invoice_id" text,
	"hosted_url" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "billing_trial_claims" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"kind" text NOT NULL,
	"value_hash" text NOT NULL,
	"organization_id" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "data_exports" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"requested_by" uuid NOT NULL,
	"status" text DEFAULT 'queued' NOT NULL,
	"file_name" text,
	"size_bytes" integer,
	"files" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"token_hash" text,
	"storage_key" text,
	"content" "bytea",
	"error" text,
	"expires_at" timestamp with time zone,
	"completed_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "franchisee_billing_accounts" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"scope_kind" text NOT NULL,
	"scope_id" uuid NOT NULL,
	"billing_country" char(2) NOT NULL,
	"currency" char(3) NOT NULL,
	"price_list" text NOT NULL,
	"stripe_customer_id" text,
	"stripe_payment_method_id" text,
	"stripe_subscription_id" text,
	"card" jsonb,
	"tax_id" text,
	"status" text DEFAULT 'needs_payment_method' NOT NULL,
	"setup" jsonb,
	"created_by" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "location_fee_payers" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"scope_kind" text NOT NULL,
	"scope_id" uuid NOT NULL,
	"payer" text NOT NULL,
	"franchisee_percent" integer DEFAULT 0 NOT NULL,
	"updated_by" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "location_fee_payers_pct" CHECK ("location_fee_payers"."franchisee_percent" between 0 and 100)
);
--> statement-breakpoint
ALTER TABLE "subscriptions" ALTER COLUMN "status" SET DEFAULT 'checkout_required';--> statement-breakpoint
ALTER TABLE "subscriptions" ADD COLUMN "billing_country" char(2);--> statement-breakpoint
ALTER TABLE "subscriptions" ADD COLUMN "price_list" text;--> statement-breakpoint
ALTER TABLE "subscriptions" ADD COLUMN "price_book_version" text;--> statement-breakpoint
ALTER TABLE "subscriptions" ADD COLUMN "platform_fee_minor" bigint;--> statement-breakpoint
ALTER TABLE "subscriptions" ADD COLUMN "included_locations" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "subscriptions" ADD COLUMN "trial_ends_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "subscriptions" ADD COLUMN "trial_fee_minor" bigint;--> statement-breakpoint
ALTER TABLE "subscriptions" ADD COLUMN "trial_reminders_sent" jsonb DEFAULT '[]'::jsonb NOT NULL;--> statement-breakpoint
ALTER TABLE "subscriptions" ADD COLUMN "cancel_at_period_end" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "subscriptions" ADD COLUMN "canceled_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "subscriptions" ADD COLUMN "stripe_payment_method_id" text;--> statement-breakpoint
ALTER TABLE "subscriptions" ADD COLUMN "card" jsonb;--> statement-breakpoint
ALTER TABLE "subscriptions" ADD COLUMN "tax_id" text;--> statement-breakpoint
ALTER TABLE "subscriptions" ADD COLUMN "tax_id_country" char(2);--> statement-breakpoint
ALTER TABLE "subscriptions" ADD COLUMN "country_evidence" text;--> statement-breakpoint
ALTER TABLE "subscriptions" ADD COLUMN "checkout" jsonb;--> statement-breakpoint
ALTER TABLE "subscriptions" ADD COLUMN "pending_change" jsonb;--> statement-breakpoint
ALTER TABLE "billing_invoices" ADD CONSTRAINT "billing_invoices_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "billing_trial_claims" ADD CONSTRAINT "billing_trial_claims_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "data_exports" ADD CONSTRAINT "data_exports_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "franchisee_billing_accounts" ADD CONSTRAINT "franchisee_billing_accounts_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "location_fee_payers" ADD CONSTRAINT "location_fee_payers_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "billing_invoices_org_idx" ON "billing_invoices" USING btree ("organization_id","created_at");--> statement-breakpoint
CREATE UNIQUE INDEX "billing_invoices_stripe_uq" ON "billing_invoices" USING btree ("stripe_invoice_id");--> statement-breakpoint
CREATE UNIQUE INDEX "billing_trial_claims_kind_value_uq" ON "billing_trial_claims" USING btree ("kind","value_hash");--> statement-breakpoint
CREATE INDEX "billing_trial_claims_org_idx" ON "billing_trial_claims" USING btree ("organization_id");--> statement-breakpoint
CREATE INDEX "data_exports_org_idx" ON "data_exports" USING btree ("organization_id","created_at");--> statement-breakpoint
CREATE UNIQUE INDEX "franchisee_billing_accounts_scope_uq" ON "franchisee_billing_accounts" USING btree ("organization_id","scope_kind","scope_id");--> statement-breakpoint
CREATE UNIQUE INDEX "location_fee_payers_scope_uq" ON "location_fee_payers" USING btree ("organization_id","scope_kind","scope_id");