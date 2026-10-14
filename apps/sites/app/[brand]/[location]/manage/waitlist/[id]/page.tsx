import type { Metadata } from 'next';
import { getLocale, getTranslations } from 'next-intl/server';
import { ManageAction } from '@/components/ManageAction';
import { MessagePage } from '@/components/Message';
import { dateLong, time, zone } from '@/lib/format';
import { manageLookup } from '@/lib/manage';

export const metadata: Metadata = { robots: { index: false, follow: false } };

type Entry = { id: string; status: string; class: { name: string; startsAt: string; endsAt: string }; location: { name: string; timeZone: string }; brand: { name: string }; canLeave: boolean };

export default async function ManageWaitlist({ params, searchParams }: { params: Promise<{ id: string }>; searchParams: Promise<{ token?: string }> }) {
  const { id } = await params;
  const { token } = await searchParams;
  const t = await getTranslations();
  const locale = await getLocale();
  const w = /^[0-9a-f-]{36}$/i.test(id) ? await manageLookup<Entry>(`/v1/public/sites/manage/waitlist/${id}`, token) : null;
  if (!w) return <MessagePage icon="lock" title={t('manage.waitlistTitle')} body={t('manage.invalidLink')} />;
  const tz = w.location.timeZone;
  return (
    <main id="main" className="mx-auto max-w-2xl px-4 py-10">
      <h1 className="text-3xl font-extrabold tracking-tight">{t('manage.waitlistTitle')}</h1>
      <section className="card mt-5 p-6">
        <p className="inline-flex rounded-full bg-canvas px-3 py-1 text-sm font-bold">{t(`manage.status.${w.status}` as 'manage.status.waiting')}</p>
        <h2 className="mt-3 text-xl font-bold">{w.class.name}</h2>
        <p className="mt-1">{dateLong(w.class.startsAt, tz, locale)}, {time(w.class.startsAt, tz, locale)} {zone(tz, locale, w.class.startsAt)}</p>
        <p className="text-graphite">{w.brand.name} {w.location.name}</p>
        {w.canLeave && <div className="mt-5"><ManageAction path={`/public/studios/waitlist/${w.id}/leave`} token={token!} label={t('manage.leave')} question={t('manage.leaveQuestion')} /></div>}
      </section>
    </main>
  );
}
