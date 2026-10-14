import { z } from 'zod';

/**
 * Environment configuration. Every third-party integration is optional: when its key is
 * missing, the adapter runs in a clearly logged "disabled" or "sandbox" mode instead of
 * crashing. See .env.example for documentation of each variable.
 */

const bool = (def: boolean) =>
  z
    .enum(['true', 'false', '1', '0', ''])
    .optional()
    .transform((v) => (v === undefined || v === '' ? def : v === 'true' || v === '1'));

const optional = z
  .string()
  .optional()
  .transform((v) => (v && v.trim() !== '' ? v.trim() : undefined));

const envSchema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  PORT: z.coerce.number().int().default(4000),
  HOST: z.string().default('0.0.0.0'),
  LOG_LEVEL: z.enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace', 'silent']).default('info'),
  PUBLIC_API_URL: z.string().default('http://localhost:4000'),
  WEB_URL: z.string().default('http://localhost:3000'),
  APP_URL: z.string().default('http://localhost:3001'),
  CORS_ORIGINS: z
    .string()
    .default('http://localhost:3000,http://localhost:3001,http://localhost:8081,http://localhost:19006')
    .transform((v) => v.split(',').map((s) => s.trim()).filter(Boolean)),

  DATABASE_URL: z.string().default('postgres://bh:bh@localhost:5432/branchharbor'),
  DATABASE_POOL_MAX: z.coerce.number().int().default(10),
  REDIS_URL: optional,
  RUN_WORKERS: bool(true),

  JWT_SECRET: z.string().min(32).default('dev-only-insecure-jwt-secret-change-me-please-0000'),
  JWT_ISSUER: z.string().default('branchharbor'),
  ACCESS_TOKEN_TTL_SECONDS: z.coerce.number().int().default(900),
  REFRESH_TOKEN_TTL_DAYS: z.coerce.number().int().default(30),
  COOKIE_DOMAIN: optional,
  COOKIE_SECURE: bool(false),
  REQUIRE_EMAIL_VERIFICATION: bool(true),
  /** 32-byte key (hex or base64) used to encrypt connection credentials at rest. */
  ENCRYPTION_KEY: z.string().default('0000000000000000000000000000000000000000000000000000000000000000'),
  /** In non-production, expose verification/invite tokens in API responses so flows can be tested without email. */
  EXPOSE_DEV_TOKENS: bool(true),

  // Email
  EMAIL_FROM: z.string().default('BranchHarbor <no-reply@branchharbor.com>'),
  EMAIL_PROVIDER: z.preprocess((v) => (v === '' ? undefined : v), z.enum(['postmark', 'resend', 'log']).optional()),
  POSTMARK_SERVER_TOKEN: optional,
  RESEND_API_KEY: optional,
  SALES_NOTIFICATION_EMAIL: z.string().default('sales@branchharbor.com'),

  // Messaging
  TWILIO_ACCOUNT_SID: optional,
  TWILIO_AUTH_TOKEN: optional,
  TWILIO_FROM_NUMBER: optional,
  WHATSAPP_CLOUD_TOKEN: optional,
  WHATSAPP_PHONE_NUMBER_ID: optional,

  // Payments
  STRIPE_SECRET_KEY: optional,
  STRIPE_WEBHOOK_SECRET: optional,
  STRIPE_CONNECT_CLIENT_ID: optional,
  STRIPE_APPLICATION_FEE_BPS: z.coerce.number().int().min(0).max(10000).default(100),
  BOOKING_HOLD_MINUTES: z.coerce.number().int().default(10),

  // AI
  ANTHROPIC_API_KEY: optional,
  ANTHROPIC_MODEL: z.string().default('claude-sonnet-5-5'),
  ANTHROPIC_MAX_TOKENS: z.coerce.number().int().default(4096),
  ANTHROPIC_REFUSAL_FALLBACK: bool(true),

  // Domains
  CLOUDFLARE_API_TOKEN: optional,
  CLOUDFLARE_ZONE_ID: optional,
  DOMAINS_CNAME_TARGET: z.string().default('edge.branchharbor.com'),
  DOMAINS_SANDBOX_AUTO_VERIFY: bool(true),
  SITES_BASE_URL: z.string().default('https://sites.branchharbor.com'),

  // Maps / FX / storage / observability
  GOOGLE_MAPS_API_KEY: optional,
  OPEN_EXCHANGE_RATES_APP_ID: optional,
  S3_ENDPOINT: optional,
  S3_REGION: z.string().default('auto'),
  S3_BUCKET: optional,
  S3_ACCESS_KEY_ID: optional,
  S3_SECRET_ACCESS_KEY: optional,
  S3_PUBLIC_URL: optional,
  SENTRY_DSN: optional,
  POSTHOG_API_KEY: optional,
  POSTHOG_HOST: z.string().default('https://eu.i.posthog.com'),

  // OAuth sign-in / ads
  GOOGLE_OAUTH_CLIENT_ID: optional,
  GOOGLE_OAUTH_CLIENT_SECRET: optional,
  META_APP_ID: optional,
  META_APP_SECRET: optional,

  // Connectors
  MINDBODY_API_KEY: optional,
  MINDBODY_SITE_ID: optional,
  SQUARE_ACCESS_TOKEN: optional,
  SQUARE_ENVIRONMENT: z.enum(['sandbox', 'production']).default('sandbox'),
  SHOPIFY_API_KEY: optional,
  SHOPIFY_API_SECRET: optional,
  WOOCOMMERCE_CONSUMER_KEY: optional,
  WOOCOMMERCE_CONSUMER_SECRET: optional,
});

