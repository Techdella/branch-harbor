'use client';

import { useCallback, useEffect, useState } from 'react';
import { useLocale, useTranslations } from 'next-intl';
import { Icon } from '@bh/ui';
import { call } from '@/lib/client';
import { calendarLabel, dateTime, money, zone } from '@/lib/format';
import { EMAIL_RE, ErrorSummary, Field, CardPayment, type PaymentInfo } from '@/components/forms';
import { SavedCard, type CardOnFile, type SetupStart } from '@/components/payments/SavedCard';

type Money = { amount: number; currency: string };
interface Instalment { id: string; seq: number; dueOn: string; amount: Money; status: string; state: string; paymentState: string | null }
interface Reg { id: string; status: string; programme: { id: string; name: string; refundPolicy: string | null; requiresApproval: boolean }; location: { id: string; name: string; timeZone: string }; team: { id: string; name: string } | null; paymentPlan: string; balance: { currency: string | null; paid: number; outstanding: number; overdue: number; state: string }; instalments: Instalment[]; forms: { complete: boolean } }
interface Participant { id: string; name: string; dateOfBirth: string | null; otherGuardians: { relationshipId: string; name: string; relationship: string; status: string }[]; registrations: Reg[] }
interface Session { id: string; kind: string; status: string; startsAt: string; endsAt: string; venue: string | null; opponent: string | null; homeAway: string | null; cancelReason: string | null; team: { id: string; name: string }; location: { id: string; name: string; timeZone: string }; participants: { id: string; name: string; attendance: { status: string; reason: string | null; reportedBy: string } | null }[] }
interface Overview { guardian: { name: string; email: string | null }; participants: Participant[]; schedule: Session[]; balances: { currency: string; outstanding: number; overdue: number; paid: number }[]; notifications: { id: string; subject: string; body: string; createdAt: string; kind: string }[]; pendingRelationships: number; locations: { id: string; name: string }[] }
interface Msg { id: string; locationId: string; locationName: string; direction: string; body: string; createdAt: string }

const KEY = 'bh_sports_portal';
const REASONS = ['illness', 'injury', 'family', 'school', 'travel', 'other'] as const;

/** Guardian portal on the customer website. The session token lives in sessionStorage and is sent in request bodies. */
export function GuardianPortal({ locationId, brandName, programmesHref }: { locationId: string; brandName: string; programmesHref: string }) {
  const t = useTranslations('portal');
  const [token, setToken] = useState<string | null>(null);
  const [phase, setPhase] = useState<'init' | 'login' | 'ready'>('init');
  const [error, setError] = useState<string | null>(null);
  const [invite, setInvite] = useState<string | null>(null);

  useEffect(() => {
    const q = new URLSearchParams(window.location.search);
    const link = q.get('token');
    const inv = q.get('invite');
    let stored: string | null = null;
    try { stored = sessionStorage.getItem(KEY); } catch { /* storage blocked */ }
    if (link) {
      void (async () => {
        const r = await call<{ portalToken: string }>('POST', '/public/sports/portal/session', { token: link });
        window.history.replaceState(null, '', window.location.pathname);
        if (r.ok) { save(r.data.portalToken); } else { setError(r.error.message); setPhase('login'); }
      })();
    } else if (inv) {
      setInvite(inv);
      setPhase('login');
    } else if (stored) {
      setToken(stored);
      setPhase('ready');
    } else setPhase('login');
  }, []);

  const save = (tk: string) => {
    try { sessionStorage.setItem(KEY, tk); } catch { /* storage blocked: this tab only */ }
    setToken(tk);
    setPhase('ready');
  };
  const signOut = () => { try { sessionStorage.removeItem(KEY); } catch { /* ignore */ } setToken(null); setPhase('login'); };

  if (phase === 'init') return <p role="status">{t('loading')}</p>;
  if (phase === 'login' || !token) return <Login locationId={locationId} brandName={brandName} invite={invite} initialError={error} onSession={save} />;
  return <Dashboard locationId={locationId} token={token} programmesHref={programmesHref} onExpired={signOut} />;
}

