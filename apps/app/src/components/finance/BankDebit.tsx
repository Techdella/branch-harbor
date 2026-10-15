'use client';

import { useState } from 'react';
import { useLocale, useTranslations } from 'next-intl';
import { Badge, Button, Icon, cx } from '@bh/ui';
import { http } from '@/lib/http/client';
import { orgId } from '@/lib/http/workspace';
import { Async, Banner, Empty, LoadingBlock, SectionCard } from '../ui/States';
import { financeApi, useFinance, useFinanceAction, type PaymentMethodVM } from './api';
import { ActionError, SandboxNote } from './FinanceUi';

type Method = PaymentMethodVM & { mandateId?: string | null; verificationUrl?: string | null; failureReason?: string | null };
interface MethodsVM { mode: 'live' | 'sandbox'; collectionCountry: string | null; ownerGroups: Array<{ id: string; name: string; currencies: Array<{ currency: string; methodTypes: string[] }> }>; items: Method[] }

const base = (p: string) => `/orgs/${orgId()}/finance${p}`;
const api = {
  methods: () => http.get<MethodsVM>(base('/payment-methods')),
  mandate: (ownerGroupId: string, currency: string, methodType: string) => http.get<{ mandateText: string; methodTypes: string[] }>(base('/payment-methods/mandate'), { ownerGroupId, currency, methodType }),
  setup: (body: { ownerGroupId: string; currency: string; methodType: string; acceptMandate: boolean; mandateText: string; locale: string }) => http.post<{ id: string; mode: string; mandateText: string }>(base('/payment-methods/setup'), body),
};

/**
 * Debit authorisation for royalty collection: the franchisee chooses card or the local bank debit (ACH, Canadian
 * PAD, Bacs, SEPA or BECS — offered by currency and HQ's collection-account country), reads the exact mandate text,
 * accepts it (the server stores that text verbatim) and confirms the method. Bank debits settle days later.
 */
export function BankDebitAuthorisation() {
  const t = useTranslations('royaltyDebit');
  const res = useFinance(() => api.methods(), []);
  return (
    <Async res={res} loading={<LoadingBlock variant="detail" />} isEmpty={(d) => d.ownerGroups.length === 0} empty={<Empty icon="card" title={t('noGroups')} />}>
      {(d) => (
        <div className="flex flex-col gap-4" data-testid="bank-debit">
          <p className="text-sm text-stone">{t('intro')}</p>
          {d.mode === 'sandbox' && <SandboxNote />}
          {d.ownerGroups.flatMap((g) => g.currencies.map((c) => (
            <GroupCurrency key={`${g.id}:${c.currency}`} group={g} currency={c.currency} methodTypes={c.methodTypes} items={d.items.filter((m) => m.ownerGroupId === g.id && m.currency === c.currency)} sandbox={d.mode === 'sandbox'} onChanged={res.reload} />
          )))}
        </div>
      )}
    </Async>
  );
}

