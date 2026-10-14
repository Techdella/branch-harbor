import type { Metadata } from 'next';
import { getLocale, getTranslations } from 'next-intl/server';
import { MessagePage } from '@/components/Message';
import { dateLong, money } from '@/lib/format';
import { manageLookup } from '@/lib/manage';
import type { Money } from '@/lib/types';

export const metadata: Metadata = { robots: { index: false, follow: false } };

type V = { id: string; code: string | null; initial: Money; balance: Money; expiresAt: string; status: string; recipientName: string | null; message: string | null };

export default async function ManageVoucher({ params, searchParams }: { params: Promise<{ id: string }>; searchParams: Promise<{ token?: string }> }) {
  const { id } = await params;
  const { token } = await searchParams;
  const t = await getTranslations('wellnessPro');
  const locale = await getLocale();
  const v = /^[0-9a-f-]{36}$/i.test(id) ? await manageLookup<V>(`/v1/public/wellness/vouchers/${id}`, token) : null;
  if (!v) return <MessagePage icon="lock" title={t('yourVoucher')} body={t('invalidLink')} />;
  return (
    <main id="main" className="mx-auto max-w-2xl px-4 py-10">
      <h1 className="text-3xl font-extrabold tracking-tight">{t('yourVoucher')}</h1>
      <section className="card mt-5 space-y-2 p-6 text-center">
        <p className="inline-flex rounded-full bg-canvas px-3 py-1 text-sm font-bold">{t(`voucherStatus.${v.status}` as 'voucherStatus.active')}</p>
        {v.code ? <p className="tabular text-3xl font-extrabold tracking-wider">{v.code}</p> : <p className="text-graphite">{t('codeAfterPayment')}</p>}
        <p className="text-xl font-bold">{money(v.balance, locale)} <span className="text-base font-medium text-graphite">/ {money(v.initial, locale)}</span></p>
        <p className="text-graphite">{t('expiresOn', { date: dateLong(v.expiresAt, 'UTC', locale) })}{v.recipientName ? ` · ${t('forName', { name: v.recipientName })}` : ''}</p>
        <p className="text-sm text-graphite">{t('voucherCurrencyRule', { currency: v.balance.currency })}</p>
      </section>
    </main>
  );
}
