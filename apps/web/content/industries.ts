import type { IconName } from '@bh/icons';
import { IMG, PASTEL, type PastelKey } from './images';

export const INDUSTRY_KEYS = ['studios', 'sports', 'wellness', 'commerce', 'foods', 'realty'] as const;
export type IndustryKey = (typeof INDUSTRY_KEYS)[number];

export function isIndustryKey(v: string): v is IndustryKey {
  return (INDUSTRY_KEYS as readonly string[]).includes(v);
}

/** Release labels shown on the site. Planned verticals are never presented as working features. */
export type Availability = 'pilot' | 'next' | 'planned';

export interface SampleLocation {
  name: string;
  country: string; // ISO 3166-1 alpha-2
  currency: string;
  timeZone: string;
  status: 'operating' | 'openingSoon' | 'onboarding';
}

export interface WorkflowStepDef {
  icon: IconName;
  /** One entry per sample row: icon and tag tone. Row copy lives in messages. */
  rows: { icon: IconName; tone: PastelKey }[];
}

export interface IndustryDef {
  key: IndustryKey;
  icon: IconName;
  pastel: string;
  accent: string;
  availability: Availability;
  image: string;
  image2: string;
  problemIcons: IconName[];
  workflow: WorkflowStepDef[];
  /** Integration ids from content/integrations.ts. */
  connected: string[];
  sampleLocations: SampleLocation[];
}

const r = (icon: IconName, tone: PastelKey = 'canvas') => ({ icon, tone });

