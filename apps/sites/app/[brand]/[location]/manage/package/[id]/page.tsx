import type { Metadata } from 'next';
import { getLocale, getTranslations } from 'next-intl/server';
import { MessagePage } from '@/components/Message';
import { dateLong, money } from '@/lib/format';
import { manageLookup } from '@/lib/manage';
import type { Money } from '@/lib/types';

export const metadata: Metadata = { robots: { index: false, follow: false } };

type Pkg = { id: string; name: string | null; sessionsTotal: number; sessionsRemaining: number; price: Money; expiresAt: string | null; status: string; sharing: string };

export default async function ManagePackage({ params, searchParams }: { params: Promise<{ id: string }>; searchParams: Promise<{ token?: string }> }) {
  const { id } = await params;
  const { token } = await searchParams;
  const t = await getTranslations('wellnessPro');
  const locale = await getLocale();
  const p = /^[0-9a-f-]{36}$/i.test(id) ? await manageLookup<Pkg>(`/v1/public/wellness/client-packages/${id}`, token) : null;
  if (!p) return <MessagePage icon="lock" title={t('yourPackage')} body={t('invalidLink')} />;
  return (
    <main id="main" className="mx-auto max-w-2xl px-4 py-10">
      <h1 className="text-3xl font-extrabold tracking-tight">{t('yourPackage')}</h1>
      <section className="card mt-5 space-y-2 p-6">
        <p className="inline-flex rounded-full bg-canvas px-3 py-1 text-sm font-bold">{t(`packageStatus.${p.status}` as 'packageStatus.active')}</p>
        <h2 className="text-xl font-bold">{p.name}</h2>
        <p className="text-2xl font-extrabold">{t('sessionsLeftOf', { n: p.sessionsRemaining, total: p.sessionsTotal })}</p>
        <p className="text-graphite">{money(p.price, locale)}{p.expiresAt ? ` · ${t('expiresOn', { date: dateLong(p.expiresAt, 'UTC', locale) })}` : ''}</p>
        <p className="rounded-xl bg-canvas p-3 text-sm">{t('packageRefHelp')} <code className="font-bold">{p.id}</code></p>
      </section>
    </main>
  );
}