export type Config = z.infer<typeof envSchema>;

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const parsed = envSchema.safeParse(env);
  if (!parsed.success) {
    const issues = parsed.error.issues.map((i) => `  ${i.path.join('.')}: ${i.message}`).join('\n');
    throw new Error(`Invalid environment configuration:\n${issues}`);
  }
  const cfg = parsed.data;
  if (cfg.NODE_ENV === 'production') {
    if (cfg.JWT_SECRET.startsWith('dev-only')) throw new Error('JWT_SECRET must be set in production');
    if (/^0+$/.test(cfg.ENCRYPTION_KEY)) throw new Error('ENCRYPTION_KEY must be set in production');
  }
  return cfg;
}

let cached: Config | undefined;
export function config(): Config {
  cached ??= loadConfig();
  return cached;
}

/** Summary of which integrations are live vs disabled/sandbox, logged at boot and exposed at /health. */
export function integrationStatus(cfg: Config) {
  const mode = (on: boolean, off: 'disabled' | 'sandbox' = 'disabled') => (on ? 'live' : off);
  return {
    email: cfg.POSTMARK_SERVER_TOKEN || cfg.RESEND_API_KEY ? 'live' : 'disabled (logged to console)',
    sms: mode(!!(cfg.TWILIO_ACCOUNT_SID && cfg.TWILIO_AUTH_TOKEN)),
    whatsapp: mode(!!cfg.WHATSAPP_CLOUD_TOKEN),
    stripe: mode(!!cfg.STRIPE_SECRET_KEY, 'sandbox'),
    stripeWebhooks: cfg.STRIPE_WEBHOOK_SECRET ? 'verified' : 'disabled (unsigned events rejected)',
    ai: mode(!!cfg.ANTHROPIC_API_KEY),
    domains: mode(!!(cfg.CLOUDFLARE_API_TOKEN && cfg.CLOUDFLARE_ZONE_ID), 'sandbox'),
    maps: mode(!!cfg.GOOGLE_MAPS_API_KEY),
    fx: mode(!!cfg.OPEN_EXCHANGE_RATES_APP_ID),
    storage: mode(!!(cfg.S3_BUCKET && cfg.S3_ACCESS_KEY_ID), 'sandbox'),
    sentry: mode(!!cfg.SENTRY_DSN),
    posthog: mode(!!cfg.POSTHOG_API_KEY),
    jobs: cfg.REDIS_URL ? 'bullmq' : 'inline (no REDIS_URL)',
    mindbody: mode(!!cfg.MINDBODY_API_KEY, 'sandbox'),
    square: mode(!!cfg.SQUARE_ACCESS_TOKEN, 'sandbox'),
    shopify: mode(!!cfg.SHOPIFY_API_KEY, 'sandbox'),
    woocommerce: 'per-connection credentials',
    wordpress: 'per-connection credentials',
  } as const;
}