function Login({ locationId, brandName, invite, initialError, onSession }: { locationId: string; brandName: string; invite: string | null; initialError: string | null; onSession: (t: string) => void }) {
  const t = useTranslations('portal');
  const tc = useTranslations('common');
  const [email, setEmail] = useState('');
  const [name, setName] = useState('');
  const [sent, setSent] = useState<{ dev?: string } | null>(null);
  const [error, setError] = useState<string | null>(initialError);
  const [busy, setBusy] = useState(false);
  if (invite) {
    return (
      <section className="card mx-auto max-w-lg space-y-4 p-6">
        <h1 className="text-2xl font-extrabold">{t('inviteTitle')}</h1>
        <p className="text-graphite">{t('inviteBody', { brand: brandName })}</p>
        <ErrorSummary message={error} />
        <Field label={t('yourName')} value={name} onChange={(e) => setName(e.target.value)} autoComplete="name" />
        <button type="button" className="btn btn-primary" disabled={busy} onClick={async () => {
          setBusy(true);
          const r = await call<{ portalToken: string }>('POST', '/public/sports/invitations/accept', { token: invite, ...(name.trim() ? { name: name.trim() } : {}) });
          setBusy(false);
          window.history.replaceState(null, '', window.location.pathname);
          if (r.ok) onSession(r.data.portalToken); else setError(r.error.message);
        }}>{t('acceptInvite')}</button>
      </section>
    );
  }
  return (
    <section className="card mx-auto max-w-lg space-y-4 p-6">
      <h1 className="text-2xl font-extrabold">{t('title')}</h1>
      <p className="text-graphite">{t('loginBody', { brand: brandName })}</p>
      <ErrorSummary message={error} />
      {sent ? (
        <div role="status" className="rounded-2xl bg-success-bg p-4 text-sm">
          <p className="font-bold text-success">{t('linkSent')}</p>
          <p>{t('linkSentBody')}</p>
          {sent.dev && <button type="button" className="mt-2 font-bold underline" onClick={async () => { const r = await call<{ portalToken: string }>('POST', '/public/sports/portal/session', { token: sent.dev }); if (r.ok) onSession(r.data.portalToken); else setError(r.error.message); }}>{t('devLink')}</button>}
        </div>
      ) : (
        <form noValidate className="space-y-3" onSubmit={async (e) => {
          e.preventDefault();
          if (!EMAIL_RE.test(email)) { setError(tc('invalidEmail')); return; }
          setBusy(true); setError(null);
          const r = await call<{ sent: boolean; devLinkToken?: string }>('POST', '/public/sports/portal/request-link', { locationId, email: email.trim() });
          setBusy(false);
          if (r.ok) setSent({ dev: r.data.devLinkToken }); else setError(r.error.message);
        }}>
          <Field label={t('email')} type="email" autoComplete="email" value={email} onChange={(e) => setEmail(e.target.value)} />
          <button type="submit" className="btn btn-primary" disabled={busy} aria-busy={busy}>{t('sendLink')}</button>
        </form>
      )}
      <p className="text-xs text-graphite">{t('privacyNote')}</p>
    </section>
  );
}

