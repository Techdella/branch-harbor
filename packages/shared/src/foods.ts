/**
 * Foods vertical vocabulary shared by the API, the business app, customer websites and mobile.
 *
 * Allergen and dietary labels are ALWAYS supplied by the business. These lists only define the
 * vocabulary a business can pick from (per jurisdiction convention); nothing here infers a label.
 */
import { z } from 'zod';
import { foodOrderStates } from './schemas.ts';
import { publicContactSchema } from './api-contracts.ts';

/** Every allergen key a business can declare. Regimes below pick the ones a jurisdiction lists. */
export const FOOD_ALLERGENS = [
  'cereals_gluten', 'wheat', 'crustaceans', 'molluscs', 'eggs', 'fish', 'peanuts', 'soybeans', 'milk',
  'tree_nuts', 'celery', 'mustard', 'sesame', 'sulphites', 'lupin',
] as const;
export type FoodAllergen = (typeof FOOD_ALLERGENS)[number];

/**
 * Allergen conventions a business can present to customers:
 *  - eu14: the 14 allergens of EU FIC Regulation 1169/2011 Annex II (also used in the UK).
 *  - us9:  the US "major food allergens" (FALCPA as amended by the FASTER Act).
 *  - ca:   Health Canada's priority food allergens (plus gluten sources and sulphites).
 */
export const ALLERGEN_REGIMES = {
  eu14: ['cereals_gluten', 'crustaceans', 'eggs', 'fish', 'peanuts', 'soybeans', 'milk', 'tree_nuts', 'celery', 'mustard', 'sesame', 'sulphites', 'lupin', 'molluscs'],
  us9: ['milk', 'eggs', 'fish', 'crustaceans', 'tree_nuts', 'peanuts', 'wheat', 'soybeans', 'sesame'],
  ca: ['eggs', 'milk', 'mustard', 'peanuts', 'crustaceans', 'molluscs', 'fish', 'sesame', 'soybeans', 'sulphites', 'tree_nuts', 'wheat', 'cereals_gluten'],
} as const satisfies Record<string, readonly FoodAllergen[]>;
export type AllergenRegime = keyof typeof ALLERGEN_REGIMES;
export const ALLERGEN_REGIME_KEYS = Object.keys(ALLERGEN_REGIMES) as AllergenRegime[];

/** English labels; apps translate by key and fall back to these. */
export const ALLERGEN_LABELS: Record<FoodAllergen, string> = {
  cereals_gluten: 'Cereals containing gluten', wheat: 'Wheat', crustaceans: 'Crustaceans', molluscs: 'Molluscs', eggs: 'Eggs', fish: 'Fish',
  peanuts: 'Peanuts', soybeans: 'Soy', milk: 'Milk', tree_nuts: 'Tree nuts', celery: 'Celery', mustard: 'Mustard', sesame: 'Sesame',
  sulphites: 'Sulphites', lupin: 'Lupin',
};

const EU_LIKE = new Set(['AT', 'BE', 'BG', 'HR', 'CY', 'CZ', 'DK', 'EE', 'FI', 'FR', 'DE', 'GR', 'HU', 'IE', 'IT', 'LV', 'LT', 'LU', 'MT', 'NL', 'PL', 'PT', 'RO', 'SK', 'SI', 'ES', 'SE', 'GB', 'NO', 'IS', 'LI', 'CH']);

/** Default convention for a location's country. The business can override it per location. */
export function defaultAllergenRegime(country: string): AllergenRegime {
  const c = country.toUpperCase();
  if (c === 'US') return 'us9';
  if (c === 'CA') return 'ca';
  if (EU_LIKE.has(c)) return 'eu14';
  return 'eu14';
}

/** Older free-text keys used before the controlled vocabulary existed. */
const ALLERGEN_ALIASES: Record<string, FoodAllergen> = {
  gluten: 'cereals_gluten', egg: 'eggs', soy: 'soybeans', soya: 'soybeans', nuts: 'tree_nuts', 'tree nuts': 'tree_nuts', shellfish: 'crustaceans',
  dairy: 'milk', sulfites: 'sulphites', sulphur_dioxide: 'sulphites',
};
export function normalizeAllergen(key: string): FoodAllergen | null {
  const k = key.trim().toLowerCase().replace(/[\s-]+/g, '_');
  if ((FOOD_ALLERGENS as readonly string[]).includes(k)) return k as FoodAllergen;
  return ALLERGEN_ALIASES[key.trim().toLowerCase()] ?? ALLERGEN_ALIASES[k] ?? null;
}

