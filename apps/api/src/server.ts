import { buildApp } from './app.ts';
import { config } from './config.ts';

const cfg = config();
const app = await buildApp();

// Periodic housekeeping: expire class holds so seats return to the pool / waitlist.
const sweep = setInterval(() => void app.ctx.jobs.enqueue('studios.expire-holds', {}).catch(() => {}), 60_000);
// Real Estate: viewing reminders and consented saved-search alerts.
const realtySweep = setInterval(() => void import('./services/realty-jobs.ts').then((m) => m.runRealtyHousekeeping(app.ctx)), 5 * 60_000);
// Franchise development: due cadence emails, task reminders, agreement expiry reminders.
const franchiseSweep = setInterval(() => void import('./services/franchise.ts').then((m) => m.runFranchiseJobs(app.ctx)).catch((err) => app.log.error({ err }, 'franchise jobs failed')), 15 * 60_000);
// Hospitality: expire unpaid holds and send consented pre-arrival / check-in messages.
const hospitalitySweep = setInterval(() => void (async () => {
  const m = await import('./services/hospitality.ts');
  await m.expireHolds(app.ctx);
  await (await import('./services/hospitality-ops.ts')).runGuestMessages(app.ctx);
})().catch((err) => app.log.warn({ err }, 'hospitality sweep failed')), 5 * 60_000);
// Network workspaces: scheduled announcements, required-read reminders, help desk SLA alerts, re-certification, email digests.
const networkSweep = setInterval(() => void import('./services/community.ts').then((m) => m.runNetworkHousekeeping(app.ctx)).catch((err) => app.log.error({ err }, 'network housekeeping failed')), 5 * 60_000);
// Marketing: resume delayed automation runs, deliver scheduled campaigns and publish scheduled pages (works without Redis).
const marketingSweep = setInterval(() => void app.ctx.jobs.enqueue('marketing.tick', {}, { jobId: `marketing-tick-${Math.floor(Date.now() / 30_000)}` }).catch(() => {}), 30_000);
// Finance: dunning (reminders, collection retries, late fees, final notices) once a day per organisation with finance
// settings; each step is recorded once, so a repeated run is harmless.
const enqueueDunning = () => void (async () => {
  const { financeSettings } = await import('./db/schema/index.ts');
  const day = new Date().toISOString().slice(0, 10);
  for (const r of await app.ctx.db.select({ organizationId: financeSettings.organizationId }).from(financeSettings)) {
    await app.ctx.jobs.enqueue('finance.dunning', { organizationId: r.organizationId }, { jobId: `finance-dunning-${r.organizationId}-${day}` });
  }
})().catch((err) => app.log.warn({ err }, 'finance dunning schedule failed'));
const dunningStart = setTimeout(enqueueDunning, 60_000);
const dunningSweep = setInterval(enqueueDunning, 24 * 3600_000);
// Audits and compliance documents: overdue corrective actions / audits and expiry reminders. Hourly, each reminder is
// recorded once, so repeated runs are harmless (one job per hour with BullMQ).
const qualitySweep = setInterval(() => void app.ctx.jobs.enqueue('quality.daily', {}, { jobId: `quality-${Math.floor(Date.now() / 3600_000)}` }).catch(() => {}), 3600_000);
// Franchise development: open scheduled survey rounds, flag ended cure periods (each recorded once; hourly).
const franchiseDevSweep = setInterval(() => void app.ctx.jobs.enqueue('franchise-dev.hourly', {}, { jobId: `franchise-dev-${Math.floor(Date.now() / 3600_000)}` }).catch(() => {}), 3600_000);

// BranchHarbor billing: trial reminders 3 days and 1 day before the plan starts; in sandbox also trial conversions,
// renewals and billing-country changes; expired data exports are purged.
const billingSweep = setInterval(() => void (async () => {
  await (await import('./services/billing.ts')).runBillingSweep(app.ctx);
  await (await import('./services/data-export.ts')).purgeExpiredExports(app.ctx);
})().catch((err) => app.log.warn({ err }, 'billing sweep failed')), cfg.BILLING_SWEEP_MINUTES * 60_000);

// Network data platform: nightly POS / booking sales sync (last three local days per connection, one job per
// connection and day), daily benchmark recompute, and purging parsed import rows once the undo window has closed.
const dataPlatformHourly = setInterval(() => void (async () => {
  const hour = Math.floor(Date.now() / 3600_000);
  const day = new Date().toISOString().slice(0, 10);
  await app.ctx.jobs.enqueue('sales.nightly', {}, { jobId: `sales-nightly-${day}` });
  if (hour % 24 === 3) await app.ctx.jobs.enqueue('benchmarks.recompute', {}, { jobId: `benchmarks-${day}` });
  await (await import('./services/imports.ts')).purgeImportRows(app.ctx.db);
})().catch((err) => app.log.warn({ err }, 'data platform sweep failed')), 3600_000);

const shutdown = async (signal: string) => {
  app.log.info({ signal }, 'shutting down');
  clearInterval(dataPlatformHourly);
  clearInterval(sweep);
  clearInterval(realtySweep);
  clearInterval(franchiseSweep);
  clearInterval(hospitalitySweep);
  clearInterval(networkSweep);
  clearInterval(marketingSweep);
  clearTimeout(dunningStart);
  clearInterval(dunningSweep);
  clearInterval(billingSweep);
  clearInterval(qualitySweep);
  clearInterval(franchiseDevSweep);
  await app.close();
  process.exit(0);
};
process.on('SIGINT', () => void shutdown('SIGINT'));
process.on('SIGTERM', () => void shutdown('SIGTERM'));

try {
  await app.listen({ port: cfg.PORT, host: cfg.HOST });
  app.log.info(`BranchHarbor API listening on ${cfg.PUBLIC_API_URL} — docs at ${cfg.PUBLIC_API_URL}/docs`);
} catch (err) {
  app.log.error(err);
  process.exit(1);
}
