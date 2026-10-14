'use client';

import { useEffect, useState } from 'react';
import { useLocale, useTranslations } from 'next-intl';
import { Icon } from '@bh/ui';
import { CardPayment } from '@/components/forms';
import { sleep } from '@/lib/client';
import { dateTime, money } from '@/lib/format';
import { getSession, pcall } from '@/lib/portal';
import { SignIn, useStudioSession } from './Account';

type Money = { amount: number; currency: string };
type Payment = { id: string; sandbox: boolean; amount: number; currency: string };

/** Buy a pack / membership / intro offer. Prices come from the server in the location currency. */
export function BuyButton({ brand, locationId, kind, productId, offerId, label, accountPath, disabled }: { brand: string; locationId: string; kind: 'pack' | 'membership' | 'offer' | 'online'; productId?: string; offerId?: string; label: string; accountPath: string; disabled?: boolean }) {
  const t = useTranslations('studio');
  const locale = useLocale();
  const [state, setState] = useState<{ phase: 'idle' | 'signin' | 'pay' | 'done' | 'busy'; payment?: Payment; purchaseId?: string; error?: string }>({ phase: 'idle' });
  if (state.phase === 'done') return <p role="status" className="flex items-center gap-1.5 font-bold text-success"><Icon name="check-circle" size={18} />{t('purchased')} <a className="link" href={accountPath}>{t('viewAccount')}</a></p>;
  if (state.phase === 'signin') return <SignIn brand={brand} locationId={locationId} returnPath={typeof window !== 'undefined' ? window.location.pathname : accountPath} compact />;
  if (state.phase === 'pay' && state.payment) return (
    <div className="space-y-2">
      <CardPayment payment={state.payment} label={t('payAmount', { amount: money(state.payment, locale) })} onDone={async (r) => {
        if (!r.ok) { setState({ ...state, error: r.message ?? t('payFailed') }); return; }
        for (let i = 0; i < 12; i++) {
          const s = await pcall<{ status: string }>(brand, 'GET', `/public/studios/account/purchases/${state.purchaseId}`);
          if (s.ok && s.data.status === 'paid') { setState({ phase: 'done' }); return; }
          await sleep(800);
        }
        setState({ ...state, error: t('paymentPending') });
      }} />
      {state.error && <p role="alert" className="text-sm font-semibold text-danger">{state.error}</p>}
    </div>
  );
  return (
    <div className="space-y-1">
      <button type="button" className="btn btn-primary w-full sm:w-auto" disabled={disabled || state.phase === 'busy'} onClick={async () => {
        if (!getSession(brand)) { setState({ phase: 'signin' }); return; }
        setState({ phase: 'busy' });
        const r = await pcall<{ purchase: { id: string; status: string }; payment: Payment | null }>(brand, 'POST', '/public/studios/account/purchases', { locationId, kind, productId, offerId });
        if (!r.ok) { setState({ phase: r.status === 401 ? 'signin' : 'idle', error: r.error.message }); return; }
        if (!r.data.payment) setState({ phase: 'done' });
        else setState({ phase: 'pay', payment: r.data.payment, purchaseId: r.data.purchase.id });
      }}>{label}</button>
      {state.error && <p role="alert" className="text-sm font-semibold text-danger">{state.error}</p>}
    </div>
  );
}

interface Options {
  signedIn: boolean; price: Money; payOnline: boolean; creditCost: number | null; outstandingFees: number;
  credits: Array<{ id: string; name: string; creditsRemaining: number; creditsNeeded: number; expiresAt: string | null; usable: boolean; reason: string | null }>;
  memberships: Array<{ id: string; name: string; usable: boolean; reason: string | null; usage: { used: number; limit: number | null } | null }>;
  policy: { lines: string[] };
  recommended: { kind: 'pay' | 'credit' | 'membership'; packId?: string; membershipId?: string };
}

