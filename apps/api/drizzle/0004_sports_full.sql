CREATE TABLE "sports_announcements" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"location_id" uuid NOT NULL,
	"scope_kind" text NOT NULL,
	"scope_id" uuid NOT NULL,
	"title" text NOT NULL,
	"body" text NOT NULL,
	"created_by" uuid,
	"recipient_count" integer DEFAULT 0 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "sports_fee_adjustments" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"registration_id" uuid NOT NULL,
	"kind" text NOT NULL,
	"amount_minor" bigint NOT NULL,
	"currency" char(3) NOT NULL,
	"reason" text,
	"created_by" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "sports_fee_plans" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"programme_id" uuid NOT NULL,
	"name" text NOT NULL,
	"kind" text NOT NULL,
	"schedule" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"active" boolean DEFAULT true NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "sports_guardian_invitations" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"participant_customer_id" uuid NOT NULL,
	"invited_by_customer_id" uuid,
	"invited_by_user_id" uuid,
	"name" text,
	"email" text NOT NULL,
	"relationship" text DEFAULT 'parent' NOT NULL,
	"token_hash" text NOT NULL,
	"status" text DEFAULT 'pending' NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"accepted_customer_id" uuid,
	"accepted_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "sports_instalments" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"location_id" uuid NOT NULL,
	"registration_id" uuid NOT NULL,
	"seq" integer NOT NULL,
	"due_on" date NOT NULL,
	"amount_minor" bigint NOT NULL,
	"currency" char(3) NOT NULL,
	"status" text DEFAULT 'scheduled' NOT NULL,
	"payment_id" uuid,
	"payment_attempts" integer DEFAULT 0 NOT NULL,
	"paid_at" timestamp with time zone,
	"reminders_sent" integer DEFAULT 0 NOT NULL,
	"last_reminder_stage" text,
	"last_reminder_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "sports_messages" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"location_id" uuid NOT NULL,
	"guardian_customer_id" uuid NOT NULL,
	"direction" text NOT NULL,
	"author_user_id" uuid,
	"body" text NOT NULL,
	"read_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "sports_notifications" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"location_id" uuid,
	"guardian_customer_id" uuid NOT NULL,
	"participant_customer_id" uuid,
	"kind" text NOT NULL,
	"channel" text DEFAULT 'email' NOT NULL,
	"status" text NOT NULL,
	"subject" text NOT NULL,
	"body" text NOT NULL,
	"ref_type" text,
	"ref_id" uuid,
	"read_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "sports_portal_tokens" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"guardian_customer_id" uuid NOT NULL,
	"kind" text NOT NULL,
	"token_hash" text NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"used_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "sports_registration_forms" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"location_id" uuid,
	"name" text NOT NULL,
	"version" integer DEFAULT 1 NOT NULL,
	"questions" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"status" text DEFAULT 'active' NOT NULL,
	"created_by" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "sports_relationship_disputes" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"relationship_id" uuid NOT NULL,
	"participant_customer_id" uuid NOT NULL,
	"raised_by_customer_id" uuid,
	"raised_by_user_id" uuid,
	"reason" text NOT NULL,
	"previous_status" text NOT NULL,
	"status" text DEFAULT 'open' NOT NULL,
	"resolution_note" text,
	"resolved_by" uuid,
	"resolved_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "sports_restricted_answers" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"location_id" uuid NOT NULL,
	"registration_id" uuid NOT NULL,
	"participant_customer_id" uuid NOT NULL,
	"form_id" uuid,
	"form_version" integer,
	"answers" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"coach_visible_keys" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "sports_schedule_proposals" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"session_id" uuid NOT NULL,
	"source" text NOT NULL,
	"proposal" jsonb NOT NULL,
	"rationale" text,
	"status" text DEFAULT 'proposed' NOT NULL,
	"created_by" uuid,
	"decided_by" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"decided_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "sports_selection_entries" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"selection_id" uuid NOT NULL,
	"participant_customer_id" uuid NOT NULL,
	"note" text
);
--> statement-breakpoint
CREATE TABLE "sports_selections" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"location_id" uuid NOT NULL,
	"squad_team_id" uuid NOT NULL,
	"title" text NOT NULL,
	"notes" text,
	"status" text DEFAULT 'proposed' NOT NULL,
	"proposed_by" uuid NOT NULL,
	"decided_by" uuid,
	"decision_note" text,
	"decided_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "sports_session_series" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"team_id" uuid NOT NULL,
	"weekdays" jsonb NOT NULL,
	"start_time" text NOT NULL,
	"duration_minutes" integer NOT NULL,
	"from_date" date NOT NULL,
	"until_date" date NOT NULL,
	"venue_id" uuid,
	"created_by" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "sports_squad_members" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"team_id" uuid NOT NULL,
	"participant_customer_id" uuid NOT NULL,
	"selection_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "sports_team_coaches" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"team_id" uuid NOT NULL,
	"user_id" uuid NOT NULL,
	"role" text DEFAULT 'assistant' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "sports_team_moves" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"registration_id" uuid NOT NULL,
	"participant_customer_id" uuid NOT NULL,
	"from_team_id" uuid,
	"to_team_id" uuid,
	"reason" text,
	"moved_by" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "sports_venues" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"location_id" uuid NOT NULL,
	"name" text NOT NULL,
	"kind" text DEFAULT 'pitch' NOT NULL,
	"surface" text,
	"parent_venue_id" uuid,
	"capacity_note" text,
	"active" boolean DEFAULT true NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "seasons" ALTER COLUMN "programme_id" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "attendance" ADD COLUMN "absence_reason" text;--> statement-breakpoint
