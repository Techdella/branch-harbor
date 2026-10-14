import type { Metadata } from 'next';
import { getLocale, getTranslations } from 'next-intl/server';
import { ManageAction } from '@/components/ManageAction';
import { MessagePage } from '@/components/Message';
import { dateLong, money, time, zone } from '@/lib/format';
import { manageLookup } from '@/lib/manage';

export const metadata: Metadata = { robots: { index: false, follow: false } };

type Booking = {
  id: string; status: string; holdExpiresAt: string | null;
  class: { name: string; startsAt: string; endsAt: string; instructorName: string | null; room: string | null; status: string };
  price: { amount: number; currency: string };
  payment: { state: string; refundState: string | null; sandbox: boolean } | null;
  location: { name: string; timeZone: string };
  brand: { name: string };
  cancellable: boolean; cancellationPolicy: string | null;
};

export default async function ManageBooking({ params, searchParams }: { params: Promise<{ id: string }>; searchParams: Promise<{ token?: string }> }) {
  const { id } = await params;
  const { token } = await searchParams;
  const t = await getTranslations();
  const locale = await getLocale();
  const b = /^[0-9a-f-]{36}$/i.test(id) ? await manageLookup<Booking>(`/v1/public/sites/manage/class-bookings/${id}`, token) : null;
  if (!b) return <MessagePage icon="lock" title={t('manage.bookingTitle')} body={t('manage.invalidLink')} />;
  const tz = b.location.timeZone;
  return (
    <main id="main" className="mx-auto max-w-2xl px-4 py-10">
      <h1 className="text-3xl font-extrabold tracking-tight">{t('manage.bookingTitle')}</h1>
      <section className="card mt-5 p-6">
        <p className="inline-flex rounded-full bg-canvas px-3 py-1 text-sm font-bold">{t(`manage.status.${b.status}` as 'manage.status.confirmed')}</p>
        <h2 className="mt-3 text-xl font-bold">{b.class.name}</h2>
        <p className="mt-1">{dateLong(b.class.startsAt, tz, locale)}, {time(b.class.startsAt, tz, locale)}–{time(b.class.endsAt, tz, locale)} {zone(tz, locale, b.class.startsAt)}</p>
        <p className="text-graphite">{b.brand.name} {b.location.name}{b.class.room ? ` · ${b.class.room}` : ''}</p>
        <p className="mt-3 text-sm"><span className="font-semibold">{t('booking.price')}:</span> {b.price.amount ? money(b.price, locale) : t('schedule.free')}
          {b.payment && <> · <span className="font-semibold">{t('manage.payment')}:</span> {t(`manage.paymentState.${b.payment.state}` as 'manage.paymentState.succeeded')}{b.payment.refundState ? ` (${b.payment.refundState})` : ''}</>}
        </p>
        {b.cancellationPolicy && <p className="mt-3 text-sm text-graphite"><span className="font-semibold">{t('manage.policy')}:</span> {b.cancellationPolicy}</p>}
        <div className="mt-5">
          {b.cancellable
            ? <ManageAction path={`/public/studios/bookings/${b.id}/cancel`} token={token!} label={t('manage.cancel')} question={t('manage.cancelQuestion')} />
            : ['confirmed', 'held'].includes(b.status) ? <p className="text-sm text-graphite">{t('manage.notCancellable')}</p> : null}
        </div>
      </section>
    </main>
  );
}
