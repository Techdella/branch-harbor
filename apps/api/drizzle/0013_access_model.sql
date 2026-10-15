CREATE TABLE "custom_roles" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"name" text NOT NULL,
	"description" text,
	"base_role" text,
	"primary_workspace" text,
	"created_by" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "member_access_overrides" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"assignment_id" uuid NOT NULL,
	"capability" text NOT NULL,
	"effect" text NOT NULL,
	"created_by" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "role_capabilities" (
	"role_id" uuid NOT NULL,
	"organization_id" uuid NOT NULL,
	"capability" text NOT NULL,
	CONSTRAINT "role_capabilities_role_id_capability_pk" PRIMARY KEY("role_id","capability")
);
--> statement-breakpoint
DROP INDEX "role_assignments_uq";--> statement-breakpoint
ALTER TABLE "invitations" ADD COLUMN "custom_role_id" uuid;--> statement-breakpoint
ALTER TABLE "role_assignments" ADD COLUMN "custom_role_id" uuid;--> statement-breakpoint
ALTER TABLE "users" ADD COLUMN "platform_role" text;--> statement-breakpoint
ALTER TABLE "custom_roles" ADD CONSTRAINT "custom_roles_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "custom_roles" ADD CONSTRAINT "custom_roles_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "member_access_overrides" ADD CONSTRAINT "member_access_overrides_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "member_access_overrides" ADD CONSTRAINT "member_access_overrides_assignment_id_role_assignments_id_fk" FOREIGN KEY ("assignment_id") REFERENCES "public"."role_assignments"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "role_capabilities" ADD CONSTRAINT "role_capabilities_role_id_custom_roles_id_fk" FOREIGN KEY ("role_id") REFERENCES "public"."custom_roles"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "role_capabilities" ADD CONSTRAINT "role_capabilities_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "custom_roles_org_name_uq" ON "custom_roles" USING btree ("organization_id",lower("name"));--> statement-breakpoint
CREATE UNIQUE INDEX "member_access_overrides_uq" ON "member_access_overrides" USING btree ("assignment_id","capability");--> statement-breakpoint
CREATE INDEX "member_access_overrides_org_idx" ON "member_access_overrides" USING btree ("organization_id");--> statement-breakpoint
CREATE UNIQUE INDEX "role_assignments_uq" ON "role_assignments" USING btree ("user_id","role","scope_kind","scope_id",coalesce("custom_role_id", '00000000-0000-0000-0000-000000000000'::uuid));--> statement-breakpoint
ALTER TABLE "role_assignments" ADD CONSTRAINT "role_assignments_custom_role_id_fk" FOREIGN KEY ("custom_role_id") REFERENCES "public"."custom_roles"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "invitations" ADD CONSTRAINT "invitations_custom_role_id_fk" FOREIGN KEY ("custom_role_id") REFERENCES "public"."custom_roles"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "role_assignments" ADD CONSTRAINT "role_assignments_custom_role_ck" CHECK (("role" = 'custom') = ("custom_role_id" IS NOT NULL));--> statement-breakpoint
ALTER TABLE "invitations" ADD CONSTRAINT "invitations_custom_role_ck" CHECK (("role" = 'custom') = ("custom_role_id" IS NOT NULL));--> statement-breakpoint
ALTER TABLE "member_access_overrides" ADD CONSTRAINT "member_access_overrides_effect_ck" CHECK ("effect" IN ('grant', 'revoke'));
