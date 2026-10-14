'use client';

import Link from 'next/link';
import { useState } from 'react';
import { useRouter, useSearchParams } from 'next/navigation';
import { useLocale, useTranslations } from 'next-intl';
import { Button, Field, Input } from '@bh/ui';
import { useMutation } from '@/lib/useApi';
import { AuthFrame, ErrorSummary } from './AuthFrame';

export function SignInForm() {
  const t = useTranslations('auth');
  const router = useRouter();
  const [email, setEmail] = useState('jamie@stillwater-sample.com');
  const [password, setPassword] = useState('');
  const m = useMutation((api) => api.auth.signIn({ email, password }));
  return (
    <AuthFrame title={t('signInTitle')} subtitle={t('signInSub')} footer={<>{t('noAccount')} <Link href="/sign-up" className="font-bold text-ink underline">{t('createAccount')}</Link></>}>
      <form
        noValidate
        className="flex flex-col gap-4"
        onSubmit={async (e) => {
          e.preventDefault();
          const r = await m.run();
          if (r) router.push(r.needsVerification ? `/verify-email?email=${encodeURIComponent(email)}` : '/overview');
        }}
      >
        {m.error && <ErrorSummary message={m.error.message} fields={m.error.fields} />}
        <Field label={t('email')} error={m.error?.fields?.email}>{(p) => <Input id={p.id} type="email" autoComplete="email" aria-invalid={p.invalid} aria-describedby={p.describedBy} value={email} onChange={(e) => setEmail(e.target.value)} />}</Field>
        <Field label={t('password')} error={m.error?.fields?.password} hint={t('demoPassword')}>{(p) => <Input id={p.id} type="password" autoComplete="current-password" aria-invalid={p.invalid} aria-describedby={p.describedBy} value={password} onChange={(e) => setPassword(e.target.value)} />}</Field>
        <div className="flex justify-end">
          <Link href="/forgot-password" className="text-sm font-semibold underline">
            {t('forgot')}
          </Link>
        </div>
        <Button type="submit" size="lg" loading={m.pending}>
          {t('signIn')}
        </Button>
      </form>
    </AuthFrame>
  );
}

export function SignUpForm() {
  const t = useTranslations('auth');
  const locale = useLocale();
  const router = useRouter();
  const [name, setName] = useState('');
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const m = useMutation((api) => api.auth.signUp({ name, email, password, locale }));
  return (
    <AuthFrame title={t('signUpTitle')} subtitle={t('signUpSub')} footer={<>{t('haveAccount')} <Link href="/sign-in" className="font-bold text-ink underline">{t('signIn')}</Link></>}>
      <form
        noValidate
        className="flex flex-col gap-4"
        onSubmit={async (e) => {
          e.preventDefault();
          const r = await m.run();
          if (r) router.push(`/verify-email?email=${encodeURIComponent(email)}`);
        }}
      >
        {m.error && <ErrorSummary message={m.error.message} fields={m.error.fields} />}
        <Field label={t('name')} error={m.error?.fields?.name}>{(p) => <Input id={p.id} autoComplete="name" aria-invalid={p.invalid} aria-describedby={p.describedBy} value={name} onChange={(e) => setName(e.target.value)} />}</Field>
        <Field label={t('workEmail')} error={m.error?.fields?.email}>{(p) => <Input id={p.id} type="email" autoComplete="email" aria-invalid={p.invalid} aria-describedby={p.describedBy} value={email} onChange={(e) => setEmail(e.target.value)} />}</Field>
        <Field label={t('password')} hint={t('passwordHint')} error={m.error?.fields?.password}>{(p) => <Input id={p.id} type="password" autoComplete="new-password" aria-invalid={p.invalid} aria-describedby={p.describedBy} value={password} onChange={(e) => setPassword(e.target.value)} />}</Field>
        <p className="text-xs text-stone">{t('languageNote')}</p>
        <Button type="submit" size="lg" loading={m.pending}>
          {t('createAccount')}
        </Button>
      </form>
    </AuthFrame>
  );
}

export function VerifyEmailForm() {
  const t = useTranslations('auth');
  const router = useRouter();
  const params = useSearchParams();
  const email = params.get('email') ?? 'you@business.example';
  const [code, setCode] = useState('');
  const [resent, setResent] = useState(false);
  const m = useMutation((api) => api.auth.verifyEmail({ email, code }));
  const resend = useMutation((api) => api.auth.resendCode({ email }));
  return (
    <AuthFrame title={t('verifyTitle')} subtitle={t('verifySub', { email })}>
      <form
        noValidate
        className="flex flex-col gap-4"
        onSubmit={async (e) => {
          e.preventDefault();
          const r = await m.run();
          if (r) router.push('/onboarding');
        }}
      >
        {m.error && <ErrorSummary message={m.error.message} />}
        <Field label={t('code')} hint={t('codeHint')} error={m.error?.fields?.code}>
          {(p) => <Input id={p.id} inputMode="numeric" autoComplete="one-time-code" maxLength={6} aria-invalid={p.invalid} aria-describedby={p.describedBy} value={code} onChange={(e) => setCode(e.target.value.replace(/\D/g, '').slice(0, 6))} className="tabular text-center text-2xl font-bold tracking-[0.4em]" />}
        </Field>
        <Button type="submit" size="lg" loading={m.pending} disabled={code.length !== 6}>
          {t('verify')}
        </Button>
        <Button
          type="button"
          variant="ghost"
          loading={resend.pending}
          onClick={async () => {
            if (await resend.run()) setResent(true);
          }}
        >
          {t('resend')}
        </Button>
        {resent && <p role="status" className="text-center text-sm font-semibold text-success">{t('resent')}</p>}
      </form>
    </AuthFrame>
  );
}

export function ForgotPasswordForm() {
  const t = useTranslations('auth');
  const [email, setEmail] = useState('');
  const [sent, setSent] = useState(false);
  const m = useMutation((api) => api.auth.forgotPassword({ email }));
  return (
    <AuthFrame title={t('forgotTitle')} subtitle={t('forgotSub')} footer={<Link href="/sign-in" className="font-bold text-ink underline">{t('backToSignIn')}</Link>}>
      {sent ? (
        <div role="status" className="rounded-lg bg-success-bg p-4 text-sm text-success">
          <strong>{t('forgotSentTitle')}</strong>
          <p className="mt-1">{t('forgotSent', { email })}</p>
        </div>
      ) : (
        <form
          noValidate
          className="flex flex-col gap-4"
          onSubmit={async (e) => {
            e.preventDefault();
            if (await m.run()) setSent(true);
          }}
        >
          {m.error && <ErrorSummary message={m.error.message} fields={m.error.fields} />}
          <Field label={t('email')} error={m.error?.fields?.email}>{(p) => <Input id={p.id} type="email" autoComplete="email" aria-invalid={p.invalid} aria-describedby={p.describedBy} value={email} onChange={(e) => setEmail(e.target.value)} />}</Field>
          <Button type="submit" size="lg" loading={m.pending}>
            {t('sendLink')}
          </Button>
        </form>
      )}
    </AuthFrame>
  );
}
