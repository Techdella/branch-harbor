import { z } from 'zod';
import { INDUSTRIES } from './industries.ts';
import { SUPPORTED_CURRENCIES } from './money.ts';
import { SUPPORTED_LOCALES, DATA_REGIONS } from './locale.ts';
import { ROLES } from './permissions.ts';

/** API contracts shared by the web app, mobile app and backend. */

export const id = z.string().min(1);
export const currency = z.enum(SUPPORTED_CURRENCIES);
export const locale = z.enum(SUPPORTED_LOCALES);
export const industry = z.enum(INDUSTRIES);
export const countryCode = z.string().length(2).toUpperCase();
export const timeZone = z.string().min(3);
export const moneySchema = z.object({ amount: z.number().int(), currency });

export const addressSchema = z.object({
  line1: z.string().min(1),
  line2: z.string().optional(),
  city: z.string().min(1),
  region: z.string().optional(), // state / province / county
  postalCode: z.string().optional(), // not every country uses one
  country: countryCode,
});

export const demoRequestSchema = z.object({
  name: z.string().min(1).max(120),
  email: z.string().email(),
  business: z.string().min(1).max(160),
  industry,
  locationCount: z.number().int().min(1).max(10000),
  country: countryCode,
  existingWebsite: z.string().url().optional().or(z.literal('')),
  primaryDifficulty: z.string().max(2000).optional(),
  phone: z.string().max(40).optional(),
  existingSystems: z.string().max(500).optional(),
  locale: locale.default('en'),
  marketingConsent: z.boolean().default(false),
});
export type DemoRequest = z.infer<typeof demoRequestSchema>;

export const signUpSchema = z.object({
  name: z.string().min(1),
  email: z.string().email(),
  password: z.string().min(10),
  locale: locale.default('en'),
});

export const createOrganizationSchema = z.object({
  name: z.string().min(1),
  industry,
  model: z.enum(['independent', 'network']),
  country: countryCode,
  defaultCurrency: currency,
  defaultTimeZone: timeZone,
  defaultLocale: locale,
  dataRegion: z.enum(DATA_REGIONS),
});

export const createLocationSchema = z.object({
  name: z.string().min(1),
  code: z.string().min(1).max(24),
  regionId: id.optional(),
  ownerGroupId: id.optional(),
  address: addressSchema,
  timeZone,
  currency,
  locale: locale.optional(),
  phone: z.string().optional(),
  email: z.string().email().optional(),
  templateId: id.optional(),
});

export const inviteMemberSchema = z.object({
  email: z.string().email(),
  role: z.enum(ROLES),
  scope: z.object({ kind: z.enum(['organization', 'region', 'owner_group', 'location']), id }),
});

export const paymentStates = ['created', 'requires_action', 'processing', 'succeeded', 'failed', 'cancelled'] as const;
export const refundStates = ['requested', 'pending', 'partial', 'complete', 'failed'] as const;
export const connectionStates = ['connected', 'initial_sync', 'degraded', 'disconnected', 'authorization_expired'] as const;
export const domainStates = ['awaiting_dns', 'verifying', 'certificate_pending', 'ready', 'failed'] as const;
export const foodOrderStates = ['awaiting_acceptance', 'accepted', 'preparing', 'ready', 'collected', 'cancelled', 'rejected'] as const;

export const paginated = <T extends z.ZodTypeAny>(item: T) =>
  z.object({ items: z.array(item), nextCursor: z.string().nullable() });

export const apiError = z.object({
  error: z.object({ code: z.string(), message: z.string(), fields: z.record(z.string(), z.string()).optional() }),
});
export type ApiError = z.infer<typeof apiError>;
