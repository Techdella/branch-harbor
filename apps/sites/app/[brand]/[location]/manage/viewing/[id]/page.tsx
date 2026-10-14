import type { Metadata } from 'next';
import { getLocale, getTranslations } from 'next-intl/server';
import { ManageAction } from '@/components/ManageAction';
import { MessagePage } from '@/components/Message';
import { dateLong, time, zone } from '@/lib/format';
import { manageLookup } from '@/lib/manage';

export const metadata: Metadata = { robots: { index: false, follow: false } };

type V = { viewing: { id: string; status: string; startsAt: string; endsAt: string; timeZone: string; agentName: string | null; listing: { title: string; reference: string } | null; kind: string }; office: { name: string; phone: string | null } };

/** Manage a viewing request from the confirmation link (token-gated; no account needed). */
export default async function ManageViewing({ params, searchParams }: { params: Promise<{ id: string }>; searchParams: Promise<{ token?: string }> }) {
  const { id } = await params;
  const { token } = await searchParams;
  const t = await getTranslations('realty');
  const locale = await getLocale();
  const v = /^[0-9a-f-]{36}$/i.test(id) ? await manageLookup<V>(`/v1/public/realty/viewings/${id}`, token) : null;
  if (!v) return <MessagePage icon="lock" title={t('manageViewing.title')} body={t('manageViewing.invalid')} />;
  const tz = v.viewing.timeZone;
  const active = ['requested', 'confirmed'].includes(v.viewing.status) && new Date(v.viewing.startsAt) > new Date();
  return (
    <main id="main" className="mx-auto max-w-2xl px-4 py-10">
      <h1 className="text-3xl font-extrabold tracking-tight">{t('manageViewing.title')}</h1>
      <section className="card mt-5 p-6">
        <p className="inline-flex rounded-full bg-canvas px-3 py-1 text-sm font-bold">{t(`viewingStatus.${v.viewing.status}`)}</p>
        <h2 className="mt-3 text-xl font-bold">{v.viewing.listing?.title}</h2>
        <p className="mt-1">{dateLong(v.viewing.startsAt, tz, locale)}, {time(v.viewing.startsAt, tz, locale)}–{time(v.viewing.endsAt, tz, locale)} {zone(tz, locale, v.viewing.startsAt)}</p>
        <p className="text-graphite">{v.viewing.agentName} · {v.office.name}{v.office.phone ? ` · ${v.office.phone}` : ''}</p>
        {v.viewing.status === 'requested' && <p className="mt-3 text-sm text-graphite">{t('manageViewing.awaiting')}</p>}
        {active && <div className="mt-5"><ManageAction path={`/public/realty/viewings/${v.viewing.id}/cancel`} token={token!} label={t('manageViewing.cancel')} question={t('manageViewing.question')} /></div>}
      </section>
    </main>
  );
}
