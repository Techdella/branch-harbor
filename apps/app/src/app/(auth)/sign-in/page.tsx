import type { Metadata } from 'next';
import { Suspense } from 'react';
import { SignInForm } from '@/components/auth/AuthForms';

export const metadata: Metadata = { title: 'Sign in' };
export default function Page() {
  return (
    <Suspense>
      <SignInForm />
    </Suspense>
  );
}
