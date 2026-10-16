import type { Metadata } from 'next';
import { getTranslations } from 'next-intl/server';
import { SurveyResultsScreen } from '@/components/fdev/SurveysScreen';

export async function generateMetadata(): Promise<Metadata> {
  return { title: (await getTranslations('fdev'))('surveys.results') };
}
export default async function Page({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  return <SurveyResultsScreen id={id} />;
}