ALTER TABLE "attendance" ADD COLUMN "reported_by" text DEFAULT 'coach' NOT NULL;--> statement-breakpoint
ALTER TABLE "attendance" ADD COLUMN "guardian_notified_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "programmes" ADD COLUMN "season_id" uuid;--> statement-breakpoint
ALTER TABLE "programmes" ADD COLUMN "kind" text DEFAULT 'programme' NOT NULL;--> statement-breakpoint
ALTER TABLE "programmes" ADD COLUMN "age_rule" text DEFAULT 'age_on_date' NOT NULL;--> statement-breakpoint
ALTER TABLE "programmes" ADD COLUMN "eligibility_notes" text;--> statement-breakpoint
ALTER TABLE "programmes" ADD COLUMN "venue_ids" jsonb DEFAULT '[]'::jsonb NOT NULL;--> statement-breakpoint
ALTER TABLE "programmes" ADD COLUMN "sibling_discount_bps" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "programmes" ADD COLUMN "registration_form_id" uuid;--> statement-breakpoint
ALTER TABLE "programmes" ADD COLUMN "refund_policy_version" text;--> statement-breakpoint
ALTER TABLE "programmes" ADD COLUMN "hold_minutes" integer DEFAULT 30 NOT NULL;--> statement-breakpoint
ALTER TABLE "registrations" ADD COLUMN "payment_plan" text DEFAULT 'full' NOT NULL;--> statement-breakpoint
ALTER TABLE "registrations" ADD COLUMN "fee_plan_id" uuid;--> statement-breakpoint
ALTER TABLE "registrations" ADD COLUMN "list_fee_minor" bigint DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "registrations" ADD COLUMN "total_fee_minor" bigint DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "registrations" ADD COLUMN "currency" char(3);--> statement-breakpoint
ALTER TABLE "registrations" ADD COLUMN "hold_expires_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "registrations" ADD COLUMN "refund_policy_accepted_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "registrations" ADD COLUMN "refund_policy_version" text;--> statement-breakpoint
ALTER TABLE "registrations" ADD COLUMN "manage_token_hash" text;--> statement-breakpoint
ALTER TABLE "registrations" ADD COLUMN "withdrawn_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "registrations" ADD COLUMN "withdrawal_reason" text;--> statement-breakpoint
ALTER TABLE "seasons" ADD COLUMN "location_id" uuid;--> statement-breakpoint
ALTER TABLE "seasons" ADD COLUMN "age_rule" text;--> statement-breakpoint
ALTER TABLE "seasons" ADD COLUMN "age_cutoff_date" date;--> statement-breakpoint
ALTER TABLE "seasons" ADD COLUMN "status" text DEFAULT 'draft' NOT NULL;--> statement-breakpoint
ALTER TABLE "teams" ADD COLUMN "kind" text DEFAULT 'team' NOT NULL;--> statement-breakpoint
ALTER TABLE "teams" ADD COLUMN "home_venue_id" uuid;--> statement-breakpoint
ALTER TABLE "teams" ADD COLUMN "archived_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "training_sessions" ADD COLUMN "venue_id" uuid;--> statement-breakpoint
ALTER TABLE "training_sessions" ADD COLUMN "series_id" uuid;--> statement-breakpoint
ALTER TABLE "training_sessions" ADD COLUMN "opponent" text;--> statement-breakpoint
ALTER TABLE "training_sessions" ADD COLUMN "home_away" text;--> statement-breakpoint
ALTER TABLE "training_sessions" ADD COLUMN "competition" text;--> statement-breakpoint
ALTER TABLE "training_sessions" ADD COLUMN "notes" text;--> statement-breakpoint
ALTER TABLE "training_sessions" ADD COLUMN "cancelled_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "training_sessions" ADD COLUMN "cancel_reason" text;--> statement-breakpoint
ALTER TABLE "sports_announcements" ADD CONSTRAINT "sports_announcements_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sports_announcements" ADD CONSTRAINT "sports_announcements_location_id_locations_id_fk" FOREIGN KEY ("location_id") REFERENCES "public"."locations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sports_fee_adjustments" ADD CONSTRAINT "sports_fee_adjustments_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sports_fee_adjustments" ADD CONSTRAINT "sports_fee_adjustments_registration_id_registrations_id_fk" FOREIGN KEY ("registration_id") REFERENCES "public"."registrations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sports_fee_plans" ADD CONSTRAINT "sports_fee_plans_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sports_fee_plans" ADD CONSTRAINT "sports_fee_plans_programme_id_programmes_id_fk" FOREIGN KEY ("programme_id") REFERENCES "public"."programmes"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sports_guardian_invitations" ADD CONSTRAINT "sports_guardian_invitations_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sports_guardian_invitations" ADD CONSTRAINT "sports_guardian_invitations_participant_customer_id_customers_id_fk" FOREIGN KEY ("participant_customer_id") REFERENCES "public"."customers"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sports_guardian_invitations" ADD CONSTRAINT "sports_guardian_invitations_invited_by_customer_id_customers_id_fk" FOREIGN KEY ("invited_by_customer_id") REFERENCES "public"."customers"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sports_instalments" ADD CONSTRAINT "sports_instalments_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sports_instalments" ADD CONSTRAINT "sports_instalments_location_id_locations_id_fk" FOREIGN KEY ("location_id") REFERENCES "public"."locations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sports_instalments" ADD CONSTRAINT "sports_instalments_registration_id_registrations_id_fk" FOREIGN KEY ("registration_id") REFERENCES "public"."registrations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sports_messages" ADD CONSTRAINT "sports_messages_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sports_messages" ADD CONSTRAINT "sports_messages_location_id_locations_id_fk" FOREIGN KEY ("location_id") REFERENCES "public"."locations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sports_messages" ADD CONSTRAINT "sports_messages_guardian_customer_id_customers_id_fk" FOREIGN KEY ("guardian_customer_id") REFERENCES "public"."customers"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sports_notifications" ADD CONSTRAINT "sports_notifications_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sports_notifications" ADD CONSTRAINT "sports_notifications_guardian_customer_id_customers_id_fk" FOREIGN KEY ("guardian_customer_id") REFERENCES "public"."customers"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sports_portal_tokens" ADD CONSTRAINT "sports_portal_tokens_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sports_portal_tokens" ADD CONSTRAINT "sports_portal_tokens_guardian_customer_id_customers_id_fk" FOREIGN KEY ("guardian_customer_id") REFERENCES "public"."customers"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sports_registration_forms" ADD CONSTRAINT "sports_registration_forms_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sports_registration_forms" ADD CONSTRAINT "sports_registration_forms_location_id_locations_id_fk" FOREIGN KEY ("location_id") REFERENCES "public"."locations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sports_relationship_disputes" ADD CONSTRAINT "sports_relationship_disputes_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sports_relationship_disputes" ADD CONSTRAINT "sports_relationship_disputes_relationship_id_guardian_relationships_id_fk" FOREIGN KEY ("relationship_id") REFERENCES "public"."guardian_relationships"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sports_restricted_answers" ADD CONSTRAINT "sports_restricted_answers_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sports_restricted_answers" ADD CONSTRAINT "sports_restricted_answers_location_id_locations_id_fk" FOREIGN KEY ("location_id") REFERENCES "public"."locations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sports_restricted_answers" ADD CONSTRAINT "sports_restricted_answers_registration_id_registrations_id_fk" FOREIGN KEY ("registration_id") REFERENCES "public"."registrations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sports_restricted_answers" ADD CONSTRAINT "sports_restricted_answers_participant_customer_id_customers_id_fk" FOREIGN KEY ("participant_customer_id") REFERENCES "public"."customers"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sports_schedule_proposals" ADD CONSTRAINT "sports_schedule_proposals_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sports_schedule_proposals" ADD CONSTRAINT "sports_schedule_proposals_session_id_training_sessions_id_fk" FOREIGN KEY ("session_id") REFERENCES "public"."training_sessions"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sports_selection_entries" ADD CONSTRAINT "sports_selection_entries_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sports_selection_entries" ADD CONSTRAINT "sports_selection_entries_selection_id_sports_selections_id_fk" FOREIGN KEY ("selection_id") REFERENCES "public"."sports_selections"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sports_selection_entries" ADD CONSTRAINT "sports_selection_entries_participant_customer_id_customers_id_fk" FOREIGN KEY ("participant_customer_id") REFERENCES "public"."customers"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sports_selections" ADD CONSTRAINT "sports_selections_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sports_selections" ADD CONSTRAINT "sports_selections_location_id_locations_id_fk" FOREIGN KEY ("location_id") REFERENCES "public"."locations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sports_selections" ADD CONSTRAINT "sports_selections_squad_team_id_teams_id_fk" FOREIGN KEY ("squad_team_id") REFERENCES "public"."teams"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sports_session_series" ADD CONSTRAINT "sports_session_series_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sports_session_series" ADD CONSTRAINT "sports_session_series_team_id_teams_id_fk" FOREIGN KEY ("team_id") REFERENCES "public"."teams"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sports_squad_members" ADD CONSTRAINT "sports_squad_members_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sports_squad_members" ADD CONSTRAINT "sports_squad_members_team_id_teams_id_fk" FOREIGN KEY ("team_id") REFERENCES "public"."teams"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sports_squad_members" ADD CONSTRAINT "sports_squad_members_participant_customer_id_customers_id_fk" FOREIGN KEY ("participant_customer_id") REFERENCES "public"."customers"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sports_team_coaches" ADD CONSTRAINT "sports_team_coaches_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sports_team_coaches" ADD CONSTRAINT "sports_team_coaches_team_id_teams_id_fk" FOREIGN KEY ("team_id") REFERENCES "public"."teams"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sports_team_moves" ADD CONSTRAINT "sports_team_moves_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sports_team_moves" ADD CONSTRAINT "sports_team_moves_registration_id_registrations_id_fk" FOREIGN KEY ("registration_id") REFERENCES "public"."registrations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sports_venues" ADD CONSTRAINT "sports_venues_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sports_venues" ADD CONSTRAINT "sports_venues_location_id_locations_id_fk" FOREIGN KEY ("location_id") REFERENCES "public"."locations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "sports_guardian_inv_token_uq" ON "sports_guardian_invitations" USING btree ("token_hash");--> statement-breakpoint
CREATE UNIQUE INDEX "sports_instalments_reg_seq_uq" ON "sports_instalments" USING btree ("registration_id","seq");--> statement-breakpoint
CREATE INDEX "sports_instalments_payment_idx" ON "sports_instalments" USING btree ("payment_id");--> statement-breakpoint
CREATE INDEX "sports_instalments_due_idx" ON "sports_instalments" USING btree ("organization_id","due_on");--> statement-breakpoint
CREATE INDEX "sports_messages_thread_idx" ON "sports_messages" USING btree ("location_id","guardian_customer_id","created_at");--> statement-breakpoint
CREATE INDEX "sports_notifications_guardian_idx" ON "sports_notifications" USING btree ("guardian_customer_id","created_at");--> statement-breakpoint
CREATE INDEX "sports_notifications_ref_idx" ON "sports_notifications" USING btree ("ref_type","ref_id");--> statement-breakpoint
CREATE UNIQUE INDEX "sports_portal_tokens_hash_uq" ON "sports_portal_tokens" USING btree ("token_hash");--> statement-breakpoint
CREATE UNIQUE INDEX "sports_restricted_answers_reg_uq" ON "sports_restricted_answers" USING btree ("registration_id");--> statement-breakpoint
CREATE INDEX "sports_schedule_proposals_session_idx" ON "sports_schedule_proposals" USING btree ("session_id");--> statement-breakpoint
CREATE UNIQUE INDEX "sports_selection_entries_uq" ON "sports_selection_entries" USING btree ("selection_id","participant_customer_id");--> statement-breakpoint
CREATE UNIQUE INDEX "sports_squad_members_uq" ON "sports_squad_members" USING btree ("team_id","participant_customer_id");--> statement-breakpoint
CREATE UNIQUE INDEX "sports_team_coaches_uq" ON "sports_team_coaches" USING btree ("team_id","user_id");--> statement-breakpoint
CREATE INDEX "sports_team_moves_reg_idx" ON "sports_team_moves" USING btree ("registration_id");--> statement-breakpoint
CREATE INDEX "sports_venues_location_idx" ON "sports_venues" USING btree ("location_id");--> statement-breakpoint
ALTER TABLE "seasons" ADD CONSTRAINT "seasons_location_id_locations_id_fk" FOREIGN KEY ("location_id") REFERENCES "public"."locations"("id") ON DELETE cascade ON UPDATE no action;