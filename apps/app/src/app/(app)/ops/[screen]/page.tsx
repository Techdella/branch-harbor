import { Suspense } from 'react';
import { OpsRouter } from '@/components/screens/OpsRouter';

export default async function Page({ params }: { params: Promise<{ screen: string }> }) {
  const { screen } = await params;
  return (
    <Suspense>
      <OpsRouter screen={screen} />
    </Suspense>
  );
}
