-- One leads pipeline: course leads from the Training academy (course_leads) move into leads with kind = 'course'
-- (Sales → Course leads, lead routing rules). "enrolled" becomes "converted". course_leads is dropped next.
INSERT INTO "leads" ("id", "organization_id", "kind", "course_id", "enrolment_id", "name", "email", "phone", "message", "source", "campaign", "utm", "assigned_user_id", "status", "notes", "marketing_consent", "created_at", "updated_at")
SELECT "id", "organization_id", 'course', "course_id", "enrolment_id", "name", "email", "phone", "message", "source", "campaign", "utm", "assigned_to",
  CASE "status" WHEN 'enrolled' THEN 'converted' ELSE "status" END, "notes", "marketing_consent", "created_at", "updated_at"
FROM "course_leads"
ON CONFLICT ("id") DO NOTHING;
