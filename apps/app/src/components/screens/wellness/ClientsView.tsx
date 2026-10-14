'use client';

import { useState } from 'react';
import { useLocale, useTranslations } from 'next-intl';
import { Badge, Button, DataTable, Drawer, Field, Input, Select, Textarea, Toggle, type Column } from '@bh/ui';
import { fmtDateTime, fmtYmd } from '@/lib/format';
import { useWellness, useWellnessAction } from '@/lib/wellness/api';
import type { ClientRow, Draft } from '@/lib/wellness/types';
import { useApp } from '../../shell/AppContext';
import { PageHeader } from '../../shell/PageHeader';
import { Banner, Empty, LoadingBlock, SectionCard } from '../../ui/States';
import { Loadable, Money, StatusBadge, useScopeLocations } from './shared';

export function ClientsView() {
  const t = useTranslations('wellnessFull.clients');
  const locale = useLocale();
  const app = useApp();
  const locs = useScopeLocations();
  const [q, setQ] = useState('');
  const [open, setOpen] = useState<string | null>(null);
  const res = useWellness(app.locations, (api) => api.clients(''), [app.role, app.scopeId]);
  const tzOf = (id: string | null) => app.locations.find((l) => l.id === id)?.timeZone ?? 'UTC';
  const columns: Column<ClientRow>[] = [
    { key: 'name', header: t('name'), render: (c) => <span className="font-bold">{c.name}</span> },
    { key: 'contact', header: t('contact'), render: (c) => c.email ?? <span className="text-stone">{t('hidden')}</span> },
    { key: 'next', header: t('next'), render: (c) => (c.nextAppointmentAt ? fmtDateTime(c.nextAppointmentAt, tzOf(c.locationId), locale) : '—') },
    { key: 'last', header: t('last'), render: (c) => (c.lastVisitAt ? fmtDateTime(c.lastVisitAt, tzOf(c.locationId), locale) : '—') },
    { key: 'visits', header: t('visits'), align: 'right', render: (c) => c.visits },
    { key: 'pk', header: t('packages'), align: 'right', render: (c) => c.activePackages },
  ];
  return (
    <>
      <PageHeader icon="users" title={t('title')} description={t('description')} />
      <div className="grid gap-3 xl:grid-cols-[1fr_360px]">
        <section className="rounded-xl bg-surface p-3.5">
          <div className="flex flex-wrap items-center gap-2 px-1 pb-3">
            <Input aria-label={t('search')} placeholder={t('search')} value={q} onChange={(e) => setQ(e.target.value)} className="!h-9 max-w-xs !text-[13px]" />
            <span className="text-xs text-stone">{t('scopeNote')}</span>
          </div>
          <Loadable res={res} loading={<LoadingBlock variant="table" />}>
            {(rows) => {
              const ids = new Set(locs.map((l) => l.id));
              const list = rows.filter((c) => (!c.locationId || ids.has(c.locationId)) && (!q || `${c.name} ${c.email ?? ''}`.toLowerCase().includes(q.toLowerCase())));
              return <DataTable columns={columns} rows={list} rowKey={(c) => c.id} onRowClick={(c) => setOpen(c.id)} empty={<Empty icon="users" title={t('empty')} body={t('emptyBody')} />} />;
            }}
          </Loadable>
        </section>
        {app.can('ai.use') && <ReplyAssistant />}
      </div>
      {open && <ClientDrawer id={open} onClose={() => setOpen(null)} />}
    </>
  );
}

