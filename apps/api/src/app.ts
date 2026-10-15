import Fastify, { type FastifyInstance, type FastifyServerOptions } from 'fastify';
import cors from '@fastify/cors';
import cookie from '@fastify/cookie';
import helmet from '@fastify/helmet';
import rateLimit from '@fastify/rate-limit';
import swagger from '@fastify/swagger';
import swaggerUi from '@fastify/swagger-ui';
import {
  hasZodFastifySchemaValidationErrors,
  isResponseSerializationError,
  jsonSchemaTransform,
  serializerCompiler,
  validatorCompiler,
  type ZodTypeProvider,
} from 'fastify-type-provider-zod';
import { z } from 'zod';
import { sql } from 'drizzle-orm';
import { loadConfig, integrationStatus, type Config } from './config.ts';
import { createDb, type DbHandle } from './db/client.ts';
import { createServices, type Services } from './context.ts';
import { AppError } from './lib/errors.ts';
import { optionalAuth } from './plugins/auth.ts';
import { registerJobHandlers } from './jobs/handlers.ts';
import { registerRoutes } from './routes/index.ts';

declare module 'fastify' {
  interface FastifyInstance {
    ctx: Services;
  }
}

export type App = FastifyInstance;

export interface BuildOptions {
  config?: Partial<Record<keyof Config, string>> | Config;
  dbHandle?: DbHandle;
  overrides?: Partial<Services>;
  logger?: FastifyServerOptions['logger'];
}

/** Trust the nearest `n` proxies (Fastify's types don't accept a bare hop count). */
const trustHops = (n: number) => (_address: string, hop: number) => hop < n;