/** On the class page: the cancellation policy (always), and — when signed in — booking with a membership or pack credit. */
export function MemberBooking({ brand, occurrenceId, locationId, full, accountPath, manageBase, timeZone }: { brand: string; occurrenceId: string; locationId: string; full: boolean; accountPath: string; manageBase: string; timeZone: string }) {
  const t = useTranslations('studio');
  const locale = useLocale();
  const { session } = useStudioSession(brand);
  const [opts, setOpts] = useState<Options | null>(null);
  const [choice, setChoice] = useState<string>('');
  const [result, setResult] = useState<{ ok: boolean; text: string; href?: string } | null>(null);
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    if (session === undefined) return;
    void pcall<Options>(brand, 'GET', `/public/studios/account/occurrences/${occurrenceId}/options`).then((r) => {
      if (!r.ok) return;
      setOpts(r.data);
      const rec = r.data.recommended;
      setChoice(rec.kind === 'membership' ? `membership:${rec.membershipId}` : rec.kind === 'credit' ? `credit:${rec.packId}` : '');
    });
  }, [brand, occurrenceId, session]);
  if (!opts) return null;
  const usable = [...opts.memberships.filter((m) => m.usable), ...opts.credits.filter((c) => c.usable)];
  return (
    <section className="card mt-5 space-y-3 p-5" aria-labelledby="policy-h">
      <h2 id="policy-h" className="text-lg font-extrabold">{t('policyTitle')}</h2>
      <ul className="list-disc space-y-1 ps-5 text-sm text-graphite">{opts.policy.lines.map((l) => <li key={l}>{l}</li>)}</ul>
      {!session ? (
        <p className="text-sm">{t('memberPrompt')} <a className="link font-semibold" href={accountPath}>{t('signInToBook')}</a></p>
      ) : result ? (
        <p role={result.ok ? 'status' : 'alert'} className={`rounded-2xl p-4 text-sm ${result.ok ? 'bg-success-bg text-success' : 'bg-danger-bg text-danger'}`}>{result.text} {result.href && <a className="link font-semibold" href={result.href}>{t('viewAccount')}</a>}</p>
      ) : (
        <div className="space-y-2">
          <h3 className="font-bold">{t('bookWith')}</h3>
          {opts.outstandingFees > 0 && <p className="text-sm text-warning">{t('feesOutstanding', { n: opts.outstandingFees })}</p>}
          {[...opts.memberships.map((m) => ({ key: `membership:${m.id}`, label: `${m.name}${m.usage?.limit ? ` · ${t('usage', { used: m.usage.used, limit: m.usage.limit })}` : ''}`, usable: m.usable, reason: m.reason })),
            ...opts.credits.map((c) => ({ key: `credit:${c.id}`, label: `${c.name} · ${t('creditsNeeded', { n: c.creditsNeeded, left: c.creditsRemaining })}${c.expiresAt ? ` · ${t('expires', { date: dateTime(c.expiresAt, timeZone, locale) })}` : ''}`, usable: c.usable, reason: c.reason }))].map((o) => (
            <label key={o.key} className={`flex items-start gap-3 text-sm ${o.usable ? '' : 'opacity-60'}`}>
              <input type="radio" name="paywith" className="mt-1 size-5 accent-[var(--site-brand)]" disabled={!o.usable} checked={choice === o.key} onChange={() => setChoice(o.key)} />
              <span>{o.label}{!o.usable && o.reason && <span className="block text-xs font-semibold text-graphite">{t('notUsable', { reason: o.reason })}</span>}</span>
            </label>
          ))}
          {usable.length === 0 && <p className="text-sm text-graphite">{t('nothingUsable')}</p>}
          {usable.length > 0 && (
            <button type="button" className="btn btn-primary" disabled={busy || !choice} onClick={async () => {
              setBusy(true);
              const [kind, id] = choice.split(':') as ['credit' | 'membership', string];
              const r = await pcall<{ outcome: string; bookingId?: string; position?: number; manageToken?: string }>(brand, 'POST', `/public/studios/account/occurrences/${occurrenceId}/bookings`, { payWith: kind === 'credit' ? { kind, packId: id } : { kind, membershipId: id }, joinWaitlist: full });
              setBusy(false);
              if (!r.ok) { setResult({ ok: false, text: r.error.code === 'duplicate_booking' ? t('duplicate') : r.error.message }); return; }
              setResult(r.data.outcome === 'waitlisted' ? { ok: true, text: t('waitlistedN', { n: r.data.position ?? 1 }), href: accountPath } : { ok: true, text: t('bookedWith'), href: r.data.bookingId && r.data.manageToken ? `${manageBase}/booking/${r.data.bookingId}?token=${encodeURIComponent(r.data.manageToken)}` : accountPath });
            }}>{full ? t('joinWaitlist') : t('bookNow')}</button>
          )}
        </div>
      )}
    </section>
  );
}

