import { eq } from 'drizzle-orm';
import type { Services } from '../context.ts';
import { demoRequests } from '../db/schema/index.ts';
import type { EmailMessage } from '../integrations/mailer.ts';
import { runConnectionSync } from '../services/connections.ts';
import { expireHolds } from '../services/studios.ts';
import { deliverPush, type NotifyInput } from '../services/notifications.ts';

/** Background job handlers. Run via BullMQ when REDIS_URL is set, inline otherwise. */
export function registerJobHandlers(s: Services) {
  s.jobs.register('email.send', async (msg: EmailMessage) => {
    await s.mailer.send(msg);
  });

  s.jobs.register('demo-request.notify', async ({ id }: { id: string }) => {
    const [d] = await s.db.select().from(demoRequests).where(eq(demoRequests.id, id));
    if (!d) return;
    await s.mailer.send({
      to: s.cfg.SALES_NOTIFICATION_EMAIL,
      subject: `Demo request: ${d.business} (${d.industry}, ${d.locationCount} location${d.locationCount === 1 ? '' : 's'}, ${d.country})`,
      text: [`Name: ${d.name}`, `Email: ${d.email}`, `Business: ${d.business}`, `Industry: ${d.industry}`, `Locations: ${d.locationCount}`, `Country: ${d.country}`, `Website: ${d.existingWebsite ?? '—'}`, `Phone: ${d.phone ?? '—'}`, `Systems: ${d.existingSystems ?? '—'}`, `Difficulty: ${d.primaryDifficulty ?? '—'}`, `Locale: ${d.locale}`, `Marketing consent: ${d.marketingConsent ? 'yes' : 'no'}`].join('\n'),
      tag: 'demo-request',
    });
    await s.mailer.send({
      to: d.email,
      subject: 'Thanks for your interest in BranchHarbor',
      text: `Hi ${d.name},\n\nThanks for telling us about ${d.business}. A member of our team will review your request and contact you by email to arrange a demo.\n\n— BranchHarbor`,
      tag: 'demo-request-confirmation',
    });
    await s.db.update(demoRequests).set({ notifiedAt: new Date() }).where(eq(demoRequests.id, id));
  });

  s.jobs.register('connection.sync', async ({ connectionId, syncRunId }: { connectionId: string; syncRunId: string }) => {
    await runConnectionSync(s, connectionId, syncRunId);
  });

  s.jobs.register('push.send', async (input: NotifyInput) => {
    await deliverPush(s, input);
  });

  s.jobs.register('studios.expire-holds', async () => {
    await expireHolds(s);
  });
}
