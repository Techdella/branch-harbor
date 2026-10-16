'use client';

import { useState } from 'react';
import { useTranslations } from 'next-intl';
import { Badge, Button, Field, Input, Select, Textarea, type Tone } from '@bh/ui';
import { useApi, useMutation } from '@/lib/useApi';
import { useApp } from '../shell/AppContext';
import { Async, Banner, Empty, LoadingBlock, SectionCard } from '../ui/States';
import type { ReviewContext } from '../marketing-comms/api';
import { Stars } from '../reviews/ReviewsScreen';
import { settingsApi } from './api';

const REPLY_TONE: Record<string, Tone> = { none: 'neutral', draft: 'neutral', pending_approval: 'warning', published: 'success', rejected: 'danger', failed: 'danger' };

/** The Google review behind an inbox conversation: rating, reply status and approval. */
export function ReviewPanel({ review }: { review: ReviewContext }) {
  const t = useTranslations('lmk.inbox');
  return (
    <div className="flex flex-col gap-2 rounded-lg bg-canvas p-3" data-testid="review-panel">
      <div className="flex flex-wrap items-center gap-2">
        <Stars rating={review.rating} />
        <Badge tone="info" icon="star">{t('google')}</Badge>
        <Badge tone={REPLY_TONE[review.reply.status] ?? 'neutral'}>{t(`reply.${review.reply.status}`)}</Badge>
        {review.sandbox && <Badge>{t('sandbox')}</Badge>}
      </div>
      {review.reply.status === 'pending_approval' && <Banner tone="warning">{review.canApprove ? t('approveHint') : t('waitingHq')}</Banner>}
      {review.reply.status === 'rejected' && review.reply.decisionNote && <Banner tone="danger" title={t('rejected')}>{review.reply.decisionNote}</Banner>}
      {review.reply.error && <Banner tone="danger">{review.reply.error}</Banner>}
      {review.reply.status === 'pending_approval' && review.canApprove && <a className="text-sm font-semibold underline" href={`/marketing/reviews?review=${review.id}`}>{t('openInReviews')}</a>}
    </div>
  );
}

export function ReviewTemplatePicker({ templates, onPick }: { templates: ReviewContext['templates']; onPick: (body: string) => void }) {
  const t = useTranslations('lmk.inbox');
  return (
    <Select aria-label={t('templates')} className="h-10 w-auto" value="" onChange={(e) => { const x = templates.find((y) => y.id === e.target.value); if (x) onPick(x.body); }}>
      <option value="">{t('templates')}</option>
      {templates.map((x) => <option key={x.id} value={x.id}>{x.name}</option>)}
    </Select>
  );
}

export function ReviewReplyNote({ review }: { review: ReviewContext }) {
  const t = useTranslations('lmk.inbox');
  return <span className="text-xs text-stone">{review.needsApproval ? t('needsApproval') : review.sandbox ? t('sandboxReply') : t('publicReply')}</span>;
}

