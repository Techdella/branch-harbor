import type { Metadata } from 'next';
import { getTranslations } from 'next-intl/server';
import { SurveysScreen } from '@/components/fdev/SurveysScreen';

export async function generateMetadata(): Promise<Metadata> {
  return { title: (await getTranslations('fdev'))('surveys.title') };
}
export default function Page() {
  return <SurveysScreen />;
}