interface OnlineItem { id: string; kind: 'livestream' | 'on_demand'; title: string; description: string | null; instructorName: string | null; startsAt: string | null; durationMinutes: number | null; provider: string; rules: string[]; price: Money | null; access?: { access: boolean; registered: boolean; needsRegistration: boolean; canJoin: boolean; reasons: string[]; purchasable: Money | null } }

/** Online library: anyone can browse; join links are fetched only on demand for entitled (and registered) customers. */
export function OnlineLibrary({ brand, locationId, timeZone, accountPath, publicItems }: { brand: string; locationId: string; timeZone: string; accountPath: string; publicItems: OnlineItem[] }) {
  const t = useTranslations('studio');
  const locale = useLocale();
  const { session } = useStudioSession(brand);
  const [items, setItems] = useState<OnlineItem[]>(publicItems);
  const [msg, setMsg] = useState<Record<string, { ok: boolean; text: string; url?: string }>>({});
  const load = async () => { const r = await pcall<{ items: OnlineItem[] }>(brand, 'GET', `/public/studios/account/online?locationId=${locationId}`); if (r.ok) setItems(r.data.items); };
  useEffect(() => { if (session) void load(); }, [session]); // eslint-disable-line react-hooks/exhaustive-deps
  return (
    <div className="space-y-3">
      {!session && <p className="card p-4 text-sm">{t('onlineSignIn')} <a className="link font-semibold" href={accountPath}>{t('signIn')}</a></p>}
      {items.length === 0 && <p className="card p-6 text-center text-graphite">{t('noOnline')}</p>}
      {items.map((c) => (
        <article key={c.id} className="card space-y-2 p-5">
          <div className="flex flex-wrap items-center gap-2">
            <Icon name={c.kind === 'livestream' ? 'video' : 'play'} size={18} />
            <h2 className="font-extrabold">{c.title}</h2>
            <span className="rounded-full bg-canvas px-2 py-0.5 text-xs font-bold">{c.kind === 'livestream' ? t('live') : t('recording')}</span>
          </div>
          <p className="text-sm text-graphite">{[c.instructorName, c.startsAt ? dateTime(c.startsAt, timeZone, locale) : null, c.durationMinutes ? t('minutes', { n: c.durationMinutes }) : null].filter(Boolean).join(' · ')}</p>
          {c.description && <p className="text-sm">{c.description}</p>}
          <p className="text-xs text-graphite">{c.rules.join(' · ')}{c.price ? ` · ${money(c.price, locale)}` : ''}</p>
          {session && c.access && (
            <div className="flex flex-wrap items-center gap-2">
              {c.access.access ? (
                c.access.needsRegistration && !c.access.registered ? (
                  <button type="button" className="btn btn-primary" onClick={async () => { const r = await pcall(brand, 'POST', `/public/studios/account/online/${c.id}/register`, { locationId }); setMsg({ ...msg, [c.id]: r.ok ? { ok: true, text: t('registered') } : { ok: false, text: r.error.message } }); await load(); }}>{t('register')}</button>
                ) : (
                  <button type="button" className="btn btn-primary" onClick={async () => { const r = await pcall<{ url: string }>(brand, 'POST', `/public/studios/account/online/${c.id}/join`, { locationId }); setMsg({ ...msg, [c.id]: r.ok ? { ok: true, text: t('linkReady'), url: r.data.url } : { ok: false, text: r.error.message } }); }}>{c.kind === 'livestream' ? t('getJoinLink') : t('watch')}</button>
                )
              ) : c.access.purchasable ? (
                <BuyButton brand={brand} locationId={locationId} kind="online" productId={c.id} label={t('buyFor', { amount: money(c.access.purchasable, locale) })} accountPath={accountPath} />
              ) : <p className="text-sm text-graphite">{c.access.reasons.join(' · ')}</p>}
              {c.access.registered && <span className="text-xs font-bold text-success">✓ {t('registered')}</span>}
            </div>
          )}
          {msg[c.id] && <p role={msg[c.id]!.ok ? 'status' : 'alert'} className={`text-sm ${msg[c.id]!.ok ? 'text-success' : 'text-danger'}`}>{msg[c.id]!.text} {msg[c.id]!.url && <a className="link font-bold" href={msg[c.id]!.url} target="_blank" rel="noopener noreferrer">{t('openLink')}</a>}</p>}
        </article>
      ))}
    </div>
  );
}
