import type { Metadata } from 'next';
import { getTranslations } from 'next-intl/server';
import { AssetsScreen } from '@/components/marketing/assets/AssetsScreen';

export async function generateMetadata(): Promise<Metadata> {
  return { title: (await getTranslations('mkt'))('meta.assets') };
}
export default function Page() {
  return <AssetsScreen />;
}
