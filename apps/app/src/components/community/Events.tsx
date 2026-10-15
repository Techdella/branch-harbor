'use client';

import { useState } from 'react';
import { useLocale, useTranslations } from 'next-intl';
import { Badge, Button, Drawer, Field, Icon, Input, Select, Textarea } from '@bh/ui';
import { AudiencePicker, ErrorNote, Pill, canDo, useAudienceText, useNet, useNetAction, type Audience, type NetMe } from './net';
import { LoadingBlock } from '../ui/States';

interface EventT { id: string; title: string; description: string | null; kind: string; startsAt: string; endsAt: string; timeZone: string; joinUrl: string | null; place: string | null; capacity: number | null; audience: Audience; cancelled: boolean; going: number; maybe: number; myRsvp: string | null; full: boolean }
const KINDS = ['network_call', 'training', 'webinar', 'in_person', 'social'] as const;

export function EventsPanel({ me }: { me: NetMe }) {
  const t = useTranslations('community.events');
  const locale = useLocale();
  const res = useNet<{ items: EventT[] }>('/community/events');
  const act = useNetAction();
  const [creating, setCreating] = useState(false);
  const audienceText = useAudienceText(me.directory);
  const fmt = (iso: string, tz: string) => new Intl.DateTimeFormat(locale, { weekday: 'short', day: 'numeric', month: 'short', hour: 'numeric', minute: '2-digit', timeZone: tz, timeZoneName: 'short' }).format(new Date(iso));
  return (
    <div className="flex flex-col gap-3">
      {canDo(me, 'community.manage', true) && <Button size="sm" variant="signal" icon="plus" className="self-end" onClick={() => setCreating(true)}>{t('new')}</Button>}
      <ErrorNote error={res.error ?? act.error} />
      {res.loading && !res.data ? <LoadingBlock variant="cards" rows={2} /> : (
        <ul className="grid gap-3 md:grid-cols-2">
          {(res.data?.items ?? []).map((e) => (
            <li key={e.id} className="flex flex-col gap-2 rounded-xl bg-surface p-4">
              <div className="flex flex-wrap items-center gap-2"><Badge tone="info" icon="calendar">{t(`kinds.${e.kind}`)}</Badge>{e.cancelled && <Badge tone="danger">{t('cancelled')}</Badge>}{e.full && !e.cancelled && <Badge tone="warning">{t('full')}</Badge>}</div>
              <h3 className="text-base font-bold">{e.title}</h3>
              <p className="text-[13px] font-semibold">{fmt(e.startsAt, e.timeZone)}</p>
              {e.description && <p className="text-[13px] text-stone">{e.description}</p>}
              <p className="text-xs text-stone">{audienceText(e.audience)} · {t('going', { count: e.going })}{e.capacity ? ` · ${t('capacity', { count: e.capacity })}` : ''}</p>
              <div className="flex flex-wrap items-center gap-1.5">
                {e.joinUrl && <a href={e.joinUrl} target="_blank" rel="noreferrer" className="inline-flex h-9 items-center gap-1.5 rounded-full bg-ink px-3.5 text-[13px] font-bold text-white"><Icon name="video" size={15} />{t('join')}</a>}
                {e.place && <span className="inline-flex items-center gap-1 text-[13px]"><Icon name="pin" size={14} />{e.place}</span>}
                {!e.cancelled && (['going', 'maybe', 'declined'] as const).map((s) => (
                  <Pill key={s} active={e.myRsvp === s} onClick={async () => { if (await act.run('post', `/community/events/${e.id}/rsvp`, { status: s })) void res.reload(); }}>{t(`rsvp.${s}`)}</Pill>
                ))}
              </div>
            </li>
          ))}
          {!res.loading && !(res.data?.items ?? []).length && <li className="rounded-xl bg-surface p-6 text-sm text-stone">{t('empty')}</li>}
        </ul>
      )}
      {creating && <EventForm me={me} onClose={() => setCreating(false)} onDone={() => { setCreating(false); void res.reload(); }} />}
    </div>
  );
}

function EventForm({ me, onClose, onDone }: { me: NetMe; onClose: () => void; onDone: () => void }) {
  const t = useTranslations('community.events');
  const act = useNetAction();
  const [title, setTitle] = useState('');
  const [kind, setKind] = useState<string>('network_call');
  const [start, setStart] = useState('');
  const [minutes, setMinutes] = useState('60');
  const [joinUrl, setJoinUrl] = useState('');
  const [place, setPlace] = useState('');
  const [description, setDescription] = useState('');
  const [audience, setAudience] = useState<Audience>({});
  const tz = Intl.DateTimeFormat().resolvedOptions().timeZone;
  const f = act.error?.fields ?? {};
  return (
    <Drawer open onClose={onClose} title={t('new')} footer={<Button loading={act.pending} disabled={!title.trim() || !start} onClick={async () => {
      const s = new Date(start);
      if (await act.run('post', '/community/events', { title, kind, startsAt: s.toISOString(), endsAt: new Date(s.getTime() + Number(minutes || 60) * 60_000).toISOString(), timeZone: tz, joinUrl: joinUrl || null, place: place || null, description: description || null, audience })) onDone();
    }}>{t('save')}</Button>}>
      <div className="flex flex-col gap-3">
        <ErrorNote error={act.error && !Object.keys(f).length ? act.error : null} />
        <Field label={t('title')} error={f.title}>{(p) => <Input id={p.id} value={title} onChange={(e) => setTitle(e.target.value)} />}</Field>
        <Field label={t('kind')}>{(p) => <Select id={p.id} value={kind} onChange={(e) => setKind(e.target.value)}>{KINDS.map((k) => <option key={k} value={k}>{t(`kinds.${k}`)}</option>)}</Select>}</Field>
        <div className="grid gap-2 sm:grid-cols-2">
          <Field label={t('startsAt')} hint={tz}>{(p) => <Input id={p.id} type="datetime-local" value={start} onChange={(e) => setStart(e.target.value)} />}</Field>
          <Field label={t('minutes')}>{(p) => <Input id={p.id} type="number" min={15} step={15} value={minutes} onChange={(e) => setMinutes(e.target.value)} />}</Field>
        </div>
        <Field label={t('joinUrl')} error={f.joinUrl} optional>{(p) => <Input id={p.id} type="url" value={joinUrl} onChange={(e) => setJoinUrl(e.target.value)} />}</Field>
        <Field label={t('place')} optional>{(p) => <Input id={p.id} value={place} onChange={(e) => setPlace(e.target.value)} />}</Field>
        <Field label={t('description')} optional>{(p) => <Textarea id={p.id} rows={3} value={description} onChange={(e) => setDescription(e.target.value)} />}</Field>
        <AudiencePicker value={audience} onChange={setAudience} directory={me.directory} />
      </div>
    </Drawer>
  );
}
