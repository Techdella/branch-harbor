import type { Metadata } from 'next';
import { getTranslations } from 'next-intl/server';
import { SurveyRespondScreen } from '@/components/fdev/SurveysScreen';

export async function generateMetadata(): Promise<Metadata> {
  return { title: (await getTranslations('fdev'))('surveys.answer') };
}
export default async function Page({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  return <SurveyRespondScreen id={id} />;
}
