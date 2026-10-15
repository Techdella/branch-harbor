import type { Metadata } from 'next';
import { getTranslations } from 'next-intl/server';
import { Suspense } from 'react';
import { ReviewsScreen } from '@/components/reviews/ReviewsScreen';

export async function generateMetadata(): Promise<Metadata> {
  return { title: (await getTranslations('reviews'))('title') };
}
export default function Page() {
  return (
    <Suspense>
      <ReviewsScreen />
    </Suspense>
  );
}
