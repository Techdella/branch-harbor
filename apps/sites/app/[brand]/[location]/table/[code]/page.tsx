import type { Metadata } from 'next';
import { notFound } from 'next/navigation';
import { getTranslations } from 'next-intl/server';
import { MessagePage } from '@/components/Message';
import { CheckoutFlow } from '@/components/foods/CheckoutFlow';
import { TabPanel } from '@/components/foods/Extras';
import { apiGet, isNotFound } from '@/lib/api';
import type { MenuX, TableInfo } from '@/lib/foods-ext';
import { getRouting, loadLocation, makeLinks } from '@/lib/site';

export const metadata: Metadata = { robots: { index: false, follow: false } };

/** Dine-in QR ordering for one table: order to the table and pay now, or add to the table's tab. */
export default async function TablePage({ params }: { params: Promise<{ brand: string; location: string; code: string }> }) {
  const { brand, location, code } = await params;
  const data = await loadLocation(brand, location);
  if (data.module.kind !== 'foods') notFound();
  const t = await getTranslations('foodsite');
  let table: TableInfo | null = null;
  try {
    table = await apiGet<TableInfo>(`/v1/public/foods/tables/${encodeURIComponent(code)}`);
  } catch (err) {
    if (!isNotFound(err)) throw err;
  }
  if (!table || table.location.id !== data.location.id) return <MessagePage icon="utensils" title={t('tableTitle')} body={t('tableUnknown')} />;
  if (!table.dineInEnabled) return <MessagePage icon="utensils" title={t('tableTitle')} body={t('dineInOff')} />;
  if (!table.kitchenOpen) return <MessagePage icon="clock" title={t('tableTitle')} body={t('kitchenClosed')} />;
  const menu = await apiGet<MenuX>(`/v1/public/foods/${data.location.id}/menu`);
  const links = makeLinks(await getRouting(), brand, { brandPrimaryHost: data.site.brandPrimaryHost });
  const storageKey = `bh_tab_${table.table.code}`;
  return (
    <main id="main" className="mx-auto max-w-5xl px-4 py-10">
      <h1 className="text-3xl font-extrabold tracking-tight">{t('tableHeading', { table: table.table.label })}</h1>
      <p className="mt-1 text-graphite">{data.brand.name} {data.location.name}</p>
      <TabPanel storageKey={storageKey} tipsBps={menu.tips?.channels.includes('dine_in') ? menu.tips.presetsBps : []} />
      <CheckoutFlow
        locationId={data.location.id} locationName={data.location.name} brandName={data.brand.name} timeZone={data.location.timeZone}
        statusBase={links.location(location, '/orders')} channels={['dine_in']} tableCode={table.table.code} tableLabel={table.table.label} payments={table.payments} tabStorageKey={storageKey}
      />
    </main>
  );
}
