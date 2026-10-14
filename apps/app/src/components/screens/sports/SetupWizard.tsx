'use client';

import { useEffect, useState } from 'react';
import { useLocale, useTranslations } from 'next-intl';
import { Badge, Button, Icon, Toggle, cx } from '@bh/ui';
import { eligibleBirthDates, minorUnitExponent, type Currency } from '@bh/shared';
import type { AgeRule, SQuestion, SetupInput, SetupProgrammeInput } from '@/lib/sports/types';
import { useSports, useSportsAction } from '@/lib/sports/useSports';
import { useApp } from '../../shell/AppContext';
import { Banner, SectionCard } from '../../ui/States';
import { FieldLabel, areaCls, fmtDate, inputCls } from './ui';

type Step = 'season' | 'venues' | 'programmes' | 'fees' | 'groups' | 'form' | 'review';
const STEPS: Step[] = ['season', 'venues', 'programmes', 'fees', 'groups', 'form', 'review'];
const addMonths = (ymd: string, n: number) => { const d = new Date(`${ymd}T00:00:00Z`); d.setUTCMonth(d.getUTCMonth() + n); return d.toISOString().slice(0, 10); };

interface ProgDraft extends Omit<SetupProgrammeInput, 'feeMinor' | 'feePlans'> { feeMajor: string; instalments: number; key: string }
const blankProgramme = (i: number): ProgDraft => ({ key: `p${i}-${Date.now()}`, name: '', kind: 'programme', feeMajor: '0', requiresApproval: true, venueIds: [], siblingDiscountBps: 0, teams: [{ name: '', assistantUserIds: [], kind: 'team' }], instalments: 1 });

