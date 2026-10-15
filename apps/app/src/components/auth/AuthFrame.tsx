'use client';

import Image from 'next/image';
import Link from 'next/link';
import type { ReactNode } from 'react';
import { useTranslations } from 'next-intl';
import { Logo } from '@bh/ui';
import { LanguageSelect } from '../shell/TopBar';

const IMG = 'https://images.unsplash.com/photo-1676496962536-d8ef110ff6f0?auto=format&fit=crop&w=1200&q=70';

export function AuthFrame({ title, subtitle, children, footer }: { title: string; subtitle?: string; children: ReactNode; footer?: ReactNode }) {
  const t = useTranslations('auth');
  return (
    <div className="flex min-h-viewport gap-3 p-2 sm:p-3">
      <main className="flex min-w-0 flex-1 flex-col rounded-xl bg-surface px-4 py-6 sm:px-5 md:px-12 md:py-10">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <Link href="/sign-in" aria-label="BranchHarbor">
            <Logo size={30} />
          </Link>
          <LanguageSelect className="w-[190px] max-w-full" />
        </div>
        <div className="mx-auto flex w-full max-w-[420px] flex-1 flex-col justify-center gap-6 py-10">
          <div>
            <h1 className="text-[28px] font-bold leading-tight tracking-[-0.035em] sm:text-[32px]">{title}</h1>
            {subtitle && <p className="mt-2 text-[15px] text-stone">{subtitle}</p>}
          </div>
          {children}
          {footer && <div className="text-sm text-stone">{footer}</div>}
        </div>
        <p className="text-center text-xs text-stone">{t('legal')}</p>
      </main>
      <aside className="relative hidden w-[44%] overflow-hidden rounded-xl bg-lilac lg:block">
        <Image src={IMG} alt="" fill sizes="44vw" className="object-cover" priority />
        <div className="absolute inset-x-6 bottom-6 rounded-lg bg-surface/95 p-5 backdrop-blur">
          <div className="text-lg font-bold tracking-tight">{t('promise')}</div>
          <p className="mt-1 text-sm text-stone">{t('promiseSub')}</p>
        </div>
      </aside>
    </div>
  );
}

export function ErrorSummary({ fields, message }: { fields?: Record<string, string>; message?: string }) {
  const t = useTranslations('auth');
  if (!message && !fields) return null;
  const items = Object.values(fields ?? {});
  return (
    <div role="alert" className="rounded-md bg-danger-bg p-3.5 text-sm text-danger">
      <strong>{message ?? t('checkFields')}</strong>
      {items.length > 0 && (
        <ul className="mt-1 list-disc pl-5">
          {items.map((m) => (
            <li key={m}>{m}</li>
          ))}
        </ul>
      )}
    </div>
  );
}
