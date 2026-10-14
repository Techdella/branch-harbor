import type { FastifyBaseLogger } from 'fastify';
import type { Config } from './config.ts';
import type { Db, DbHandle } from './db/client.ts';
import { createMailer, type Mailer } from './integrations/mailer.ts';
import { createMessaging, type Messaging } from './integrations/messaging.ts';
import { createJobQueue, type JobQueue } from './integrations/jobs.ts';
import { createPaymentsProvider, type PaymentsProvider } from './integrations/payments.ts';
import { autoPassDnsChecker, createDomainProvider, systemDnsChecker, type DnsChecker, type DomainProvider } from './integrations/domains.ts';
import { createConnectors, type ConnectorAdapter, type ConnectorProvider } from './integrations/connectors.ts';
import { createAnalytics, createFx, createGeocoder, createStorage } from './integrations/misc.ts';
import { createAi, type AiProvider } from './integrations/ai.ts';

/** Dependency container shared by routes, services and jobs. Tests override individual members. */
export interface Services {
  cfg: Config;
  db: Db;
  dbHandle: DbHandle;
  log: FastifyBaseLogger;
  mailer: Mailer;
  messaging: Messaging;
  jobs: JobQueue;
  payments: PaymentsProvider;
  domains: DomainProvider;
  dns: DnsChecker;
  connectors: Record<ConnectorProvider, ConnectorAdapter>;
  fx: ReturnType<typeof createFx>;
  geocoder: ReturnType<typeof createGeocoder>;
  analytics: ReturnType<typeof createAnalytics>;
  storage: ReturnType<typeof createStorage>;
  ai: AiProvider;
}

export async function createServices(cfg: Config, dbHandle: DbHandle, log: FastifyBaseLogger, overrides: Partial<Services> = {}): Promise<Services> {
  const domainProvider = overrides.domains ?? createDomainProvider(cfg, log);
  return {
    cfg,
    db: dbHandle.db,
    dbHandle,
    log,
    mailer: overrides.mailer ?? createMailer(cfg, log),
    messaging: overrides.messaging ?? createMessaging(cfg, log),
    jobs: overrides.jobs ?? (await createJobQueue(cfg, log)),
    payments: overrides.payments ?? createPaymentsProvider(cfg, log),
    domains: domainProvider,
    dns: overrides.dns ?? (domainProvider.mode === 'sandbox' && cfg.DOMAINS_SANDBOX_AUTO_VERIFY ? autoPassDnsChecker : systemDnsChecker),
    connectors: overrides.connectors ?? createConnectors(cfg, log),
    fx: overrides.fx ?? createFx(cfg, log),
    geocoder: overrides.geocoder ?? createGeocoder(cfg, log),
    analytics: overrides.analytics ?? createAnalytics(cfg),
    storage: overrides.storage ?? createStorage(cfg, log),
    ai: overrides.ai ?? createAi(cfg, log),
  };
}
