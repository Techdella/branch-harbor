import { z } from 'zod';
import { DEFAULT_PAYMENT_APPLICATION_FEE_BPS } from '@bh/shared';

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
  /**
   * Which proxies may set X-Forwarded-For (client IP used for rate limits and audit).
   * 'loopback' (default) trusts only a proxy on the same host, e.g. the sites app; set to the
   * load balancer's address range, a hop count or 'true' only when every path goes through it.
   */
  TRUST_PROXY: z
    .string()
    .default('loopback')
    .transform((v): boolean | number | string => {
      const t = v.trim();
      if (t === '' || t === 'false') return false;
      if (t === 'true') return true;
      if (/^\d+$/.test(t)) return Number(t);
      return t;
    }),
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
  /**
   * Demo site only (e.g. demo.branchharbor.com against a database seeded with `pnpm db:seed:demo`): enables the
   * demo-account list and one-click demo sign-in. Never set it on the production database.
   */
  DEMO_MODE: bool(false),

  // Email
  EMAIL_FROM: z.string().default('BranchHarbor <no-reply@branchharbor.com>'),
  EMAIL_PROVIDER: z.preprocess((v) => (v === '' ? undefined : v), z.enum(['postmark', 'resend', 'log']).optional()),
  POSTMARK_SERVER_TOKEN: optional,
  RESEND_API_KEY: optional,
  /** Cloudflare Turnstile secret. When set, public demo requests must carry a valid token. */
  TURNSTILE_SECRET_KEY: optional,
  SALES_NOTIFICATION_EMAIL: z.string().default('sales@branchharbor.com'),

  // Messaging
  TWILIO_ACCOUNT_SID: optional,
  TWILIO_AUTH_TOKEN: optional,
  TWILIO_FROM_NUMBER: optional,
  WHATSAPP_CLOUD_TOKEN: optional,
  WHATSAPP_PHONE_NUMBER_ID: optional,
  /** Meta app secret of the WhatsApp Business app (X-Hub-Signature-256 on webhooks). Falls back to META_APP_SECRET. */
  WHATSAPP_APP_SECRET: optional,
  /** Token Meta echoes when subscribing the WhatsApp / Messenger / Instagram webhook (hub.verify_token). */
  META_WEBHOOK_VERIFY_TOKEN: optional,
  /** Postmark inbound: the webhook URL carries HTTP basic auth `inbound:<token>` (Postmark signs nothing else). */
  POSTMARK_INBOUND_TOKEN: optional,
  /** Resend inbound / webhooks: Svix signing secret (whsec_…). */
  RESEND_WEBHOOK_SECRET: optional,
  /**
   * Secret used to sign and verify sandbox webhooks (simulated inbound messages) for channels without provider
   * credentials. Defaults to a key derived from ENCRYPTION_KEY, so it is never empty.
   */
  COMMS_SANDBOX_SECRET: optional,
  /** First-reply SLA for new inbox conversations, in minutes. */
  INBOX_REPLY_SLA_MINUTES: z.coerce.number().int().min(5).default(240),

  // Payments
  STRIPE_SECRET_KEY: optional,
  STRIPE_WEBHOOK_SECRET: optional,
  /** Signing secret of the Connect webhook endpoint (events from connected accounts carry `account`). */
  STRIPE_CONNECT_WEBHOOK_SECRET: optional,
  /** Publishable key returned to browsers/apps (only when STRIPE_SECRET_KEY is set; never a secret). */
  STRIPE_PUBLISHABLE_KEY: optional,
  STRIPE_CONNECT_CLIENT_ID: optional,
  /** Application fee on online consumer payments (basis points). Default = DEFAULT_PAYMENT_APPLICATION_FEE_BPS in @bh/shared (shown on the pricing page). */
  STRIPE_APPLICATION_FEE_BPS: z.coerce.number().int().min(0).max(10000).default(DEFAULT_PAYMENT_APPLICATION_FEE_BPS),
  /**
   * BranchHarbor plan billing. STRIPE_TAX_ENABLED=true turns on Stripe Tax (automatic_tax) for the subscription, so
   * VAT/GST/sales tax is calculated and collected on top of the tax-exclusive list prices (register the tax
   * registrations in the Stripe Dashboard first).
   */
  STRIPE_TAX_ENABLED: bool(false),
  /**
   * When true, organisations without a paid trial or plan (subscription status checkout_required / canceled) can read
   * but not change data, apart from billing, onboarding and data export. Defaults to on in production.
   */
  BILLING_ENFORCE: optional,
  /** How often the billing sweep runs (trial reminders 3 and 1 days before the end, sandbox conversions), in minutes. */
  BILLING_SWEEP_MINUTES: z.coerce.number().int().min(1).default(60),
  BOOKING_HOLD_MINUTES: z.coerce.number().int().default(10),

  // Push notifications (Expo Push API). Without either value pushes are logged (sandbox), not sent.
  EXPO_ACCESS_TOKEN: optional,
  ENABLE_EXPO_PUSH: bool(false),
  EXPO_PUSH_URL: z.string().default('https://exp.host/--/api/v2/push/send'),

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
  LINKEDIN_CLIENT_ID: optional,
  LINKEDIN_CLIENT_SECRET: optional,
  /** Google Ads developer token (with GOOGLE_OAUTH_*). Without it, ad results are entered manually. */
  GOOGLE_ADS_DEVELOPER_TOKEN: optional,

  // Connectors
  MINDBODY_API_KEY: optional,
  MINDBODY_SITE_ID: optional,
  SQUARE_ACCESS_TOKEN: optional,
  SQUARE_ENVIRONMENT: z.enum(['sandbox', 'production']).default('sandbox'),
  SHOPIFY_API_KEY: optional,
  SHOPIFY_API_SECRET: optional,
  WOOCOMMERCE_CONSUMER_KEY: optional,
  WOOCOMMERCE_CONSUMER_SECRET: optional,

  // Partner integrations (per-location credentials live in connections; these are platform-level overrides)
  /** Override Uber Direct endpoints (defaults: https://auth.uber.com/oauth/v2/token, https://api.uber.com). */
  UBER_DIRECT_AUTH_URL: optional,
  UBER_DIRECT_API_URL: optional,
  /** Comma-separated ISO countries where Uber Direct may be offered (default: built-in list). */
  UBER_DIRECT_COUNTRIES: optional,
  /** Fallback webhook signing key when a location connection has none (single Uber Direct account setups). */
  UBER_DIRECT_WEBHOOK_SIGNING_KEY: optional,
  /** Override the Deliverect API base (defaults per connection: staging or production). */
  DELIVERECT_API_URL: optional,
  /** Fallback Deliverect webhook HMAC secret (production partner secret). */
  DELIVERECT_WEBHOOK_SECRET: optional,

  // POS and booking sales connectors (platform app credentials; each location authorises its own account).
  // Without them a connection runs in sandbox mode with sample sales. See docs/API_INTEGRATIONS.md "Sales connectors".
  SQUARE_APPLICATION_ID: optional,
  SQUARE_APPLICATION_SECRET: optional,
  TOAST_CLIENT_ID: optional,
  TOAST_CLIENT_SECRET: optional,
  TOAST_ENVIRONMENT: z.enum(['sandbox', 'production']).default('sandbox'),
  /** Mindbody source credentials (developer portal) used with MINDBODY_API_KEY for site activation and staff tokens. */
  MINDBODY_SOURCE_NAME: optional,
  MINDBODY_SOURCE_PASSWORD: optional,
  LIGHTSPEED_X_CLIENT_ID: optional,
  LIGHTSPEED_X_CLIENT_SECRET: optional,
  LIGHTSPEED_K_CLIENT_ID: optional,
  LIGHTSPEED_K_CLIENT_SECRET: optional,
  LIGHTSPEED_K_ENVIRONMENT: z.enum(['trial', 'production']).default('trial'),
  CLOVER_APP_ID: optional,
  CLOVER_APP_SECRET: optional,
  CLOVER_ENVIRONMENT: z.enum(['sandbox', 'production']).default('sandbox'),
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

