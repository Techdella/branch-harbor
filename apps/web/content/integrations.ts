export const INTEGRATION_STATUSES = ['tested', 'limited', 'setup', 'planned'] as const;
export type IntegrationStatus = (typeof INTEGRATION_STATUSES)[number];

export const INTEGRATION_CATEGORIES = ['commerce', 'payments', 'pos', 'booking', 'marketing', 'messaging', 'accounting', 'wordpress', 'analytics', 'automation'] as const;
export type IntegrationCategory = (typeof INTEGRATION_CATEGORIES)[number];

export type Direction = 'import' | 'export' | 'bidirectional' | 'none';

export interface Integration {
  id: string;
  name: string;
  mono: string;
  category: IntegrationCategory;
  status: IntegrationStatus;
  direction: Direction;
}

/**
 * Compatibility catalogue. Status is honest: "planned" means not available. Copy for each
 * entry lives in messages under integrations.items.<id>.
 */
export const INTEGRATIONS: Integration[] = [
  { id: 'woocommerce', name: 'WooCommerce', mono: 'Wo', category: 'commerce', status: 'tested', direction: 'bidirectional' },
  { id: 'gutenberg', name: 'Gutenberg (WordPress)', mono: 'Gb', category: 'wordpress', status: 'tested', direction: 'export' },
  { id: 'yoast', name: 'Yoast SEO', mono: 'Yo', category: 'wordpress', status: 'tested', direction: 'none' },
  { id: 'wprocket', name: 'WP Rocket', mono: 'Wr', category: 'wordpress', status: 'tested', direction: 'none' },
  { id: 'stripe', name: 'Stripe', mono: 'St', category: 'payments', status: 'setup', direction: 'import' },
  { id: 'mailchimp', name: 'Mailchimp', mono: 'Mc', category: 'marketing', status: 'setup', direction: 'export' },
  { id: 'twilio', name: 'Twilio (SMS)', mono: 'Tw', category: 'messaging', status: 'setup', direction: 'export' },
  { id: 'gravityforms', name: 'Gravity Forms', mono: 'Gf', category: 'wordpress', status: 'setup', direction: 'import' },
  { id: 'multisite', name: 'WordPress Multisite', mono: 'Ms', category: 'wordpress', status: 'setup', direction: 'bidirectional' },
  { id: 'ga4', name: 'Google Analytics 4', mono: 'Ga', category: 'analytics', status: 'setup', direction: 'export' },
  { id: 'googlecalendar', name: 'Google Calendar', mono: 'Gc', category: 'booking', status: 'limited', direction: 'export' },
  { id: 'elementor', name: 'Elementor', mono: 'El', category: 'wordpress', status: 'limited', direction: 'export' },
  { id: 'wpml', name: 'WPML', mono: 'Wm', category: 'wordpress', status: 'limited', direction: 'bidirectional' },
  { id: 'mindbody', name: 'Mindbody', mono: 'Mb', category: 'booking', status: 'planned', direction: 'import' },
  { id: 'momence', name: 'Momence', mono: 'Mo', category: 'booking', status: 'planned', direction: 'import' },
  { id: 'janeapp', name: 'Jane App', mono: 'Ja', category: 'booking', status: 'planned', direction: 'import' },
  { id: 'teamsnap', name: 'TeamSnap', mono: 'Ts', category: 'booking', status: 'planned', direction: 'import' },
  { id: 'adyen', name: 'Adyen', mono: 'Ad', category: 'payments', status: 'planned', direction: 'import' },
  { id: 'paypal', name: 'PayPal', mono: 'Pp', category: 'payments', status: 'planned', direction: 'import' },
  { id: 'square', name: 'Square', mono: 'Sq', category: 'pos', status: 'planned', direction: 'import' },
  { id: 'toast', name: 'Toast', mono: 'To', category: 'pos', status: 'planned', direction: 'import' },
  { id: 'lightspeed', name: 'Lightspeed', mono: 'Ls', category: 'pos', status: 'planned', direction: 'import' },
  { id: 'shopify', name: 'Shopify', mono: 'Sh', category: 'commerce', status: 'planned', direction: 'bidirectional' },
  { id: 'googlebusiness', name: 'Google Business Profile', mono: 'Gp', category: 'marketing', status: 'planned', direction: 'export' },
  { id: 'meta', name: 'Meta (Facebook & Instagram)', mono: 'Me', category: 'marketing', status: 'planned', direction: 'import' },
  { id: 'whatsapp', name: 'WhatsApp Business', mono: 'Wa', category: 'messaging', status: 'planned', direction: 'export' },
  { id: 'xero', name: 'Xero', mono: 'Xe', category: 'accounting', status: 'planned', direction: 'export' },
  { id: 'quickbooks', name: 'QuickBooks Online', mono: 'Qb', category: 'accounting', status: 'planned', direction: 'export' },
  { id: 'zapier', name: 'Zapier', mono: 'Za', category: 'automation', status: 'planned', direction: 'bidirectional' },
];

export const STATUS_STYLE: Record<IntegrationStatus, { bg: string; fg: string; icon: 'check-circle' | 'alert' | 'settings' | 'clock' }> = {
  tested: { bg: '#D6F26B', fg: '#141414', icon: 'check-circle' },
  limited: { bg: '#F7EDA8', fg: '#141414', icon: 'alert' },
  setup: { bg: '#CDEEEE', fg: '#141414', icon: 'settings' },
  planned: { bg: '#F3F2EE', fg: '#3E3E3A', icon: 'clock' },
};

export const CATEGORY_PASTEL: Record<IntegrationCategory, string> = {
  commerce: '#F7EDA8',
  payments: '#CDEEEE',
  pos: '#EFE3D3',
  booking: '#E9DDF8',
  marketing: '#F8D6D8',
  messaging: '#D4E6D9',
  accounting: '#E2F5A6',
  wordpress: '#E9DDF8',
  analytics: '#CDEEEE',
  automation: '#F7EDA8',
};

export function getIntegration(id: string): Integration | undefined {
  return INTEGRATIONS.find((i) => i.id === id);
}