function ReplyAssistant() {
  const t = useTranslations('wellnessFull.clients');
  const app = useApp();
  const locs = useScopeLocations();
  const action = useWellnessAction(app.locations);
  const [loc, setLoc] = useState(locs[0]?.id ?? '');
  const [enquiry, setEnquiry] = useState('');
  const [draft, setDraft] = useState<Draft | null>(null);
  return (
    <SectionCard title={t('assistantTitle')}>
      <div className="flex flex-col gap-2.5 text-[13px]">
        <p className="text-stone">{t('assistantBody')}</p>
        <Field label={t('location')}>{({ id }) => <Select id={id} value={loc} onChange={(e) => setLoc(e.target.value)}>{locs.map((l) => <option key={l.id} value={l.id}>{l.name}</option>)}</Select>}</Field>
        <Field label={t('enquiry')} hint={t('enquiryHint')}>{({ id, describedBy }) => <Textarea id={id} aria-describedby={describedBy} value={enquiry} onChange={(e) => setEnquiry(e.target.value)} />}</Field>
        <Button size="sm" icon="sparkles" disabled={!enquiry.trim() || action.pending} onClick={async () => setDraft((await action.run((api) => api.draftPolicyReply(loc, enquiry))) ?? null)}>{action.pending ? t('drafting') : t('draft')}</Button>
        {action.error && <Banner tone={action.error.code === 'ai_unavailable' ? 'warning' : 'danger'} live="polite">{action.error.message}</Banner>}
        {draft && (
          <div className="flex flex-col gap-2 rounded-lg bg-canvas p-3">
            <Badge tone="info" icon="file">{t('draftOnly')}</Badge>
            <p className="whitespace-pre-wrap">{draft.output}</p>
            <p className="text-xs text-stone">{t('sources')}: {draft.sources.join(', ')}</p>
            <div className="flex gap-2"><Button size="sm" variant="secondary" icon="copy" onClick={() => { void navigator.clipboard?.writeText(draft.output); void action.run(async (api) => { await api.decideDraft(draft.id, 'apply'); return true; }); }}>{t('copy')}</Button><Button size="sm" variant="ghost" onClick={() => setDraft(null)}>{t('discard')}</Button></div>
          </div>
        )}
      </div>
    </SectionCard>
  );
}