/** Whether organisations need a paid trial or plan before changing data (BILLING_ENFORCE, default on in production). */
export function billingEnforced(cfg: Pick<Config, 'BILLING_ENFORCE' | 'NODE_ENV'>): boolean {
  const v = cfg.BILLING_ENFORCE?.toLowerCase();
  return v ? v === 'true' || v === '1' : cfg.NODE_ENV === 'production';
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
    stripeConnectWebhooks: cfg.STRIPE_CONNECT_WEBHOOK_SECRET ? 'verified' : 'disabled (connected-account events rejected)',
    stripeTax: cfg.STRIPE_TAX_ENABLED ? 'automatic tax on plan invoices' : 'off (tax-exclusive prices, no tax collected)',
    billingEnforcement: billingEnforced(cfg) ? 'on' : 'off',
    stripeCardEntry: cfg.STRIPE_SECRET_KEY && cfg.STRIPE_PUBLISHABLE_KEY ? 'live' : 'sandbox (simulated payments)',
    ai: mode(!!cfg.ANTHROPIC_API_KEY),
    push: mode(!!cfg.EXPO_ACCESS_TOKEN || cfg.ENABLE_EXPO_PUSH, 'sandbox'),
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
    uberDirect: 'per-location credentials (sandbox without them)',
    deliverect: 'per-location credentials (sandbox without them)',
    propertyPortals: 'per-office credentials (sandbox without them)',
    inboxEmail: cfg.POSTMARK_INBOUND_TOKEN || cfg.RESEND_WEBHOOK_SECRET ? 'live' : 'sandbox (simulated inbound)',
    inboxMeta: cfg.META_APP_ID && cfg.META_APP_SECRET ? 'live (per-page tokens)' : 'sandbox (simulated inbound)',
    socialPublishing: cfg.META_APP_ID && cfg.META_APP_SECRET ? 'meta live; linkedin/google business sandbox' : 'sandbox (posts simulated, never claimed as published)',
    adsPlatforms: 'manual results entry (Meta/Google Ads OAuth scaffolding only)',
  } as const;
}
