import { getTranslations } from 'next-intl/server';
import { MessagePage } from '@/components/Message';

export const metadata = { robots: { index: false, follow: false } };

/** The bare included host has no site of its own; each business lives at /{brand}. */
export default async function Root() {
  const t = await getTranslations('error');
  return <MessagePage icon="globe" title={t('notFoundTitle')} body={t('notFoundBody')} />;
}
