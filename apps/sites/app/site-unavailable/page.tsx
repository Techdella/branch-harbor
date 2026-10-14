import { getTranslations } from 'next-intl/server';
import { MessagePage } from '@/components/Message';

export const metadata = { robots: { index: false, follow: false } };

export default async function SiteUnavailable() {
  const t = await getTranslations('error');
  return <MessagePage icon="wifi-off" title={t('unavailableTitle')} body={t('unavailableBody')} />;
}