function ClientDrawer({ id, onClose }: { id: string; onClose: () => void }) {
  const t = useTranslations('wellnessFull.clients');
  const locale = useLocale();
  const app = useApp();
  const res = useWellness(app.locations, async (api) => ({ profile: await api.client(id), pracs: await api.practitioners() }), [id]);
  const action = useWellnessAction(app.locations);
  const [note, setNote] = useState({ body: '', confidential: false });
  const [prefs, setPrefs] = useState<{ comfort: string; channel: 'email' | 'sms'; practitionerId: string } | null>(null);
  return (
    <Drawer open onClose={onClose} kicker={t('client')} title={res.status === 'ready' ? res.data.profile.client.name : t('client')}>
      <Loadable res={res}>
        {({ profile: p, pracs }) => {
          const noteLoc = p.client.locationId ?? p.appointments[0]?.locationId ?? app.locations[0]?.id ?? '';
          const pf = prefs ?? { comfort: (p.preferences?.comfort ?? []).join(', '), channel: p.preferences?.preferredChannel ?? 'email', practitionerId: p.preferences?.preferredPractitionerIds[0] ?? '' };
          return (
            <div className="flex flex-col gap-4 text-[13px]">
              <div className="flex flex-wrap gap-3 text-stone">
                <span>{p.client.email ?? t('hidden')}</span>{p.client.phone && <span>{p.client.phone}</span>}
                <span>{t('stats', { visits: p.stats.visits, noShows: p.stats.noShows, late: p.stats.lateCancellations })}</span>
              </div>
              <section>
                <h3 className="mb-1.5 text-xs font-extrabold uppercase tracking-[0.06em] text-stone">{t('history')}</h3>
                {p.appointments.length ? (
                  <ul className="flex flex-col gap-1">
                    {p.appointments.slice(0, 12).map((a) => (
                      <li key={a.id} className="grid grid-cols-[1fr_auto] gap-2 rounded-md bg-canvas px-3 py-2">
                        <span><strong>{fmtDateTime(a.startsAt, a.timeZone, locale)}</strong> · {a.serviceName} · {a.practitionerName}<span className="block text-xs text-stone">{a.locationName} · <Money m={a.price} />{a.clientPackageId ? ` · ${t('packageSession')}` : ''}</span></span>
                        <StatusBadge status={a.status} checkedIn={!!a.checkedInAt} />
                      </li>
                    ))}
                  </ul>
                ) : <p className="text-stone">{t('noHistory')}</p>}
              </section>
              <section>
                <h3 className="mb-1.5 text-xs font-extrabold uppercase tracking-[0.06em] text-stone">{t('packagesTitle')}</h3>
                {p.packages.length ? p.packages.map((k) => (
                  <div key={k.id} className="mb-1 flex flex-wrap items-center justify-between gap-2 rounded-md bg-canvas px-3 py-2">
                    <span><strong>{k.name}</strong> · {t('remaining', { n: k.sessionsRemaining, total: k.sessionsTotal })}{k.expiresAt ? ` · ${t('expires', { date: fmtYmd(k.expiresAt.slice(0, 10), locale, { day: 'numeric', month: 'short', year: 'numeric' }) })}` : ''}{k.customerId !== p.client.id ? ` · ${t('sharedWithClient')}` : ''}</span>
                    <StatusBadge status={k.status} />
                  </div>
                )) : <p className="text-stone">{t('noPackages')}</p>}
                {p.charges.filter((c) => c.status === 'outstanding').map((c) => <Banner key={c.appointmentId} tone="warning" title={t('outstandingFee')}><Money m={c.outstanding} /> · {t(`charge.${c.kind}`)}</Banner>)}
              </section>
              <section className="flex flex-col gap-2">
                <h3 className="text-xs font-extrabold uppercase tracking-[0.06em] text-stone">{t('preferences')}</h3>
                <p className="text-xs text-stone">{t('prefsNote')}</p>
                <div className="grid grid-cols-2 gap-2">
                  <Field label={t('preferredPractitioner')} optional>{({ id }) => <Select id={id} value={pf.practitionerId} onChange={(e) => setPrefs({ ...pf, practitionerId: e.target.value })}><option value="">{t('noPreference')}</option>{pracs.map((x) => <option key={x.id} value={x.id}>{x.name}</option>)}</Select>}</Field>
                  <Field label={t('channel')}>{({ id }) => <Select id={id} value={pf.channel} onChange={(e) => setPrefs({ ...pf, channel: e.target.value as 'email' })}><option value="email">{t('email')}</option><option value="sms">{t('sms')}</option></Select>}</Field>
                </div>
                <Field label={t('comfort')} hint={t('comfortHint')} optional>{({ id, describedBy }) => <Input id={id} aria-describedby={describedBy} value={pf.comfort} onChange={(e) => setPrefs({ ...pf, comfort: e.target.value })} />}</Field>
                {prefs && <Button size="sm" variant="secondary" disabled={action.pending} onClick={async () => { const ok = await action.run(async (api) => { await api.savePreferences(id, { preferredPractitionerIds: pf.practitionerId ? [pf.practitionerId] : [], preferredChannel: pf.channel, comfort: pf.comfort.split(',').map((x) => x.trim()).filter(Boolean) }); return true; }); if (ok) { setPrefs(null); res.reload(); } }}>{t('savePrefs')}</Button>}
              </section>
              <section className="flex flex-col gap-2">
                <h3 className="text-xs font-extrabold uppercase tracking-[0.06em] text-stone">{t('notes')}</h3>
                <p className="text-xs text-stone">{t('notesRule')}</p>
                {p.notes.length ? p.notes.map((n) => (
                  <div key={n.id} className="rounded-md bg-canvas px-3 py-2">
                    <div className="mb-0.5 flex items-center gap-2">{n.confidential ? <Badge tone="warning" icon="lock">{t('confidential')}</Badge> : <Badge tone="neutral" icon="file">{t('shared')}</Badge>}{n.mine && <span className="text-[11px] text-stone">{t('yours')}</span>}<span className="text-[11px] text-stone">{fmtDateTime(n.createdAt, app.locations.find((l) => l.id === n.locationId)?.timeZone ?? 'UTC', locale)}</span></div>
                    <p>{n.body}</p>
                  </div>
                )) : <p className="text-stone">{t('noNotes')}</p>}
                <Field label={t('addNote')} hint={t('noteHint')}>{({ id, describedBy }) => <Textarea id={id} aria-describedby={describedBy} value={note.body} onChange={(e) => setNote({ ...note, body: e.target.value })} />}</Field>
                <label className="flex items-center justify-between gap-2"><span className="flex items-center gap-1.5">{t('markConfidential')}</span><Toggle checked={note.confidential} label={t('markConfidential')} onChange={(v) => setNote({ ...note, confidential: v })} /></label>
                {action.error && <Banner tone="danger" live="assertive">{action.error.message}</Banner>}
                <Button size="sm" disabled={!note.body.trim() || action.pending} onClick={async () => { const ok = await action.run(async (api) => { await api.addNote(id, { locationId: noteLoc, body: note.body, confidential: note.confidential }); return true; }); if (ok) { setNote({ body: '', confidential: false }); res.reload(); } }}>{t('saveNote')}</Button>
              </section>
              <section className="rounded-lg border border-line-soft p-3">
                <div className="flex items-center gap-2"><Badge tone="neutral" icon="lock">{t('intakeRestricted')}</Badge><Badge tone="info" icon="shield">{t('aiExcluded')}</Badge></div>
                <p className="mt-1.5 text-stone">{t('intakeBody', { n: p.intake.responses })}{p.intake.canView ? ` ${t('intakeWhere')}` : ` ${t('intakeNoAccess')}`}</p>
              </section>
            </div>
          );
        }}
      </Loadable>
    </Drawer>
  );
}
