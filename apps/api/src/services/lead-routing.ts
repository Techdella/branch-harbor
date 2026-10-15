/**
 * Lead routing: rules are checked in order and the first match wins. Actions send the lead to a location's queue,
 * round-robin over named people, or round-robin over the people with access at the lead's location. Course leads
 * (teacher training) that match no rule go to the instructor with the fewest open course leads.
 */
import { and, asc, eq, inArray, sql } from 'drizzle-orm';
import type { Exec } from '../db/client.ts';
import { leadRoutingRules, leads, locations, type RoutingAction, type RoutingConditions } from '../db/schema/index.ts';
import { audit } from './audit.ts';
import { usersWithCapabilityAt } from './comms-scope.ts';

export type LeadRow = typeof leads.$inferSelect;
type RuleRow = typeof leadRoutingRules.$inferSelect;

export interface LeadFacts {
  kind: string;
  source: string;
  locationId: string | null;
  country: string | null;
  postalCode: string | null;
  adCampaignId: string | null;
}

const norm = (v: string | null | undefined) => (v ?? '').replace(/\s+/g, '').toUpperCase();

export function ruleMatches(c: RoutingConditions, lead: LeadFacts, locationCountry: string | null): boolean {
  if (c.sources?.length && !c.sources.includes(lead.source)) return false;
  if (c.locationIds?.length && (!lead.locationId || !c.locationIds.includes(lead.locationId))) return false;
  const country = lead.country ?? locationCountry;
  if (c.countries?.length && (!country || !c.countries.map(norm).includes(norm(country)))) return false;
  if (c.postalPrefixes?.length && !c.postalPrefixes.some((p) => norm(p) && norm(lead.postalCode).startsWith(norm(p)))) return false;
  if (c.campaignIds?.length && (!lead.adCampaignId || !c.campaignIds.includes(lead.adCampaignId))) return false;
  return true;
}

export const pipelineModule = (kind: string) => (kind === 'course' ? 'sales.course_leads' : 'sales.customer_pipeline');

/** Atomically advance a rule's round-robin cursor and return the slot to use. */
async function nextSlot(db: Exec, ruleId: string, n: number): Promise<number> {
  const [r] = await db.update(leadRoutingRules).set({ cursor: sql`${leadRoutingRules.cursor} + 1` }).where(eq(leadRoutingRules.id, ruleId)).returning({ cursor: leadRoutingRules.cursor });
  return ((r?.cursor ?? 1) - 1) % n;
}

export interface RoutingDecision {
  ruleId: string | null;
  ruleName: string | null;
  locationId: string | null;
  assignedUserId: string | null;
  reason: 'rule' | 'least_loaded_instructor' | 'unrouted';
}

/** Decide where a lead goes. With `dryRun`, cursors are not advanced (used by "Test a lead"). */
export async function decideRouting(db: Exec, orgId: string, lead: LeadFacts, opts: { dryRun?: boolean } = {}): Promise<RoutingDecision> {
  const rules: RuleRow[] = await db.select().from(leadRoutingRules)
    .where(and(eq(leadRoutingRules.organizationId, orgId), eq(leadRoutingRules.kind, lead.kind === 'course' ? 'course' : 'customer'), eq(leadRoutingRules.active, true)))
    .orderBy(asc(leadRoutingRules.position), asc(leadRoutingRules.createdAt));
  const [loc] = lead.locationId ? await db.select({ country: locations.country }).from(locations).where(eq(locations.id, lead.locationId)) : [];
  const module = pipelineModule(lead.kind);
  for (const r of rules) {
    if (!ruleMatches(r.conditions, lead, loc?.country ?? null)) continue;
    const a: RoutingAction = r.action;
    if (a.type === 'location') return { ruleId: r.id, ruleName: r.name, locationId: a.locationId ?? lead.locationId, assignedUserId: null, reason: 'rule' };
    const locationId = a.type === 'location_team' ? (a.locationId ?? lead.locationId) : lead.locationId;
    const pool = a.type === 'users' ? [...(a.userIds ?? [])] : await usersWithCapabilityAt(db, orgId, locationId, module, 'edit', { excludeOwners: true });
    if (!pool.length) return { ruleId: r.id, ruleName: r.name, locationId, assignedUserId: null, reason: 'rule' };
    const slot = opts.dryRun ? r.cursor % pool.length : await nextSlot(db, r.id, pool.length);
    return { ruleId: r.id, ruleName: r.name, locationId, assignedUserId: pool[slot]!, reason: 'rule' };
  }
  if (lead.kind === 'course') {
    // Owners hold every module but aren't instructors: they never receive course leads automatically.
    const instructors = await usersWithCapabilityAt(db, orgId, null, 'sales.course_leads', 'edit', { excludeOwners: true });
    if (instructors.length) {
      const load = await db.select({ userId: leads.assignedUserId, n: sql<number>`count(*)::int` }).from(leads)
        .where(and(eq(leads.organizationId, orgId), eq(leads.kind, 'course'), inArray(leads.assignedUserId, instructors), inArray(leads.status, ['new', 'contacted', 'qualified'])))
        .groupBy(leads.assignedUserId);
      const count = (id: string) => load.find((l) => l.userId === id)?.n ?? 0;
      const pick = [...instructors].sort((x, y) => count(x) - count(y) || x.localeCompare(y))[0]!;
      return { ruleId: null, ruleName: null, locationId: lead.locationId, assignedUserId: pick, reason: 'least_loaded_instructor' };
    }
  }
  return { ruleId: null, ruleName: null, locationId: lead.locationId, assignedUserId: null, reason: 'unrouted' };
}

/** Route a stored lead and persist the decision (audited). */
export async function routeLead(db: Exec, lead: LeadRow): Promise<LeadRow> {
  const d = await decideRouting(db, lead.organizationId, lead);
  const [u] = await db.update(leads).set({ locationId: d.locationId, assignedUserId: d.assignedUserId, routingRuleId: d.ruleId, updatedAt: new Date() }).where(eq(leads.id, lead.id)).returning();
  await audit(db, {
    organizationId: lead.organizationId, actorUserId: null, actorType: 'system', action: 'lead.routed', scopeKind: d.locationId ? 'location' : 'organization', scopeId: d.locationId ?? lead.organizationId,
    targetType: 'lead', targetId: lead.id, metadata: { ruleId: d.ruleId, reason: d.reason, assignedUserId: d.assignedUserId },
  });
  return u!;
}

export async function createRoutedLead(db: Exec, values: typeof leads.$inferInsert): Promise<LeadRow> {
  const [l] = await db.insert(leads).values({ ...values, updatedAt: new Date() }).returning();
  return routeLead(db, l!);
}
