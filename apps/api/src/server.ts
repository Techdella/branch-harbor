import { buildApp } from './app.ts';
import { config } from './config.ts';

const cfg = config();
const app = await buildApp();

// Periodic housekeeping: expire class holds so seats return to the pool / waitlist.
const sweep = setInterval(() => void app.ctx.jobs.enqueue('studios.expire-holds', {}).catch(() => {}), 60_000);
// Real Estate: viewing reminders and consented saved-search alerts.
const realtySweep = setInterval(() => void import('./services/realty-jobs.ts').then((m) => m.runRealtyHousekeeping(app.ctx)), 5 * 60_000);
// Marketing: resume delayed automation runs, deliver scheduled campaigns and publish scheduled pages (works without Redis).
const marketingSweep = setInterval(() => void app.ctx.jobs.enqueue('marketing.tick', {}, { jobId: `marketing-tick-${Math.floor(Date.now() / 30_000)}` }).catch(() => {}), 30_000);

const shutdown = async (signal: string) => {
  app.log.info({ signal }, 'shutting down');
  clearInterval(sweep);
  clearInterval(realtySweep);
  clearInterval(marketingSweep);
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
