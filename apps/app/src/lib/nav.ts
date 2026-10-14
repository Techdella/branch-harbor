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
    { key: 'cover', icon: 'users', kind: 'screen' },
    { key: 'offers', icon: 'tag', kind: 'table' },
    { key: 'online', icon: 'play', kind: 'later' },
  ],
  sports: [
    { key: 'programmes', icon: 'flag', kind: 'table' },
    { key: 'registrations', icon: 'file', kind: 'screen' },
    { key: 'teams', icon: 'users', kind: 'table' },
    { key: 'schedule', icon: 'calendar', kind: 'table' },
    { key: 'attendance', icon: 'check-circle', kind: 'screen' },
    { key: 'guardian', icon: 'user', kind: 'later' },
  ],
  wellness: [
    { key: 'calendar', icon: 'calendar', kind: 'screen' },
    { key: 'services', icon: 'leaf', kind: 'table' },
    { key: 'practitioners', icon: 'user', kind: 'table' },
    { key: 'packages', icon: 'gift', kind: 'later' },
    { key: 'forms', icon: 'file', kind: 'table' },
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
    { key: 'orders', icon: 'receipt', kind: 'screen' },
    { key: 'kitchen', icon: 'chef', kind: 'screen' },
    { key: 'pickup', icon: 'clock', kind: 'table' },
    { key: 'catering', icon: 'gift', kind: 'later' },
  ],
};

export const INDUSTRY_UI: Record<IndustryKey, { icon: IconName; pastel: string }> = {
  studios: { icon: 'lotus', pastel: '#E9DDF8' },
  sports: { icon: 'trophy', pastel: '#E2F5A6' },
  wellness: { icon: 'leaf', pastel: '#D4E6D9' },
  commerce: { icon: 'bag', pastel: '#F7EDA8' },
  foods: { icon: 'utensils', pastel: '#F8D6D8' },
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
