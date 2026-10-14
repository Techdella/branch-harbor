import type { Metadata } from 'next';
import { getTranslations } from 'next-intl/server';
import { Suspense } from 'react';
import { SignInForm } from '@/components/auth/AuthForms';

export async function generateMetadata(): Promise<Metadata> {
  return { title: (await getTranslations('meta'))('signIn') };
}
export default function Page() {
  return (
    <Suspense>
      <SignInForm />
    </Suspense>
  );
}
