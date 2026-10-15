'use client';

import type { ReactNode } from 'react';
import { useTranslations } from 'next-intl';
import { UiLabelsProvider } from '@bh/ui';

/** Gives the shared @bh/ui components (Field, Drawer, ScopeSelector) their words in the user's language. */
export function UiLabels({ children }: { children: ReactNode }) {
  const t = useTranslations('common');
  const shell = useTranslations('shell');
  return <UiLabelsProvider labels={{ optional: t('optional').toLowerCase(), close: t('close'), scope: shell('scope') }}>{children}</UiLabelsProvider>;
}
