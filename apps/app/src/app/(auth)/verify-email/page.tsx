import type { Metadata } from 'next';
import { getTranslations } from 'next-intl/server';
import { Suspense } from 'react';
import { VerifyEmailForm } from '@/components/auth/AuthForms';

export async function generateMetadata(): Promise<Metadata> {
  return { title: (await getTranslations('meta'))('verifyEmail') };
}
export default function Page() {
  return (
    <Suspense>
      <VerifyEmailForm />
    </Suspense>
  );
}
