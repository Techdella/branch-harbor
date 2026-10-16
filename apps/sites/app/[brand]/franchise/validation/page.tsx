import type { Metadata } from 'next';
import { getTranslations } from 'next-intl/server';
import { ValidationCall } from '@/components/franchise/ValidationCalls';
import { MessagePage } from '@/components/Message';
import { getValidation } from '@/lib/franchise';

export const metadata: Metadata = { robots: { index: false, follow: false } };

/** A franchise candidate books validation calls with existing franchisees (link from the franchisor's email). */
export default async function ValidationPage({ searchParams }: { searchParams: Promise<{ token?: string }> }) {
  const { token } = await searchParams;
  const t = await getTranslations('franchiseSite');
  const d = token && token.length >= 20 ? await getValidation(token).catch(() => null) : null;
  if (!d || !token) return <MessagePage icon="lock" title={t('validationTitle')} body={t('linkInvalid')} />;
  return (
    <main id="main" className="mx-auto flex max-w-2xl flex-col gap-5 px-4 py-10">
      <h1 className="text-3xl font-extrabold tracking-tight">{t('validationTitle')}</h1>
      <p className="text-lg text-graphite">{t('validationIntro', { brand: d.brand.name, name: d.candidateFirstName })}</p>
      {d.calls.length ? d.calls.map((c) => <ValidationCall key={c.id} token={token} c={c} />) : <p className="text-graphite">{t('validationEmpty')}</p>}
      <p className="text-sm text-graphite">{t('validationNote', { brand: d.brand.name })}</p>
    </main>
  );
}
