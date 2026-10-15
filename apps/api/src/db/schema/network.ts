import { boolean, index, integer, jsonb, pgTable, text, uniqueIndex, uuid } from 'drizzle-orm/pg-core';
import { createdAt, currencyCol, minor, orgId, pk, ts, updatedAt } from './_shared.ts';
import { locations, organizations, users } from './core.ts';

/**
 * Network workspaces: Community (announcements, discussion spaces, resource library, events, account managers and
 * coaching threads, notifications), Training academy (courses, paths, assignments, progress, certificates, public
 * paid courses and course leads) and the Help desk (tickets to HQ, SLAs, canned replies; knowledge base articles
 * live in the resource library).
 */

/**
 * Who something is for. Scope lists are alternatives (a person in any listed region, owner group or location
 * matches); `roles` narrows further (the person must hold one of them). Empty everything = the whole network.
 */
export interface Audience {
  regionIds?: string[];
  ownerGroupIds?: string[];
  locationIds?: string[];
  roles?: string[];
  /** Only people with an organisation-wide (HQ) assignment. */
  hqOnly?: boolean;
  /** Named people (training assignments, coaching). */
  userIds?: string[];
}

export interface Attachment { name: string; url: string; mimeType?: string | null; sizeBytes?: number | null }

const org = () => orgId().references(() => organizations.id, { onDelete: 'cascade' });

// ───────────────────────── Community ─────────────────────────

export const communityAnnouncements = pgTable('community_announcements', {
  id: pk(),
  organizationId: org(),
  title: text('title').notNull(),
  body: text('body').notNull(),
  audience: jsonb('audience').$type<Audience>().notNull().default({}),
  requiredRead: boolean('required_read').notNull().default(false),
  /** Required reads: confirm by this time. */
  dueAt: ts('due_at'),
  pinned: boolean('pinned').notNull().default(false),
  /** draft | published | archived. A published announcement with a future publishAt is "scheduled". */
  status: text('status').notNull().default('draft'),
  publishAt: ts('publish_at'),
  /** When the audience was notified (scheduled posts notify when they go live). */
  notifiedAt: ts('notified_at'),
  lastReminderAt: ts('last_reminder_at'),
  attachments: jsonb('attachments').$type<Attachment[]>().notNull().default([]),
  authorId: uuid('author_id').references(() => users.id, { onDelete: 'set null' }),
  createdAt: createdAt(),
  updatedAt: updatedAt(),
}, (t) => [index('community_announcements_org_idx').on(t.organizationId, t.publishAt)]);

export const communityAnnouncementReads = pgTable('community_announcement_reads', {
  id: pk(),
  organizationId: org(),
  announcementId: uuid('announcement_id').notNull().references(() => communityAnnouncements.id, { onDelete: 'cascade' }),
  userId: uuid('user_id').notNull().references(() => users.id, { onDelete: 'cascade' }),
  /** Opened (null when only a reminder was sent). */
  readAt: ts('read_at'),
  /** "I have read and understood" for required reads. */
  acknowledgedAt: ts('acknowledged_at'),
  remindedAt: ts('reminded_at'),
}, (t) => [uniqueIndex('community_announcement_reads_uq').on(t.announcementId, t.userId)]);

export const communitySpaces = pgTable('community_spaces', {
  id: pk(),
  organizationId: org(),
  slug: text('slug').notNull(),
  name: text('name').notNull(),
  description: text('description'),
  /** discussion | qa (questions can have an accepted answer) */
  kind: text('kind').notNull().default('discussion'),
  audience: jsonb('audience').$type<Audience>().notNull().default({}),
  /** everyone | hq_only */
  postingPolicy: text('posting_policy').notNull().default('everyone'),
  icon: text('icon'),
  position: integer('position').notNull().default(0),
  archivedAt: ts('archived_at'),
  createdBy: uuid('created_by'),
  createdAt: createdAt(),
}, (t) => [uniqueIndex('community_spaces_org_slug_uq').on(t.organizationId, t.slug)]);

