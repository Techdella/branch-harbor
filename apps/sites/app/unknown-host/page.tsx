import { getTranslations } from 'next-intl/server';
import { MessagePage } from '@/components/Message';

export const metadata = { robots: { index: false, follow: false } };

export default async function UnknownHost() {
  const t = await getTranslations('error');
  return <MessagePage icon="link" title={t('unknownHostTitle')} body={t('unknownHostBody')} />;
}
