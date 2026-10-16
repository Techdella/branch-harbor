import type { FastifyBaseLogger } from 'fastify';
import type { Config } from './config.ts';
import type { Db, DbHandle } from './db/client.ts';
import { createMailer, type Mailer } from './integrations/mailer.ts';
import { createMessaging, type Messaging } from './integrations/messaging.ts';
import { createJobQueue, type JobQueue } from './integrations/jobs.ts';
import { createPaymentsProvider, type PaymentsProvider } from './integrations/payments.ts';
import { autoPassDnsChecker, createDomainProvider, systemDnsChecker, type DnsChecker, type DomainProvider } from './integrations/domains.ts';
import { createConnectors, type ConnectorAdapter, type ConnectorProvider } from './integrations/connectors.ts';
import { createAnalytics, createBotCheck, createFx, createGeocoder, createStorage } from './integrations/misc.ts';
import { createAi, type AiProvider } from './integrations/ai.ts';
import { createPushProvider, type PushProvider } from './integrations/push.ts';
import type { FetchLike } from './integrations/partners/http.ts';
import { mtlsFetch } from './integrations/partners/rightmove.ts';
import { createAssetStore, type AssetStore } from './integrations/asset-storage.ts';
import { createPlatformBilling, type PlatformBilling } from './integrations/platform-billing.ts';
import { randomBytes } from 'node:crypto';
import type { InjectOptions, LightMyRequestResponse as InjectResponse } from 'fastify';
import { createMarinaLlm, type MarinaLlm } from './ai/llm.ts';

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
  /** BranchHarbor's own plan billing on the platform Stripe account (paid trial, subscription, invoices). */
  billing: PlatformBilling;
  domains: DomainProvider;
  dns: DnsChecker;
  connectors: Record<ConnectorProvider, ConnectorAdapter>;
  fx: ReturnType<typeof createFx>;
  geocoder: ReturnType<typeof createGeocoder>;
  analytics: ReturnType<typeof createAnalytics>;
  storage: ReturnType<typeof createStorage>;
  /** Brand asset library storage (S3/R2 when configured, Postgres sandbox otherwise). */
  assets: AssetStore;
  ai: AiProvider;
  /** The assistant's model layer: live Claude API, or the deterministic sandbox (no key, tests, demo). */
  marina: MarinaLlm;
  /**
   * In-process call into the REST API (set by buildApp once routes are registered). The assistant's tools use it with
   * the signed-in person's own token, so they pass exactly the same access checks as the app.
   */
  inject?: (opts: InjectOptions) => Promise<InjectResponse>;
  /** Per-process secret marking those in-process calls (exempt from per-IP rate limits, never accepted from outside). */
  internalKey: string;
  push: PushProvider;
  botCheck: ReturnType<typeof createBotCheck>;
  /** HTTP for partner APIs (Uber Direct, Deliverect, Rightmove). Tests inject a mock; never the real network. */
  partnerFetch: FetchLike;
  /** Mutual-TLS transport for Rightmove RTDF (client certificate). Tests inject a mock. */
  rightmoveFetch: (pfxBase64: string, passphrase?: string) => FetchLike;
}

export async function createServices(cfg: Config, dbHandle: DbHandle, log: FastifyBaseLogger, overrides: Partial<Services> = {}): Promise<Services> {
  const domainProvider = overrides.domains ?? createDomainProvider(cfg, log);
  const payments = overrides.payments ?? createPaymentsProvider(cfg, log);
  return {
    cfg,
    db: dbHandle.db,
    dbHandle,
    log,
    mailer: overrides.mailer ?? createMailer(cfg, log),
    messaging: overrides.messaging ?? createMessaging(cfg, log),
    jobs: overrides.jobs ?? (await createJobQueue(cfg, log)),
    payments,
    billing: overrides.billing ?? createPlatformBilling(cfg, payments, log),
    domains: domainProvider,
    dns: overrides.dns ?? (domainProvider.mode === 'sandbox' && cfg.DOMAINS_SANDBOX_AUTO_VERIFY ? autoPassDnsChecker : systemDnsChecker),
    connectors: overrides.connectors ?? createConnectors(cfg, log),
    fx: overrides.fx ?? createFx(cfg, log),
    geocoder: overrides.geocoder ?? createGeocoder(cfg, log),
    analytics: overrides.analytics ?? createAnalytics(cfg),
    storage: overrides.storage ?? createStorage(cfg, log),
    assets: overrides.assets ?? createAssetStore(cfg),
    ai: overrides.ai ?? createAi(cfg, log),
    marina: overrides.marina ?? createMarinaLlm(cfg, log),
    internalKey: overrides.internalKey ?? randomBytes(24).toString('hex'),
    push: overrides.push ?? createPushProvider(cfg, log),
    botCheck: overrides.botCheck ?? createBotCheck(cfg, log),
    partnerFetch: overrides.partnerFetch ?? ((url, init) => fetch(url, init)),
    rightmoveFetch: overrides.rightmoveFetch ?? mtlsFetch,
  };
}
