import type { Metadata } from 'next';
import { getTranslations } from 'next-intl/server';
import { CompletePayment } from '@/components/payments/CompletePayment';

export const metadata: Metadata = { robots: { index: false, follow: false } };

/** "Complete your payment" link from the email sent when an automatic charge needs the customer (3-D Secure). */
export default async function PayPage({ params, searchParams }: { params: Promise<{ id: string }>; searchParams: Promise<{ token?: string }> }) {
  const { id } = await params;
  const { token } = await searchParams;
  const t = await getTranslations('payment');
  return (
    <main id="main" className="mx-auto max-w-xl px-4 py-10">
      <h1 className="text-3xl font-extrabold tracking-tight">{t('complete.title')}</h1>
      <CompletePayment paymentId={/^[0-9a-f-]{36}$/i.test(id) ? id : null} token={token ?? null} />
    </main>
  );
}
