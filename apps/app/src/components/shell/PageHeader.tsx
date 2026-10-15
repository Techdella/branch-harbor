'use client';

import type { ReactNode } from 'react';
import { useTranslations } from 'next-intl';
import { Icon } from '@bh/ui';
import type { IconName } from '@bh/icons';
import { INDUSTRY_UI } from '@/lib/nav';
import { useApp } from './AppContext';
import { ScopeChip } from './ScopePicker';

export function PageHeader({ icon, title, description, actions, scope = true }: { icon: IconName; title: string; description?: string; actions?: ReactNode; scope?: boolean }) {
  const t = useTranslations();
  const app = useApp();
  const org = app.org;
  return (
    <div className="flex flex-wrap items-end justify-between gap-3.5 rounded-xl bg-surface px-5 py-5 md:px-6 md:py-6">
      <div className="flex min-w-0 items-center gap-3.5">
        <span className="flex h-[52px] w-[52px] shrink-0 items-center justify-center rounded-[18px]" style={{ background: INDUSTRY_UI[app.industry].pastel }}>
          <Icon name={icon} size={24} />
        </span>
        <div className="min-w-0">
          <div className="truncate text-[13px] text-stone">
            {org.name} · {t(`industries.${app.industry}.name`)}
          </div>
          <h1 className="text-[26px] font-bold leading-tight tracking-[-0.035em] md:text-[30px]">{title}</h1>
          {description && <p className="mt-1 max-w-2xl text-sm text-stone">{description}</p>}
        </div>
      </div>
      <div className="flex flex-wrap items-center gap-2">
        {scope && <ScopeChip />}
        {actions}
      </div>
    </div>
  );
}
