import { z } from 'zod';
import { INDUSTRIES } from './industries.ts';
import { SUPPORTED_CURRENCIES } from './money.ts';
import { SUPPORTED_LOCALES, DATA_REGIONS } from './locale.ts';
import { ROLES, SCOPE_KINDS, SENSITIVE_CLASSES } from './permissions.ts';
import { WORKSPACES } from './access.ts';

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
  /** Cloudflare Turnstile token; required by the API only when bot checks are enabled. */
  turnstileToken: z.string().max(2048).optional(),
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

export const scopeSchema = z.object({ kind: z.enum(SCOPE_KINDS), id });

/** Invite with a system role, or with `role: 'custom'` + `customRoleId` (a role the organisation created). */
export const inviteMemberSchema = z.object({
  email: z.string().email(),
  role: z.enum([...ROLES, 'custom']),
  customRoleId: z.string().uuid().optional(),
  scope: scopeSchema,
}).refine((v) => (v.role === 'custom') === !!v.customRoleId, { message: 'Pick a custom role (role "custom" needs customRoleId)', path: ['customRoleId'] });

/** A custom role: a name and the module actions it grants (`<module>:<action>`). */
export const customRoleSchema = z.object({
  name: z.string().trim().min(1).max(80),
  description: z.string().trim().max(300).optional(),
  baseRole: z.enum(ROLES).optional(),
  primaryWorkspace: z.enum(WORKSPACES).optional(),
  capabilities: z.array(z.string().max(80)).max(400),
});

/** What one person's role assignment gives them: a role (system or custom) plus per-person overrides. */
export const assignmentAccessSchema = z.object({
  role: z.enum([...ROLES, 'custom']).optional(),
  customRoleId: z.string().uuid().nullable().optional(),
  grants: z.array(z.string().max(80)).max(400).default([]),
  revokes: z.array(z.string().max(80)).max(400).default([]),
});

/** A person in one business: a free-text job title (separate from their roles) and sensitive classes denied to them. */
export const memberProfileSchema = z.object({
  jobTitle: z.string().trim().max(80).nullable().optional(),
  deniedClasses: z.array(z.enum(SENSITIVE_CLASSES)).max(3).optional(),
});

/** The business's own name for a system role (null restores the template name). */
export const roleLabelSchema = z.object({ name: z.string().trim().min(1).max(80).nullable() });

/** A portfolio: any named set of locations (for field consultants and area representatives). */
export const portfolioSchema = z.object({
  name: z.string().trim().min(1).max(120),
  description: z.string().trim().max(500).nullable().optional(),
  locationIds: z.array(id).max(500).default([]),
});

/** A territory: a sub-network (a country for a master franchisee, a development area for an area developer). */
export const territoryScopeSchema = z.object({
  name: z.string().trim().min(1).max(120),
  kind: z.enum(['master', 'development', 'support']).default('master'),
  country: z.string().length(2).transform((s) => s.toUpperCase()).nullable().optional(),
  brandId: id.nullable().optional(),
  locationIds: z.array(id).max(500).optional(),
});

/** A brand (single-brand today; modelled for multi-brand networks). */
export const brandSchema = z.object({ name: z.string().trim().min(1).max(120) });

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
