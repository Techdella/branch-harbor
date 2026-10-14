'use client';

import { useTranslations } from 'next-intl';
import { useApp } from '../shell/AppContext';
import { DeniedState } from '../ui/States';
import { LaterScreen } from './LaterScreen';
import { TableScreen } from './TableScreen';

export function CustomersScreen() {
  const t = useTranslations();
  const app = useApp();
  if (!app.can('customers.read')) return <DeniedState permission="customers.read" detail={t('customers.denied')} />;
  return <TableScreen tableKey="customers" icon="users" permission="customers.read" title={t(`industries.${app.industry}.customers`)} description={t('customers.description')} />;
}

export function MarketingScreen() {
  const t = useTranslations();
  const app = useApp();
  if (!app.can('marketing.draft')) return <DeniedState permission="marketing.draft" />;
  return <TableScreen tableKey="marketing" icon="megaphone" permission="marketing.draft" title={t('nav.marketing')} description={t('marketing.description')} />;
}

export function CommunityScreen() {
  const t = useTranslations('later.community');
  return <LaterScreen icon="message" title={t('title')} note={t('body')} />;
}
