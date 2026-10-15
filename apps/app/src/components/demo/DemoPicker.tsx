'use client';

import { useEffect, useState } from 'react';
import { useRouter } from 'next/navigation';
import { useTranslations } from 'next-intl';
import { Icon } from '@bh/ui';
import { INDUSTRY_UI } from '@/lib/nav';
import { APP_INDUSTRIES, type IndustryKey } from '@/lib/types';
import { demoAccounts, signInAsDemo, type DemoOrg } from '@/lib/demo';

/**
 * Demo site only: every demo account, grouped by business, with its role — one click signs in. Shown on the sign-in
 * page when the app is built with NEXT_PUBLIC_DEMO_MODE=true (and the API runs with DEMO_MODE=true).
 */
export function DemoPicker({ next }: { next: string }) {
  const t = useTranslations('demo.picker');
  const tr = useTranslations('access.roles');
  const ti = useTranslations('industries');
  const router = useRouter();
  const [orgs, setOrgs] = useState<DemoOrg[] | null>(null);
  const [failed, setFailed] = useState(false);
  const [busy, setBusy] = useState<string | null>(null);

  useEffect(() => {
    demoAccounts().then(setOrgs, () => setFailed(true));
  }, []);

  const roleName = (r: { role: string; roleName: string }) => (r.role !== 'custom' && tr.has(`${r.role}.name`) ? tr(`${r.role}.name`) : r.roleName);
  const industry = (v: string): IndustryKey => ((APP_INDUSTRIES as readonly string[]).includes(v) ? (v as IndustryKey) : 'studios');

  return (
    <section aria-labelledby="demo-picker-title" className="flex flex-col gap-3 rounded-lg border border-line-soft p-4" data-testid="demo-picker">
      <div>
        <h2 id="demo-picker-title" className="text-base font-bold">{t('title')}</h2>
        <p className="text-sm text-stone">{t('body')}</p>
      </div>
      {failed && <p role="alert" className="text-sm text-danger">{t('failed')}</p>}
      {!orgs && !failed && <p className="text-sm text-stone" role="status">{t('loading')}</p>}
      {orgs?.map((o) => (
        <details key={o.id} className="rounded-md bg-canvas p-2.5" open={o.accounts.length > 6}>
          <summary className="flex cursor-pointer list-none items-center gap-2.5 text-sm font-bold">
            <span className="flex h-8 w-8 shrink-0 items-center justify-center rounded-[10px]" style={{ background: INDUSTRY_UI[industry(o.industry)].pastel }}>
              <Icon name={INDUSTRY_UI[industry(o.industry)].icon} size={15} />
            </span>
            <span className="min-w-0 flex-1">
              <span className="block truncate">{o.name}</span>
              <span className="block text-xs font-medium text-stone">{t('accounts', { industry: ti(`${industry(o.industry)}.name`), count: o.accounts.length })}</span>
            </span>
            <Icon name="chevron-down" size={14} />
          </summary>
          <ul className="mt-2 flex flex-col gap-1">
            {o.accounts.map((a) => (
              <li key={a.email}>
                <button
                  type="button"
                  disabled={!!busy}
                  data-testid={`demo-login-${a.email}`}
                  onClick={async () => {
                    setBusy(a.email);
                    try {
                      await signInAsDemo(a.email);
                      router.push(next);
                    } catch {
                      setFailed(true);
                      setBusy(null);
                    }
                  }}
                  className="flex w-full items-center gap-3 rounded-md bg-surface px-3 py-2 text-left hover:bg-line-soft disabled:opacity-60"
                >
                  <span className="min-w-0 flex-1">
                    <span className="block truncate text-sm font-bold">{a.name}</span>
                    <span className="block truncate text-xs text-stone">{a.roles.map((r) => (r.scope ? `${roleName(r)} · ${r.scope}` : roleName(r))).join(', ')}</span>
                  </span>
                  <span className="shrink-0 text-xs font-bold underline">{busy === a.email ? t('signingIn') : t('signIn')}</span>
                </button>
              </li>
            ))}
          </ul>
        </details>
      ))}
    </section>
  );
}
