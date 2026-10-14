'use client';

import { useTranslations } from 'next-intl';
import { MessagePage } from './Message';

/** Friendly error. Customer-facing sites never fall back to sample data. */
export function ErrorView({ reset }: { reset: () => void }) {
  const t = useTranslations();
  return (
    <MessagePage icon="wifi-off" title={t('error.title')} body={t('error.body')}>
      <button type="button" className="btn btn-primary" onClick={reset}>{t('common.retry')}</button>
    </MessagePage>
  );
}
