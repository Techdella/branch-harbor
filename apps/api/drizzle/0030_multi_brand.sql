ALTER TABLE "brands" ADD COLUMN "slug" text;--> statement-breakpoint
ALTER TABLE "brands" ADD COLUMN "logo_url" text;--> statement-breakpoint
ALTER TABLE "brands" ADD COLUMN "primary_color" text;--> statement-breakpoint
ALTER TABLE "brands" ADD COLUMN "accent_color" text;--> statement-breakpoint
ALTER TABLE "brands" ADD COLUMN "heading_font" text;--> statement-breakpoint
ALTER TABLE "brands" ADD COLUMN "body_font" text;--> statement-breakpoint
ALTER TABLE "brands" ADD COLUMN "theme_id" text;--> statement-breakpoint
ALTER TABLE "brands" ADD COLUMN "tagline" text;--> statement-breakpoint
ALTER TABLE "brands" ADD COLUMN "domain" text;--> statement-breakpoint
ALTER TABLE "brands" ADD COLUMN "locales" text[] DEFAULT '{}'::text[] NOT NULL;--> statement-breakpoint
ALTER TABLE "brands" ADD COLUMN "default_currency" char(3);--> statement-breakpoint
ALTER TABLE "brands" ADD COLUMN "email_from_name" text;--> statement-breakpoint
ALTER TABLE "brands" ADD COLUMN "email_reply_to" text;--> statement-breakpoint
ALTER TABLE "brands" ADD COLUMN "onboarding_template_key" text;--> statement-breakpoint
ALTER TABLE "brands" ADD COLUMN "settings" jsonb DEFAULT '{}'::jsonb NOT NULL;--> statement-breakpoint
ALTER TABLE "brands" ADD COLUMN "updated_at" timestamp with time zone DEFAULT now() NOT NULL;--> statement-breakpoint
ALTER TABLE "brands" ADD COLUMN "archived_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "templates" ADD COLUMN "brand_id" uuid;--> statement-breakpoint
ALTER TABLE "websites" ADD COLUMN "brand_id" uuid;--> statement-breakpoint
ALTER TABLE "franchise_agreements" ADD COLUMN "brand_id" uuid;--> statement-breakpoint
ALTER TABLE "franchise_documents" ADD COLUMN "brand_id" uuid;--> statement-breakpoint
ALTER TABLE "franchise_projects" ADD COLUMN "brand_id" uuid;--> statement-breakpoint
ALTER TABLE "franchise_prospects" ADD COLUMN "brand_id" uuid;--> statement-breakpoint
ALTER TABLE "franchise_territories" ADD COLUMN "brand_id" uuid;--> statement-breakpoint
ALTER TABLE "ad_campaigns" ADD COLUMN "brand_id" uuid;--> statement-breakpoint
ALTER TABLE "social_accounts" ADD COLUMN "brand_id" uuid;--> statement-breakpoint
ALTER TABLE "brand_assets" ADD COLUMN "brand_id" uuid;--> statement-breakpoint
ALTER TABLE "email_templates" ADD COLUMN "brand_id" uuid;--> statement-breakpoint
ALTER TABLE "royalty_terms" ADD COLUMN "brand_id" uuid;--> statement-breakpoint
ALTER TABLE "templates" ADD CONSTRAINT "templates_brand_id_brands_id_fk" FOREIGN KEY ("brand_id") REFERENCES "public"."brands"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "websites" ADD CONSTRAINT "websites_brand_id_brands_id_fk" FOREIGN KEY ("brand_id") REFERENCES "public"."brands"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "franchise_agreements" ADD CONSTRAINT "franchise_agreements_brand_id_brands_id_fk" FOREIGN KEY ("brand_id") REFERENCES "public"."brands"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "franchise_documents" ADD CONSTRAINT "franchise_documents_brand_id_brands_id_fk" FOREIGN KEY ("brand_id") REFERENCES "public"."brands"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "franchise_projects" ADD CONSTRAINT "franchise_projects_brand_id_brands_id_fk" FOREIGN KEY ("brand_id") REFERENCES "public"."brands"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "franchise_prospects" ADD CONSTRAINT "franchise_prospects_brand_id_brands_id_fk" FOREIGN KEY ("brand_id") REFERENCES "public"."brands"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "franchise_territories" ADD CONSTRAINT "franchise_territories_brand_id_brands_id_fk" FOREIGN KEY ("brand_id") REFERENCES "public"."brands"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ad_campaigns" ADD CONSTRAINT "ad_campaigns_brand_id_brands_id_fk" FOREIGN KEY ("brand_id") REFERENCES "public"."brands"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "social_accounts" ADD CONSTRAINT "social_accounts_brand_id_brands_id_fk" FOREIGN KEY ("brand_id") REFERENCES "public"."brands"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "brand_assets" ADD CONSTRAINT "brand_assets_brand_id_brands_id_fk" FOREIGN KEY ("brand_id") REFERENCES "public"."brands"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "email_templates" ADD CONSTRAINT "email_templates_brand_id_brands_id_fk" FOREIGN KEY ("brand_id") REFERENCES "public"."brands"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "royalty_terms" ADD CONSTRAINT "royalty_terms_brand_id_brands_id_fk" FOREIGN KEY ("brand_id") REFERENCES "public"."brands"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "brands_slug_uq" ON "brands" USING btree ("slug");--> statement-breakpoint
-- The default brand answers on the business's own site address.
UPDATE "brands" b SET "slug" = o."slug" FROM "organizations" o WHERE b."organization_id" = o."id" AND b."is_default" AND b."slug" IS NULL;
