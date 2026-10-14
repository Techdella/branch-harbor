import type { Metadata } from 'next';
import { getLocale, getTranslations } from 'next-intl/server';
import { MessagePage } from '@/components/Message';
import { ManageAppointment, type ManageView } from '@/components/wellness/ManageAppointment';
import { dateLong, money, time, zone } from '@/lib/format';
import { localDate } from '@/lib/format';
import { manageLookup } from '@/lib/manage';

export const metadata: Metadata = { robots: { index: false, follow: false } };

export default async function ManageAppointmentPage({ params, searchParams }: { params: Promise<{ id: string }>; searchParams: Promise<{ token?: string }> }) {
  const { id } = await params;
  const { token } = await searchParams;
  const t = await getTranslations();
  const locale = await getLocale();
  const a = /^[0-9a-f-]{36}$/i.test(id) ? await manageLookup<ManageView>(`/v1/public/wellness/appointments/${id}`, token) : null;
  if (!a) return <MessagePage icon="lock" title={t('manage.appointmentTitle')} body={t('manage.invalidLink')} />;
  const tz = a.location.timeZone;
  return (
    <main id="main" className="mx-auto max-w-2xl px-4 py-10">
      <h1 className="text-3xl font-extrabold tracking-tight">{t('manage.appointmentTitle')}</h1>
      <section className="card mt-5 p-6">
        <p className="inline-flex rounded-full bg-canvas px-3 py-1 text-sm font-bold">{t(`manage.status.${a.status}` as 'manage.status.confirmed')}</p>
        <h2 className="mt-3 text-xl font-bold">{a.service.name}{a.service.variantName ? ` · ${a.service.variantName}` : ''} · {a.practitioners.map((p) => p.name).join(' & ')}</h2>
        <p className="mt-1">{dateLong(a.startsAt, tz, locale)}, {time(a.startsAt, tz, locale)}–{time(a.endsAt, tz, locale)} {zone(tz, locale, a.startsAt)}</p>
        <p className="text-graphite">{a.location.name} · {money(a.appointment.price, locale)}{a.guests > 1 ? ` · ${t('wellnessPro.guests', { n: a.guests })}` : ''}</p>
        {a.service.cancellationPolicy && <p className="mt-3 text-sm text-graphite"><span className="font-semibold">{t('manage.policy')}:</span> {a.service.cancellationPolicy}</p>}
        <ManageAppointment view={a} token={token!} today={localDate(new Date(), tz)} />
      </section>
    </main>
  );
}
