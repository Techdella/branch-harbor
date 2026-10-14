CREATE TABLE "off_session_charges" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"location_id" uuid NOT NULL,
	"kind" text NOT NULL,
	"ref_id" uuid NOT NULL,
	"attempt" integer DEFAULT 1 NOT NULL,
	"idempotency_key" text NOT NULL,
	"customer_id" uuid NOT NULL,
	"amount_minor" bigint NOT NULL,
	"currency" char(3) NOT NULL,
	"payment_id" uuid,
	"state" text DEFAULT 'pending' NOT NULL,
	"failure_code" text,
	"failure_message" text,
	"notified_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "payment_consents" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"customer_id" uuid NOT NULL,
	"connected_account_id" text DEFAULT '' NOT NULL,
	"purpose" text NOT NULL,
	"target_type" text,
	"target_id" uuid,
	"payment_id" uuid,
	"text" text NOT NULL,
	"locale" text,
	"source" text DEFAULT 'web' NOT NULL,
	"ip" text,
	"revoked_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "payment_customers" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"customer_id" uuid NOT NULL,
	"connected_account_id" text DEFAULT '' NOT NULL,
	"stripe_customer_id" text NOT NULL,
	"default_payment_method_id" text,
	"card_brand" text,
	"card_last4" text,
	"card_exp_month" integer,
	"card_exp_year" integer,
	"sandbox" boolean DEFAULT false NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "stripe_recurring_prices" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"connected_account_id" text DEFAULT '' NOT NULL,
	"plan_key" text NOT NULL,
	"currency" char(3) NOT NULL,
	"amount_minor" bigint NOT NULL,
	"interval" text NOT NULL,
	"stripe_product_id" text NOT NULL,
	"stripe_price_id" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX "off_session_charges_idem_uq" ON "off_session_charges" USING btree ("idempotency_key");--> statement-breakpoint
CREATE INDEX "off_session_charges_ref_idx" ON "off_session_charges" USING btree ("kind","ref_id");--> statement-breakpoint
CREATE INDEX "off_session_charges_payment_idx" ON "off_session_charges" USING btree ("payment_id");--> statement-breakpoint
CREATE INDEX "payment_consents_target_idx" ON "payment_consents" USING btree ("target_type","target_id","purpose");--> statement-breakpoint
CREATE INDEX "payment_consents_customer_idx" ON "payment_consents" USING btree ("customer_id","purpose");--> statement-breakpoint
CREATE INDEX "payment_consents_payment_idx" ON "payment_consents" USING btree ("payment_id");--> statement-breakpoint
CREATE UNIQUE INDEX "payment_customers_customer_acct_uq" ON "payment_customers" USING btree ("customer_id","connected_account_id");--> statement-breakpoint
CREATE INDEX "payment_customers_stripe_idx" ON "payment_customers" USING btree ("stripe_customer_id");--> statement-breakpoint
CREATE UNIQUE INDEX "stripe_recurring_prices_uq" ON "stripe_recurring_prices" USING btree ("connected_account_id","plan_key","currency","amount_minor","interval");