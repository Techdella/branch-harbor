import type { Metadata } from 'next';
import { getTranslations } from 'next-intl/server';
import { Suspense } from 'react';
import { WebsitesHub } from '@/components/marketing/website/WebsitesHub';

export async function generateMetadata(): Promise<Metadata> {
  return { title: (await getTranslations('mkt'))('meta.websites') };
}
export default function Page() {
  return <Suspense><WebsitesHub /></Suspense>;
}
