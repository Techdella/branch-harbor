'use client';

import { useState } from 'react';
import Link from 'next/link';
import { useSearchParams } from 'next/navigation';
import { useTranslations } from 'next-intl';
import { Badge, Button, Field, Icon, Input, Select, Textarea, Toggle, cx } from '@bh/ui';
import { MANUAL_STAGES, type FranchiseStage } from '@bh/shared';
import type { IconName } from '@bh/icons';
import { franchiseApi, useFranchise, useFranchiseAction, type ProspectDetail } from '@/lib/franchise/api';
import { useApp } from '../../shell/AppContext';
import { PageHeader } from '../../shell/PageHeader';
import { Banner, Empty, SectionCard } from '../../ui/States';
import { ComplianceSummary, CounselBanner, FAsync, NetworkOnly, StageBadge, useBlockerText, useFmt } from './common';

export function ProspectScreen() {
  return <NetworkOnly><Prospect /></NetworkOnly>;
}

const ACTIVITY_ICON: Record<string, IconName> = {
  enquiry: 'mail', note: 'edit', call: 'phone', meeting: 'users', email: 'send', stage: 'arrow-right', disclosure_sent: 'file', receipt_signed: 'check-circle',
  agreement_sent: 'signature', agreement_signed: 'signature', payment: 'card', blocked: 'lock', task_done: 'check',
};

function Prospect() {
  const t = useTranslations('franchise');
  const id = useSearchParams().get('id') ?? '';
  const app = useApp();
  const res = useFranchise(() => franchiseApi.prospect(id), [app.org.id, id], !!id);
  if (!id) return <Empty icon="search" title={t('prospect.notFound')} />;
  return (
    <FAsync res={res} variant="detail">
      {(p) => <Detail p={p} reload={res.reload} />}
    </FAsync>
  );
}

function Detail({ p, reload }: { p: ProspectDetail; reload: () => void }) {
  const t = useTranslations('franchise');
  const f = useFmt();
  const app = useApp();
  const canEdit = app.can('franchise.pipeline.edit');
  return (
    <>
      <div><Link href="/franchise/pipeline" className="inline-flex items-center gap-1 text-[13px] font-semibold text-graphite hover:underline"><Icon name="arrow-left" size={14} />{t('pipeline.title')}</Link></div>
      <PageHeader icon="user" title={p.name} description={[p.email, p.phone, p.territoryName ?? p.desiredTerritory, [p.city, f.place(p.country, p.region)].filter(Boolean).join(', ')].filter(Boolean).join(' · ')} scope={false} />
      <div className="flex flex-wrap items-center gap-2">
        <StageBadge stage={p.stage} />
        <Badge tone="neutral" icon="map">{p.jurisdiction}</Badge>
        <Badge tone="neutral">{t(`source.${p.source}` as 'source.website')}</Badge>
        {p.ownerName && <Badge tone="neutral" icon="user">{t('prospect.owner', { name: p.ownerName })}</Badge>}
        {p.project && <Link href={`/franchise/onboarding?project=${p.project.id}`} className="text-[13px] font-bold underline">{t('prospect.openProject')}</Link>}
      </div>
      <div className="grid items-start gap-4 xl:grid-cols-[minmax(0,1.2fr)_minmax(0,1fr)]">
        <div className="flex flex-col gap-4">
          <RulesPanel p={p} />
          {canEdit && <Actions p={p} reload={reload} />}
          <Documents p={p} />
        </div>
        <div className="flex flex-col gap-4">
          <SectionCard title={t('prospect.profile')}>
            <dl className="grid grid-cols-[auto_1fr] gap-x-4 gap-y-1.5 text-[13px]">
              <dt className="text-stone">{t('prospect.liquidCapital')}</dt><dd className="font-semibold">{f.money(p.liquidCapital)}</dd>
              <dt className="text-stone">{t('prospect.netWorth')}</dt><dd className="font-semibold">{f.money(p.netWorth)}</dd>
              <dt className="text-stone">{t('prospect.unitsLabel')}</dt><dd className="font-semibold">{p.units}</dd>
              {Object.keys(p.attribution).length > 0 && <><dt className="text-stone">{t('prospect.attribution')}</dt><dd className="font-semibold">{Object.entries(p.attribution).map(([k, v]) => `${k}: ${v}`).join(' · ')}</dd></>}
            </dl>
            <p className="mt-2 text-xs text-stone">{t('prospect.selfDeclared')}</p>
            {p.message && <p className="mt-3 rounded-md bg-canvas-raised px-3 py-2 text-[13px]">{p.message}</p>}
          </SectionCard>
          <Tasks p={p} reload={reload} />
          <Timeline p={p} reload={reload} />
        </div>
      </div>
    </>
  );
}

