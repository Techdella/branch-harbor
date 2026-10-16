ALTER TABLE "subscriptions" ADD COLUMN "synced_lines" jsonb DEFAULT '[]'::jsonb NOT NULL;--> statement-breakpoint
ALTER TABLE "franchisee_billing_accounts" ADD COLUMN "subscription_status" text;--> statement-breakpoint
ALTER TABLE "franchisee_billing_accounts" ADD COLUMN "subscription_lines" jsonb DEFAULT '[]'::jsonb NOT NULL;--> statement-breakpoint
ALTER TABLE "franchisee_billing_accounts" ADD COLUMN "current_period_end" timestamp with time zone;