export const communityThreads = pgTable('community_threads', {
  id: pk(),
  organizationId: org(),
  spaceId: uuid('space_id').notNull().references(() => communitySpaces.id, { onDelete: 'cascade' }),
  authorId: uuid('author_id').references(() => users.id, { onDelete: 'set null' }),
  title: text('title').notNull(),
  body: text('body').notNull(),
  attachments: jsonb('attachments').$type<Attachment[]>().notNull().default([]),
  mentions: uuid('mentions').array().notNull().default([]),
  pinned: boolean('pinned').notNull().default(false),
  lockedAt: ts('locked_at'),
  hiddenAt: ts('hidden_at'),
  hiddenReason: text('hidden_reason'),
  acceptedReplyId: uuid('accepted_reply_id'),
  replyCount: integer('reply_count').notNull().default(0),
  lastActivityAt: ts('last_activity_at').notNull().defaultNow(),
  editedAt: ts('edited_at'),
  createdAt: createdAt(),
}, (t) => [index('community_threads_space_idx').on(t.spaceId, t.lastActivityAt)]);

export const communityReplies = pgTable('community_replies', {
  id: pk(),
  organizationId: org(),
  threadId: uuid('thread_id').notNull().references(() => communityThreads.id, { onDelete: 'cascade' }),
  authorId: uuid('author_id').references(() => users.id, { onDelete: 'set null' }),
  body: text('body').notNull(),
  attachments: jsonb('attachments').$type<Attachment[]>().notNull().default([]),
  mentions: uuid('mentions').array().notNull().default([]),
  hiddenAt: ts('hidden_at'),
  hiddenReason: text('hidden_reason'),
  editedAt: ts('edited_at'),
  createdAt: createdAt(),
}, (t) => [index('community_replies_thread_idx').on(t.threadId, t.createdAt)]);

export const communityReactions = pgTable('community_reactions', {
  id: pk(),
  organizationId: org(),
  /** thread | reply | announcement */
  targetType: text('target_type').notNull(),
  targetId: uuid('target_id').notNull(),
  userId: uuid('user_id').notNull().references(() => users.id, { onDelete: 'cascade' }),
  reaction: text('reaction').notNull(),
  createdAt: createdAt(),
}, (t) => [uniqueIndex('community_reactions_uq').on(t.targetType, t.targetId, t.userId, t.reaction)]);

export const communityReports = pgTable('community_reports', {
  id: pk(),
  organizationId: org(),
  targetType: text('target_type').notNull(),
  targetId: uuid('target_id').notNull(),
  reporterId: uuid('reporter_id').notNull().references(() => users.id, { onDelete: 'cascade' }),
  reason: text('reason').notNull(),
  /** open | actioned | dismissed */
  status: text('status').notNull().default('open'),
  resolvedBy: uuid('resolved_by'),
  resolvedAt: ts('resolved_at'),
  createdAt: createdAt(),
}, (t) => [index('community_reports_org_idx').on(t.organizationId, t.status)]);

export const libraryFolders = pgTable('library_folders', {
  id: pk(),
  organizationId: org(),
  parentId: uuid('parent_id'),
  name: text('name').notNull(),
  audience: jsonb('audience').$type<Audience>().notNull().default({}),
  position: integer('position').notNull().default(0),
  createdAt: createdAt(),
}, (t) => [index('library_folders_org_idx').on(t.organizationId)]);

export const libraryResources = pgTable('library_resources', {
  id: pk(),
  organizationId: org(),
  folderId: uuid('folder_id').references(() => libraryFolders.id, { onDelete: 'set null' }),
  /** document | playbook | sop | kb_article | link | video */
  kind: text('kind').notNull().default('document'),
  title: text('title').notNull(),
  summary: text('summary'),
  /** Current text (articles, SOPs written in the app); mirrors the latest version. */
  body: text('body'),
  url: text('url'),
  fileName: text('file_name'),
  tags: text('tags').array().notNull().default([]),
  /** Extra narrowing on top of the folder's audience. */
  audience: jsonb('audience').$type<Audience>().notNull().default({}),
  /** Knowledge base articles: shown in the help desk with this category. */
  helpCategory: text('help_category'),
  currentVersion: integer('current_version').notNull().default(1),
  createdBy: uuid('created_by'),
  updatedBy: uuid('updated_by'),
  archivedAt: ts('archived_at'),
  createdAt: createdAt(),
  updatedAt: updatedAt(),
}, (t) => [index('library_resources_org_idx').on(t.organizationId, t.kind)]);

export const libraryVersions = pgTable('library_resource_versions', {
  id: pk(),
  organizationId: org(),
  resourceId: uuid('resource_id').notNull().references(() => libraryResources.id, { onDelete: 'cascade' }),
  version: integer('version').notNull(),
  title: text('title').notNull(),
  body: text('body'),
  url: text('url'),
  fileName: text('file_name'),
  note: text('note'),
  createdBy: uuid('created_by'),
  createdAt: createdAt(),
}, (t) => [uniqueIndex('library_resource_versions_uq').on(t.resourceId, t.version)]);

