import type { Metadata } from 'next';
import { getTranslations } from 'next-intl/server';
import { OrderScreen } from '@/components/supply/OrderScreen';

export async function generateMetadata(): Promise<Metadata> {
  return { title: (await getTranslations('supply'))('order.pageTitle') };
}
export default async function Page({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  return <OrderScreen id={id} />;
}