export const INDUSTRIES: Record<IndustryKey, IndustryDef> = {
  studios: {
    key: 'studios',
    icon: 'lotus',
    pastel: PASTEL.lilac,
    accent: '#7460A8',
    availability: 'pilot',
    image: IMG.yogaGroup,
    image2: IMG.yogaMeditate,
    problemIcons: ['globe', 'mail', 'users'],
    workflow: [
      { icon: 'mail', rows: [r('user', 'butter'), r('user'), r('user', 'aqua')] },
      { icon: 'gift', rows: [r('tag', 'signal'), r('tag', 'lilac'), r('tag', 'butter')] },
      { icon: 'calendar', rows: [r('clock', 'blush'), r('clock', 'butter'), r('clock', 'signal')] },
      { icon: 'card', rows: [r('user', 'signal'), r('user', 'butter'), r('user', 'lilac')] },
    ],
    connected: ['mindbody', 'momence', 'googlecalendar', 'stripe'],
    sampleLocations: [
      { name: 'Toronto – Queen West', country: 'CA', currency: 'CAD', timeZone: 'America/Toronto', status: 'operating' },
      { name: 'London – Shoreditch', country: 'GB', currency: 'GBP', timeZone: 'Europe/London', status: 'operating' },
      { name: 'Berlin – Prenzlauer Berg', country: 'DE', currency: 'EUR', timeZone: 'Europe/Berlin', status: 'operating' },
      { name: 'Austin – East Side', country: 'US', currency: 'USD', timeZone: 'America/Chicago', status: 'openingSoon' },
    ],
  },
  sports: {
    key: 'sports',
    icon: 'trophy',
    pastel: PASTEL.lime,
    accent: '#2867AA',
    availability: 'planned',
    image: IMG.sportKids,
    image2: IMG.sportCones,
    problemIcons: ['file', 'calendar', 'user'],
    workflow: [
      { icon: 'file', rows: [r('user', 'butter'), r('user', 'signal'), r('user', 'aqua')] },
      { icon: 'users', rows: [r('users', 'signal'), r('users', 'butter'), r('users', 'signal')] },
      { icon: 'calendar', rows: [r('clock'), r('alert', 'blush'), r('clock')] },
      { icon: 'check-circle', rows: [r('user', 'signal'), r('user', 'blush'), r('user')] },
    ],
    connected: ['stripe', 'googlecalendar', 'teamsnap', 'twilio'],
    sampleLocations: [
      { name: 'Manchester – Platt Fields', country: 'GB', currency: 'GBP', timeZone: 'Europe/London', status: 'operating' },
      { name: 'Melbourne – Albert Park', country: 'AU', currency: 'AUD', timeZone: 'Australia/Melbourne', status: 'operating' },
      { name: 'Vancouver – Burnaby Fields', country: 'CA', currency: 'CAD', timeZone: 'America/Vancouver', status: 'operating' },
      { name: 'Mexico City – Coyoacán', country: 'MX', currency: 'MXN', timeZone: 'America/Mexico_City', status: 'onboarding' },
    ],
  },
  wellness: {
    key: 'wellness',
    icon: 'leaf',
    pastel: PASTEL.sage,
    accent: '#56836C',
    availability: 'planned',
    image: IMG.spaProne,
    image2: IMG.spaDiffuser,
    problemIcons: ['room', 'refresh', 'lock'],
    workflow: [
      { icon: 'leaf', rows: [r('leaf', 'signal'), r('leaf', 'signal'), r('leaf')] },
      { icon: 'user', rows: [r('user', 'signal'), r('user'), r('user', 'butter')] },
      { icon: 'calendar', rows: [r('clock', 'signal'), r('clock', 'aqua'), r('clock', 'blush')] },
      { icon: 'refresh', rows: [r('gift', 'signal'), r('gift', 'butter')] },
    ],
    connected: ['stripe', 'googlecalendar', 'janeapp', 'twilio'],
    sampleLocations: [
      { name: 'Sydney – Surry Hills', country: 'AU', currency: 'AUD', timeZone: 'Australia/Sydney', status: 'operating' },
      { name: 'Auckland – Ponsonby', country: 'NZ', currency: 'NZD', timeZone: 'Pacific/Auckland', status: 'operating' },
      { name: 'Dubai – Jumeirah', country: 'AE', currency: 'AED', timeZone: 'Asia/Dubai', status: 'operating' },
      { name: 'Madrid – Salamanca', country: 'ES', currency: 'EUR', timeZone: 'Europe/Madrid', status: 'openingSoon' },
    ],
  },
  commerce: {
    key: 'commerce',
    icon: 'bag',
    pastel: PASTEL.butter,
    accent: '#A66C26',
    availability: 'planned',
    image: IMG.shopInterior,
    image2: IMG.shopPay,
    problemIcons: ['box', 'tag', 'receipt'],
    workflow: [
      { icon: 'layers', rows: [r('box', 'signal'), r('box', 'butter'), r('box')] },
      { icon: 'store', rows: [r('box', 'signal'), r('box', 'butter'), r('box', 'lilac')] },
      { icon: 'cart', rows: [r('receipt', 'aqua'), r('receipt', 'signal'), r('receipt', 'blush')] },
      { icon: 'undo', rows: [r('undo', 'aqua'), r('undo', 'signal')] },
    ],
    connected: ['woocommerce', 'shopify', 'square', 'lightspeed'],
    sampleLocations: [
      { name: 'Amsterdam – De Pijp', country: 'NL', currency: 'EUR', timeZone: 'Europe/Amsterdam', status: 'operating' },
      { name: 'Paris – Le Marais', country: 'FR', currency: 'EUR', timeZone: 'Europe/Paris', status: 'operating' },
      { name: 'Chicago – Wicker Park', country: 'US', currency: 'USD', timeZone: 'America/Chicago', status: 'operating' },
      { name: 'Singapore – Orchard', country: 'SG', currency: 'SGD', timeZone: 'Asia/Singapore', status: 'openingSoon' },
    ],
  },
  foods: {
    key: 'foods',
    icon: 'utensils',
    pastel: PASTEL.blush,
    accent: '#B9543D',
    availability: 'next',
    image: IMG.foodChef,
    image2: IMG.foodPizza,
    problemIcons: ['list', 'clock', 'wifi-off'],
    workflow: [
      { icon: 'list', rows: [r('utensils', 'signal'), r('utensils', 'butter'), r('utensils', 'signal')] },
      { icon: 'clock', rows: [r('clock', 'signal'), r('clock', 'butter'), r('clock')] },
      { icon: 'receipt', rows: [r('receipt', 'butter'), r('receipt'), r('receipt', 'signal')] },
      { icon: 'chef', rows: [r('alert', 'blush'), r('chef', 'butter')] },
    ],
    connected: ['stripe', 'square', 'toast', 'googlebusiness'],
    sampleLocations: [
      { name: 'Singapore – Tanjong Pagar', country: 'SG', currency: 'SGD', timeZone: 'Asia/Singapore', status: 'operating' },
      { name: 'São Paulo – Pinheiros', country: 'BR', currency: 'BRL', timeZone: 'America/Sao_Paulo', status: 'operating' },
      { name: 'Dublin – Portobello', country: 'IE', currency: 'EUR', timeZone: 'Europe/Dublin', status: 'operating' },
      { name: 'Seattle – Ballard', country: 'US', currency: 'USD', timeZone: 'America/Los_Angeles', status: 'openingSoon' },
    ],
  },
  realty: {
    key: 'realty',
    icon: 'house',
    pastel: PASTEL.aqua,
    accent: '#2C7A7B',
    availability: 'next',
    image: IMG.realtyHouse,
    image2: IMG.realtyLiving,
    problemIcons: ['shield', 'mail', 'chart'],
    workflow: [
      { icon: 'house', rows: [r('house', 'signal'), r('shield', 'butter'), r('house', 'aqua')] },
      { icon: 'mail', rows: [r('user', 'signal'), r('users', 'butter'), r('user')] },
      { icon: 'key', rows: [r('clock', 'signal'), r('clock', 'butter'), r('check', 'aqua')] },
      { icon: 'receipt', rows: [r('receipt', 'butter'), r('receipt', 'signal')] },
    ],
    connected: ['stripe', 'googlecalendar', 'mailchimp', 'wpml'],
    sampleLocations: [
      { name: 'Toronto – Midtown', country: 'CA', currency: 'CAD', timeZone: 'America/Toronto', status: 'operating' },
      { name: 'London – Hampstead', country: 'GB', currency: 'GBP', timeZone: 'Europe/London', status: 'operating' },
      { name: 'Madrid – Salamanca', country: 'ES', currency: 'EUR', timeZone: 'Europe/Madrid', status: 'operating' },
      { name: 'Dubai – Marina', country: 'AE', currency: 'AED', timeZone: 'Asia/Dubai', status: 'openingSoon' },
    ],
  },
};