function Dashboard({ token, programmesHref, onExpired, locationId }: { token: string; programmesHref: string; onExpired: () => void; locationId: string }) {
  const t = useTranslations('portal');
  const locale = useLocale();
  const [data, setData] = useState<Overview | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [msg, setMsg] = useState<string | null>(null);
  const [tab, setTab] = useState<'schedule' | 'balances' | 'participants' | 'messages'>('schedule');
  const [paying, setPaying] = useState<PaymentInfo | null>(null);
  const load = useCallback(async () => {
    const r = await call<Overview>('POST', '/public/sports/portal/overview', { portalToken: token });
    if (r.ok) setData(r.data);
    else if (r.status === 401) onExpired();
    else setError(r.error.message);
  }, [token, onExpired]);
  useEffect(() => { void load(); }, [load]);
  if (!data) return error ? <ErrorSummary message={error} /> : <p role="status">{t('loading')}</p>;
  const m = (x: Money) => money({ amount: x.amount, currency: x.currency as 'CAD' }, locale);
  const day = (d: string) => calendarLabel(d, locale, { day: 'numeric', month: 'short', year: 'numeric' });

  return (
    <div className="space-y-5">
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div><h1 className="text-3xl font-extrabold tracking-tight">{t('hello', { name: data.guardian.name })}</h1><p className="text-graphite">{t('subtitle')}</p></div>
        <button type="button" className="btn btn-secondary" onClick={onExpired}>{t('signOut')}</button>
      </div>
      {msg && <p role="status" className="rounded-2xl bg-success-bg p-3 text-sm font-semibold text-success">{msg}</p>}
      <ErrorSummary message={error} />
      {data.pendingRelationships > 0 && <p className="rounded-2xl bg-warning-bg p-3 text-sm text-warning">{t('pendingRelationships', { n: data.pendingRelationships })}</p>}
      {data.balances.length > 0 && (
        <div className="grid gap-3 sm:grid-cols-2">
          {data.balances.map((b) => (
            <div key={b.currency} className="card p-4">
              <p className="text-sm text-graphite">{t('balanceIn', { currency: b.currency })}</p>
              <p className="text-2xl font-extrabold">{m({ amount: b.outstanding, currency: b.currency })}</p>
              {b.overdue > 0 && <p className="text-sm font-bold text-danger"><Icon name="alert" size={14} className="mr-1 inline" />{t('overdue', { amount: m({ amount: b.overdue, currency: b.currency }) })}</p>}
            </div>
          ))}
        </div>
      )}
      <div role="tablist" aria-label={t('sections')} className="flex flex-wrap gap-1.5">
        {(['schedule', 'balances', 'participants', 'messages'] as const).map((k) => (
          <button key={k} role="tab" type="button" aria-selected={tab === k} onClick={() => setTab(k)} className={`h-10 rounded-full px-4 text-sm font-bold ${tab === k ? 'bg-ink text-white' : 'bg-canvas'}`}>{t(`tab.${k}`)}</button>
        ))}
      </div>
      {data.participants.length === 0 && (
        <div className="card p-6"><p className="font-bold">{t('noParticipants')}</p><p className="mt-1 text-sm text-graphite">{t('noParticipantsBody')}</p><a href={programmesHref} className="btn btn-primary mt-3 inline-flex">{t('browse')}</a></div>
      )}
      {tab === 'schedule' && <Schedule data={data} token={token} onDone={(x) => { setMsg(x); void load(); }} />}
      {tab === 'balances' && (
        <section className="space-y-3">
          <SavedCard
            load={() => call<CardOnFile>('POST', '/public/sports/portal/payment-method', { portalToken: token, locationId })}
            start={(text, loc) => call<SetupStart>('POST', '/public/sports/portal/payment-method/setup', { portalToken: token, locationId, purposes: ['instalments'], text, locale: loc })}
          />
          {paying && <div className="card space-y-2 p-4"><p className="font-bold">{t('payNow')}</p><CardPayment payment={paying} label={t('payAmount', { amount: m({ amount: paying.amount ?? 0, currency: paying.currency ?? 'CAD' }) })} onDone={(r) => { setPaying(null); setMsg(r.ok ? t('paid') : r.message ?? t('payFailed')); void load(); }} /></div>}
          {data.participants.flatMap((p) => p.registrations.filter((r) => r.instalments.length).map((r) => (
            <article key={r.id} className="card p-4">
              <div className="flex flex-wrap justify-between gap-2"><h3 className="font-bold">{p.name} · {r.programme.name}</h3><span className="text-sm font-semibold">{t(`state.${r.balance.state}`)}</span></div>
              <ul className="mt-2 divide-y divide-line-soft text-sm">
                {r.instalments.map((i) => (
                  <li key={i.id} className="flex flex-wrap items-center justify-between gap-2 py-2">
                    <span>{t('instalment', { seq: i.seq, date: day(i.dueOn) })} · <strong>{m(i.amount)}</strong></span>
                    <span className="flex items-center gap-2">
                      <span className={i.state === 'overdue' ? 'font-bold text-danger' : i.state === 'paid' ? 'text-success' : 'text-graphite'}>{t(`inst.${i.state}`)}</span>
                      {i.status === 'scheduled' && i.amount.amount > 0 && r.status !== 'waitlisted' && <button type="button" className="btn btn-primary !min-h-9 !px-3 text-xs" onClick={async () => { const x = await call<{ payment: PaymentInfo }>('POST', `/public/sports/portal/instalments/${i.id}/pay`, { portalToken: token }); if (x.ok) setPaying(x.data.payment); else setError(x.error.message); }}>{t('pay')}</button>}
                    </span>
                  </li>
                ))}
              </ul>
              {r.programme.refundPolicy && <p className="mt-2 text-xs text-graphite">{t('policy')}: {r.programme.refundPolicy}</p>}
            </article>
          )))}
        </section>
      )}
      {tab === 'participants' && <Participants data={data} token={token} onDone={(x) => { setMsg(x); void load(); }} onError={setError} />}
      {tab === 'messages' && <Messages data={data} token={token} />}
      {data.notifications.length > 0 && (
        <section className="card p-4">
          <h2 className="font-bold">{t('updates')}</h2>
          <ul className="mt-2 divide-y divide-line-soft text-sm">{data.notifications.slice(0, 8).map((n) => <li key={n.id} className="py-2"><p className="font-semibold">{n.subject}</p><p className="text-graphite">{n.body}</p><p className="text-xs text-graphite">{dateTime(n.createdAt, 'UTC', locale)} UTC</p></li>)}</ul>
        </section>
      )}
    </div>
  );
}

