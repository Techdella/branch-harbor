import type { Metadata } from 'next';
import { getTranslations } from 'next-intl/server';
import { LeagueTableScreen } from '@/components/quality/LeagueTableScreen';

export async function generateMetadata(): Promise<Metadata> {
  return { title: (await getTranslations('quality'))('league.title') };
}
export default function Page() {
  return <LeagueTableScreen />;
}
