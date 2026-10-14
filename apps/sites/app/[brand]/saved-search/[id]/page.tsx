import type { Metadata } from 'next';
import { getTranslations } from 'next-intl/server';
import { ManageAction } from '@/components/ManageAction';
import { MessagePage } from '@/components/Message';
import { manageLookup } from '@/lib/manage';

export const metadata: Metadata = { robots: { index: false, follow: false } };

type S = { id: string; name: string | null; criteria: Record<string, unknown>; frequency: string; alerts: boolean; unsubscribedAt: string | null };

/** Manage a saved search from the link in every alert: stop alerts (withdraws consent). */
export default async function ManageSavedSearch({ params, searchParams }: { params: Promise<{ id: string }>; searchParams: Promise<{ token?: string }> }) {
  const { id } = await params;
  const { token } = await searchParams;
  const t = await getTranslations('realty');
  const s = /^[0-9a-f-]{36}$/i.test(id) ? await manageLookup<S>(`/v1/public/realty/saved-searches/${id}`, token) : null;
  if (!s) return <MessagePage icon="lock" title={t('manageSearch.title')} body={t('manageSearch.invalid')} />;
  return (
    <main id="main" className="mx-auto max-w-2xl px-4 py-10">
      <h1 className="text-3xl font-extrabold tracking-tight">{t('manageSearch.title')}</h1>
      <section className="card mt-5 p-6">
        <h2 className="text-xl font-bold">{s.name ?? t('manageSearch.unnamed')}</h2>
        <p className="mt-2 text-sm text-graphite">{s.alerts ? t('manageSearch.on', { frequency: t(`save.freq.${s.frequency}`) }) : t('manageSearch.off')}</p>
        {s.alerts && <div className="mt-5"><ManageAction path={`/public/realty/saved-searches/${s.id}/unsubscribe`} token={token!} label={t('manageSearch.stop')} question={t('manageSearch.question')} /></div>}
      </section>
    </main>
  );
}