/** Home-page product visual: a sample studio network across several countries. */
export interface PreviewLocation {
  id: string;
  name: string;
  country: string;
  timeZone: string;
  enquiries: number;
  classesToday: number;
  /** null = unavailable (degraded sync); 'not_connected' = no booking system. */
  occupancy: number | null | 'not_connected';
  sync: { state: 'connected'; minutes: number } | { state: 'degraded'; hours: number } | { state: 'not_connected' };
  pastel: string;
}

export const PREVIEW_LOCATIONS: PreviewLocation[] = [
  { id: 'tor', name: 'Toronto – Queen West', country: 'CA', timeZone: 'America/Toronto', enquiries: 14, classesToday: 9, occupancy: 78, sync: { state: 'connected', minutes: 4 }, pastel: PASTEL.lilac },
  { id: 'lon', name: 'London – Shoreditch', country: 'GB', timeZone: 'Europe/London', enquiries: 11, classesToday: 8, occupancy: 72, sync: { state: 'connected', minutes: 6 }, pastel: PASTEL.butter },
  { id: 'ber', name: 'Berlin – Prenzlauer Berg', country: 'DE', timeZone: 'Europe/Berlin', enquiries: 9, classesToday: 7, occupancy: null, sync: { state: 'degraded', hours: 2 }, pastel: PASTEL.aqua },
  { id: 'syd', name: 'Sydney – Surry Hills', country: 'AU', timeZone: 'Australia/Sydney', enquiries: 8, classesToday: 6, occupancy: 64, sync: { state: 'connected', minutes: 3 }, pastel: PASTEL.blush },
  { id: 'aus', name: 'Austin – East Side', country: 'US', timeZone: 'America/Chicago', enquiries: 6, classesToday: 5, occupancy: 59, sync: { state: 'connected', minutes: 9 }, pastel: PASTEL.sage },
  { id: 'sao', name: 'São Paulo – Pinheiros', country: 'BR', timeZone: 'America/Sao_Paulo', enquiries: 3, classesToday: 4, occupancy: 'not_connected', sync: { state: 'not_connected' }, pastel: PASTEL.lime },
];
