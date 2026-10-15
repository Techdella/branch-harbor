'use client';

import { useTranslations } from 'next-intl';
import { OPS } from '@/lib/nav';
import { useApp } from '../shell/AppContext';
import { DeniedState } from '../ui/States';
import { NotAvailable } from './NotAvailable';
import { LaterScreen } from './LaterScreen';
import { TableScreen } from './TableScreen';
import { ClassesScreen } from './studios/ClassesScreen';
import { CoverScreen } from './studios/CoverScreen';
import { ScheduleScreen } from './studios/ScheduleScreen';
import { RoomsScreen } from './studios/RoomsScreen';
import { PricingScreen } from './studios/PricingScreen';
import { MembersScreen } from './studios/MembersScreen';
import { OnlineScreen } from './studios/OnlineScreen';
import { InsightsScreen } from './studios/InsightsScreen';
import { RegistrationsScreen } from './sports/RegistrationsScreen';
import { AttendanceScreen } from './sports/AttendanceScreen';
import { SportsScreen } from './sports/SportsScreens';
import { wellnessScreen } from './wellness/WellnessRouter';
import { CommerceRoutes } from './commerce/CommerceRoutes';
import { MenuScreen } from './foods/MenuScreen';
import { FoodOrdersScreen } from './foods/FoodOrdersScreen';
import { KitchenScreen } from './foods/KitchenScreen';
import { RealtyScreen } from './realty/RealtyRouter';
import { foodsScreen } from './foods/ext';

export function OpsRouter({ screen }: { screen: string }) {
  const t = useTranslations('ops');
  const app = useApp();
  const def = OPS[app.industry].find((o) => o.key === screen);
  // Screens of another industry don't exist in this business account (one industry per account).
  if (!def) return <NotAvailable />;
  const title = t(`${app.industry}.${def.key}.title`);
  if (def.kind === 'later') return <LaterScreen icon={def.icon} title={title} note={t(`${app.industry}.${def.key}.later`)} />;
  if (!app.can('operations.read')) return <DeniedState permission="operations.read" />;
  if (app.industry === 'wellness') { const w = wellnessScreen(def.key); if (w) return w; }
  if (def.kind === 'table') return <TableScreen tableKey={def.key} title={title} icon={def.icon} permission="operations.read" />;
  const foodsExt = app.industry === 'foods' ? foodsScreen(def.key) : null;
  if (foodsExt) return foodsExt;
  const key = `${app.industry}:${def.key}`;
  if (app.industry === 'commerce') return <CommerceRoutes screen={def.key} />;
  switch (key) {
    case 'studios:classes':
      return <ClassesScreen />;
    case 'studios:cover':
      return <CoverScreen />;
    case 'studios:schedule':
      return <ScheduleScreen />;
    case 'studios:rooms':
      return <RoomsScreen />;
    case 'studios:pricing':
      return <PricingScreen />;
    case 'studios:members':
      return <MembersScreen />;
    case 'studios:online':
      return <OnlineScreen />;
    case 'studios:insights':
      return <InsightsScreen />;
    case 'sports:registrations':
      return <RegistrationsScreen />;
    case 'sports:attendance':
      return <AttendanceScreen />;
    case 'sports:overview':
    case 'sports:programmes':
    case 'sports:teams':
    case 'sports:schedule':
    case 'sports:balances':
    case 'sports:announcements':
    case 'sports:guardians':
    case 'sports:reports':
      return <SportsScreen screen={def.key} />;
    case 'foods:menu':
      return <MenuScreen />;
    case 'foods:orders':
      return <FoodOrdersScreen />;
    case 'foods:kitchen':
      return <KitchenScreen />;
  }
  if (app.industry === 'realty') return <RealtyScreen screen={def.key} />;
  return null;
}