function Schedule({ data, token, onDone }: { data: Overview; token: string; onDone: (m: string) => void }) {
  const t = useTranslations('portal');
  const locale = useLocale();
  const [absence, setAbsence] = useState<{ sessionId: string; participantId: string } | null>(null);
  const [reason, setReason] = useState<string>('illness');
  const [note, setNote] = useState('');
  const [err, setErr] = useState<string | null>(null);
  const upcoming = data.schedule.filter((s) => Date.parse(s.endsAt) > Date.now());
  if (!upcoming.length) return <p className="text-graphite">{t('noSessions')}</p>;
  return (
    <ul className="space-y-2">
      {upcoming.map((s) => (
        <li key={s.id} className={`card p-4 ${s.status === 'cancelled' ? 'opacity-70' : ''}`}>
          <div className="flex flex-wrap items-start justify-between gap-2">
            <div>
              <p className="font-bold"><Icon name={s.kind === 'fixture' ? 'trophy' : 'calendar'} size={15} className="mr-1 inline" />{s.team.name}{s.opponent ? ` ${t('vs')} ${s.opponent}` : ''}{s.homeAway ? ` (${t(`ha.${s.homeAway}`)})` : ''}</p>
              <p className="text-sm text-graphite">{dateTime(s.startsAt, s.location.timeZone, locale)} {zone(s.location.timeZone, locale, s.startsAt)} · {s.venue ?? t('venueTbc')} · {s.location.name}</p>
              {s.status === 'cancelled' && <p className="text-sm font-bold text-danger">{t('cancelled')}{s.cancelReason ? `: ${s.cancelReason}` : ''}</p>}
            </div>
          </div>
          <ul className="mt-2 space-y-1 text-sm">
            {s.participants.map((p) => (
              <li key={p.id} className="flex flex-wrap items-center gap-2">
                <span className="font-semibold">{p.name}</span>
                {p.attendance ? <span className="text-graphite">{t('reported', { status: t(`att.${p.attendance.status}`), reason: p.attendance.reason ? t(`reason.${p.attendance.reason}`) : '' })}</span>
                  : s.status !== 'cancelled' && <button type="button" className="text-sm font-bold underline" onClick={() => { setAbsence({ sessionId: s.id, participantId: p.id }); setErr(null); }}>{t('reportAbsence')}</button>}
              </li>
            ))}
          </ul>
          {absence?.sessionId === s.id && (
            <form className="mt-3 space-y-2 rounded-2xl bg-canvas p-3" onSubmit={async (e) => {
              e.preventDefault();
              const r = await call('POST', '/public/sports/portal/absences', { portalToken: token, participantId: absence.participantId, sessionId: s.id, reason, ...(note.trim() ? { note: note.trim() } : {}) });
              if (r.ok) { setAbsence(null); setNote(''); onDone(t('absenceSaved')); } else setErr(r.error.message);
            }}>
              <label htmlFor={`rs-${s.id}`} className="block text-sm font-semibold">{t('reason')}</label>
              <select id={`rs-${s.id}`} className="field" value={reason} onChange={(e) => setReason(e.target.value)}>{REASONS.map((r) => <option key={r} value={r}>{t(`reason.${r}`)}</option>)}</select>
              <Field label={t('note')} optional value={note} onChange={(e) => setNote(e.target.value)} hint={t('noteHint')} />
              {err && <p className="text-sm font-semibold text-danger">{err}</p>}
              <div className="flex gap-2"><button type="submit" className="btn btn-primary">{t('send')}</button><button type="button" className="btn btn-secondary" onClick={() => setAbsence(null)}>{t('cancel')}</button></div>
            </form>
          )}
        </li>
      ))}
    </ul>
  );
}