export const communityEvents = pgTable('community_events', {
  id: pk(),
  organizationId: org(),
  title: text('title').notNull(),
  description: text('description'),
  /** network_call | training | webinar | in_person | social */
  kind: text('kind').notNull().default('network_call'),
  startsAt: ts('starts_at').notNull(),
  endsAt: ts('ends_at').notNull(),
  timeZone: text('time_zone').notNull(),
  joinUrl: text('join_url'),
  place: text('place'),
  capacity: integer('capacity'),
  audience: jsonb('audience').$type<Audience>().notNull().default({}),
  cancelledAt: ts('cancelled_at'),
  createdBy: uuid('created_by'),
  createdAt: createdAt(),
}, (t) => [index('community_events_org_idx').on(t.organizationId, t.startsAt)]);

export const communityEventRsvps = pgTable('community_event_rsvps', {
  id: pk(),
  organizationId: org(),
  eventId: uuid('event_id').notNull().references(() => communityEvents.id, { onDelete: 'cascade' }),
  userId: uuid('user_id').notNull().references(() => users.id, { onDelete: 'cascade' }),
  /** going | maybe | declined */
  status: text('status').notNull(),
  updatedAt: updatedAt(),
}, (t) => [uniqueIndex('community_event_rsvps_uq').on(t.eventId, t.userId)]);

/** HQ contact for a franchisee: an owner group (all its locations), one location, or a region. */
export const accountManagers = pgTable('account_managers', {
  id: pk(),
  organizationId: org(),
  userId: uuid('user_id').notNull().references(() => users.id, { onDelete: 'cascade' }),
  /** region | owner_group | location */
  scopeKind: text('scope_kind').notNull(),
  scopeId: uuid('scope_id').notNull(),
  title: text('title'),
  /** External scheduling page (Calendly, Cal.com, Microsoft Bookings…). */
  bookingUrl: text('booking_url'),
  bio: text('bio'),
  phone: text('phone'),
  createdAt: createdAt(),
}, (t) => [uniqueIndex('account_managers_uq').on(t.userId, t.scopeKind, t.scopeId)]);

/** Private 1:1 thread between a franchisee (owner group or location) and their HQ contact. */
export const coachingThreads = pgTable('coaching_threads', {
  id: pk(),
  organizationId: org(),
  /** owner_group | location */
  scopeKind: text('scope_kind').notNull(),
  scopeId: uuid('scope_id').notNull(),
  managerUserId: uuid('manager_user_id').notNull().references(() => users.id, { onDelete: 'cascade' }),
  lastMessageAt: ts('last_message_at'),
  createdAt: createdAt(),
}, (t) => [uniqueIndex('coaching_threads_uq').on(t.organizationId, t.scopeKind, t.scopeId, t.managerUserId)]);

export const coachingMessages = pgTable('coaching_messages', {
  id: pk(),
  organizationId: org(),
  threadId: uuid('thread_id').notNull().references(() => coachingThreads.id, { onDelete: 'cascade' }),
  authorId: uuid('author_id').references(() => users.id, { onDelete: 'set null' }),
  body: text('body').notNull(),
  attachments: jsonb('attachments').$type<Attachment[]>().notNull().default([]),
  createdAt: createdAt(),
}, (t) => [index('coaching_messages_thread_idx').on(t.threadId, t.createdAt)]);

/** In-app notifications (also the source of email digests and push). */
export const networkNotifications = pgTable('network_notifications', {
  id: pk(),
  organizationId: org(),
  userId: uuid('user_id').notNull().references(() => users.id, { onDelete: 'cascade' }),
  /** announcement | required_read_reminder | mention | reply | answer_accepted | coaching | event | course_assigned | course_approval | course_lead | ticket | ticket_reply | sla */
  kind: text('kind').notNull(),
  title: text('title').notNull(),
  body: text('body'),
  /** App path to open, e.g. /community?announcement=… */
  link: text('link'),
  data: jsonb('data').$type<Record<string, unknown>>().notNull().default({}),
  readAt: ts('read_at'),
  emailedAt: ts('emailed_at'),
  createdAt: createdAt(),
}, (t) => [index('network_notifications_user_idx').on(t.userId, t.organizationId, t.createdAt)]);

