'use client';

import { useState } from 'react';
import { useTranslations } from 'next-intl';
import { Button, Icon } from '@bh/ui';
import type { IconName } from '@bh/icons';
import { PageHeader } from '../shell/PageHeader';

/** Honest placeholder for features that are not in the first release. */
export function LaterScreen({ icon, title, note }: { icon: IconName; title: string; note: string }) {
  const t = useTranslations();
  const [asked, setAsked] = useState(false);
  return (
    <>
      <PageHeader icon={icon} title={title} scope={false} actions={<span className="rounded-full bg-canvas px-3 py-1.5 text-xs font-bold text-stone">{t('ops.laterBadge')}</span>} />
      <section className="flex flex-col items-center gap-3.5 rounded-xl bg-surface px-7 py-12 text-center">
        <span className="flex h-16 w-16 items-center justify-center rounded-[22px] bg-canvas">
          <Icon name="clock" size={28} />
        </span>
        <h2 className="text-2xl font-bold">{t('ops.laterTitle', { name: title })}</h2>
        <p className="max-w-[520px] text-[15px] leading-relaxed text-stone">{note}</p>
        {asked ? (
          <p role="status" className="flex items-center gap-2 text-sm font-semibold text-success">
            <Icon name="check-circle" size={16} />
            {t('common.notifyThanks')}
          </p>
        ) : (
          <Button variant="secondary" onClick={() => setAsked(true)}>
            {t('common.notifyMe')}
          </Button>
        )}
      </section>
    </>
  );
}
