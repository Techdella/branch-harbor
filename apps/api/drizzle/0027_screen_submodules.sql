-- Screen-level sub-modules (packages/shared/src/access.ts SCREEN_MODULES): management screens that used to belong to a
-- front-line Operations module are now capabilities of their own. System templates are narrowed in code (staff keep
-- the front-line screens only). Custom roles and per-person grants that already held the parent module keep the
-- screens they had, so nobody silently loses access in the move.
CREATE TEMP TABLE "_screen_submodules" ("parent" text NOT NULL, "child" text NOT NULL);
--> statement-breakpoint
INSERT INTO "_screen_submodules" ("parent", "child") VALUES
  ('operations.classes', 'operations.classes.schedule_builder'), ('operations.classes', 'operations.classes.rooms'),
  ('operations.memberships', 'operations.memberships.packs_offers'), ('operations.teams', 'operations.teams.schedule_builder'),
  ('operations.appointments', 'operations.appointments.practitioners'), ('operations.inventory', 'operations.inventory.purchasing'),
  ('operations.food_orders', 'operations.food_orders.catering'), ('operations.listings', 'operations.listings.portals'),
  ('operations.agents', 'operations.agents.offices');
--> statement-breakpoint
INSERT INTO "role_capabilities" ("role_id", "organization_id", "capability")
SELECT rc."role_id", rc."organization_id", x."child" || substr(rc."capability", length(x."parent") + 1)
FROM "role_capabilities" rc JOIN "_screen_submodules" x ON rc."capability" IN (x."parent" || ':view', x."parent" || ':edit')
ON CONFLICT DO NOTHING;
--> statement-breakpoint
INSERT INTO "member_access_overrides" ("organization_id", "assignment_id", "capability", "effect")
SELECT o."organization_id", o."assignment_id", x."child" || substr(o."capability", length(x."parent") + 1), o."effect"
FROM "member_access_overrides" o JOIN "_screen_submodules" x ON o."capability" IN (x."parent" || ':view', x."parent" || ':edit')
ON CONFLICT DO NOTHING;
--> statement-breakpoint
DROP TABLE "_screen_submodules";
