import { eq } from 'drizzle-orm';
import type { Services } from '../context.ts';
import { demoRequests } from '../db/schema/index.ts';
import type { EmailMessage } from '../integrations/mailer.ts';
import { demoRequestCopy } from '../lib/demoRequestCopy.ts';
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
    const copy = demoRequestCopy(d.locale);
    await s.mailer.send({
      to: d.email,
      subject: copy.subject,
      text: copy.body(d.name, d.business),
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

  s.jobs.register('foods.partner_order_event', async ({ orderId, to }: { orderId: string; to: string }) => {
    await (await import('../services/foods-partners.ts')).onFoodOrderTransition(s, orderId, to);
  });

  s.jobs.register('realty.portal_sync', async ({ listingId }: { listingId: string }) => {
    await (await import('../services/realty-portals.ts')).syncListingPortals(s, listingId);
  });

  // Marketing workspace: event inbox → automation runs, run advancement, campaign delivery, housekeeping tick.
  s.jobs.register('marketing.event', async ({ eventId }: { eventId: string }) => {
    await (await import('../services/automation-engine.ts')).processMarketingEvent(s, eventId);
  });
  s.jobs.register('automation.advance', async ({ runId }: { runId: string }) => {
    await (await import('../services/automation-engine.ts')).advanceRun(s, runId);
  });
  s.jobs.register('marketing.campaign', async ({ campaignId }: { campaignId: string }) => {
    await (await import('../services/marketing.ts')).deliverCampaign(s, campaignId);
  });
  s.jobs.register('marketing.tick', async () => {
    await (await import('../services/automation-engine.ts')).marketingTick(s);
  });

  s.jobs.register('studios.expire-holds', async () => {
    await expireHolds(s);
    await (await import('../services/studios-commerce.ts')).runStudioLifecycle(s);
  });
}
