/**
 * Contacts and segments. A contact is a customer record; segments filter by location, tags, behaviour (last booking
 * or purchase across the industry tables) and per-channel marketing consent. Results are always limited to the
 * locations the viewer may see.
 */
import { and, eq, inArray, isNull, sql, type SQL } from 'drizzle-orm';
import type { Exec } from '../db/client.ts';
import { contactTags, customers, type SegmentRules } from '../db/schema/index.ts';

/** Most recent booking / appointment / order of a customer (any industry). */
export const lastActivitySql = sql<Date | null>`(select max(x.at) from (
  select max(cb.created_at) as at from class_bookings cb where cb.customer_id = ${customers.id} and cb.status in ('confirmed','attended')
  union all select max(ap.created_at) from appointments ap where ap.customer_id = ${customers.id}
  union all select max(o.created_at) from orders o where o.customer_id = ${customers.id}
  union all select max(fo.created_at) from food_orders fo where fo.customer_id = ${customers.id}
) x)`;

const consentSql = (channel: string) => sql<boolean | null>`(select cr.granted from consent_records cr where cr.customer_id = ${customers.id} and cr.purpose = ${`marketing_${channel}`} order by cr.recorded_at desc limit 1)`;

export function segmentConditions(orgId: string, rules: SegmentRules, visible: string[] | null): SQL[] {
  const conds: SQL[] = [eq(customers.organizationId, orgId), isNull(customers.erasedAt)];
  if (visible) conds.push(visible.length ? inArray(customers.locationId, visible) : sql`false`);
  if (rules.locationIds?.length) conds.push(inArray(customers.locationId, rules.locationIds));
  if (rules.tagsAny?.length) conds.push(sql`exists (select 1 from contact_tags t where t.customer_id = ${customers.id} and t.tag in ${rules.tagsAny})`);
  if (rules.tagsAll?.length) conds.push(sql`(select count(distinct t.tag) from contact_tags t where t.customer_id = ${customers.id} and t.tag in ${rules.tagsAll}) = ${rules.tagsAll.length}`);
  if (rules.activeWithinDays) conds.push(sql`${lastActivitySql} >= now() - make_interval(days => ${rules.activeWithinDays})`);
  if (rules.lapsedForDays) conds.push(sql`${lastActivitySql} < now() - make_interval(days => ${rules.lapsedForDays})`);
  if (rules.neverActive) conds.push(sql`${lastActivitySql} is null`);
  if (rules.consentChannel) conds.push(sql`${consentSql(rules.consentChannel)} is true`);
  return conds;
}

export async function segmentMembers(db: Exec, orgId: string, rules: SegmentRules, visible: string[] | null, limit = 200) {
  const conds = segmentConditions(orgId, rules, visible);
  const [{ n } = { n: 0 }] = await db.select({ n: sql<number>`count(*)::int` }).from(customers).where(and(...conds));
  const rows = await db.select({
    id: customers.id, name: customers.name, email: customers.email, phone: customers.phone, locationId: customers.locationId, lastActivityAt: lastActivitySql,
    consentEmail: consentSql('email'), consentSms: consentSql('sms'), consentWhatsapp: consentSql('whatsapp'),
  }).from(customers).where(and(...conds)).orderBy(customers.name).limit(limit);
  const tags = rows.length ? await db.select().from(contactTags).where(inArray(contactTags.customerId, rows.map((r) => r.id))) : [];
  return {
    count: n,
    items: rows.map((r) => ({
      ...r, lastActivityAt: r.lastActivityAt ? new Date(r.lastActivityAt).toISOString() : null,
      consent: { email: r.consentEmail, sms: r.consentSms, whatsapp: r.consentWhatsapp },
      tags: tags.filter((t) => t.customerId === r.id).map((t) => t.tag).sort(),
    })).map(({ consentEmail: _e, consentSms: _s, consentWhatsapp: _w, ...rest }) => rest),
  };
}
