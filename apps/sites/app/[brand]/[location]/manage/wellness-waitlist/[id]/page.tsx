import type { Metadata } from 'next';
import { getLocale, getTranslations } from 'next-intl/server';
import { MessagePage } from '@/components/Message';
import { WaitlistActions } from '@/components/wellness/WaitlistActions';
import { dateLong, time, zone } from '@/lib/format';
import { manageLookup } from '@/lib/manage';

export const metadata: Metadata = { robots: { index: false, follow: false } };

type W = { id: string; status: string; serviceName: string | null; windowStart: string; windowEnd: string; offeredStartsAt: string | null; location: { name: string; timeZone: string } };

export default async function ManageWaitlist({ params, searchParams }: { params: Promise<{ brand: string; location: string; id: string }>; searchParams: Promise<{ token?: string }> }) {
  const { id } = await params;
  const { token } = await searchParams;
  const t = await getTranslations('wellnessPro');
  const locale = await getLocale();
  const w = /^[0-9a-f-]{36}$/i.test(id) ? await manageLookup<W>(`/v1/public/wellness/waitlist/${id}`, token) : null;
  if (!w) return <MessagePage icon="lock" title={t('waitlistTitle')} body={t('invalidLink')} />;
  const tz = w.location.timeZone;
  return (
    <main id="main" className="mx-auto max-w-2xl px-4 py-10">
      <h1 className="text-3xl font-extrabold tracking-tight">{t('waitlistTitle')}</h1>
      <section className="card mt-5 space-y-2 p-6">
        <p className="inline-flex rounded-full bg-canvas px-3 py-1 text-sm font-bold">{t(`waitlistStatus.${w.status}` as 'waitlistStatus.waiting')}</p>
        <h2 className="text-xl font-bold">{w.serviceName} · {w.location.name}</h2>
        <p>{dateLong(w.windowStart, tz, locale)}, {time(w.windowStart, tz, locale)}–{time(w.windowEnd, tz, locale)} {zone(tz, locale, w.windowStart)}</p>
        {w.status === 'offered' && w.offeredStartsAt && <p className="rounded-xl bg-info-bg p-3 font-semibold text-info">{t('offerAt', { when: `${dateLong(w.offeredStartsAt, tz, locale)} ${time(w.offeredStartsAt, tz, locale)}` })}</p>}
        <WaitlistActions id={w.id} token={token!} status={w.status} />
      </section>
    </main>
  );
}