export const networkNotificationPrefs = pgTable('network_notification_prefs', {
  id: pk(),
  organizationId: org(),
  userId: uuid('user_id').notNull().references(() => users.id, { onDelete: 'cascade' }),
  inApp: boolean('in_app').notNull().default(true),
  push: boolean('push').notNull().default(true),
  /** off | daily | weekly */
  emailDigest: text('email_digest').notNull().default('daily'),
  /** Kinds the person does not want (required reads and SLA alerts are always delivered). */
  mutedKinds: text('muted_kinds').array().notNull().default([]),
  mutedSpaceIds: uuid('muted_space_ids').array().notNull().default([]),
  lastDigestAt: ts('last_digest_at'),
  updatedAt: updatedAt(),
}, (t) => [uniqueIndex('network_notification_prefs_uq').on(t.organizationId, t.userId)]);

// ───────────────────────── Training academy ─────────────────────────

export interface QuizQuestion { id: string; prompt: string; options: string[]; correct: number[]; explanation?: string | null }

export const courses = pgTable('courses', {
  id: pk(),
  organizationId: org(),
  slug: text('slug').notNull(),
  title: text('title').notNull(),
  summary: text('summary'),
  description: text('description'),
  coverUrl: text('cover_url'),
  /** draft | pending_approval | published | archived */
  status: text('status').notNull().default('draft'),
  /** internal (network staff) | public (sold on the brand site) */
  visibility: text('visibility').notNull().default('internal'),
  category: text('category'),
  estimatedMinutes: integer('estimated_minutes'),
  passMark: integer('pass_mark').notNull().default(80),
  certificateEnabled: boolean('certificate_enabled').notNull().default(true),
  /** Re-certification: certificate expires this many months after completion (null = never). */
  validityMonths: integer('validity_months'),
  prerequisiteIds: uuid('prerequisite_ids').array().notNull().default([]),
  /** Instructor-trainers who teach this course (co-authors; course leads are assigned to them). */
  trainerUserIds: uuid('trainer_user_ids').array().notNull().default([]),
  // Public paid courses (e.g. a 200-hour teacher training sold to the public).
  priceMinor: minor('price_minor'),
  currency: currencyCol('currency'),
  /** The location whose payment account takes the money. */
  saleLocationId: uuid('sale_location_id').references(() => locations.id, { onDelete: 'set null' }),
  seats: integer('seats'),
  startsOn: text('starts_on'),
  scheduleNote: text('schedule_note'),
  authorId: uuid('author_id').references(() => users.id, { onDelete: 'set null' }),
  submittedAt: ts('submitted_at'),
  approvedBy: uuid('approved_by'),
  approvedAt: ts('approved_at'),
  reviewComment: text('review_comment'),
  publishedAt: ts('published_at'),
  createdAt: createdAt(),
  updatedAt: updatedAt(),
}, (t) => [uniqueIndex('courses_org_slug_uq').on(t.organizationId, t.slug)]);

export const courseModules = pgTable('course_modules', {
  id: pk(),
  organizationId: org(),
  courseId: uuid('course_id').notNull().references(() => courses.id, { onDelete: 'cascade' }),
  title: text('title').notNull(),
  position: integer('position').notNull().default(0),
}, (t) => [index('course_modules_course_idx').on(t.courseId)]);

export const courseLessons = pgTable('course_lessons', {
  id: pk(),
  organizationId: org(),
  courseId: uuid('course_id').notNull().references(() => courses.id, { onDelete: 'cascade' }),
  moduleId: uuid('module_id').notNull().references(() => courseModules.id, { onDelete: 'cascade' }),
  title: text('title').notNull(),
  /** text | video | file | quiz */
  kind: text('kind').notNull().default('text'),
  body: text('body'),
  videoUrl: text('video_url'),
  attachments: jsonb('attachments').$type<Attachment[]>().notNull().default([]),
  quiz: jsonb('quiz').$type<QuizQuestion[]>(),
  /** Quiz pass mark override (defaults to the course pass mark). */
  passMark: integer('pass_mark'),
  minutes: integer('minutes'),
  position: integer('position').notNull().default(0),
}, (t) => [index('course_lessons_course_idx').on(t.courseId)]);

export const learningPaths = pgTable('learning_paths', {
  id: pk(),
  organizationId: org(),
  title: text('title').notNull(),
  description: text('description'),
  courseIds: uuid('course_ids').array().notNull().default([]),
  /** draft | published | archived */
  status: text('status').notNull().default('published'),
  createdBy: uuid('created_by'),
  createdAt: createdAt(),
  updatedAt: updatedAt(),
});

