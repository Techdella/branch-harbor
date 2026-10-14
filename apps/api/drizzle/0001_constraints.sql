-- Custom constraints that Drizzle cannot express declaratively.
CREATE EXTENSION IF NOT EXISTS btree_gist;
--> statement-breakpoint
-- A practitioner can never hold two overlapping confirmed reservations (buffers included).
ALTER TABLE "appointments" ADD CONSTRAINT "appointments_practitioner_no_overlap"
  EXCLUDE USING gist ("practitioner_id" WITH =, tstzrange("blocked_from", "blocked_until", '[)') WITH &&)
  WHERE ("status" = 'confirmed');
--> statement-breakpoint
-- Two calendars can never independently promise the same room/resource.
ALTER TABLE "appointments" ADD CONSTRAINT "appointments_resource_no_overlap"
  EXCLUDE USING gist ("resource_id" WITH =, tstzrange("blocked_from", "blocked_until", '[)') WITH &&)
  WHERE ("status" = 'confirmed' AND "resource_id" IS NOT NULL);
--> statement-breakpoint
ALTER TABLE "pickup_slots" ADD CONSTRAINT "pickup_slots_capacity_check" CHECK ("booked" >= 0 AND "booked" <= "capacity");
--> statement-breakpoint
ALTER TABLE "class_occurrences" ADD CONSTRAINT "class_occurrences_capacity_check" CHECK ("capacity" >= 0);
--> statement-breakpoint
ALTER TABLE "payment_references" ADD CONSTRAINT "payment_references_amount_check" CHECK ("amount_minor" >= 0 AND "refunded_minor" >= 0 AND "refunded_minor" <= "amount_minor");
--> statement-breakpoint
ALTER TABLE "refunds" ADD CONSTRAINT "refunds_amount_check" CHECK ("amount_minor" > 0);
