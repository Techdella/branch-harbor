import type { Metadata } from 'next';
import { getTranslations } from 'next-intl/server';
import { MessagePage } from '@/components/Message';
import { OrderStatus } from '@/components/foods/OrderStatus';
import { apiGet, isNotFound } from '@/lib/api';
import type { FoodOrder } from '@/lib/foods';
import { loadLocation } from '@/lib/site';

export const metadata: Metadata = { robots: { index: false, follow: false } };

export default async function OrderStatusPage({ params, searchParams }: { params: Promise<{ brand: string; location: string; id: string }>; searchParams: Promise<{ token?: string }> }) {
  const { brand, location, id } = await params;
  const { token } = await searchParams;
  const data = await loadLocation(brand, location);
  const t = await getTranslations();
  let order: FoodOrder | null = null;
  if (token && token.length >= 10 && /^[0-9a-f-]{36}$/i.test(id)) {
    try {
      order = await apiGet<FoodOrder & { locationId: string }>(`/v1/public/foods/orders/${id}/track?token=${encodeURIComponent(token)}`);
      if ((order as FoodOrder & { locationId: string }).locationId !== data.location.id) order = null;
    } catch (err) {
      if (!isNotFound(err)) throw err;
    }
  }
  if (!order) return <MessagePage icon="lock" title={t('order.title')} body={t('manage.invalidLink')} />;
  return (
    <main id="main" className="mx-auto max-w-2xl px-4 py-10">
      <OrderStatus initial={order} token={token!} locationName={data.location.name} timeZone={data.location.timeZone} />
    </main>
  );
}