export const trainingAssignments = pgTable('training_assignments', {
  id: pk(),
  organizationId: org(),
  /** course | path */
  targetType: text('target_type').notNull(),
  targetId: uuid('target_id').notNull(),
  audience: jsonb('audience').$type<Audience>().notNull().default({}),
  dueAt: ts('due_at'),
  /** Due this many days after the person is first enrolled (people who join later get their own date). */
  dueInDays: integer('due_in_days'),
  /** manual | onboarding | recertification */
  source: text('source').notNull().default('manual'),
  sourceRef: text('source_ref'),
  assignedBy: uuid('assigned_by'),
  createdAt: createdAt(),
}, (t) => [index('training_assignments_org_idx').on(t.organizationId)]);

export const enrolments = pgTable('enrolments', {
  id: pk(),
  organizationId: org(),
  courseId: uuid('course_id').notNull().references(() => courses.id, { onDelete: 'cascade' }),
  userId: uuid('user_id').references(() => users.id, { onDelete: 'cascade' }),
  /** Public learners (no network account): who bought the course. */
  learnerName: text('learner_name'),
  learnerEmail: text('learner_email'),
  learnerPhone: text('learner_phone'),
  /** assignment | self | public_purchase | manual */
  source: text('source').notNull().default('self'),
  assignmentId: uuid('assignment_id'),
  /** pending_payment | active | completed | expired | cancelled */
  status: text('status').notNull().default('active'),
  dueAt: ts('due_at'),
  startedAt: ts('started_at'),
  completedAt: ts('completed_at'),
  /** Re-certification: when the completion stops counting. */
  expiresAt: ts('expires_at'),
  progressPct: integer('progress_pct').notNull().default(0),
  paymentId: uuid('payment_id'),
  amountMinor: minor('amount_minor'),
  currency: currencyCol('currency'),
  accessTokenHash: text('access_token_hash'),
  createdAt: createdAt(),
  updatedAt: updatedAt(),
}, (t) => [
  index('enrolments_course_idx').on(t.courseId),
  index('enrolments_user_idx').on(t.userId, t.organizationId),
]);

export const lessonProgress = pgTable('lesson_progress', {
  id: pk(),
  organizationId: org(),
  enrolmentId: uuid('enrolment_id').notNull().references(() => enrolments.id, { onDelete: 'cascade' }),
  lessonId: uuid('lesson_id').notNull().references(() => courseLessons.id, { onDelete: 'cascade' }),
  completedAt: ts('completed_at').notNull().defaultNow(),
  score: integer('score'),
}, (t) => [uniqueIndex('lesson_progress_uq').on(t.enrolmentId, t.lessonId)]);

export const quizAttempts = pgTable('quiz_attempts', {
  id: pk(),
  organizationId: org(),
  enrolmentId: uuid('enrolment_id').notNull().references(() => enrolments.id, { onDelete: 'cascade' }),
  lessonId: uuid('lesson_id').notNull().references(() => courseLessons.id, { onDelete: 'cascade' }),
  answers: jsonb('answers').$type<Record<string, number[]>>().notNull(),
  score: integer('score').notNull(),
  passed: boolean('passed').notNull(),
  createdAt: createdAt(),
}, (t) => [index('quiz_attempts_enrolment_idx').on(t.enrolmentId)]);

export const certificates = pgTable('certificates', {
  id: pk(),
  organizationId: org(),
  enrolmentId: uuid('enrolment_id').notNull().references(() => enrolments.id, { onDelete: 'cascade' }),
  courseId: uuid('course_id').notNull().references(() => courses.id, { onDelete: 'cascade' }),
  userId: uuid('user_id'),
  /** Public verification code printed on the certificate. */
  code: text('code').notNull().unique(),
  learnerName: text('learner_name').notNull(),
  courseTitle: text('course_title').notNull(),
  issuedAt: ts('issued_at').notNull().defaultNow(),
  expiresAt: ts('expires_at'),
  revokedAt: ts('revoked_at'),
}, (t) => [index('certificates_org_idx').on(t.organizationId)]);

