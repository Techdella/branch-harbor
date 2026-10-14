-- Wellness: one canonical table of resource holds (rooms + equipment) with an exclusion constraint.
-- Rooms come from appointments.resource_id via trigger; equipment rows are inserted by the booking engine.
-- The hold is active exactly while its appointment is 'confirmed' (trigger), so cancel / reschedule / no-show
-- release rooms and equipment in the same transaction on every code path.
CREATE EXTENSION IF NOT EXISTS btree_gist;
--> statement-breakpoint
ALTER TABLE "wellness_resource_reservations" ADD CONSTRAINT "wellness_resource_reservations_no_overlap"
  EXCLUDE USING gist ("resource_id" WITH =, tstzrange("blocked_from", "blocked_until", '[)') WITH &&)
  WHERE ("active");
--> statement-breakpoint
ALTER TABLE "wellness_resource_reservations" ADD CONSTRAINT "wellness_resource_reservations_range_check" CHECK ("blocked_until" > "blocked_from");
--> statement-breakpoint
CREATE OR REPLACE FUNCTION wellness_appointment_room_hold() RETURNS trigger AS $$
BEGIN
  IF NEW.resource_id IS NOT NULL THEN
    INSERT INTO wellness_resource_reservations (organization_id, location_id, resource_id, appointment_id, blocked_from, blocked_until, role, active)
    VALUES (NEW.organization_id, NEW.location_id, NEW.resource_id, NEW.id, NEW.blocked_from, NEW.blocked_until, 'room', NEW.status = 'confirmed');
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;
--> statement-breakpoint
CREATE TRIGGER wellness_appointment_room_hold_trg AFTER INSERT ON appointments
  FOR EACH ROW EXECUTE FUNCTION wellness_appointment_room_hold();
--> statement-breakpoint
CREATE OR REPLACE FUNCTION wellness_appointment_hold_status() RETURNS trigger AS $$
BEGIN
  IF NEW.status IS DISTINCT FROM OLD.status THEN
    UPDATE wellness_resource_reservations SET active = (NEW.status = 'confirmed') WHERE appointment_id = NEW.id;
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;
--> statement-breakpoint
CREATE TRIGGER wellness_appointment_hold_status_trg AFTER UPDATE OF status ON appointments
  FOR EACH ROW EXECUTE FUNCTION wellness_appointment_hold_status();
--> statement-breakpoint
-- Backfill holds for appointments created before this migration.
INSERT INTO wellness_resource_reservations (organization_id, location_id, resource_id, appointment_id, blocked_from, blocked_until, role, active)
SELECT a.organization_id, a.location_id, a.resource_id, a.id, a.blocked_from, a.blocked_until, 'room', a.status = 'confirmed'
FROM appointments a
WHERE a.resource_id IS NOT NULL
  AND NOT EXISTS (SELECT 1 FROM wellness_resource_reservations r WHERE r.appointment_id = a.id AND r.role = 'room');