export async function buildApp(opts: BuildOptions = {}): Promise<FastifyInstance> {
  const cfg = opts.config && 'DATABASE_URL' in opts.config && typeof (opts.config as Config).PORT === 'number'
    ? (opts.config as Config)
    : loadConfig({ ...process.env, ...(opts.config as Record<string, string> | undefined) });

  const app = Fastify({
    logger: opts.logger ?? {
      level: cfg.LOG_LEVEL,
      transport: cfg.NODE_ENV === 'development' ? { target: 'pino-pretty', options: { translateTime: 'SYS:HH:MM:ss', ignore: 'pid,hostname' } } : undefined,
      redact: ['req.headers.authorization', 'req.headers.cookie', 'req.headers["stripe-signature"]'],
    },
    trustProxy: typeof cfg.TRUST_PROXY === 'number' ? trustHops(cfg.TRUST_PROXY) : cfg.TRUST_PROXY,
    bodyLimit: 2 * 1024 * 1024,
  });
  app.setValidatorCompiler(validatorCompiler);
  app.setSerializerCompiler(serializerCompiler);

  const dbHandle = opts.dbHandle ?? createDb(cfg.DATABASE_URL, { max: cfg.DATABASE_POOL_MAX });
  const services = await createServices(cfg, dbHandle, app.log, opts.overrides);
  app.decorate('ctx', services);
  registerJobHandlers(services);

  app.addHook('onClose', async () => {
    await services.jobs.close();
    if (!opts.dbHandle) await dbHandle.close();
  });

  await app.register(helmet, { contentSecurityPolicy: false });
  await app.register(cors, {
    origin: (origin, cb) => {
      if (!origin) return cb(null, true); // server-to-server, mobile apps, curl
      cb(null, cfg.CORS_ORIGINS.includes(origin) || cfg.CORS_ORIGINS.includes('*'));
    },
    credentials: true,
    methods: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'],
  });
  await app.register(cookie);
  await app.register(rateLimit, { global: false, max: 300, timeWindow: '1 minute' });

  await app.register(swagger, {
    openapi: {
      info: { title: 'BranchHarbor API', version: '0.1.0', description: 'Multi-location platform API. Errors use { error: { code, message, fields? } }. Money is integer minor units + ISO 4217 currency; timestamps are UTC ISO 8601.' },
      servers: [{ url: cfg.PUBLIC_API_URL }],
      components: { securitySchemes: { bearerAuth: { type: 'http', scheme: 'bearer', bearerFormat: 'JWT' } } },
      tags: ['public', 'auth', 'me', 'orgs', 'locations', 'members', 'websites', 'domains', 'connections', 'payments', 'webhooks', 'reports', 'studios', 'sports', 'wellness', 'commerce', 'foods', 'ai', 'audit', 'inbox', 'sales', 'social', 'marketing'].map((name) => ({ name })),
    },
    transform: jsonSchemaTransform,
  });
  await app.register(swaggerUi, { routePrefix: '/docs' });

  app.addHook('onRequest', optionalAuth(cfg));
  // Requests without a body arrive as null; treat as {} so optional/defaulted body schemas apply.
  app.addHook('preValidation', async (req) => {
    if ((req.body === null || req.body === undefined) && req.method !== 'GET' && req.method !== 'HEAD') (req as { body: unknown }).body = {};
  });

  app.setErrorHandler((err, req, reply) => {
    if (hasZodFastifySchemaValidationErrors(err)) {
      const fields: Record<string, string> = {};
      for (const v of err.validation) fields[v.instancePath.replace(/^\//, '').replace(/\//g, '.') || '_'] = v.message ?? 'Invalid value';
      return reply.code(400).send({ error: { code: 'validation_failed', message: 'Some fields need attention', fields } });
    }
    if (isResponseSerializationError(err)) {
      req.log.error({ err, issues: err.cause.issues }, 'response serialization failed');
      return reply.code(500).send({ error: { code: 'internal_error', message: 'Unexpected server error' } });
    }
    if (err instanceof AppError) {
      return reply.code(err.status).send({ error: { code: err.code, message: err.message, ...(err.fields ? { fields: err.fields } : {}), ...(err.details ? { details: err.details } : {}) } });
    }
    const e = err as { statusCode?: number; code?: string; message: string };
    if (e.statusCode === 429) return reply.code(429).send({ error: { code: 'rate_limited', message: 'Too many requests. Please wait and try again.' } });
    if (e.statusCode && e.statusCode >= 400 && e.statusCode < 500) {
      return reply.code(e.statusCode).send({ error: { code: (e.code ?? 'bad_request').toLowerCase(), message: e.message } });
    }
    // Postgres constraint violations that escaped service-level checks.
    const pg = (err as { cause?: { code?: string } }).cause ?? (err as { code?: string });
    if (pg?.code === '23505') return reply.code(409).send({ error: { code: 'conflict', message: 'That record already exists' } });
    if (pg?.code === '23P01') return reply.code(409).send({ error: { code: 'slot_unavailable', message: 'That time is no longer available' } });
    req.log.error({ err }, 'unhandled error');
    return reply.code(500).send({ error: { code: 'internal_error', message: 'Unexpected server error' } });
  });
  app.setNotFoundHandler((req, reply) => reply.code(404).send({ error: { code: 'not_found', message: `Route ${req.method} ${req.url} not found` } }));

  const zapp = app.withTypeProvider<ZodTypeProvider>();
  zapp.get('/health', {
    schema: {
      tags: ['public'],
      summary: 'Health and integration status',
      response: { 200: z.object({ status: z.enum(['ok', 'degraded']), database: z.enum(['up', 'down']), version: z.string(), time: z.string(), demoMode: z.boolean(), integrations: z.record(z.string(), z.string()) }) },
    },
  }, async () => {
    const database = await services.db.execute(sql`select 1`).then(() => 'up' as const).catch(() => 'down' as const);
    return { status: database === 'up' ? ('ok' as const) : ('degraded' as const), database, version: '0.1.0', time: new Date().toISOString(), demoMode: cfg.DEMO_MODE, integrations: integrationStatus(cfg) as Record<string, string> };
  });

  await app.register(registerRoutes, { prefix: '/v1' });

  app.log.info({ integrations: integrationStatus(cfg) }, 'BranchHarbor API configured');
  return app;
}