/** Reviews → Reply templates and SLA: HQ templates for every location, location templates, and the reply SLA. */
export function ReplyTemplatesSection() {
  const t = useTranslations('lmk.templates');
  const app = useApp();
  const res = useApi(() => settingsApi.templates(), [app.org.id]);
  const st = useApi(() => settingsApi.get(), [app.org.id]);
  const [name, setName] = useState('');
  const [body, setBody] = useState('');
  const [band, setBand] = useState('1-2');
  const [locationId, setLocationId] = useState('');
  const [pos, setPos] = useState('');
  const [neg, setNeg] = useState('');
  const add = useMutation(() => settingsApi.addTemplate({ locationId: locationId || null, name, body, minRating: Number(band.split('-')[0]), maxRating: Number(band.split('-')[1]), locale: null }));
  const del = useMutation((_a, id: string) => settingsApi.deleteTemplate(id));
  const sla = useMutation(() => settingsApi.save({ reviewSla: { positiveHours: Number(pos || st.data!.settings.reviewSla.positiveHours), negativeHours: Number(neg || st.data!.settings.reviewSla.negativeHours) } }));
  const locName = (id: string | null) => (id ? app.locations.find((l) => l.id === id)?.name ?? '—' : t('allLocations'));
  return (
    <div className="grid gap-4 lg:grid-cols-2">
      <SectionCard title={t('title')}>
        <p className="mb-3 text-sm text-stone">{t('intro')}</p>
        <Async res={res} loading={<LoadingBlock variant="table" rows={3} />}>
          {(d) => (d.items.length ? (
            <ul className="flex flex-col gap-2">
              {d.items.map((x) => (
                <li key={x.id} className="rounded-lg border border-line-soft p-3 text-sm">
                  <div className="flex flex-wrap items-center gap-2"><strong>{x.name}</strong><Badge>{t('band', { min: x.minRating, max: x.maxRating })}</Badge><Badge tone="info">{locName(x.locationId)}</Badge>
                    <Button size="sm" variant="ghost" icon="x" className="ms-auto" aria-label={t('remove')} onClick={async () => { if (await del.run(x.id)) res.reload(); }} />
                  </div>
                  <p className="mt-1 whitespace-pre-wrap text-stone">{x.body}</p>
                </li>
              ))}
            </ul>
          ) : <Empty icon="message" title={t('none')} />)}
        </Async>
        <div className="mt-4 grid gap-3 sm:grid-cols-2">
          <Field label={t('name')}>{(f) => <Input id={f.id} value={name} onChange={(e) => setName(e.target.value)} />}</Field>
          <Field label={t('ratings')}>{(f) => <Select id={f.id} value={band} onChange={(e) => setBand(e.target.value)}><option value="1-2">{t('band', { min: 1, max: 2 })}</option><option value="3-3">{t('band', { min: 3, max: 3 })}</option><option value="4-5">{t('band', { min: 4, max: 5 })}</option><option value="1-5">{t('band', { min: 1, max: 5 })}</option></Select>}</Field>
          <Field label={t('appliesTo')}>{(f) => <Select id={f.id} value={locationId} onChange={(e) => setLocationId(e.target.value)}>{res.data?.canManageHq && <option value="">{t('allLocations')}</option>}{app.locations.map((l) => <option key={l.id} value={l.id}>{l.name}</option>)}</Select>}</Field>
        </div>
        <div className="mt-3"><Field label={t('body')} hint={t('tokens')}>{(f) => <Textarea id={f.id} rows={3} value={body} onChange={(e) => setBody(e.target.value)} />}</Field></div>
        {(add.error || del.error) && <Banner tone="danger" live="assertive">{(add.error ?? del.error)!.message}</Banner>}
        <div className="mt-3"><Button icon="plus" loading={add.pending} disabled={name.trim().length < 2 || body.trim().length < 5} onClick={async () => { if (await add.run()) { setName(''); setBody(''); res.reload(); } }}>{t('add')}</Button></div>
      </SectionCard>
      <SectionCard title={t('slaTitle')}>
        <Async res={st} loading={<LoadingBlock variant="table" rows={2} />}>
          {(d) => (
            <>
              <p className="mb-3 text-sm text-stone">{t('slaIntro')}</p>
              <div className="grid gap-3 sm:grid-cols-2">
                <Field label={t('slaNegative')}>{(f) => <Input id={f.id} inputMode="numeric" disabled={!d.canEdit.reviews} value={neg || String(d.settings.reviewSla.negativeHours)} onChange={(e) => setNeg(e.target.value.replace(/\D/g, ''))} />}</Field>
                <Field label={t('slaPositive')}>{(f) => <Input id={f.id} inputMode="numeric" disabled={!d.canEdit.reviews} value={pos || String(d.settings.reviewSla.positiveHours)} onChange={(e) => setPos(e.target.value.replace(/\D/g, ''))} />}</Field>
              </div>
              {sla.error && <Banner tone="danger" live="assertive">{sla.error.message}</Banner>}
              {d.canEdit.reviews && <div className="mt-3"><Button icon="check" loading={sla.pending} onClick={async () => { if (await sla.run()) st.reload(); }}>{t('saveSla')}</Button></div>}
            </>
          )}
        </Async>
      </SectionCard>
    </div>
  );
}
