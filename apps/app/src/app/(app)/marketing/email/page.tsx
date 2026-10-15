import type { Metadata } from 'next';
import { getTranslations } from 'next-intl/server';
import { Suspense } from 'react';
import { EmailHub } from '@/components/marketing/email/EmailScreens';

export async function generateMetadata(): Promise<Metadata> {
  return { title: (await getTranslations('mkt'))('meta.email') };
}
export default function Page() {
  return <Suspense><EmailHub /></Suspense>;
}
