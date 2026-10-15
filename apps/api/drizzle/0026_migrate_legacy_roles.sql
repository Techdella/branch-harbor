-- Team-based role templates (docs/PRODUCT_PLAN.md "Access model"). The old templates copied one franchisor's team;
-- every stored role key moves to the nearest new template. Where the old template gave more than the new one, the
-- person keeps it as a per-person grant on that assignment, so nobody silently loses access in the move.
--
--   vp_franchise          → development_lead  (+ academy, assignments, course leads view)
--   cmo                   → marketing_lead    (+ community moderation, library, help desk agent, academy authoring)
--   brand_lead            → brand_manager
--   instructor_trainer    → trainer           (+ course leads view/edit)
--   operations_manager    → operations_lead   (+ payments, royalties view, websites, customers and the customer pipeline)
--   finance               → finance_lead
--   legal                 → legal_lead
--   regional_manager      → field_consultant  (+ approvals, campaign and email drafts, websites view, announcements)
--   marketing_contributor → content_social
CREATE TEMP TABLE "_legacy_role_extras" ("role" text NOT NULL, "capability" text NOT NULL);
--> statement-breakpoint
INSERT INTO "_legacy_role_extras" ("role", "capability") VALUES
  ('vp_franchise', 'training.academy:view'), ('vp_franchise', 'training.academy:edit'), ('vp_franchise', 'training.academy:publish'), ('vp_franchise', 'training.academy:export'),
  ('vp_franchise', 'training.assignments:view'), ('vp_franchise', 'training.assignments:edit'), ('vp_franchise', 'sales.course_leads:view'),
  ('cmo', 'community.discussions:publish'), ('cmo', 'community.library:edit'), ('cmo', 'community.help_desk:edit'), ('cmo', 'training.academy:edit'),
  ('instructor_trainer', 'sales.course_leads:view'), ('instructor_trainer', 'sales.course_leads:edit'),
  ('operations_manager', 'finance.payments:view'), ('operations_manager', 'finance.payments:edit'), ('operations_manager', 'finance.payments:export'), ('operations_manager', 'finance.royalties:view'),
  ('operations_manager', 'marketing.website_builder:view'), ('operations_manager', 'marketing.website_builder:edit'), ('operations_manager', 'marketing.website_builder:publish'),
  ('operations_manager', 'sales.customers:edit'), ('operations_manager', 'sales.customers:export'),
  ('operations_manager', 'sales.customer_pipeline:view'), ('operations_manager', 'sales.customer_pipeline:edit'), ('operations_manager', 'sales.customer_pipeline:publish'), ('operations_manager', 'sales.customer_pipeline:export'),
  ('regional_manager', 'network.approvals:publish'), ('regional_manager', 'marketing.campaigns:view'), ('regional_manager', 'marketing.campaigns:edit'),
  ('regional_manager', 'marketing.email:view'), ('regional_manager', 'marketing.email:edit'), ('regional_manager', 'marketing.website_builder:view'),
  ('regional_manager', 'community.announcements:edit'), ('regional_manager', 'community.announcements:publish'), ('regional_manager', 'community.discussions:publish');
--> statement-breakpoint
INSERT INTO "member_access_overrides" ("organization_id", "assignment_id", "capability", "effect")
SELECT ra."organization_id", ra."id", x."capability", 'grant'
FROM "role_assignments" ra JOIN "_legacy_role_extras" x ON x."role" = ra."role"
ON CONFLICT ("assignment_id", "capability") DO NOTHING;
--> statement-breakpoint
DROP TABLE "_legacy_role_extras";
--> statement-breakpoint
CREATE TEMP TABLE "_legacy_role_map" ("old" text PRIMARY KEY, "new" text NOT NULL);
--> statement-breakpoint
INSERT INTO "_legacy_role_map" ("old", "new") VALUES
  ('vp_franchise', 'development_lead'), ('cmo', 'marketing_lead'), ('brand_lead', 'brand_manager'), ('instructor_trainer', 'trainer'),
  ('operations_manager', 'operations_lead'), ('finance', 'finance_lead'), ('legal', 'legal_lead'), ('regional_manager', 'field_consultant'),
  ('marketing_contributor', 'content_social');
--> statement-breakpoint
UPDATE "role_assignments" ra SET "role" = m."new" FROM "_legacy_role_map" m WHERE ra."role" = m."old";
--> statement-breakpoint
UPDATE "invitations" i SET "role" = m."new" FROM "_legacy_role_map" m WHERE i."role" = m."old";
--> statement-breakpoint
UPDATE "custom_roles" c SET "base_role" = m."new" FROM "_legacy_role_map" m WHERE c."base_role" = m."old";
--> statement-breakpoint
-- Audience role filters (announcements, spaces, library folders, resources, events, training assignments).
CREATE OR REPLACE FUNCTION "_bh_map_audience_roles"(a jsonb) RETURNS jsonb LANGUAGE sql AS $$
  SELECT CASE WHEN jsonb_typeof(a -> 'roles') = 'array' THEN
    jsonb_set(a, '{roles}', COALESCE((SELECT jsonb_agg(DISTINCT COALESCE(m."new", r)) FROM jsonb_array_elements_text(a -> 'roles') r LEFT JOIN "_legacy_role_map" m ON m."old" = r), '[]'::jsonb))
  ELSE a END
$$;
--> statement-breakpoint
UPDATE "community_announcements" SET "audience" = "_bh_map_audience_roles"("audience") WHERE "audience" ? 'roles';
--> statement-breakpoint
UPDATE "community_spaces" SET "audience" = "_bh_map_audience_roles"("audience") WHERE "audience" ? 'roles';
--> statement-breakpoint
UPDATE "library_folders" SET "audience" = "_bh_map_audience_roles"("audience") WHERE "audience" ? 'roles';
--> statement-breakpoint
UPDATE "library_resources" SET "audience" = "_bh_map_audience_roles"("audience") WHERE "audience" ? 'roles';
--> statement-breakpoint
UPDATE "community_events" SET "audience" = "_bh_map_audience_roles"("audience") WHERE "audience" ? 'roles';
--> statement-breakpoint
UPDATE "training_assignments" SET "audience" = "_bh_map_audience_roles"("audience") WHERE "audience" ? 'roles';
--> statement-breakpoint
DROP FUNCTION "_bh_map_audience_roles"(jsonb);
--> statement-breakpoint
DROP TABLE "_legacy_role_map";
--> statement-breakpoint
-- Every business gets its default brand (single-brand today); locations without a brand belong to it.
INSERT INTO "brands" ("organization_id", "name", "is_default") SELECT o."id", o."name", true FROM "organizations" o
WHERE NOT EXISTS (SELECT 1 FROM "brands" b WHERE b."organization_id" = o."id" AND b."is_default");