function RulesPanel({ p }: { p: ProspectDetail }) {
  const t = useTranslations('franchise');
  const f = useFmt();
  const c = p.compliance;
  const stepIcon = { done: 'check-circle', pending: 'clock', blocked: 'lock', info: 'info' } as const;
  const warnings = c.warnings.filter((w) => w.code !== 'verify');
  return (
    <SectionCard title={t('rules.panelTitle')} aside={<Link href={`/franchise/rules?country=${p.country}${p.region ? `&region=${p.region}` : ''}`} className="text-[13px] font-bold underline">{t('rules.browse')}</Link>}>
      <div className="flex flex-col gap-3">
        <CounselBanner />
        <div className="flex flex-wrap gap-1.5">
          {c.applicable.map((a) => (
            <Badge key={a.code} tone={a.reviewedByCounsel ? 'success' : 'neutral'} icon={a.reviewedByCounsel ? 'check' : 'scale'}>
              {a.name} · {t(`rules.confidence.${a.confidence}`)}{a.basis === 'franchisor_location' ? ` · ${t('rules.franchisorBasis')}` : ''}
            </Badge>
          ))}
          {!c.applicable.length && <span className="text-[13px] text-stone">{t('rules.noneApplicable')}</span>}
        </div>
        <ComplianceSummary c={c} />
        {c.steps.length > 0 && (
          <ul className="flex flex-col gap-1">
            {c.steps.map((s, i) => (
              <li key={`${s.key}-${s.ruleCode}-${i}`} className={cx('flex items-center gap-2 rounded-md px-3 py-2 text-[13px]', s.status === 'done' ? 'bg-success-bg' : s.status === 'blocked' ? 'bg-warning-bg' : 'bg-canvas-raised')}>
                <Icon name={stepIcon[s.status]} size={15} />
                <span className="min-w-0 flex-1">{s.label}</span>
                {s.dueAt && <span className="text-xs text-stone">{f.date(s.dueAt)}</span>}
              </li>
            ))}
          </ul>
        )}
        {c.requiredDocuments.length > 0 && (
          <div>
            <h3 className="mb-1 text-[13px] font-bold">{t('rules.requiredDocuments')}</h3>
            <ul className="list-disc pl-5 text-[13px]">{c.requiredDocuments.map((d) => <li key={d.key}>{d.label} <span className="text-stone">({d.ruleCodes.join(', ')})</span></li>)}</ul>
          </div>
        )}
        {warnings.map((w, i) => <Banner key={`${w.code}-${i}`} tone="neutral" icon="info">{w.message}</Banner>)}
        <p className="text-xs text-stone">{c.disclaimer}</p>
      </div>
    </SectionCard>
  );
}

