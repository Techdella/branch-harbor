'use client';

import { useTranslations } from 'next-intl';
import { useApp } from '../shell/AppContext';
import { DeniedState } from '../ui/States';
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
  if (!app.hasModule('marketing.campaigns')) return <DeniedState />;
  return <TableScreen tableKey="marketing" icon="megaphone" title={t('nav.marketing')} description={t('marketing.description')} />;
}
