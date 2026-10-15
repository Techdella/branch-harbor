import type { IconName } from '@bh/icons';
import type { Permission } from '@bh/shared';
import type { IndustryKey } from './types';

export type OpsKind = 'screen' | 'table' | 'later';
export interface OpsDef {
  key: string;
  icon: IconName;
  kind: OpsKind;
}

/** Industry operations per vertical. `later` items are honest placeholders, not working features. */
export const OPS: Record<IndustryKey, OpsDef[]> = {
  studios: [
    { key: 'classes', icon: 'calendar', kind: 'screen' },
    { key: 'schedule', icon: 'repeat', kind: 'screen' },
    { key: 'members', icon: 'user', kind: 'screen' },
    { key: 'pricing', icon: 'wallet', kind: 'screen' },
    { key: 'rooms', icon: 'room', kind: 'screen' },
    { key: 'cover', icon: 'users', kind: 'screen' },
    { key: 'offers', icon: 'tag', kind: 'table' },
    { key: 'online', icon: 'play', kind: 'screen' },
    { key: 'insights', icon: 'chart', kind: 'screen' },
  ],
  sports: [
    { key: 'overview', icon: 'grid', kind: 'screen' },
    { key: 'programmes', icon: 'flag', kind: 'screen' },
    { key: 'registrations', icon: 'file', kind: 'screen' },
    { key: 'teams', icon: 'users', kind: 'screen' },
    { key: 'schedule', icon: 'calendar', kind: 'screen' },
    { key: 'attendance', icon: 'check-circle', kind: 'screen' },
    { key: 'balances', icon: 'card', kind: 'screen' },
    { key: 'announcements', icon: 'megaphone', kind: 'screen' },
    { key: 'guardians', icon: 'user', kind: 'screen' },
    { key: 'reports', icon: 'chart', kind: 'screen' },
  ],
  wellness: [
    { key: 'calendar', icon: 'calendar', kind: 'screen' },
    { key: 'services', icon: 'leaf', kind: 'screen' },
    { key: 'practitioners', icon: 'user', kind: 'screen' },
    { key: 'clients', icon: 'users', kind: 'screen' },
    { key: 'packages', icon: 'gift', kind: 'screen' },
    { key: 'forms', icon: 'file', kind: 'table' },
    { key: 'insights', icon: 'chart', kind: 'screen' },
  ],
  commerce: [
    { key: 'pulse', icon: 'activity', kind: 'screen' },
    { key: 'catalogue', icon: 'layers', kind: 'screen' },
    { key: 'assortment', icon: 'store', kind: 'screen' },
    { key: 'orders', icon: 'receipt', kind: 'screen' },
    { key: 'inventory', icon: 'box', kind: 'screen' },
    { key: 'transfers', icon: 'truck', kind: 'screen' },
    { key: 'purchasing', icon: 'file', kind: 'screen' },
    { key: 'returns', icon: 'undo', kind: 'screen' },
    { key: 'giftcards', icon: 'gift', kind: 'screen' },
    { key: 'storefront', icon: 'cart', kind: 'screen' },
    { key: 'insights', icon: 'chart', kind: 'screen' },
  ],
  foods: [
    { key: 'menu', icon: 'list', kind: 'screen' },
    { key: 'builder', icon: 'layers', kind: 'screen' },
    { key: 'availability', icon: 'sliders', kind: 'screen' },
    { key: 'orders', icon: 'receipt', kind: 'screen' },
    { key: 'kitchen', icon: 'chef', kind: 'screen' },
    { key: 'pickup', icon: 'clock', kind: 'table' },
    { key: 'delivery', icon: 'truck', kind: 'screen' },
    { key: 'tables', icon: 'grid', kind: 'screen' },
    { key: 'catering', icon: 'gift', kind: 'screen' },
    { key: 'mealplans', icon: 'repeat', kind: 'screen' },
    { key: 'ingredients', icon: 'box', kind: 'screen' },
    { key: 'ordering', icon: 'settings', kind: 'screen' },
    { key: 'foodreports', icon: 'chart', kind: 'screen' },
  ],
  realty: [
    { key: 'pulse', icon: 'grid', kind: 'screen' },
    { key: 'listings', icon: 'house', kind: 'screen' },
    { key: 'enquiries', icon: 'mail', kind: 'screen' },
    { key: 'viewings', icon: 'key', kind: 'screen' },
    { key: 'offers', icon: 'receipt', kind: 'screen' },
    { key: 'agents', icon: 'users', kind: 'screen' },
    { key: 'portals', icon: 'plug', kind: 'screen' },
  ],
  hospitality: [
    { key: 'pulse', icon: 'grid', kind: 'screen' },
    { key: 'grid', icon: 'calendar', kind: 'screen' },
    { key: 'reservations', icon: 'list', kind: 'screen' },
    { key: 'rates', icon: 'sliders', kind: 'screen' },
    { key: 'housekeeping', icon: 'check-circle', kind: 'screen' },
    { key: 'outlet', icon: 'utensils', kind: 'screen' },
    { key: 'hotelreports', icon: 'chart', kind: 'screen' },
    { key: 'setup', icon: 'settings', kind: 'screen' },
    { key: 'channels', icon: 'plug', kind: 'screen' },
  ],
};

export const INDUSTRY_UI: Record<IndustryKey, { icon: IconName; pastel: string }> = {
  studios: { icon: 'lotus', pastel: '#E9DDF8' },
  sports: { icon: 'trophy', pastel: '#E2F5A6' },
  wellness: { icon: 'leaf', pastel: '#D4E6D9' },
  commerce: { icon: 'bag', pastel: '#F7EDA8' },
  foods: { icon: 'utensils', pastel: '#F8D6D8' },
  realty: { icon: 'house', pastel: '#CDEEEE' },
  hospitality: { icon: 'bed', pastel: '#E4DDF7' },
};

export interface NavItem {
  key: string;
  href: string;
  icon: IconName;
  perm?: Permission;
  later?: boolean;
}

export const NAV_TOP: NavItem[] = [
  { key: 'overview', href: '/overview', icon: 'grid' },
  { key: 'locations', href: '/locations', icon: 'pin', perm: 'locations.read' },
];

export const NAV_SHARED: NavItem[] = [
  { key: 'approvals', href: '/approvals', icon: 'shield', perm: 'locations.read' },
  { key: 'customers', href: '/customers', icon: 'users', perm: 'customers.read' },
  { key: 'websites', href: '/websites', icon: 'globe', perm: 'website.edit' },
  { key: 'marketing', href: '/marketing', icon: 'megaphone', perm: 'marketing.draft' },
  { key: 'payments', href: '/payments', icon: 'card', perm: 'payments.read' },
  { key: 'team', href: '/team', icon: 'user', perm: 'operations.read' },
  { key: 'community', href: '/community', icon: 'message', later: true },
  { key: 'reports', href: '/reports', icon: 'chart', perm: 'reports.read' },
  { key: 'connections', href: '/connections', icon: 'plug', perm: 'locations.read' },
  { key: 'settings', href: '/settings', icon: 'settings', perm: 'org.manage' },
];
