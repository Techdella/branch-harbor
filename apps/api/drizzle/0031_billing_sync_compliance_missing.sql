CREATE TABLE "compliance_missing_reminders" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"requirement_id" uuid NOT NULL,
	"location_id" uuid,
	"owner_group_id" uuid,
	"missing_since" timestamp with time zone NOT NULL,
	"last_reminded_at" timestamp with time zone,
	"reminder_count" integer DEFAULT 0 NOT NULL,
	"escalated_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "subscriptions" ADD COLUMN "synced_lines" jsonb DEFAULT '[]'::jsonb NOT NULL;--> statement-breakpoint
ALTER TABLE "franchisee_billing_accounts" ADD COLUMN "subscription_status" text;--> statement-breakpoint
ALTER TABLE "franchisee_billing_accounts" ADD COLUMN "subscription_lines" jsonb DEFAULT '[]'::jsonb NOT NULL;--> statement-breakpoint
ALTER TABLE "franchisee_billing_accounts" ADD COLUMN "current_period_end" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "compliance_missing_reminders" ADD CONSTRAINT "compliance_missing_reminders_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "compliance_missing_reminders" ADD CONSTRAINT "compliance_missing_reminders_requirement_id_compliance_requirements_id_fk" FOREIGN KEY ("requirement_id") REFERENCES "public"."compliance_requirements"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "compliance_missing_reminders" ADD CONSTRAINT "compliance_missing_reminders_location_id_locations_id_fk" FOREIGN KEY ("location_id") REFERENCES "public"."locations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "compliance_missing_reminders" ADD CONSTRAINT "compliance_missing_reminders_owner_group_id_owner_groups_id_fk" FOREIGN KEY ("owner_group_id") REFERENCES "public"."owner_groups"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "compliance_missing_target_uq" ON "compliance_missing_reminders" USING btree ("requirement_id","location_id","owner_group_id");--> statement-breakpoint
CREATE INDEX "compliance_missing_org_idx" ON "compliance_missing_reminders" USING btree ("organization_id");