function GroupCurrency({ group, currency, methodTypes, items, sandbox, onChanged }: { group: { id: string; name: string }; currency: string; methodTypes: string[]; items: Method[]; sandbox: boolean; onChanged: () => void }) {
  const t = useTranslations('royaltyDebit');
  const locale = useLocale();
  const bank = methodTypes.find((m) => m !== 'card') ?? null;
  const [type, setType] = useState<string>(bank ?? 'card');
  const [accepted, setAccepted] = useState(false);
  const [msg, setMsg] = useState<string | null>(null);
  const mandate = useFinance(() => api.mandate(group.id, currency, type), [group.id, currency, type]);
  const active = items.find((m) => m.status === 'active');
  const waiting = items.find((m) => m.status === 'pending' || m.status === 'verifying');
  const act = useFinanceAction(async (fn: () => Promise<unknown>, message: string) => { await fn(); setMsg(message); setAccepted(false); onChanged(); });
  return (
    <SectionCard title={`${group.name} · ${currency}`} aside={active ? <Badge tone="success">{t('active')}</Badge> : <Badge tone="warning">{t('none')}</Badge>}>
      {active && (
        <div className="mb-4 flex flex-wrap items-center gap-3 rounded-lg bg-canvas p-3 text-sm">
          <Icon name={active.methodType === 'card' ? 'card' : 'building'} size={18} />
          <span><strong>{t(`type.${active.methodType}`)}</strong>{active.display.bankName ? ` · ${active.display.bankName}` : ''} · {t('ending', { last4: active.display.last4 ?? '••••' })}</span>
          <Button size="sm" variant="ghost" loading={act.pending} onClick={() => void act.run(() => financeApi.revokeMethod(active.id), t('revoked'))}>{t('revoke')}</Button>
        </div>
      )}
      {waiting ? (
        <div className="flex flex-col gap-3 text-sm">
          <Banner tone="info" title={t(waiting.status === 'verifying' ? 'verifyingTitle' : 'pendingTitle', { method: t(`type.${waiting.methodType}`) })}>
            {waiting.status === 'verifying' ? t('verifyingBody') : t('pendingBody')}
          </Banner>
          {waiting.verificationUrl && <a className="font-semibold underline" href={waiting.verificationUrl} target="_blank" rel="noreferrer">{t('verifyLink')}</a>}
          <details className="rounded-lg bg-canvas p-3"><summary className="cursor-pointer font-semibold">{t('mandateAccepted')}</summary><p className="mt-2 whitespace-pre-line text-xs">{waiting.mandateText}</p></details>
          <div className="flex flex-wrap gap-2">
            {sandbox ? (
              <>
                <Button size="sm" loading={act.pending} onClick={() => void act.run(() => financeApi.sandboxConfirmMethod(waiting.id, 'ok'), t('confirmed'))} data-testid="sandbox-confirm-method">{t('sandboxConfirm')}</Button>
                <Button size="sm" variant="ghost" loading={act.pending} onClick={() => void act.run(() => financeApi.sandboxConfirmMethod(waiting.id, 'decline'), t('confirmed'))}>{t('sandboxDecline')}</Button>
              </>
            ) : <Button size="sm" variant="secondary" icon="refresh" loading={act.pending} onClick={() => void act.run(() => financeApi.refreshMethod(waiting.id), t('checked'))}>{t('check')}</Button>}
          </div>
        </div>
      ) : (
        <div className="flex flex-col gap-3">
          <fieldset>
            <legend className="mb-2 text-sm font-semibold">{t('choose')}</legend>
            <div className="grid gap-2 sm:grid-cols-2">
              {methodTypes.map((m) => (
                <label key={m} className={cx('flex cursor-pointer gap-3 rounded-lg border-[1.5px] p-3', type === m ? 'border-ink bg-canvas' : 'border-line-soft')}>
                  <input type="radio" name={`m-${group.id}-${currency}`} className="mt-1" checked={type === m} onChange={() => { setType(m); setAccepted(false); }} />
                  <span className="text-sm">
                    <span className="flex items-center gap-2 font-bold"><Icon name={m === 'card' ? 'card' : 'building'} size={16} />{t(`type.${m}`)}{m !== 'card' && <Badge tone="success">{t('recommended')}</Badge>}</span>
                    <span className="mt-1 block text-xs text-stone">{t(`about.${m}`)}</span>
                  </span>
                </label>
              ))}
            </div>
            {!bank && <p className="mt-2 text-xs text-stone">{t('noBankDebit', { currency })}</p>}
          </fieldset>
          <div>
            <div className="mb-1 text-sm font-semibold">{t('mandateTitle')}</div>
            <Async res={mandate} loading={<LoadingBlock variant="detail" rows={2} />}>
              {(md) => <p className="max-h-48 overflow-y-auto whitespace-pre-line rounded-lg bg-canvas p-3 text-xs leading-relaxed" data-testid="mandate-text">{md.mandateText}</p>}
            </Async>
          </div>
          <label className="flex items-start gap-2 text-sm">
            <input type="checkbox" className="mt-1" checked={accepted} onChange={(e) => setAccepted(e.target.checked)} data-testid="accept-mandate" />
            <span>{t('accept', { group: group.name })}</span>
          </label>
          <div>
            <Button icon={type === 'card' ? 'card' : 'building'} loading={act.pending} disabled={!accepted || !mandate.data} data-testid="setup-method"
              onClick={() => void act.run(() => api.setup({ ownerGroupId: group.id, currency, methodType: type, acceptMandate: true, mandateText: mandate.data!.mandateText, locale }), t('started'))}>
              {active ? t('replace') : t('authorise')}
            </Button>
          </div>
          <p className="text-xs text-stone">{t('settleNote')}</p>
        </div>
      )}
      <ActionError error={act.error} />
      {msg && <div className="mt-3"><Banner tone="success" live="polite">{msg}</Banner></div>}
    </SectionCard>
  );
}