/** Season → venues → programmes (age groups) → fees & instalments → groups & coaches → registration form → publish. */
export function SetupWizard({ onDone, onCancel }: { onDone: (msg: string) => void; onCancel: () => void }) {
  const t = useTranslations('sportsHub.wizard');
  const locale = useLocale();
  const app = useApp();
  const scopeLocs = app.locations.filter((l) => !app.scope.locationIds.length || app.scope.locationIds.includes(l.id));
  const [step, setStep] = useState<Step>('season');
  const [locationId, setLocationId] = useState(scopeLocs[0]?.id ?? '');
  const loc = app.locations.find((l) => l.id === locationId);
  const currency = (loc?.currency ?? 'CAD') as Currency;
  const year = new Date().getUTCFullYear();
  const [season, setSeason] = useState({ name: `${t('defaultSeason')} ${year}`, startsOn: `${year}-09-01`, endsOn: `${year}-12-15`, ageRule: '' as '' | AgeRule, ageCutoffDate: '' });
  const [newVenues, setNewVenues] = useState<{ name: string; kind: string }[]>([]);
  const [venueIds, setVenueIds] = useState<string[]>([]);
  const [progs, setProgs] = useState<ProgDraft[]>([{ ...blankProgramme(0), name: t('exampleProgramme'), ageMin: 8, ageMax: 10, capacity: 36, feeMajor: '420', refundPolicy: t('exampleRefund'), teams: [{ name: 'U10 A', capacity: 18, assistantUserIds: [], kind: 'team' }, { name: 'U10 B', capacity: 18, assistantUserIds: [], kind: 'team' }] }]);
  const [formChoice, setFormChoice] = useState<string>('');
  const [custom, setCustom] = useState<SQuestion[]>([]);
  const [publish, setPublish] = useState(false);
  const [fieldErrors, setFieldErrors] = useState<Record<string, string>>({});

  const preview = useSports((c) => c.agePreview({ locationId, startsOn: season.startsOn, endsOn: season.endsOn, rule: season.ageRule || undefined, cutoffDate: season.ageCutoffDate || undefined }), [locationId, season.startsOn, season.endsOn, season.ageRule, season.ageCutoffDate], !!locationId && !!season.startsOn && !!season.endsOn);
  const venues = useSports((c) => c.venues(locationId), [locationId], !!locationId);
  const coaches = useSports((c) => c.coaches(locationId), [locationId], !!locationId);
  const forms = useSports((c) => c.forms(), []);
  const createForm = useSportsAction((c, input: { locationId: string; name: string; questions: SQuestion[] }) => c.createForm(input));
  const submit = useSportsAction((c, input: SetupInput) => c.setup(input));
  const rule: AgeRule = (season.ageRule || preview.data?.rule || 'age_on_date') as AgeRule;
  const cutoff = season.ageCutoffDate || preview.data?.cutoffDate || season.startsOn;
  useEffect(() => { setVenueIds([]); }, [locationId]);

  const toMinor = (major: string) => Math.round(Number(major || 0) * 10 ** minorUnitExponent(currency));
  const planFor = (p: ProgDraft) => {
    if (p.instalments <= 1) return [{ name: t('payInFull'), kind: 'full' as const, schedule: [] }];
    const base = Math.floor(10_000 / p.instalments);
    const schedule = Array.from({ length: p.instalments }, (_, i) => ({ dueOn: addMonths(season.startsOn, i), shareBps: base + (i === 0 ? 10_000 - base * p.instalments : 0) }));
    return [{ name: t('payInFull'), kind: 'full' as const, schedule: [] }, { name: t('nInstalments', { n: p.instalments }), kind: 'instalments' as const, schedule }];
  };
  const payload = (): SetupInput => ({
    locationId, publish,
    season: { name: season.name, startsOn: season.startsOn, endsOn: season.endsOn, ...(season.ageRule ? { ageRule: season.ageRule } : {}), ...(season.ageCutoffDate ? { ageCutoffDate: season.ageCutoffDate } : {}) },
    venues: newVenues.filter((v) => v.name.trim()),
    programmes: progs.map(({ key: _k, feeMajor, instalments: _n, ...p }) => ({ ...p, feeMinor: toMinor(feeMajor), venueIds, feePlans: planFor({ ...p, feeMajor, instalments: _n, key: _k }), registrationFormId: formChoice || undefined, teams: p.teams.filter((x) => x.name.trim()).map((x) => ({ ...x, coachUserId: x.coachUserId || undefined })) })),
  });

  const validate = (s: Step): Record<string, string> => {
    const e: Record<string, string> = {};
    if (s === 'season') {
      if (!locationId) e.location = t('required');
      if (!season.name.trim()) e['season.name'] = t('required');
      if (season.endsOn < season.startsOn) e['season.endsOn'] = t('endBeforeStart');
    }
    if (s === 'programmes') progs.forEach((p, i) => {
      if (!p.name.trim()) e[`programmes.${i}.name`] = t('required');
      if (p.ageMin !== undefined && p.ageMax !== undefined && p.ageMin > p.ageMax) e[`programmes.${i}.ageMax`] = t('ageOrder');
    });
    if (s === 'fees') progs.forEach((p, i) => { if (toMinor(p.feeMajor) > 0 && !p.refundPolicy?.trim()) e[`programmes.${i}.refundPolicy`] = t('policyRequired'); });
    return e;
  };
  const next = () => {
    const e = validate(step);
    setFieldErrors(e);
    if (Object.keys(e).length) return;
    setStep(STEPS[Math.min(STEPS.length - 1, STEPS.indexOf(step) + 1)]!);
  };
  const finish = async () => {
    let formId = formChoice;
    if (custom.length && !formChoice) {
      const f = await createForm.run({ locationId, name: `${season.name} — ${t('formName')}`, questions: custom });
      if (!f) return;
      formId = f.id;
      setFormChoice(f.id);
    }
    const body = payload();
    body.programmes = body.programmes.map((p) => ({ ...p, registrationFormId: formId || undefined }));
    const r = await submit.run(body);
    if (r) onDone(t('created', { n: r.programmes.length, season: r.season.name }));
    else if (submit.error?.fields) setFieldErrors(submit.error.fields);
  };
  const upd = (i: number, patch: Partial<ProgDraft>) => setProgs((ps) => ps.map((p, k) => (k === i ? { ...p, ...patch } : p)));
  const err = (k: string) => fieldErrors[k] ?? submit.error?.fields?.[k];

  return (
    <SectionCard title={t('title')} aside={<Button variant="ghost" size="sm" icon="x" onClick={onCancel}>{t('cancel')}</Button>}>
      <ol className="mb-5 flex flex-wrap gap-1.5" aria-label={t('steps')}>
        {STEPS.map((s, i) => (
          <li key={s}>
            <button type="button" onClick={() => i < STEPS.indexOf(step) && setStep(s)} aria-current={s === step ? 'step' : undefined} className={cx('h-9 rounded-full px-3.5 text-[13px] font-bold', s === step ? 'bg-ink text-white' : i < STEPS.indexOf(step) ? 'bg-success-bg text-success' : 'bg-canvas text-stone')}>
              {i + 1}. {t(`step.${s}`)}
            </button>
          </li>
        ))}
      </ol>
      {(submit.error || createForm.error) && <div className="mb-4"><Banner tone="danger" live="assertive" title={(submit.error ?? createForm.error)!.message}>{submit.error?.fields && <ul className="ms-5 list-disc">{Object.entries(submit.error.fields).filter(([k]) => k.includes('.')).map(([k, v]) => <li key={k}>{k}: {v}</li>)}</ul>}</Banner></div>}

      {step === 'season' && (
        <div className="grid gap-4 md:grid-cols-2">
          <div className="flex flex-col gap-1.5"><FieldLabel htmlFor="wz-loc">{t('location')}</FieldLabel>
            <select id="wz-loc" className={inputCls} value={locationId} onChange={(e) => setLocationId(e.target.value)} aria-invalid={!!err('location')}>
              {scopeLocs.map((l) => <option key={l.id} value={l.id}>{l.name} · {l.currency}</option>)}
            </select></div>
          <div className="flex flex-col gap-1.5"><FieldLabel htmlFor="wz-sn">{t('seasonName')}</FieldLabel><input id="wz-sn" className={inputCls} value={season.name} onChange={(e) => setSeason({ ...season, name: e.target.value })} aria-invalid={!!err('season.name')} />{err('season.name') && <p className="text-xs font-bold text-danger">{err('season.name')}</p>}</div>
          <div className="flex flex-col gap-1.5"><FieldLabel htmlFor="wz-ss">{t('startsOn')}</FieldLabel><input id="wz-ss" type="date" className={inputCls} value={season.startsOn} onChange={(e) => setSeason({ ...season, startsOn: e.target.value })} /></div>
          <div className="flex flex-col gap-1.5"><FieldLabel htmlFor="wz-se">{t('endsOn')}</FieldLabel><input id="wz-se" type="date" className={inputCls} value={season.endsOn} onChange={(e) => setSeason({ ...season, endsOn: e.target.value })} aria-invalid={!!err('season.endsOn')} />{err('season.endsOn') && <p className="text-xs font-bold text-danger">{err('season.endsOn')}</p>}</div>
          <div className="rounded-lg bg-canvas p-4 md:col-span-2">
            <div className="flex items-center gap-2 font-bold"><Icon name="calendar" size={16} />{t('ageConvention')}</div>
            <p className="mt-1 text-sm text-stone">{preview.data ? t('defaultConvention', { note: preview.data.default.note, rule: t(`rule.${preview.data.default.rule}`), date: fmtDate(preview.data.default.cutoffDate, locale) }) : t('loadingConvention')}</p>
            <div className="mt-3 grid gap-3 md:grid-cols-2">
              <div className="flex flex-col gap-1.5"><FieldLabel htmlFor="wz-rule">{t('ageRule')}</FieldLabel>
                <select id="wz-rule" className={inputCls} value={season.ageRule} onChange={(e) => setSeason({ ...season, ageRule: e.target.value as AgeRule | '' })}>
                  <option value="">{t('useDefault')}</option><option value="age_on_date">{t('rule.age_on_date')}</option><option value="birth_year">{t('rule.birth_year')}</option>
                </select></div>
              <div className="flex flex-col gap-1.5"><FieldLabel htmlFor="wz-cut">{t('cutoffDate')}</FieldLabel><input id="wz-cut" type="date" className={inputCls} value={season.ageCutoffDate} placeholder={preview.data?.cutoffDate} onChange={(e) => setSeason({ ...season, ageCutoffDate: e.target.value })} /></div>
            </div>
          </div>
        </div>
      )}

      {step === 'venues' && (
        <div className="flex flex-col gap-4">
          <p className="text-sm text-stone">{t('venuesHelp')}</p>
          <fieldset className="flex flex-col gap-2"><legend className="mb-1 text-[13px] font-bold">{t('existingVenues')}</legend>
            {(venues.data ?? []).filter((v) => !v.parentVenueId).map((v) => (
              <label key={v.id} className="flex items-center gap-2 text-sm"><input type="checkbox" className="size-5" checked={venueIds.includes(v.id)} onChange={(e) => setVenueIds((ids) => (e.target.checked ? [...ids, v.id] : ids.filter((x) => x !== v.id)))} />{v.name} <span className="text-xs text-stone">· {v.kind}{v.surface ? ` · ${v.surface}` : ''}</span></label>
            ))}
            {venues.data?.length === 0 && <p className="text-sm text-stone">{t('noVenues')}</p>}
          </fieldset>
          <div className="flex flex-col gap-2"><span className="text-[13px] font-bold">{t('newVenues')}</span>
            {newVenues.map((v, i) => (
              <div key={i} className="flex gap-2">
                <input aria-label={t('venueName')} className={inputCls} value={v.name} onChange={(e) => setNewVenues((vs) => vs.map((x, k) => (k === i ? { ...x, name: e.target.value } : x)))} />
                <select aria-label={t('venueKind')} className={cx(inputCls, 'max-w-36')} value={v.kind} onChange={(e) => setNewVenues((vs) => vs.map((x, k) => (k === i ? { ...x, kind: e.target.value } : x)))}>{['pitch', 'court', 'hall', 'field', 'pool', 'other'].map((k) => <option key={k} value={k}>{t(`venueKinds.${k}`)}</option>)}</select>
                <Button variant="ghost" size="sm" icon="x" aria-label={t('remove')} onClick={() => setNewVenues((vs) => vs.filter((_, k) => k !== i))} />
              </div>
            ))}
            <Button variant="secondary" size="sm" icon="plus" className="self-start" onClick={() => setNewVenues((vs) => [...vs, { name: '', kind: 'pitch' }])}>{t('addVenue')}</Button>
          </div>
        </div>
      )}

      {step === 'programmes' && (
        <div className="flex flex-col gap-4">
          {progs.map((p, i) => {
            const range = eligibleBirthDates(rule, cutoff, p.ageMin ?? null, p.ageMax ?? null);
            return (
              <div key={p.key} className="rounded-lg border border-line-soft p-4">
                <div className="grid gap-3 md:grid-cols-3">
                  <div className="flex flex-col gap-1.5 md:col-span-2"><FieldLabel htmlFor={`pn-${i}`}>{t('programmeName')}</FieldLabel><input id={`pn-${i}`} className={inputCls} value={p.name} onChange={(e) => upd(i, { name: e.target.value })} aria-invalid={!!err(`programmes.${i}.name`)} />{err(`programmes.${i}.name`) && <p className="text-xs font-bold text-danger">{err(`programmes.${i}.name`)}</p>}</div>
                  <div className="flex flex-col gap-1.5"><FieldLabel htmlFor={`pk-${i}`}>{t('kind')}</FieldLabel><select id={`pk-${i}`} className={inputCls} value={p.kind} onChange={(e) => upd(i, { kind: e.target.value })}>{['programme', 'academy', 'camp', 'league'].map((k) => <option key={k} value={k}>{t(`kinds.${k}`)}</option>)}</select></div>
                  <div className="flex flex-col gap-1.5"><FieldLabel htmlFor={`amin-${i}`}>{t('ageMin')}</FieldLabel><input id={`amin-${i}`} type="number" min={0} className={inputCls} value={p.ageMin ?? ''} onChange={(e) => upd(i, { ageMin: e.target.value === '' ? undefined : Number(e.target.value) })} /></div>
                  <div className="flex flex-col gap-1.5"><FieldLabel htmlFor={`amax-${i}`}>{t('ageMax')}</FieldLabel><input id={`amax-${i}`} type="number" min={0} className={inputCls} value={p.ageMax ?? ''} onChange={(e) => upd(i, { ageMax: e.target.value === '' ? undefined : Number(e.target.value) })} aria-invalid={!!err(`programmes.${i}.ageMax`)} />{err(`programmes.${i}.ageMax`) && <p className="text-xs font-bold text-danger">{err(`programmes.${i}.ageMax`)}</p>}</div>
                  <div className="flex flex-col gap-1.5"><FieldLabel htmlFor={`cap-${i}`}>{t('capacity')}</FieldLabel><input id={`cap-${i}`} type="number" min={1} className={inputCls} value={p.capacity ?? ''} onChange={(e) => upd(i, { capacity: e.target.value === '' ? undefined : Number(e.target.value) })} /></div>
                  <p className="text-xs text-stone md:col-span-3"><Icon name="info" size={13} className="mr-1 inline" />{t('birthRange', { from: range.from ? fmtDate(range.from, locale) : t('any'), to: range.to ? fmtDate(range.to, locale) : t('any'), rule: t(`rule.${rule}`), date: fmtDate(cutoff, locale) })}</p>
                  <div className="flex flex-col gap-1.5"><FieldLabel htmlFor={`ro-${i}`}>{t('opens')}</FieldLabel><input id={`ro-${i}`} type="date" className={inputCls} value={p.registrationOpensAt?.slice(0, 10) ?? ''} onChange={(e) => upd(i, { registrationOpensAt: e.target.value ? `${e.target.value}T00:00:00Z` : undefined })} /></div>
                  <div className="flex flex-col gap-1.5"><FieldLabel htmlFor={`rc-${i}`}>{t('closes')}</FieldLabel><input id={`rc-${i}`} type="date" className={inputCls} value={p.registrationClosesAt?.slice(0, 10) ?? ''} onChange={(e) => upd(i, { registrationClosesAt: e.target.value ? `${e.target.value}T23:59:00Z` : undefined })} /></div>
                  <label className="flex items-center gap-2 self-end pb-2 text-sm"><Toggle checked={p.requiresApproval} onChange={(v) => upd(i, { requiresApproval: v })} label={t('requiresApproval')} />{t('requiresApproval')}</label>
                  <div className="flex flex-col gap-1.5 md:col-span-3"><FieldLabel htmlFor={`el-${i}`}>{t('eligibility')}</FieldLabel><input id={`el-${i}`} className={inputCls} value={p.eligibilityNotes ?? ''} placeholder={t('eligibilityPlaceholder')} onChange={(e) => upd(i, { eligibilityNotes: e.target.value })} /></div>
                  <div className="flex flex-col gap-1.5 md:col-span-3"><FieldLabel htmlFor={`ds-${i}`}>{t('description')}</FieldLabel><textarea id={`ds-${i}`} className={areaCls} value={p.description ?? ''} onChange={(e) => upd(i, { description: e.target.value })} /></div>
                </div>
                {progs.length > 1 && <Button variant="ghost" size="sm" icon="x" className="mt-2" onClick={() => setProgs((ps) => ps.filter((_, k) => k !== i))}>{t('removeProgramme')}</Button>}
              </div>
            );
          })}
          <Button variant="secondary" size="sm" icon="plus" className="self-start" onClick={() => setProgs((ps) => [...ps, blankProgramme(ps.length)])}>{t('addProgramme')}</Button>
        </div>
      )}

      {step === 'fees' && (
        <div className="flex flex-col gap-4">
          {progs.map((p, i) => (
            <div key={p.key} className="grid gap-3 rounded-lg border border-line-soft p-4 md:grid-cols-3">
              <div className="font-bold md:col-span-3">{p.name}</div>
              <div className="flex flex-col gap-1.5"><FieldLabel htmlFor={`fee-${i}`}>{t('fee', { currency })}</FieldLabel><input id={`fee-${i}`} inputMode="decimal" className={inputCls} value={p.feeMajor} onChange={(e) => upd(i, { feeMajor: e.target.value.replace(/[^0-9.]/g, '') })} /></div>
              <div className="flex flex-col gap-1.5"><FieldLabel htmlFor={`ins-${i}`}>{t('instalments')}</FieldLabel><select id={`ins-${i}`} className={inputCls} value={p.instalments} onChange={(e) => upd(i, { instalments: Number(e.target.value) })}>{[1, 2, 3, 4, 6].map((n) => <option key={n} value={n}>{n === 1 ? t('payInFullOnly') : t('nInstalmentsMonthly', { n })}</option>)}</select></div>
              <div className="flex flex-col gap-1.5"><FieldLabel htmlFor={`sib-${i}`}>{t('sibling')}</FieldLabel><input id={`sib-${i}`} type="number" min={0} max={50} className={inputCls} value={p.siblingDiscountBps / 100} onChange={(e) => upd(i, { siblingDiscountBps: Math.round(Number(e.target.value || 0) * 100) })} /></div>
              {p.instalments > 1 && <p className="text-xs text-stone md:col-span-3">{t('scheduleNote', { dates: planFor(p)[1]!.schedule.map((s) => fmtDate(s.dueOn, locale)).join(' · ') })}</p>}
              <div className="flex flex-col gap-1.5 md:col-span-3"><FieldLabel htmlFor={`rp-${i}`}>{t('refundPolicy')}</FieldLabel><textarea id={`rp-${i}`} className={areaCls} value={p.refundPolicy ?? ''} onChange={(e) => upd(i, { refundPolicy: e.target.value })} aria-invalid={!!err(`programmes.${i}.refundPolicy`)} />
                <p className={cx('text-xs', err(`programmes.${i}.refundPolicy`) ? 'font-bold text-danger' : 'text-stone')}>{err(`programmes.${i}.refundPolicy`) ?? t('refundPolicyHelp')}</p></div>
            </div>
          ))}
          <Banner tone="info" icon="card">{t('feesNote')}</Banner>
        </div>
      )}

      {step === 'groups' && (
        <div className="flex flex-col gap-4">
          {coaches.data?.length === 0 && <Banner tone="warning">{t('noCoaches')}</Banner>}
          {progs.map((p, i) => (
            <div key={p.key} className="flex flex-col gap-2 rounded-lg border border-line-soft p-4">
              <div className="font-bold">{p.name}</div>
              {p.teams.map((tm, k) => (
                <div key={k} className="grid gap-2 md:grid-cols-[2fr_1fr_2fr_1fr_auto]">
                  <input aria-label={t('groupName')} placeholder={t('groupName')} className={inputCls} value={tm.name} onChange={(e) => upd(i, { teams: p.teams.map((x, j) => (j === k ? { ...x, name: e.target.value } : x)) })} />
                  <input aria-label={t('groupCapacity')} placeholder={t('groupCapacity')} type="number" min={1} className={inputCls} value={tm.capacity ?? ''} onChange={(e) => upd(i, { teams: p.teams.map((x, j) => (j === k ? { ...x, capacity: e.target.value ? Number(e.target.value) : undefined } : x)) })} />
                  <select aria-label={t('headCoach')} className={inputCls} value={tm.coachUserId ?? ''} onChange={(e) => upd(i, { teams: p.teams.map((x, j) => (j === k ? { ...x, coachUserId: e.target.value || undefined } : x)) })}>
                    <option value="">{t('noCoach')}</option>{(coaches.data ?? []).map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
                  </select>
                  <select aria-label={t('groupKind')} className={inputCls} value={tm.kind} onChange={(e) => upd(i, { teams: p.teams.map((x, j) => (j === k ? { ...x, kind: e.target.value as 'team' } : x)) })}>{['team', 'group', 'squad'].map((x) => <option key={x} value={x}>{t(`groupKinds.${x}`)}</option>)}</select>
                  <Button variant="ghost" size="sm" icon="x" aria-label={t('remove')} onClick={() => upd(i, { teams: p.teams.filter((_, j) => j !== k) })} />
                </div>
              ))}
              <Button variant="secondary" size="sm" icon="plus" className="self-start" onClick={() => upd(i, { teams: [...p.teams, { name: '', assistantUserIds: [], kind: 'team' }] })}>{t('addGroup')}</Button>
            </div>
          ))}
          <p className="text-xs text-stone">{t('squadNote')}</p>
        </div>
      )}

      {step === 'form' && (
        <div className="flex flex-col gap-4">
          <div className="flex flex-col gap-1.5"><FieldLabel htmlFor="wz-form">{t('useForm')}</FieldLabel>
            <select id="wz-form" className={inputCls} value={formChoice} onChange={(e) => setFormChoice(e.target.value)}>
              <option value="">{t('builtInOnly')}</option>{(forms.data?.items ?? []).filter((f) => !f.locationId || f.locationId === locationId).map((f) => <option key={f.id} value={f.id}>{f.name} · v{f.version}</option>)}
            </select></div>
          <div className="rounded-lg bg-canvas p-4">
            <div className="flex items-center gap-2 text-sm font-bold"><Icon name="lock" size={15} />{t('builtInTitle')}</div>
            <ul className="mt-2 flex flex-col gap-1 text-sm">{(forms.data?.builtIn ?? []).map((q) => <li key={q.key} className="flex flex-wrap items-center gap-2">{q.label}{q.required && <Badge tone="neutral" icon={null}>{t('required')}</Badge>}{(q.category === 'medical' || q.category === 'emergency') && <Badge tone="warning" icon="lock">{q.coachVisible ? t('restrictedCoach') : t('restrictedAdmin')}</Badge>}</li>)}</ul>
            <p className="mt-2 text-xs text-stone">{t('restrictedNote')}</p>
          </div>
          {!formChoice && (
            <div className="flex flex-col gap-2"><span className="text-[13px] font-bold">{t('customQuestions')}</span>
              {custom.map((q, i) => (
                <div key={i} className="grid gap-2 md:grid-cols-[2fr_1fr_1fr_auto_auto]">
                  <input aria-label={t('questionLabel')} placeholder={t('questionLabel')} className={inputCls} value={q.label} onChange={(e) => setCustom((cs) => cs.map((x, k) => (k === i ? { ...x, label: e.target.value, key: e.target.value.toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, '').slice(0, 40) || `q_${i}` } : x)))} />
                  <select aria-label={t('questionType')} className={inputCls} value={q.type} onChange={(e) => setCustom((cs) => cs.map((x, k) => (k === i ? { ...x, type: e.target.value } : x)))}>{['text', 'textarea', 'yes_no', 'phone', 'date'].map((x) => <option key={x} value={x}>{t(`qTypes.${x}`)}</option>)}</select>
                  <select aria-label={t('questionCategory')} className={inputCls} value={q.category} onChange={(e) => setCustom((cs) => cs.map((x, k) => (k === i ? { ...x, category: e.target.value as SQuestion['category'] } : x)))}>{['general', 'medical', 'emergency', 'consent'].map((x) => <option key={x} value={x}>{t(`qCats.${x}`)}</option>)}</select>
                  <label className="flex items-center gap-1.5 text-xs"><input type="checkbox" checked={q.required} onChange={(e) => setCustom((cs) => cs.map((x, k) => (k === i ? { ...x, required: e.target.checked } : x)))} />{t('required')}</label>
                  <Button variant="ghost" size="sm" icon="x" aria-label={t('remove')} onClick={() => setCustom((cs) => cs.filter((_, k) => k !== i))} />
                </div>
              ))}
              <Button variant="secondary" size="sm" icon="plus" className="self-start" onClick={() => setCustom((cs) => [...cs, { key: `q_${cs.length}`, label: '', type: 'text', required: false, category: 'general' }])}>{t('addQuestion')}</Button>
            </div>
          )}
        </div>
      )}

      {step === 'review' && (
        <div className="flex flex-col gap-3 text-sm">
          <p><strong>{season.name}</strong> · {fmtDate(season.startsOn, locale)} – {fmtDate(season.endsOn, locale)} · {loc?.name} · {t(`rule.${rule}`)} ({fmtDate(cutoff, locale)})</p>
          <ul className="flex flex-col gap-2">
            {progs.map((p) => (
              <li key={p.key} className="rounded-lg bg-canvas p-3">
                <div className="font-bold">{p.name || t('untitled')}</div>
                <div className="text-xs text-stone">{t('reviewLine', { min: p.ageMin ?? '—', max: p.ageMax ?? '—', capacity: p.capacity ?? '—', fee: `${p.feeMajor || '0'} ${currency}`, groups: p.teams.filter((x) => x.name).length, plans: planFor(p).length })}{p.requiresApproval ? ` · ${t('requiresApproval')}` : ''}</div>
              </li>
            ))}
          </ul>
          <label className="flex items-center gap-2"><Toggle checked={publish} onChange={setPublish} label={t('publishNow')} />{t('publishNow')}</label>
          <p className="text-xs text-stone">{publish ? t('publishNote') : t('draftNote')}</p>
        </div>
      )}

      <div className="mt-5 flex flex-wrap justify-between gap-2 border-t border-line-soft pt-4">
        <Button variant="secondary" icon="arrow-left" disabled={step === 'season'} onClick={() => setStep(STEPS[Math.max(0, STEPS.indexOf(step) - 1)]!)}>{t('back')}</Button>
        {step === 'review'
          ? <Button icon="check" loading={submit.pending || createForm.pending} onClick={() => void finish()}>{publish ? t('createPublish') : t('createDraft')}</Button>
          : <Button icon="arrow-right" onClick={next}>{t('next')}</Button>}
      </div>
    </SectionCard>
  );
}