export const courseLeads = pgTable('course_leads', {
  id: pk(),
  organizationId: org(),
  courseId: uuid('course_id').references(() => courses.id, { onDelete: 'set null' }),
  name: text('name').notNull(),
  email: text('email').notNull(),
  phone: text('phone'),
  message: text('message'),
  /** website | ad_campaign | manual | import */
  source: text('source').notNull().default('website'),
  campaign: text('campaign'),
  utm: jsonb('utm').$type<Record<string, string>>().notNull().default({}),
  assignedTo: uuid('assigned_to').references(() => users.id, { onDelete: 'set null' }),
  /** new | contacted | enrolled | lost */
  status: text('status').notNull().default('new'),
  notes: text('notes'),
  marketingConsent: boolean('marketing_consent').notNull().default(false),
  enrolmentId: uuid('enrolment_id'),
  createdAt: createdAt(),
  updatedAt: updatedAt(),
}, (t) => [index('course_leads_org_idx').on(t.organizationId, t.status)]);

// ───────────────────────── Help desk ─────────────────────────

export const helpdeskSettings = pgTable('helpdesk_settings', {
  id: pk(),
  organizationId: org().unique(),
  /** Secret part of the email-in address (support+<slug>.<token>@inbound…). */
  inboundToken: text('inbound_token').notNull(),
  autoAssign: boolean('auto_assign').notNull().default(true),
  createdAt: createdAt(),
});

export const helpdeskCategories = pgTable('helpdesk_categories', {
  id: pk(),
  organizationId: org(),
  name: text('name').notNull(),
  /** First-response and resolution targets in minutes for normal priority (scaled by priority). */
  firstResponseMinutes: integer('first_response_minutes').notNull().default(240),
  resolutionMinutes: integer('resolution_minutes').notNull().default(2880),
  defaultAssigneeId: uuid('default_assignee_id').references(() => users.id, { onDelete: 'set null' }),
  position: integer('position').notNull().default(0),
  archivedAt: ts('archived_at'),
}, (t) => [index('helpdesk_categories_org_idx').on(t.organizationId)]);

export const tickets = pgTable('tickets', {
  id: pk(),
  organizationId: org(),
  number: integer('number').notNull(),
  locationId: uuid('location_id').references(() => locations.id, { onDelete: 'set null' }),
  requesterId: uuid('requester_id').references(() => users.id, { onDelete: 'set null' }),
  requesterEmail: text('requester_email'),
  categoryId: uuid('category_id').references(() => helpdeskCategories.id, { onDelete: 'set null' }),
  subject: text('subject').notNull(),
  /** low | normal | high | urgent */
  priority: text('priority').notNull().default('normal'),
  /** open | pending (waiting on requester) | on_hold | resolved | closed */
  status: text('status').notNull().default('open'),
  assigneeId: uuid('assignee_id').references(() => users.id, { onDelete: 'set null' }),
  /** web | mobile | email */
  channel: text('channel').notNull().default('web'),
  firstResponseDueAt: ts('first_response_due_at'),
  resolutionDueAt: ts('resolution_due_at'),
  firstRespondedAt: ts('first_responded_at'),
  /** SLA clock paused while waiting on the requester. */
  pausedAt: ts('paused_at'),
  breachNotifiedAt: ts('breach_notified_at'),
  resolvedAt: ts('resolved_at'),
  closedAt: ts('closed_at'),
  satisfaction: integer('satisfaction'),
  satisfactionComment: text('satisfaction_comment'),
  createdAt: createdAt(),
  updatedAt: updatedAt(),
}, (t) => [
  uniqueIndex('tickets_org_number_uq').on(t.organizationId, t.number),
  index('tickets_org_status_idx').on(t.organizationId, t.status),
]);

export const ticketMessages = pgTable('ticket_messages', {
  id: pk(),
  organizationId: org(),
  ticketId: uuid('ticket_id').notNull().references(() => tickets.id, { onDelete: 'cascade' }),
  authorId: uuid('author_id').references(() => users.id, { onDelete: 'set null' }),
  authorEmail: text('author_email'),
  body: text('body').notNull(),
  /** Internal notes are visible to HQ agents only. */
  internal: boolean('internal').notNull().default(false),
  attachments: jsonb('attachments').$type<Attachment[]>().notNull().default([]),
  createdAt: createdAt(),
}, (t) => [index('ticket_messages_ticket_idx').on(t.ticketId, t.createdAt)]);

export const cannedReplies = pgTable('canned_replies', {
  id: pk(),
  organizationId: org(),
  title: text('title').notNull(),
  body: text('body').notNull(),
  createdBy: uuid('created_by'),
  createdAt: createdAt(),
});