function Participants({ data, token, onDone, onError }: { data: Overview; token: string; onDone: (m: string) => void; onError: (m: string) => void }) {
  const t = useTranslations('portal');
  const locale = useLocale();
  const [invite, setInvite] = useState<{ pid: string; email: string; name: string } | null>(null);
  const [dispute, setDispute] = useState<{ relId: string; reason: string } | null>(null);
  const [withdraw, setWithdraw] = useState<{ regId: string; reason: string } | null>(null);
  return (
    <div className="space-y-3">
      {data.participants.map((p) => (
        <article key={p.id} className="card space-y-3 p-4">
          <h3 className="text-lg font-bold">{p.name}{p.dateOfBirth && <span className="ml-2 text-sm font-normal text-graphite">{calendarLabel(p.dateOfBirth, locale, { day: 'numeric', month: 'short', year: 'numeric' })}</span>}</h3>
          <ul className="space-y-2 text-sm">
            {p.registrations.map((r) => (
              <li key={r.id} className="rounded-2xl bg-canvas p-3">
                <p className="font-semibold">{r.programme.name} · {r.location.name}</p>
                <p>{t(`reg.${r.status}`)}{r.team ? ` · ${t('group', { name: r.team.name })}` : ''}</p>
                <p className={r.forms.complete ? 'text-success' : 'font-bold text-danger'}>{r.forms.complete ? t('formsComplete') : t('formsMissing')}</p>
                {['submitted', 'awaiting_review', 'accepted', 'waitlisted'].includes(r.status) && (withdraw?.regId === r.id ? (
                  <div className="mt-2 space-y-2">
                    {r.programme.refundPolicy && <p className="text-xs">{t('policy')}: {r.programme.refundPolicy}</p>}
                    <Field label={t('withdrawReason')} value={withdraw.reason} onChange={(e) => setWithdraw({ ...withdraw, reason: e.target.value })} />
                    <button type="button" className="btn btn-secondary" disabled={withdraw.reason.trim().length < 3} onClick={async () => { const x = await call('POST', `/public/sports/portal/registrations/${r.id}/withdraw`, { portalToken: token, reason: withdraw.reason }); setWithdraw(null); if (x.ok) onDone(t('withdrawn')); else onError(x.error.message); }}>{t('confirmWithdraw')}</button>
                  </div>
                ) : <button type="button" className="mt-1 text-xs font-bold underline" onClick={() => setWithdraw({ regId: r.id, reason: '' })}>{t('withdraw')}</button>)}
              </li>
            ))}
          </ul>
          <div>
            <p className="text-sm font-semibold">{t('otherGuardians')}</p>
            {p.otherGuardians.length === 0 ? <p className="text-sm text-graphite">{t('noOtherGuardians')}</p> : (
              <ul className="text-sm">
                {p.otherGuardians.map((g) => (
                  <li key={g.relationshipId} className="flex flex-wrap items-center gap-2">{g.name} · {g.relationship} · {t(`rel.${g.status}`)}
                    {g.status !== 'disputed' && <button type="button" className="text-xs font-bold underline" onClick={() => setDispute({ relId: g.relationshipId, reason: '' })}>{t('dispute')}</button>}
                  </li>
                ))}
              </ul>
            )}
            {dispute && p.otherGuardians.some((g) => g.relationshipId === dispute.relId) && (
              <div className="mt-2 space-y-2 rounded-2xl bg-canvas p-3">
                <p className="text-xs">{t('disputeNote')}</p>
                <Field label={t('disputeReason')} value={dispute.reason} onChange={(e) => setDispute({ ...dispute, reason: e.target.value })} />
                <button type="button" className="btn btn-secondary" disabled={dispute.reason.trim().length < 10} onClick={async () => { const x = await call('POST', '/public/sports/portal/disputes', { portalToken: token, relationshipId: dispute.relId, reason: dispute.reason }); setDispute(null); if (x.ok) onDone(t('disputeSent')); else onError(x.error.message); }}>{t('sendDispute')}</button>
              </div>
            )}
          </div>
          {invite?.pid === p.id ? (
            <form className="space-y-2 rounded-2xl bg-canvas p-3" noValidate onSubmit={async (e) => {
              e.preventDefault();
              if (!EMAIL_RE.test(invite.email)) { onError(t('invalidEmail')); return; }
              const x = await call<{ devInvitationToken?: string }>('POST', '/public/sports/portal/invitations', { portalToken: token, participantId: p.id, email: invite.email, ...(invite.name ? { name: invite.name } : {}) });
              setInvite(null);
              if (x.ok) onDone(t('inviteSent')); else onError(x.error.message);
            }}>
              <Field label={t('inviteName')} optional value={invite.name} onChange={(e) => setInvite({ ...invite, name: e.target.value })} />
              <Field label={t('inviteEmail')} type="email" value={invite.email} onChange={(e) => setInvite({ ...invite, email: e.target.value })} />
              <button type="submit" className="btn btn-primary">{t('sendInvite')}</button>
            </form>
          ) : <button type="button" className="btn btn-secondary" onClick={() => setInvite({ pid: p.id, email: '', name: '' })}>{t('inviteGuardian')}</button>}
        </article>
      ))}
    </div>
  );
}

