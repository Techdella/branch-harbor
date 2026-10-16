import { Suspense } from 'react';
import type { Metadata } from 'next';
import { notFound } from 'next/navigation';
import { getTranslations } from 'next-intl/server';
import { FranchiseRouter } from '@/components/screens/franchise/FranchiseRouter';
import { isFranchiseScreen } from '@/lib/franchise/screens';

export async function generateMetadata({ params }: { params: Promise<{ screen: string }> }): Promise<Metadata> {
  const { screen } = await params;
  const t = await getTranslations('franchise.nav');
  const fdev = await getTranslations('fdev.nav');
  if (screen === 'validation' || screen === 'lifecycle' || screen === 'development' || screen === 'master') return { title: fdev(screen) };
  return { title: t(isFranchiseScreen(screen) ? screen : 'pipeline') };
}

export default async function Page({ params }: { params: Promise<{ screen: string }> }) {
  const { screen } = await params;
  if (!isFranchiseScreen(screen)) notFound();
  return (
    <Suspense>
      <FranchiseRouter screen={screen} />
    </Suspense>
  );
}
