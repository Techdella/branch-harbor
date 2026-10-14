import { and, eq, sql, isNull } from 'drizzle-orm';
import type { Exec } from '../db/client.ts';
import { consentRecords, customers } from '../db/schema/index.ts';

export interface ContactInput { name: string; email: string; phone?: string; marketingConsent?: boolean }

/** Find a customer by email within the organisation or create one. Never matches across organisations. */
export async function findOrCreateCustomer(db: Exec, organizationId: string, locationId: string | null, c: ContactInput, source = 'web') {
  const [existing] = await db.select().from(customers)
    .where(and(eq(customers.organizationId, organizationId), sql`lower(${customers.email}) = ${c.email.toLowerCase()}`, isNull(customers.erasedAt)));
  const customer = existing ?? (await db.insert(customers).values({ organizationId, locationId, name: c.name, email: c.email.trim(), phone: c.phone ?? null }).returning())[0]!;
  if (c.marketingConsent !== undefined) {
    await db.insert(consentRecords).values({ organizationId, customerId: customer.id, email: c.email, purpose: 'marketing_email', version: '2026-10', granted: c.marketingConsent, source });
  }
  return customer;
}