function Actions({ p, reload }: { p: ProspectDetail; reload: () => void }) {
  const t = useTranslations('franchise');
  const app = useApp();
  const act = useFranchiseAction();
  const blockerText = useBlockerText();
  const docs = useFranchise(() => franchiseApi.documents(), [app.org.id]);
  const settings = useFranchise(() => franchiseApi.settings(), [app.org.id]);
  const [disc, setDisc] = useState('');
  const [agr, setAgr] = useState('');
  const [terms, setTerms] = useState({ termYears: '10', royalty: '6', fund: '2', renewal: '', territory: p.territoryName ?? p.desiredTerritory ?? '' });
  const [material, setMaterial] = useState(false);
  const [fee, setFee] = useState({ amount: '', description: t('actions.feeDefault') });
  const [lostReason, setLostReason] = useState('');
  const [notice, setNotice] = useState<string | null>(null);
  const done = (msg: string) => { setNotice(msg); reload(); };
  const stage = p.stage as FranchiseStage;
  const signedOrLater = ['signed', 'onboarding', 'opened'].includes(stage);
  const disclosures = (docs.data ?? []).filter((d) => d.kind === 'disclosure' && d.status === 'current');
  const agreements = (docs.data ?? []).filter((d) => d.kind === 'agreement_template' && d.status === 'current');
  const pendingSig = p.signatures.find((s) => s.status === 'sent');
  const blockers = (act.error?.details?.blockers ?? []) as Array<{ code: string; ruleCode: string; message: string; until: string | null }>;

  return (
    <SectionCard title={t('actions.title')}>
      <div className="flex flex-col gap-4">
        {notice && <Banner tone="success" live="polite">{notice}</Banner>}
        {act.error && (
          <Banner tone="danger" live="assertive" title={act.error.message}>
            {blockers.length > 0 && <ul className="list-disc pl-5">{blockers.map((b, i) => <li key={i}>{blockerText(b)}</li>)}</ul>}
          </Banner>
        )}
        {stage !== 'lost' && !signedOrLater && (
          <div className="flex flex-wrap items-end gap-2">
            <span className="w-full text-[13px] font-bold">{t('actions.move')}</span>
            {MANUAL_STAGES.filter((s) => s !== 'lost' && s !== stage).map((s) => (
              <Button key={s} size="sm" variant="secondary" loading={act.pending} onClick={async () => { if (await act.run(() => franchiseApi.setStage(p.id, s))) done(t('actions.moved', { stage: t(`stage.${s}`) })); }}>{t(`stage.${s}`)}</Button>
            ))}
          </div>
        )}
        {!signedOrLater && stage !== 'lost' && (
          <div className="flex flex-col gap-2 border-t border-line-soft pt-3">
            <span className="text-[13px] font-bold">{t('actions.disclosureTitle')}</span>
            <div className="flex flex-wrap items-end gap-2">
              <div className="min-w-[220px] flex-1">
                <Field label={t('actions.disclosureDoc')}>{(x) => (
                  <Select id={x.id} value={disc} onChange={(e) => setDisc(e.target.value)}>
                    <option value="">{t('actions.choose')}</option>
                    {disclosures.map((d) => <option key={d.id} value={d.id}>{d.title} · {d.version} ({d.jurisdictions.join(', ')})</option>)}
                  </Select>
                )}</Field>
              </div>
              <Button icon="send" disabled={!disc} loading={act.pending} onClick={async () => {
                const r = await act.run(() => franchiseApi.sendDisclosure(p.id, disc));
                if (r) done([t('actions.disclosureSent'), ...r.warnings.map((w) => w.message)].join(' '));
              }}>{t('actions.sendDisclosure')}</Button>
            </div>
            <p className="text-xs text-stone">{t('actions.disclosureHint')}</p>
          </div>
        )}
        {!signedOrLater && stage !== 'lost' && (
          <div className="flex flex-col gap-2 border-t border-line-soft pt-3">
            <span className="text-[13px] font-bold">{t('actions.agreementTitle')}</span>
            <Field label={t('actions.agreementDoc')}>{(x) => (
              <Select id={x.id} value={agr} onChange={(e) => setAgr(e.target.value)}>
                <option value="">{t('actions.choose')}</option>
                {agreements.map((d) => <option key={d.id} value={d.id}>{d.title} · {d.version}</option>)}
              </Select>
            )}</Field>
            <div className="grid grid-cols-3 gap-2">
              <Field label={t('actions.termYears')}>{(x) => <Input id={x.id} inputMode="numeric" value={terms.termYears} onChange={(e) => setTerms((s) => ({ ...s, termYears: e.target.value }))} />}</Field>
              <Field label={t('actions.royalty')}>{(x) => <Input id={x.id} inputMode="decimal" value={terms.royalty} onChange={(e) => setTerms((s) => ({ ...s, royalty: e.target.value }))} />}</Field>
              <Field label={t('actions.fund')}>{(x) => <Input id={x.id} inputMode="decimal" value={terms.fund} onChange={(e) => setTerms((s) => ({ ...s, fund: e.target.value }))} />}</Field>
            </div>
            <Field label={t('actions.territory')} optional>{(x) => <Input id={x.id} value={terms.territory} onChange={(e) => setTerms((s) => ({ ...s, territory: e.target.value }))} />}</Field>
            <Field label={t('actions.renewal')} optional>{(x) => <Input id={x.id} value={terms.renewal} onChange={(e) => setTerms((s) => ({ ...s, renewal: e.target.value }))} />}</Field>
            <div className="flex items-center gap-3 text-[13px]"><Toggle checked={material} onChange={setMaterial} label={t('actions.materialChange')} /><span aria-hidden="true">{t('actions.materialChange')}</span></div>
            <div className="flex flex-wrap gap-2">
              <Button icon="signature" disabled={!agr} loading={act.pending} onClick={async () => {
                const r = await act.run(() => franchiseApi.sendAgreement(p.id, {
                  documentId: agr, provider: 'builtin', materialChange: material,
                  terms: { termYears: Number(terms.termYears) || undefined, royaltyBps: Math.round(Number(terms.royalty) * 100) || undefined, marketingFundBps: Math.round(Number(terms.fund) * 100) || undefined, territory: terms.territory || undefined, renewalOption: terms.renewal || undefined },
                }));
                if (r) done(t('actions.agreementSent'));
              }}>{t('actions.sendAgreement')}</Button>
              {pendingSig && (
                <Button variant="secondary" icon="check" loading={act.pending} onClick={async () => { if (await act.run(() => franchiseApi.recordSignature(p.id, pendingSig.id, p.name))) done(t('actions.signed')); }}>{t('actions.recordSignature')}</Button>
              )}
            </div>
            {settings.data && <p className="text-xs text-stone">{settings.data.esignDisclaimer}</p>}
          </div>
        )}
        {stage !== 'lost' && (
          <div className="flex flex-col gap-2 border-t border-line-soft pt-3">
            <span className="text-[13px] font-bold">{t('actions.feeTitle')}</span>
            <div className="flex flex-wrap items-end gap-2">
              <div className="w-32"><Field label={t('actions.amount', { currency: app.org.defaultCurrency })}>{(x) => <Input id={x.id} inputMode="decimal" value={fee.amount} onChange={(e) => setFee((s) => ({ ...s, amount: e.target.value }))} />}</Field></div>
              <div className="min-w-[200px] flex-1"><Field label={t('actions.feeDescription')}>{(x) => <Input id={x.id} value={fee.description} onChange={(e) => setFee((s) => ({ ...s, description: e.target.value }))} />}</Field></div>
              <Button variant="secondary" icon="card" disabled={!Number(fee.amount)} loading={act.pending} onClick={async () => {
                if (await act.run(() => franchiseApi.feeInvoice(p.id, { amountMinor: Math.round(Number(fee.amount) * 100), currency: String(app.org.defaultCurrency), description: fee.description }))) done(t('actions.feeRequested'));
              }}>{t('actions.requestFee')}</Button>
            </div>
            <p className="text-xs text-stone">{t('actions.feeHint')}</p>
          </div>
        )}
        {stage !== 'lost' && !signedOrLater && (
          <div className="flex flex-wrap items-end gap-2 border-t border-line-soft pt-3">
            <div className="min-w-[200px] flex-1"><Field label={t('actions.lostReason')}>{(x) => <Input id={x.id} value={lostReason} onChange={(e) => setLostReason(e.target.value)} />}</Field></div>
            <Button variant="danger" icon="x" disabled={!lostReason} loading={act.pending} onClick={async () => { if (await act.run(() => franchiseApi.setStage(p.id, 'lost', { lostReason }))) done(t('actions.markedLost')); }}>{t('actions.markLost')}</Button>
          </div>
        )}
      </div>
    </SectionCard>
  );
}

