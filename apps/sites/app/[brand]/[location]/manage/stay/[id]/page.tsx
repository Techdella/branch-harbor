import type { Metadata } from 'next';
import { getTranslations } from 'next-intl/server';
import { MessagePage } from '@/components/Message';
import { ManageStay } from '@/components/stay/ManageStay';
import { manageLookup } from '@/lib/manage';
import type { ManageStayView } from '@/lib/stay';

export const metadata: Metadata = { robots: { index: false, follow: false } };

export default async function ManageStayPage({ params, searchParams }: { params: Promise<{ id: string }>; searchParams: Promise<{ token?: string }> }) {
  const { id } = await params;
  const { token } = await searchParams;
  const t = await getTranslations();
  const v = /^[0-9a-f-]{36}$/i.test(id) ? await manageLookup<ManageStayView>(`/v1/public/hospitality/reservations/${id}`, token) : null;
  if (!v) return <MessagePage icon="lock" title={t('stay.manage.title')} body={t('manage.invalidLink')} />;
  return (
    <main id="main" className="mx-auto max-w-2xl px-4 py-10">
      <h1 className="text-3xl font-extrabold tracking-tight">{t('stay.manage.title')}</h1>
      <p className="mt-1 text-graphite">{t('stay.manage.greeting', { name: v.reservation.guestName })}</p>
      <ManageStay initial={v} id={id} token={token!} />
    </main>
  );
}