function Messages({ data, token }: { data: Overview; token: string }) {
  const t = useTranslations('portal');
  const locale = useLocale();
  const [items, setItems] = useState<Msg[] | null>(null);
  const [loc, setLoc] = useState(data.locations[0]?.id ?? '');
  const [body, setBody] = useState('');
  const [err, setErr] = useState<string | null>(null);
  const load = useCallback(async () => { const r = await call<{ items: Msg[] }>('POST', '/public/sports/portal/messages', { portalToken: token }); if (r.ok) setItems(r.data.items); }, [token]);
  useEffect(() => { void load(); }, [load]);
  if (!data.locations.length) return <p className="text-graphite">{t('noLocations')}</p>;
  return (
    <section className="card space-y-3 p-4">
      {data.locations.length > 1 && <select aria-label={t('location')} className="field" value={loc} onChange={(e) => setLoc(e.target.value)}>{data.locations.map((l) => <option key={l.id} value={l.id}>{l.name}</option>)}</select>}
      <ol className="flex flex-col gap-2" aria-live="polite">
        {(items ?? []).filter((m) => m.locationId === loc).map((m) => (
          <li key={m.id} className={`max-w-[85%] rounded-2xl p-3 text-sm ${m.direction === 'inbound' ? 'self-end bg-ink text-white' : 'self-start bg-canvas'}`}><p>{m.body}</p><p className="mt-1 text-[11px] opacity-70">{dateTime(m.createdAt, 'UTC', locale)} UTC</p></li>
        ))}
        {items && !items.some((m) => m.locationId === loc) && <li className="text-sm text-graphite">{t('noMessages')}</li>}
      </ol>
      {err && <p className="text-sm font-semibold text-danger">{err}</p>}
      <form className="flex gap-2" onSubmit={async (e) => { e.preventDefault(); if (!body.trim()) return; const r = await call('POST', '/public/sports/portal/messages/send', { portalToken: token, locationId: loc, body: body.trim() }); if (r.ok) { setBody(''); void load(); } else setErr(r.error.message); }}>
        <label htmlFor="pmsg" className="sr-only">{t('message')}</label>
        <input id="pmsg" className="field flex-1" value={body} onChange={(e) => setBody(e.target.value)} placeholder={t('message')} />
        <button type="submit" className="btn btn-primary">{t('send')}</button>
      </form>
    </section>
  );
}