function Documents({ p }: { p: ProspectDetail }) {
  const t = useTranslations('franchise');
  const f = useFmt();
  return (
    <SectionCard title={t('prospect.documents')}>
      {p.deliveries.length || p.signatures.length || p.invoices.length ? (
        <ul className="flex flex-col gap-2 text-[13px]">
          {p.deliveries.map((d) => (
            <li key={d.id} className="rounded-md bg-canvas-raised p-3">
              <div className="flex flex-wrap items-center gap-2 font-bold"><Icon name={d.kind === 'agreement' ? 'signature' : 'file'} size={15} />{d.document.title} · {d.document.version}<span className="font-normal text-stone">({d.document.jurisdictions.join(', ')})</span></div>
              <div className="mt-1 text-stone">{t('prospect.delivered', { date: f.date(d.deliveredAt) })}{d.openedAt ? ` · ${t('prospect.opened', { date: f.date(d.openedAt) })}` : ''}{d.materialChange ? ` · ${t('prospect.materialChange')}` : ''}</div>
              {d.kind === 'disclosure' && (d.receiptSignedAt
                ? <div className="mt-1 text-success">{t('prospect.receipt', { name: d.receiptName ?? '', date: f.date(d.receiptSignedAt, { day: 'numeric', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit' }), ip: d.receiptIp ?? '—' })}</div>
                : <div className="mt-1 text-warning">{t('prospect.receiptMissing')}</div>)}
            </li>
          ))}
          {p.signatures.map((s) => (
            <li key={s.id} className="flex flex-wrap items-center gap-2 rounded-md bg-canvas-raised p-3">
              <Icon name="signature" size={15} /><span className="font-bold">{t('prospect.signature', { provider: s.provider })}</span>
              <Badge tone={s.status === 'signed' ? 'success' : s.status === 'sent' ? 'info' : 'neutral'}>{t(`signatureStatus.${s.status}` as 'signatureStatus.sent')}</Badge>
              {s.signedAt && <span className="text-stone">{t('prospect.signedBy', { name: s.signerName ?? '', date: f.date(s.signedAt) })}</span>}
            </li>
          ))}
          {p.invoices.map((i) => (
            <li key={i.id} className="flex flex-wrap items-center gap-2 rounded-md bg-canvas-raised p-3">
              <Icon name="card" size={15} /><span className="font-bold">{i.description}</span><span>{f.money(i.amount)}</span>
              <Badge tone={i.status === 'paid' ? 'success' : 'warning'}>{t(`invoiceStatus.${i.status}` as 'invoiceStatus.open')}</Badge>
            </li>
          ))}
        </ul>
      ) : <p className="text-[13px] text-stone">{t('prospect.noDocuments')}</p>}
    </SectionCard>
  );
}

function Tasks({ p, reload }: { p: ProspectDetail; reload: () => void }) {
  const t = useTranslations('franchise');
  const f = useFmt();
  const app = useApp();
  const act = useFranchiseAction();
  const open = p.tasks.filter((x) => x.status === 'open');
  return (
    <SectionCard title={t('prospect.tasks')}>
      {act.error && <Banner tone="danger">{act.error.message}</Banner>}
      {open.length ? (
        <ul className="flex flex-col gap-1.5">
          {open.map((x) => (
            <li key={x.id} className="flex items-center gap-2 text-[13px]">
              <Icon name={x.kind === 'email' ? 'mail' : x.kind === 'call' ? 'phone' : 'check-circle'} size={15} />
              <span className="min-w-0 flex-1">{x.title}<span className="text-stone"> · {f.date(x.dueAt, { day: 'numeric', month: 'short' })}{x.kind === 'email' ? ` · ${t('prospect.autoEmail')}` : ''}</span></span>
              {x.overdue && <Badge tone="danger">{t('pipeline.overdueOne')}</Badge>}
              {app.can('franchise.pipeline.edit') && <Button size="sm" variant="ghost" icon="check" aria-label={t('prospect.completeTask', { title: x.title })} loading={act.pending} onClick={async () => { if (await act.run(() => franchiseApi.completeTask(x.id))) reload(); }} />}
            </li>
          ))}
        </ul>
      ) : <p className="text-[13px] text-stone">{t('pipeline.noTasks')}</p>}
    </SectionCard>
  );
}

function Timeline({ p, reload }: { p: ProspectDetail; reload: () => void }) {
  const t = useTranslations('franchise');
  const f = useFmt();
  const app = useApp();
  const act = useFranchiseAction();
  const [kind, setKind] = useState<'note' | 'call' | 'meeting'>('note');
  const [body, setBody] = useState('');
  const label = (a: ProspectDetail['activities'][number]) => {
    if (a.kind === 'stage') return t('timeline.stage', { stage: t(`stage.${String(a.metadata.to)}` as 'stage.enquiry') });
    return t(`timeline.${a.kind}` as 'timeline.note');
  };
  return (
    <SectionCard title={t('prospect.timeline')}>
      {app.can('franchise.pipeline.edit') && (
        <div className="mb-3 flex flex-col gap-2">
          <div className="flex gap-2">
            <Select aria-label={t('timeline.kind')} value={kind} onChange={(e) => setKind(e.target.value as typeof kind)} className="w-36">
              {(['note', 'call', 'meeting'] as const).map((k) => <option key={k} value={k}>{t(`timeline.${k}`)}</option>)}
            </Select>
            <Button size="sm" disabled={!body.trim()} loading={act.pending} onClick={async () => { if (await act.run(() => franchiseApi.addActivity(p.id, kind, body.trim()))) { setBody(''); reload(); } }}>{t('timeline.add')}</Button>
          </div>
          <Textarea aria-label={t('timeline.body')} rows={2} value={body} onChange={(e) => setBody(e.target.value)} />
        </div>
      )}
      <ol className="flex flex-col gap-2.5">
        {p.activities.map((a) => (
          <li key={a.id} className="flex gap-2.5 text-[13px]">
            <span className="mt-0.5 flex h-7 w-7 shrink-0 items-center justify-center rounded-full bg-canvas"><Icon name={ACTIVITY_ICON[a.kind] ?? 'info'} size={14} /></span>
            <div className="min-w-0">
              <div className="font-bold">{label(a)}</div>
              {a.body && <div className="whitespace-pre-line text-graphite">{a.body}</div>}
              <div className="text-xs text-stone">{f.date(a.createdAt, { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' })}{a.actorName ? ` · ${a.actorName}` : ''}</div>
            </div>
          </li>
        ))}
      </ol>
    </SectionCard>
  );
}