/** Dietary labels a business may declare. */
export const DIETARY_LABELS = ['vegan', 'vegetarian', 'pescatarian', 'gluten-free', 'dairy-free', 'halal', 'kosher', 'spicy', 'contains-alcohol'] as const;
export type DietaryLabel = (typeof DIETARY_LABELS)[number];

export const FOOD_CHANNELS = ['pickup', 'delivery', 'dine_in', 'preorder', 'catering', 'meal_plan'] as const;
export type FoodChannel = (typeof FOOD_CHANNELS)[number];

/** All food order states, including delivery and dine-in endings. */
export const foodOrderStatesAll = [...foodOrderStates, 'out_for_delivery', 'delivered', 'served'] as const;
export type FoodOrderStateAll = (typeof foodOrderStatesAll)[number];

export const cateringStatuses = ['new', 'quoted', 'accepted', 'deposit_paid', 'confirmed', 'completed', 'declined', 'cancelled', 'expired'] as const;
export const mealPlanSubscriptionStatuses = ['pending_payment', 'active', 'paused', 'past_due', 'cancelled'] as const;
export const kdsTicketStatuses = ['queued', 'in_progress', 'done'] as const;
export const foodDeliveryStatuses = ['pending', 'assigned', 'picked_up', 'delivered', 'failed', 'cancelled'] as const;
export const foodDeliveryProviders = ['own', 'uber_direct', 'deliverect'] as const;

const line = z.object({
  menuItemId: z.string().min(1),
  quantity: z.number().int().min(1).max(50),
  modifierIds: z.array(z.string()).default([]),
  notes: z.string().max(300).optional(),
});

export const deliveryAddressSchema = z.object({
  line1: z.string().min(1).max(200),
  line2: z.string().max(200).optional(),
  city: z.string().min(1).max(120),
  postalCode: z.string().min(1).max(20),
  country: z.string().length(2).optional(),
  instructions: z.string().max(300).optional(),
  lat: z.number().min(-90).max(90).optional(),
  lng: z.number().min(-180).max(180).optional(),
});

/** One checkout body for pickup, delivery, dine-in and preorder orders. Every value is re-checked server-side. */
export const foodCheckoutSchema = z.object({
  channel: z.enum(['pickup', 'delivery', 'dine_in', 'preorder']),
  lines: z.array(line).min(1).max(50),
  contact: publicContactSchema.extend({ email: z.string().email() }),
  notes: z.string().max(500).optional(),
  pickupSlotId: z.string().optional(),
  deliverySlotId: z.string().optional(),
  address: deliveryAddressSchema.optional(),
  tableCode: z.string().max(40).optional(),
  /** Dine-in: pay now, or add to the table's tab (requires the tab token when a tab is already open). */
  payMode: z.enum(['pay_now', 'tab']).optional(),
  tabToken: z.string().max(200).optional(),
  productionDateId: z.string().optional(),
  collectionWindow: z.string().regex(/^\d{2}:\d{2}$/).optional(),
  tipMinor: z.number().int().min(0).optional(),
  expectedTotalMinor: z.number().int().optional(),
  lang: z.string().max(10).optional(),
});
export type FoodCheckoutInput = z.infer<typeof foodCheckoutSchema>;

export const cateringEnquirySchema = z.object({
  contact: publicContactSchema,
  eventDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  eventTime: z.string().regex(/^\d{2}:\d{2}$/).optional(),
  guests: z.number().int().min(1).max(5000),
  packageId: z.string().optional(),
  fulfilment: z.enum(['pickup', 'delivery', 'onsite']).default('pickup'),
  address: deliveryAddressSchema.optional(),
  notes: z.string().max(2000).optional(),
  dietaryNotes: z.string().max(1000).optional(),
});
