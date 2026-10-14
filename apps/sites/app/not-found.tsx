import { getTranslations } from 'next-intl/server';
import { MessagePage } from '@/components/Message';

export default async function NotFound() {
  const t = await getTranslations('error');
  return <MessagePage icon="search" title={t('notFoundTitle')} body={t('notFoundBody')} />;
}
