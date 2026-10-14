'use client';

import Link from 'next/link';
import { useTranslations } from 'next-intl';
import { OPS } from '@/lib/nav';
import { APP_INDUSTRIES } from '@/lib/types';
import { useApp } from '../shell/AppContext';
import { DeniedState } from '../ui/States';
import { LaterScreen } from './LaterScreen';
import { TableScreen } from './TableScreen';
import { ClassesScreen } from './studios/ClassesScreen';
import { CoverScreen } from './studios/CoverScreen';
import { RegistrationsScreen } from './sports/RegistrationsScreen';
import { AttendanceScreen } from './sports/AttendanceScreen';
import { CalendarScreen } from './wellness/CalendarScreen';
import { CommerceOrdersScreen } from './commerce/OrdersScreen';
import { MenuScreen } from './foods/MenuScreen';
import { FoodOrdersScreen } from './foods/FoodOrdersScreen';
import { KitchenScreen } from './foods/KitchenScreen';
import { foodsScreen } from './foods/ext';

export function OpsRouter({ screen }: { screen: string }) {
  const t = useTranslations('ops');
  const tInd = useTranslations('industries');
  const app = useApp();
  const def = OPS[app.industry].find((o) => o.key === screen);
  if (!def)
    return (
      <div className="flex flex-col items-center gap-3 rounded-xl bg-surface px-6 py-14 text-center">
        <h1 className="text-h3 font-bold">{t('notInIndustry')}</h1>
        <p className="max-w-md text-sm text-stone">{t('notInIndustryBody')}</p>
        <div className="flex flex-wrap justify-center gap-2">
          {APP_INDUSTRIES.filter((k) => OPS[k].some((o) => o.key === screen)).map((k) => (
            <button key={k} type="button" onClick={() => app.setIndustry(k)} className="inline-flex h-11 items-center rounded-full bg-ink px-5 text-sm font-bold text-white">
              {t('switchTo', { industry: tInd(`${k}.name`) })}
            </button>
          ))}
          <Link href="/overview" className="inline-flex h-11 items-center rounded-full border border-line px-5 text-sm font-bold">
            {t('backToOverview')}
          </Link>
        </div>
      </div>
    );
  const title = t(`${app.industry}.${def.key}.title`);
  if (def.kind === 'later') return <LaterScreen icon={def.icon} title={title} note={t(`${app.industry}.${def.key}.later`)} />;
  if (!app.can('operations.read')) return <DeniedState permission="operations.read" />;
  if (def.kind === 'table') return <TableScreen tableKey={def.key} title={title} icon={def.icon} permission="operations.read" />;
  const foodsExt = app.industry === 'foods' ? foodsScreen(def.key) : null;
  if (foodsExt) return foodsExt;
  const key = `${app.industry}:${def.key}`;
  switch (key) {
    case 'studios:classes':
      return <ClassesScreen />;
    case 'studios:cover':
      return <CoverScreen />;
    case 'sports:registrations':
      return <RegistrationsScreen />;
    case 'sports:attendance':
      return <AttendanceScreen />;
    case 'wellness:calendar':
      return <CalendarScreen />;
    case 'commerce:orders':
      return <CommerceOrdersScreen />;
    case 'foods:menu':
      return <MenuScreen />;
    case 'foods:orders':
      return <FoodOrdersScreen />;
    case 'foods:kitchen':
      return <KitchenScreen />;
  }
  return null;
}
