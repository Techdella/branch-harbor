import type { Metadata } from 'next';
import { getTranslations } from 'next-intl/server';
import { Suspense } from 'react';
import { SignUpForm } from '@/components/auth/AuthForms';

export async function generateMetadata(): Promise<Metadata> {
  return { title: (await getTranslations('meta'))('signUp') };
}
export default function Page() {
  return (
    <Suspense>
      <SignUpForm />
    </Suspense>
  );
}
