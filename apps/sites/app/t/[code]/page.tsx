import { notFound, redirect } from 'next/navigation';
import { apiGet, isNotFound } from '@/lib/api';
import type { TableInfo } from '@/lib/foods-ext';

/** Short QR link printed on tables: /t/{code} → the location's table ordering page. */
export default async function TableShortLink({ params }: { params: Promise<{ code: string }> }) {
  const { code } = await params;
  let info: TableInfo;
  try {
    info = await apiGet<TableInfo>(`/v1/public/foods/tables/${encodeURIComponent(code)}`);
  } catch (err) {
    if (isNotFound(err)) notFound();
    throw err;
  }
  redirect(`/${info.location.orgSlug}/${info.location.slug}/table/${info.table.code}`);
}
