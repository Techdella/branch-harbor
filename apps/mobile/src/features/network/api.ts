/**
 * Network workspaces on mobile: Community announcements and required reads, Training lessons and
 * quizzes, and raising Help desk tickets. Routes: /v1/orgs/:orgId/community|training|helpdesk/*.
 */
import { http } from '@/lib/http';
import { selectedAccountId } from '@/lib/live';

export interface NetOrg { id: string; name: string }
export interface Announcement { id: string; title: string; body: string; requiredRead: boolean; dueAt: string | null; pinned: boolean; author: { name: string; badge: string } | null; publishAt: string | null; createdAt: string; readAt: string | null; acknowledgedAt: string | null; overdue: boolean }
export interface Enrolment { id: string; status: string; progressPct: number; dueAt: string | null; overdue: boolean; course: { id: string; title: string; estimatedMinutes: number | null } }
export interface CourseDetail { course: { id: string; title: string; summary: string | null; passMark: number }; outline: { id: string; title: string; lessons: { id: string; title: string; kind: string; completed: boolean }[] }[]; enrolment: { status: string; progressPct: number } | null; missingPrerequisites: { title: string }[] }
export interface Lesson { id: string; courseId: string; courseTitle: string; title: string; kind: string; body: string | null; videoUrl: string | null; attachments: { name: string; url: string }[]; quiz: { id: string; prompt: string; options: string[]; multiple: boolean }[] | null; passMark: number | null; completed: boolean; nextId: string | null; enrolment: { status: string; progressPct: number } | null }
export interface QuizResult { score: number; passed: boolean; passMark: number; results: { questionId: string; correct: boolean }[]; enrolment: { status: string; progressPct: number } }
export interface Ticket { id: string; number: number; subject: string; priority: string; status: string; updatedAt: string }
export interface HelpOverview { categories: { id: string; name: string }[]; myLocations: { id: string; name: string }[] }

interface MeOrg { id: string; name: string; roles: { role: string }[]; access?: { capabilities: string[] } }

/** Holds Community, Training or Help desk (any module of those workspaces) in this business account. */
export const holdsNetwork = (caps: readonly string[] | undefined) => (caps ?? []).some((c) => (c.startsWith('community.') || c.startsWith('training.')) && c.endsWith(':view'));

/** Business accounts where the person is a team member with network workspaces; the active account first. */
export async function networkOrgs(): Promise<NetOrg[]> {
  const me = await http<{ organizations: MeOrg[] }>('GET', '/auth/me');
  const active = selectedAccountId();
  return me.organizations
    .filter((o) => o.roles.some((r) => r.role !== 'customer') && holdsNetwork(o.access?.capabilities))
    .sort((a, b) => Number(b.id === active) - Number(a.id === active))
    .map((o) => ({ id: o.id, name: o.name }));
}

const o = (orgId: string) => `/orgs/${orgId}`;
export const netApi = {
  me: (orgId: string) => http<{ counters: { requiredReadsPending: number; unreadNotifications: number; openTickets: number }; accountManagers: { name: string; bookingUrl: string | null; title: string | null }[] }>('GET', `${o(orgId)}/community/me`),
  announcements: async (orgId: string) => (await http<{ items: Announcement[] }>('GET', `${o(orgId)}/community/announcements`)).items,
  read: (orgId: string, id: string) => http<{ readAt: string }>('POST', `${o(orgId)}/community/announcements/${id}/read`, {}),
  acknowledge: (orgId: string, id: string) => http<{ acknowledgedAt: string }>('POST', `${o(orgId)}/community/announcements/${id}/acknowledge`, {}),
  training: (orgId: string) => http<{ enrolments: Enrolment[] }>('GET', `${o(orgId)}/training/home`),
  course: (orgId: string, id: string) => http<CourseDetail>('GET', `${o(orgId)}/training/courses/${id}`),
  start: (orgId: string, id: string) => http<unknown>('POST', `${o(orgId)}/training/courses/${id}/start`, {}),
  lesson: (orgId: string, id: string) => http<Lesson>('GET', `${o(orgId)}/training/lessons/${id}`),
  complete: (orgId: string, id: string) => http<unknown>('POST', `${o(orgId)}/training/lessons/${id}/complete`, {}),
  quiz: (orgId: string, id: string, answers: Record<string, number[]>) => http<QuizResult>('POST', `${o(orgId)}/training/lessons/${id}/quiz`, { answers }),
  helpOverview: (orgId: string) => http<HelpOverview>('GET', `${o(orgId)}/helpdesk/overview`),
  tickets: async (orgId: string) => (await http<{ items: Ticket[] }>('GET', `${o(orgId)}/helpdesk/tickets?mine=true&status=all`)).items,
  raise: (orgId: string, b: { subject: string; body: string; priority: string; categoryId: string | null; locationId: string | null }) => http<Ticket>('POST', `${o(orgId)}/helpdesk/tickets`, { ...b, channel: 'mobile' }),
};
