'use client';

import Link from 'next/link';
import { useCallback, useEffect, useRef, useState } from 'react';
import { useSearchParams } from 'next/navigation';
import { useLocale, useTranslations } from 'next-intl';
import { Badge, Button, Field, Icon, Input, Logo, MarinaFigure, Select, Textarea, cx } from '@bh/ui';
import { ASSISTANT_NAME, LAUNCH_COUNTRIES, SUPPORTED_CURRENCIES } from '@bh/shared';
import type { IconName } from '@bh/icons';
import { TEAM_SHAPE_SUGGESTIONS } from '@bh/shared';
import { accessApi } from '@/lib/http/access';
import { useRoleName } from '../screens/team/AccessEditor';
import { ShapeChoices, useCombinedNames } from '../screens/team/TeamShape';
import { ONBOARDING_STEPS, type DomainStatus, type ImportRow, type IndustryKey, type OnboardingProgress, type OnboardingStep } from '@/lib/types';
import { ApiError, getApi } from '@/lib/api';
import { useErrorText, useFieldText } from '@/lib/useErrorText';
import { useDataText } from '../ui/useDataText';
import { useMutation } from '@/lib/useApi';
import { countryName, currencyName, relativeTime } from '@/lib/format';
import { INDUSTRY_UI } from '@/lib/nav';
import { APP_LOCALES, APP_LOCALE_LABELS } from '@/i18n/config';
import { LanguageSelect } from '../shell/TopBar';
import { Banner } from '../ui/States';
import { COUNTRY_ZONES, EMPTY_LOCATION, LocationWizard, validateLocation, type LocationDraft } from '../screens/LocationWizard';
import { SIGNUP_INTENT_KEY } from '../auth/AuthForms';

/**
 * Independent businesses (one location) get a shorter checklist: "Your business" covers the business details AND
 * its address, time zone, currency and hours; there is no location wizard, CSV import or staff-invite step.
 */
const INDEPENDENT_STEPS: OnboardingStep[] = ['account', 'industry', 'business', 'website', 'data', 'connect', 'publish'];
const stepsFor = (model: 'independent' | 'network'): readonly OnboardingStep[] => (model === 'independent' ? INDEPENDENT_STEPS : ONBOARDING_STEPS);

const STEP_ICON: Record<OnboardingStep, IconName> = { account: 'user', industry: 'grid', business: 'building', location: 'pin', website: 'globe', data: 'list', connect: 'plug', team: 'users', publish: 'eye' };
const OPTIONAL: OnboardingStep[] = ['connect', 'team'];
/** Every industry is available for self-service sign-up (all industries launch together). */
const INDUSTRIES: IndustryKey[] = ['studios', 'sports', 'wellness', 'commerce', 'foods', 'realty', 'hospitality'];

const SAMPLE_CSV = `name,code,country,timezone,currency
London – Shoreditch,LDN-SH,GB,Europe/London,GBP
Berlin – Prenzlauer Berg,BER-PB,DE,,EUR
Sydney – Surry Hills,SYD-SH,AU,Australia/Sydney,AUD
Seattle – Capitol Hill,SEA-CH,US,America/Los_Angeles,CAD`;

interface Data {
  industry: IndustryKey;
  model: 'independent' | 'network';
  biz: { name: string; country: string; timeZone: string; currency: string; locale: string; dataRegion: 'us' | 'eu' | 'apac' };
  loc: LocationDraft;
  imported: number;
  site: 'hosted' | 'wordpress';
  address: 'included' | 'domain';
  domain: string;
  domainPrimary: boolean;
  items: string[];
  conn: string;
  pay: 'not' | 'pending' | 'enabled';
  invites: { email: string; role: string; location: string }[];
  /** HQ accounts: full team, small team (people cover several areas), just me, or custom. Changeable later. */
  teamShape?: string | null;
  tested: boolean;
  published: boolean;
}

const INITIAL: Data = {
  industry: 'studios',
  model: 'network',
  biz: { name: 'Stillwater Yoga Collective', country: 'CA', timeZone: 'America/Toronto', currency: 'CAD', locale: 'en', dataRegion: 'us' },
  loc: { ...EMPTY_LOCATION, name: 'Toronto – Queen West', code: 'TOR-QW', line1: '812 Queen St W', city: 'Toronto', region: 'ON', postalCode: 'M6J 1E5', phone: '+1 416 555 0142', hours: 'Mon–Fri 06:30–21:00 · Sat–Sun 08:00–18:00' },
  imported: 0,
  site: 'hosted',
  address: 'included',
  domain: '',
  domainPrimary: false,
  items: ['Morning Vinyasa · 60 min · 20 spots', 'Slow Flow · 75 min · 16 spots'],
  conn: '',
  pay: 'not',
  invites: [{ email: 'maya@stillwater.example', role: 'location_manager', location: 'Toronto – Queen West' }],
  teamShape: null,
  tested: false,
  published: false,
};

const slug = (v: string) => v.toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');

export function Onboarding() {
  const t = useTranslations('onboarding');
  const ts = useTranslations('single.onboarding');
  const locale = useLocale();
  const params = useSearchParams();
  const [done, setDone] = useState<OnboardingStep[]>(['account']);
  const [skipped, setSkipped] = useState<OnboardingStep[]>([]);
  const [step, setStep] = useState<OnboardingStep>('industry');
  const [data, setData] = useState<Data>(INITIAL);
  const [savedAt, setSavedAt] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [err, setErr] = useState<Record<string, string>>({});
  const [loaded, setLoaded] = useState(false);
  const [, tick] = useState(0);
  const headingRef = useRef<HTMLHeadingElement>(null);

  useEffect(() => {
    (async () => {
      const p = await (await getApi()).onboarding.get().catch(() => null);
      let model: Data['model'] = INITIAL.model;
      if (p) {
        const d = { ...INITIAL, ...(p.data as Partial<Data>) };
        // A sign-up from the marketing site may carry the industry and business model (independent or network).
        if (!p.done.includes('industry')) {
          try {
            const intent = JSON.parse(localStorage.getItem(SIGNUP_INTENT_KEY) ?? 'null') as { industry?: string | null; model?: Data['model'] | null } | null;
            if (intent?.industry && INDUSTRIES.includes(intent.industry as IndustryKey)) d.industry = intent.industry as IndustryKey;
            if (intent?.model) d.model = intent.model;
          } catch {
            /* no stored intent */
          }
        }
        model = d.model;
        setDone(p.done);
        setSkipped(p.skipped);
        setStep(stepsFor(d.model).includes(p.current) ? p.current : p.current === 'team' ? 'publish' : 'business');
        setData(d);
        setSavedAt(p.savedAt);
      }
      const q = params.get('step') as OnboardingStep | null;
      if (q && stepsFor(model).includes(q)) setStep(q);
      else if (q === 'location' && model === 'independent') setStep('business');
      setLoaded(true);
    })();
    const h = setInterval(() => tick((x) => x + 1), 10000);
    return () => clearInterval(h);
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  const persist = useCallback(async (next: { done: OnboardingStep[]; skipped: OnboardingStep[]; current: OnboardingStep; data: Data }) => {
    setSaving(true);
    try {
      const saved = await (await getApi()).onboarding.save({ ...next, savedAt: new Date().toISOString(), data: next.data as unknown as Record<string, unknown> } as OnboardingProgress);
      setSavedAt(saved.savedAt);
    } finally {
      setSaving(false);
    }
  }, []);

  const go = (s: OnboardingStep) => {
    setStep(s);
    setErr({});
    setTimeout(() => headingRef.current?.focus(), 0);
    window.scrollTo({ top: 0, behavior: 'smooth' });
  };
  const independent = data.model === 'independent';
  const combined = useCombinedNames();
  const steps = stepsFor(data.model);
  const idx = Math.max(0, steps.indexOf(step));
  const nextStep = steps[Math.min(steps.length - 1, idx + 1)]!;
  const doneCount = done.filter((d) => steps.includes(d)).length;

  const validate = (): Record<string, string> => {
    if (step === 'business' && !data.biz.name.trim()) return { name: t('errors.businessName') };
    if (step === 'business' && independent) {
      const e: Record<string, string> = {};
      if (!data.loc.line1.trim()) e.line1 = ts('errors.line1');
      if (!data.loc.city.trim()) e.city = ts('errors.city');
      return e;
    }
    if (step === 'location') return validateLocation(data.loc, (k) => t(`wizardErrors.${k.replace('errors.', '')}`));
    if (step === 'data' && data.items.length === 0) return { items: t('errors.items') };
    if (step === 'website' && data.address === 'domain' && data.domain && !/^([a-z0-9-]+\.)+[a-z]{2,}$/i.test(data.domain.trim())) return { domain: t('errors.domain') };
    return {};
  };

  const complete = async () => {
    const e = validate();
    setErr(e);
    if (Object.keys(e).length) return;
    // Independent: "Your business" also completes the (hidden) location step — the business IS its location.
    const nd = [...new Set([...done, step, ...(independent && step === 'business' ? (['location'] as OnboardingStep[]) : [])])];
    const ns = skipped.filter((x) => x !== step);
    const nextData = independent && step === 'business'
      ? { ...data, loc: { ...data.loc, name: data.loc.city.trim() || data.biz.name, code: data.loc.code || 'MAIN', country: data.biz.country, timeZone: data.biz.timeZone, currency: data.biz.currency } }
      : data;
    setDone(nd);
    setSkipped(ns);
    if (nextData !== data) setData(nextData);
    await persist({ done: nd, skipped: ns, current: nextStep, data: nextData });
    // The team shape pre-creates suggested roles (a small team gets combined roles). Nothing is locked: it can be
    // changed later in Team & access. Before the business exists there is nothing to create yet.
    if (step === 'team' && !independent && data.teamShape) {
      const keys = TEAM_SHAPE_SUGGESTIONS[data.teamShape as keyof typeof TEAM_SHAPE_SUGGESTIONS]?.combined ?? [];
      await accessApi.setTeamShape(data.teamShape, combined.names([...keys]), combined.descriptions([...keys])).catch(() => undefined);
    }
    if (step !== 'publish') go(nextStep);
  };
  const skip = async () => {
    const ns = [...new Set([...skipped, step])];
    setSkipped(ns);
    await persist({ done, skipped: ns, current: nextStep, data });
    go(nextStep);
  };

  const set = <K extends keyof Data>(k: K, v: Data[K]) => setData((d) => ({ ...d, [k]: v }));
  const blockers = [
    !done.includes('location') && (independent ? { label: ts('blockerBusiness'), step: 'business' as const } : { label: t('blockers.location'), step: 'location' as const }),
    !done.includes('website') && { label: t('blockers.website'), step: 'website' as const },
    data.items.length === 0 && { label: t('blockers.items'), step: 'data' as const },
  ].filter(Boolean) as { label: string; step: OnboardingStep }[];

  if (!loaded) return <div className="p-10 text-center text-sm text-stone">{t('loading')}</div>;

  return (
    <div className="flex min-h-viewport flex-col gap-3 p-2 md:p-3">
      <header className="flex flex-wrap items-center gap-3 rounded-lg bg-surface px-4 py-3">
        <Link href="/overview" aria-label={t('exit')}>
          <Logo size={30} />
        </Link>
        <span className="hidden text-sm text-stone sm:inline">{t('setupTitle')}</span>
        <span className="ml-auto flex items-center gap-1.5 text-xs text-stone" role="status" aria-live="polite">
          <Icon name={saving ? 'refresh' : 'check-circle'} size={13} />
          {saving ? t('saving') : savedAt ? t('savedAgo', { when: relativeTime(savedAt, locale) }) : t('notSaved')}
        </span>
        <LanguageSelect className="w-[180px]" />
        <Link href="/overview" className="inline-flex h-10 items-center rounded-full border border-line px-4 text-[13px] font-bold">
          {t('exit')}
        </Link>
      </header>
      <div className="flex flex-col gap-3 lg:flex-row lg:items-start">
        <nav aria-label={t('checklist')} className="rounded-xl bg-surface p-4 lg:sticky lg:top-3 lg:w-[300px] lg:shrink-0">
          <div className="mb-3 px-1">
            <div className="text-sm font-bold">{t('progress', { done: doneCount, total: steps.length })}</div>
            <div className="mt-2 h-1.5 overflow-hidden rounded-full bg-canvas" role="progressbar" aria-valuenow={doneCount} aria-valuemin={0} aria-valuemax={steps.length} aria-label={t('checklist')}>
              <div className="h-full bg-ink transition-all" style={{ width: `${(doneCount / steps.length) * 100}%` }} />
            </div>
          </div>
          <ol className="flex gap-1 overflow-x-auto pb-1 lg:flex-col lg:overflow-visible">
            {steps.map((s, i) => {
              const isDone = done.includes(s);
              const isSkipped = skipped.includes(s) && !isDone;
              return (
                <li key={s} className="shrink-0">
                  <button type="button" onClick={() => go(s)} aria-current={step === s ? 'step' : undefined} className={cx('flex w-full items-center gap-2.5 rounded-full px-2.5 py-2 text-left text-[13px]', step === s ? 'bg-lime font-bold' : 'hover:bg-canvas')}>
                    <span className={cx('flex h-7 w-7 shrink-0 items-center justify-center rounded-full text-xs font-bold', isDone ? 'bg-ink text-white' : 'bg-canvas')}>
                      {isDone ? <Icon name="check" size={14} stroke={2.4} /> : i + 1}
                    </span>
                    <span className="whitespace-nowrap lg:flex-1">{independent && s === 'business' ? ts('stepBusiness') : t(`steps.${s}`)}</span>
                    {isDone && <span className="sr-only">{t('done')}</span>}
                    {isSkipped && <span className="rounded-full bg-canvas px-2 py-0.5 text-[10px] font-bold text-stone">{t('skipped')}</span>}
                    {!isDone && !isSkipped && OPTIONAL.includes(s) && <span className="rounded-full bg-canvas px-2 py-0.5 text-[10px] font-bold text-stone">{t('optional')}</span>}
                  </button>
                </li>
              );
            })}
          </ol>
          <p className="mt-3 hidden px-1 text-xs text-stone lg:block">{t('checklistHint')}</p>
          {/* Marina introduces herself once, holding her tablet: the setup assistant waits on her page after setup. */}
          <div className="mt-4 hidden flex-col items-center gap-2 rounded-lg bg-[linear-gradient(135deg,#EEF3FD,#F3EEFC_55%,#ECF7F4)] p-4 text-center lg:flex" data-testid="onboarding-marina">
            <MarinaFigure width={140} pose="hold" />
            <p className="text-sm font-bold">{t('marina.title', { name: ASSISTANT_NAME })}</p>
            <p className="text-xs leading-relaxed text-graphite">{t('marina.body', { name: ASSISTANT_NAME })}</p>
          </div>
        </nav>

        <main className="flex min-w-0 flex-1 flex-col gap-3">
          <section className="rounded-xl bg-surface p-5 md:p-8">
            <div className="mb-6 flex items-start gap-3.5">
              <span className="flex h-[52px] w-[52px] shrink-0 items-center justify-center rounded-[18px]" style={{ background: INDUSTRY_UI[data.industry].pastel }}>
                <Icon name={STEP_ICON[step]} size={24} />
              </span>
              <div>
                <div className="text-[13px] text-stone">{t('stepOf', { n: idx + 1, total: steps.length })}</div>
                <h1 ref={headingRef} tabIndex={-1} className="text-[28px] font-bold leading-tight tracking-[-0.035em] outline-none">
                  {step === 'data' ? t(`industry.${data.industry}.itemsTitle`) : independent && step === 'business' ? ts('businessTitle') : t(`title.${step}`)}
                </h1>
                <p className="mt-1 max-w-2xl text-sm text-stone">{step === 'data' ? t('desc.data') : independent && step === 'business' ? ts('businessDesc') : t(`desc.${step}`)}</p>
              </div>
            </div>

            {step === 'account' && <AccountStep />}
            {step === 'industry' && <IndustryStep data={data} set={set} />}
            {step === 'business' && <BusinessStep data={data} set={set} err={err} />}
            {step === 'location' && <LocationStep data={data} set={set} err={err} />}
            {step === 'website' && <WebsiteStep data={data} set={set} err={err} />}
            {step === 'data' && <DataStep data={data} set={set} err={err} />}
            {step === 'connect' && <ConnectStep data={data} set={set} />}
            {step === 'team' && <TeamStep data={data} set={set} />}
            {step === 'publish' && <PublishStep data={data} set={set} blockers={blockers} go={go} onPublish={complete} />}

            {step !== 'publish' && (
              <div className="mt-8 flex flex-wrap items-center gap-2 border-t border-line-soft pt-5">
                {idx > 0 && (
                  <Button variant="ghost" icon="arrow-left" onClick={() => go(steps[idx - 1]!)}>
                    {t('back')}
                  </Button>
                )}
                <span className="flex-1" />
                {OPTIONAL.includes(step) && (
                  <Button variant="secondary" onClick={skip}>
                    {t('skip')}
                  </Button>
                )}
                <Button iconRight="arrow-right" loading={saving} onClick={complete}>
                  {step === 'account' ? t('continue') : t('saveContinue')}
                </Button>
              </div>
            )}
          </section>
        </main>
      </div>
    </div>
  );
}

type StepProps = { data: Data; set: <K extends keyof Data>(k: K, v: Data[K]) => void; err?: Record<string, string> };

function AccountStep() {
  const t = useTranslations('onboarding');
  return (
    <div className="flex flex-col gap-3">
      <Banner tone="success" title={t('account.doneTitle')}>
        {t('account.doneBody')}
      </Banner>
      <p className="text-sm text-stone">{t('account.note')}</p>
    </div>
  );
}

function Choice({ checked, onChange, title, body, badge, disabled, name, icon, pastel }: { checked: boolean; onChange: () => void; title: string; body?: string; badge?: React.ReactNode; disabled?: boolean; name: string; icon?: IconName; pastel?: string }) {
  return (
    <label className={cx('flex cursor-pointer gap-3 rounded-lg border-[1.5px] p-4', checked ? 'border-ink bg-canvas-raised' : 'border-line-soft hover:border-line', disabled && 'cursor-not-allowed opacity-60')}>
      <input type="radio" name={name} checked={checked} onChange={onChange} disabled={disabled} className="mt-1 h-4 w-4 accent-ink" />
      {icon && (
        <span className="flex h-11 w-11 shrink-0 items-center justify-center rounded-md" style={{ background: pastel ?? '#F3F2EE' }}>
          <Icon name={icon} size={20} />
        </span>
      )}
      <span className="min-w-0 flex-1">
        <span className="flex flex-wrap items-center gap-2 text-[15px] font-bold">
          {title}
          {badge}
        </span>
        {body && <span className="mt-0.5 block text-[13px] text-stone">{body}</span>}
      </span>
    </label>
  );
}

function IndustryStep({ data, set }: StepProps) {
  const t = useTranslations('onboarding');
  return (
    <div className="flex flex-col gap-6">
      <fieldset className="grid gap-2.5 md:grid-cols-2">
        <legend className="mb-2 text-sm font-bold">{t('industryLegend')}</legend>
        {INDUSTRIES.map((k) => (
          <Choice
            key={k}
            name="industry"
            checked={data.industry === k}
            onChange={() => set('industry', k)}
            title={t(`industry.${k}.name`)}
            body={t(`industry.${k}.workflow`)}
            icon={INDUSTRY_UI[k].icon}
            pastel={INDUSTRY_UI[k].pastel}
            badge={<Badge tone="success">{t('selfServe')}</Badge>}
          />
        ))}
      </fieldset>
      <fieldset className="grid gap-2.5 md:grid-cols-2">
        <legend className="mb-2 text-sm font-bold">{t('modelLegend')}</legend>
        <Choice name="model" checked={data.model === 'independent'} onChange={() => set('model', 'independent')} title={t('model.independent')} body={t('model.independentBody')} icon="store" />
        <Choice name="model" checked={data.model === 'network'} onChange={() => set('model', 'network')} title={t('model.network')} body={t('model.networkBody')} icon="layers" />
      </fieldset>
    </div>
  );
}

function BusinessStep({ data, set, err = {} }: StepProps) {
  const t = useTranslations('onboarding');
  const locale = useLocale();
  const b = data.biz;
  const up = (p: Partial<Data['biz']>) => set('biz', { ...b, ...p });
  return (
    <div className="flex flex-col gap-6">
    <div className="grid gap-4 md:grid-cols-2">
      <Field label={t('biz.name')} error={err.name}>{(p) => <Input id={p.id} aria-invalid={p.invalid} aria-describedby={p.describedBy} value={b.name} onChange={(e) => up({ name: e.target.value })} />}</Field>
      <Field label={t('biz.country')}>
        {(p) => (
          <Select
            id={p.id}
            value={b.country}
            onChange={(e) => {
              const c = LAUNCH_COUNTRIES.find((x) => x.code === e.target.value);
              up({ country: e.target.value, currency: c?.currency ?? b.currency, timeZone: COUNTRY_ZONES[e.target.value]?.[0] ?? b.timeZone, dataRegion: c?.region === 'EU' ? 'eu' : c?.region === 'APAC' ? 'apac' : 'us' });
            }}
          >
            {LAUNCH_COUNTRIES.map((c) => (
              <option key={c.code} value={c.code}>
                {countryName(c.code, locale)}
              </option>
            ))}
          </Select>
        )}
      </Field>
      <Field label={t('biz.timeZone')} hint={t('biz.timeZoneHint')}>
        {(p) => (
          <Select id={p.id} aria-describedby={p.describedBy} value={b.timeZone} onChange={(e) => up({ timeZone: e.target.value })}>
            {[...new Set([...(COUNTRY_ZONES[b.country] ?? []), ...Object.values(COUNTRY_ZONES).flat()])].map((z) => (
              <option key={z} value={z}>
                {z.replace(/_/g, ' ')}
              </option>
            ))}
          </Select>
        )}
      </Field>
      <Field label={t('biz.currency')} hint={t('biz.currencyHint')}>
        {(p) => (
          <Select id={p.id} aria-describedby={p.describedBy} value={b.currency} onChange={(e) => up({ currency: e.target.value })}>
            {SUPPORTED_CURRENCIES.map((c) => (
              <option key={c} value={c}>
                {c} · {currencyName(c, locale)}
              </option>
            ))}
          </Select>
        )}
      </Field>
      <Field label={t('biz.language')}>
        {(p) => (
          <Select id={p.id} value={b.locale} onChange={(e) => up({ locale: e.target.value })}>
            {APP_LOCALES.map((l) => (
              <option key={l} value={l}>
                {APP_LOCALE_LABELS[l]}
              </option>
            ))}
          </Select>
        )}
      </Field>
      <Field label={t('biz.dataRegion')} hint={t('biz.dataRegionHint')}>
        {(p) => (
          <Select id={p.id} aria-describedby={p.describedBy} value={b.dataRegion} onChange={(e) => up({ dataRegion: e.target.value as Data['biz']['dataRegion'] })}>
            <option value="us">{t('region.us')}</option>
            <option value="eu">{t('region.eu')}</option>
            <option value="apac">{t('region.apac')}</option>
          </Select>
        )}
      </Field>
    </div>
    {data.model === 'independent' && <IndependentAddress data={data} set={set} err={err} />}
    </div>
  );
}

/** Independent path: the business's address, contact and hours (its one location) in the same step. */
function IndependentAddress({ data, set, err = {} }: StepProps) {
  const t = useTranslations('single.onboarding');
  const l = data.loc;
  const up = (p: Partial<LocationDraft>) => set('loc', { ...l, ...p });
  return (
    <fieldset className="grid gap-4 rounded-xl border-[1.5px] border-line-soft p-5 md:grid-cols-2">
      <legend className="px-1 text-sm font-bold">{t('addressLegend')}</legend>
      <Field label={t('line1')} error={err.line1}>{(p) => <Input id={p.id} aria-invalid={p.invalid} aria-describedby={p.describedBy} value={l.line1} onChange={(e) => up({ line1: e.target.value })} autoComplete="address-line1" />}</Field>
      <Field label={t('city')} error={err.city}>{(p) => <Input id={p.id} aria-invalid={p.invalid} aria-describedby={p.describedBy} value={l.city} onChange={(e) => up({ city: e.target.value })} autoComplete="address-level2" />}</Field>
      <Field label={t('region')} optional>{(p) => <Input id={p.id} value={l.region} onChange={(e) => up({ region: e.target.value })} autoComplete="address-level1" />}</Field>
      <Field label={t('postalCode')} optional>{(p) => <Input id={p.id} value={l.postalCode} onChange={(e) => up({ postalCode: e.target.value })} autoComplete="postal-code" />}</Field>
      <Field label={t('phone')} optional>{(p) => <Input id={p.id} type="tel" value={l.phone} onChange={(e) => up({ phone: e.target.value })} autoComplete="tel" />}</Field>
      <Field label={t('hours')} hint={t('hoursHint')} optional>{(p) => <Input id={p.id} aria-describedby={p.describedBy} value={l.hours} onChange={(e) => up({ hours: e.target.value })} placeholder={t('hoursPh')} />}</Field>
      <p className="text-xs text-stone md:col-span-2">{t('addressNote')}</p>
    </fieldset>
  );
}

function LocationStep({ data, set, err = {} }: StepProps) {
  const t = useTranslations('onboarding');
  return (
    <div className="flex flex-col gap-6">
      <LocationWizard value={data.loc} onChange={(l) => set('loc', l)} errors={err} ownerGroups={['Company-owned', 'Lakeshore Holdings', 'Northbound Studios LLC', 'Thames Wellbeing Ltd']} />
      {data.model === 'network' && <CsvImport imported={data.imported} onImported={(n) => set('imported', n)} />}
      {data.model === 'independent' && <p className="text-xs text-stone">{t('independentNote')}</p>}
    </div>
  );
}

function CsvImport({ imported, onImported }: { imported: number; onImported: (n: number) => void }) {
  const t = useTranslations('onboarding.csv');
  const dt = useDataText();
  const fieldText = useFieldText();
  const [open, setOpen] = useState(false);
  const [csv, setCsv] = useState('');
  const [rows, setRows] = useState<ImportRow[] | null>(null);
  const [excluded, setExcluded] = useState<Record<number, boolean>>({});
  const validate = useMutation((api, text: string) => api.onboarding.validateImport(text));
  const fileRef = useRef<HTMLInputElement>(null);

  const run = async (text: string) => {
    const r = await validate.run(text);
    if (r) {
      setRows(r);
      setExcluded({});
    }
  };
  const fixRow = (row: number, field: 'timeZone' | 'currency', value: string) => {
    if (!rows) return;
    const lines = csv.trim().split(/\r?\n/);
    const header = lines[0]!.split(',').map((h) => h.trim().toLowerCase());
    const col = header.indexOf(field === 'timeZone' ? 'timezone' : 'currency');
    const cells = lines[row - 1]!.split(',');
    cells[col] = value;
    lines[row - 1] = cells.join(',');
    const next = lines.join('\n');
    setCsv(next);
    run(next);
  };
  const included = rows?.filter((r) => !excluded[r.row]) ?? [];
  const bad = included.filter((r) => r.errors.length > 0).length;

  return (
    <div className="flex flex-col gap-3 rounded-xl border-[1.5px] border-line-soft p-5">
      <div className="flex flex-wrap items-center gap-3">
        <Icon name="download" size={18} />
        <div className="min-w-[200px] flex-1">
          <div className="text-[15px] font-bold">{t('title')}</div>
          <div className="text-[13px] text-stone">{t('body')}</div>
        </div>
        {imported > 0 ? <Badge tone="success">{t('added', { count: imported })}</Badge> : <Button variant="secondary" onClick={() => setOpen((o) => !o)}>{open ? t('hide') : t('upload')}</Button>}
      </div>
      {open && imported === 0 && (
        <>
          <div className="flex flex-wrap gap-2">
            <input
              ref={fileRef}
              type="file"
              accept=".csv,text/csv"
              className="sr-only"
              id="csv-file"
              onChange={async (e) => {
                const f = e.target.files?.[0];
                if (!f) return;
                const text = await f.text();
                setCsv(text);
                run(text);
              }}
            />
            <label htmlFor="csv-file" className="inline-flex h-9 cursor-pointer items-center gap-1.5 rounded-full border border-line px-4 text-[13px] font-bold focus-within:outline focus-within:outline-3 focus-within:outline-focus">
              <Icon name="file" size={14} />
              {t('chooseFile')}
            </label>
            <Button size="sm" variant="ghost" onClick={() => (setCsv(SAMPLE_CSV), run(SAMPLE_CSV))}>
              {t('useSample')}
            </Button>
          </div>
          <Field label={t('paste')} hint={t('columns')}>
            {(p) => <Textarea id={p.id} aria-describedby={p.describedBy} value={csv} onChange={(e) => setCsv(e.target.value)} className="font-mono text-xs" />}
          </Field>
          <Button size="sm" variant="secondary" className="self-start" disabled={!csv.trim()} loading={validate.pending} onClick={() => run(csv)}>
            {t('check')}
          </Button>
          {rows && (
            <div className="flex flex-col gap-1.5" aria-live="polite">
              <p className="text-xs text-stone">{t('summary', { total: rows.length, bad })}</p>
              {rows.map((r) => (
                <div key={r.row} className={cx('flex flex-wrap items-center gap-2.5 rounded-md px-3.5 py-2.5 text-[13px]', excluded[r.row] ? 'bg-canvas opacity-60' : r.errors.length ? 'bg-danger-bg' : 'bg-success-bg')}>
                  <span className="w-12 font-bold text-stone">{t('row', { n: r.row })}</span>
                  <span className="min-w-[160px] flex-1 font-bold">{r.name || '—'}</span>
                  <span className="text-graphite">
                    {r.country} · {r.currency} · {r.timeZone || '—'}
                  </span>
                  {excluded[r.row] ? (
                    <span className="text-xs font-semibold">{t('excluded')}</span>
                  ) : r.errors.length === 0 ? (
                    <span className="flex items-center gap-1 font-semibold text-success">
                      <Icon name="check-circle" size={14} />
                      {t('ready')}
                    </span>
                  ) : (
                    <span className="flex basis-full flex-col gap-1.5">
                      {r.errors.map((e) => (
                        <span key={e.field + e.message} className="flex flex-wrap items-center gap-2 font-semibold text-danger">
                          <Icon name="alert" size={14} />
                          {dt(e.textKey, e.textParams, fieldText(e.message))}
                          {e.field === 'timeZone' && (
                            <select aria-label={t('fixTimeZone', { row: r.row })} onChange={(ev) => ev.target.value && fixRow(r.row, 'timeZone', ev.target.value)} className="h-8 rounded-full border-[1.5px] border-ink bg-surface px-2.5 text-xs text-ink" defaultValue="">
                              <option value="">{t('choose')}</option>
                              {(COUNTRY_ZONES[r.country] ?? ['UTC']).map((z) => (
                                <option key={z} value={z}>
                                  {z}
                                </option>
                              ))}
                            </select>
                          )}
                          {e.field === 'currency' && (
                            <select aria-label={t('fixCurrency', { row: r.row })} onChange={(ev) => ev.target.value && fixRow(r.row, 'currency', ev.target.value)} className="h-8 rounded-full border-[1.5px] border-ink bg-surface px-2.5 text-xs text-ink" defaultValue="">
                              <option value="">{t('choose')}</option>
                              {SUPPORTED_CURRENCIES.map((c) => (
                                <option key={c}>{c}</option>
                              ))}
                            </select>
                          )}
                        </span>
                      ))}
                    </span>
                  )}
                  <button type="button" onClick={() => setExcluded((x) => ({ ...x, [r.row]: !x[r.row] }))} className="ml-auto text-xs font-bold underline">
                    {excluded[r.row] ? t('include') : t('skipRow')}
                  </button>
                </div>
              ))}
              <Button className="self-start" disabled={bad > 0 || included.length === 0} onClick={() => onImported(included.length)}>
                {bad > 0 ? t('fixToContinue', { count: bad }) : t('addN', { count: included.length })}
              </Button>
              <p className="text-xs text-stone">{t('nothingCreated')}</p>
            </div>
          )}
        </>
      )}
    </div>
  );
}

function WebsiteStep({ data, set, err = {} }: StepProps) {
  const t = useTranslations('onboarding.web');
  // Independent businesses: the brand site IS the location site, at /{business}.
  const included = data.model === 'independent'
    ? `https://sites.branchharbor.com/${slug(data.biz.name) || 'your-business'}`
    : `https://sites.branchharbor.com/${slug(data.biz.name) || 'your-business'}/${slug(data.loc.name) || 'your-location'}`;
  return (
    <div className="flex flex-col gap-6">
      <fieldset className="grid gap-2.5 md:grid-cols-2">
        <legend className="mb-2 text-sm font-bold">{t('siteLegend')}</legend>
        <Choice name="site" checked={data.site === 'hosted'} onChange={() => set('site', 'hosted')} title={t('hosted')} body={t('hostedBody')} icon="globe" />
        <Choice name="site" checked={data.site === 'wordpress'} onChange={() => set('site', 'wordpress')} title={t('wordpress')} body={t('wordpressBody')} icon="wordpress" />
      </fieldset>
      {data.site === 'wordpress' ? (
        <div className="flex flex-col gap-2 rounded-lg bg-canvas p-5 text-sm">
          <strong>{t('wpStepsTitle')}</strong>
          <ol className="list-decimal pl-5 leading-7">
            <li>{t('wpStep1')}</li>
            <li>{t('wpStep2')}</li>
            <li>{t('wpStep3')}</li>
            <li>{t('wpStep4')}</li>
          </ol>
          <p className="text-xs text-stone">{t('wpNote')}</p>
        </div>
      ) : (
        <fieldset className="flex flex-col gap-2.5">
          <legend className="mb-2 text-sm font-bold">{t('addressLegend')}</legend>
          <Choice name="addr" checked={data.address === 'included'} onChange={() => set('address', 'included')} title={t('included')} body={included} icon="link" />
          <Choice name="addr" checked={data.address === 'domain'} onChange={() => set('address', 'domain')} title={t('connect')} body={t('connectBody')} icon="globe" />
          <Choice name="addr" checked={false} onChange={() => {}} disabled title={t('buy')} body={t('buyBody')} icon="cart" badge={<Badge tone="neutral" icon="clock">{t('later')}</Badge>} />
          <p className="text-xs text-stone">{t('exampleNote')}</p>
        </fieldset>
      )}
      {data.site === 'hosted' && data.address === 'domain' && <DomainFlow data={data} set={set} err={err} included={included} />}
    </div>
  );
}

function DomainFlow({ data, set, err = {}, included }: StepProps & { included: string }) {
  const t = useTranslations('onboarding.domain');
  const [host, setHost] = useState(data.domain);
  const [status, setStatus] = useState<DomainStatus | null>(null);
  const [checking, setChecking] = useState(false);
  const [copied, setCopied] = useState('');
  const [localErr, setLocalErr] = useState('');

  useEffect(() => {
    if (!status || !['verifying', 'certificate_pending'].includes(status.state)) return;
    const h = setTimeout(async () => setStatus(await (await getApi()).onboarding.domain(status.hostname)), 900);
    return () => clearTimeout(h);
  }, [status]);

  const start = async () => {
    const h = host.trim().toLowerCase();
    if (!/^([a-z0-9-]+\.)+[a-z]{2,}$/.test(h)) {
      setLocalErr(t('invalid'));
      return;
    }
    setLocalErr('');
    set('domain', h);
    setStatus(await (await getApi()).onboarding.domain(h));
  };
  const verify = async () => {
    if (!status) return;
    setChecking(true);
    setStatus(await (await getApi()).onboarding.verifyDomain(status.hostname));
    setChecking(false);
  };
  const copy = (k: string, v: string) => {
    try {
      void navigator.clipboard?.writeText(v);
    } catch {
      /* ignore */
    }
    setCopied(k);
    setTimeout(() => setCopied(''), 1500);
  };
  const stages = ['awaiting_dns', 'verifying', 'certificate_pending', 'ready'] as const;
  const cur = checking ? 1 : status ? (status.state === 'failed' ? 1 : stages.indexOf(status.state as (typeof stages)[number])) : -1;

  return (
    <div className="flex flex-col gap-4 rounded-xl border-[1.5px] border-line-soft p-5">
      <div className="flex flex-wrap items-end gap-2">
        <div className="min-w-[220px] flex-1">
          <Field label={t('hostname')} hint={t('hostnameHint')} error={localErr || err.domain}>
            {(p) => <Input id={p.id} aria-invalid={p.invalid} aria-describedby={p.describedBy} value={host} onChange={(e) => setHost(e.target.value)} placeholder="www.yourbusiness.example" disabled={!!status} />}
          </Field>
        </div>
        {!status ? (
          <Button onClick={start}>{t('continue')}</Button>
        ) : (
          <Button variant="ghost" onClick={() => (setStatus(null), set('domainPrimary', false))}>
            {t('change')}
          </Button>
        )}
      </div>
      {status && (
        <>
          <ol className="grid grid-cols-2 gap-2 sm:grid-cols-4" aria-label={t('statusLabel')}>
            {stages.map((s, i) => {
              const failedHere = !checking && status.state === 'failed' && i === 1;
              const passed = status.state === 'ready' || i < cur;
              const active = i === cur && !failedHere;
              return (
                <li key={s} aria-current={active ? 'step' : undefined} className={cx('flex items-center gap-2 rounded-full px-3 py-2 text-xs font-bold', failedHere ? 'bg-blush' : active && status.state !== 'ready' ? 'bg-ink text-white' : passed ? 'bg-lime' : 'bg-canvas')}>
                  <Icon name={failedHere ? 'alert' : passed ? 'check' : s === 'awaiting_dns' ? 'clock' : s === 'verifying' ? 'refresh' : s === 'certificate_pending' ? 'shield' : 'check-circle'} size={14} />
                  {failedHere ? t('state.failed') : t(`state.${s}`)}
                </li>
              );
            })}
          </ol>
          <div>
            <h3 className="mb-2 text-sm font-bold">{t('records')}</h3>
            <div className="overflow-x-auto">
              <table className="w-full min-w-[520px] text-left text-[13px]">
                <thead>
                  <tr className="text-xs text-stone">
                    <th className="py-1.5 pr-3 font-bold">{t('type')}</th>
                    <th className="py-1.5 pr-3 font-bold">{t('name')}</th>
                    <th className="py-1.5 pr-3 font-bold">{t('value')}</th>
                    <th className="py-1.5 font-bold">{t('found')}</th>
                  </tr>
                </thead>
                <tbody>
                  {status.records.map((r) => (
                    <tr key={r.type} className="border-t border-line-soft">
                      <td className="py-2.5 pr-3 font-bold">{r.type}</td>
                      <td className="py-2.5 pr-3 font-mono text-xs">{r.name}</td>
                      <td className="py-2.5 pr-3">
                        <span className="flex items-center gap-2">
                          <code className="rounded bg-canvas px-1.5 py-0.5 text-xs">{r.value}</code>
                          <button type="button" onClick={() => copy(r.type, r.value)} className="inline-flex items-center gap-1 rounded-full border border-line px-2 py-0.5 text-[11px] font-bold" aria-label={t('copyValue', { type: r.type })}>
                            <Icon name={copied === r.type ? 'check' : 'copy'} size={11} />
                            {copied === r.type ? t('copied') : t('copy')}
                          </button>
                        </span>
                      </td>
                      <td className="py-2.5">{r.found ? <Badge tone="success">{t('yes')}</Badge> : <Badge tone="neutral" icon="minus">{t('notYet')}</Badge>}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            <p className="mt-2 text-xs text-stone">{t('emailSafe')}</p>
          </div>
          {status.state === 'failed' && !checking && (
            <Banner tone="danger" title={t('failedTitle')} live="assertive">
              {status.message}
            </Banner>
          )}
          {(checking || status.state === 'verifying' || status.state === 'certificate_pending') && (
            <Banner tone="info" icon="refresh" live="polite">
              {checking || status.state === 'verifying' ? t('verifying') : status.message}
            </Banner>
          )}
          {status.state === 'ready' ? (
            <div className="flex flex-col gap-3 rounded-lg bg-lime p-4">
              <div className="flex items-center gap-2 text-base font-bold">
                <Icon name="shield" size={18} />
                {t('readyTitle', { host: status.hostname })}
              </div>
              <label className="flex items-center gap-2 text-sm">
                <input type="checkbox" checked={data.domainPrimary} onChange={(e) => set('domainPrimary', e.target.checked)} className="h-4 w-4 accent-ink" />
                {t('makePrimary')}
              </label>
              <p className="text-xs">{t('redirectNote', { included })}</p>
            </div>
          ) : (
            <div className="flex flex-wrap gap-2">
              <Button icon="refresh" loading={checking} disabled={status.state === 'verifying' || status.state === 'certificate_pending'} onClick={verify}>
                {status.state === 'failed' ? t('checkAgain') : t('verify')}
              </Button>
            </div>
          )}
          <p className="text-xs text-stone">{t('keepsWorking', { included })}</p>
        </>
      )}
    </div>
  );
}

function DataStep({ data, set, err = {} }: StepProps) {
  const t = useTranslations('onboarding');
  const [v, setV] = useState('');
  return (
    <div className="flex flex-col gap-3">
      {err.items && <Banner tone="danger" live="assertive">{err.items}</Banner>}
      <ul className="flex flex-col gap-1.5">
        {data.items.map((it, i) => (
          <li key={i} className="flex items-center gap-3 rounded-md bg-canvas-raised px-3.5 py-3 text-sm">
            <Icon name={INDUSTRY_UI[data.industry].icon} size={16} />
            <span className="flex-1 font-semibold">{it}</span>
            <button type="button" onClick={() => set('items', data.items.filter((_, j) => j !== i))} aria-label={t('removeItem', { item: it })} className="rounded-full p-1.5 hover:bg-canvas">
              <Icon name="x" size={14} />
            </button>
          </li>
        ))}
      </ul>
      <form
        className="flex flex-wrap gap-2"
        onSubmit={(e) => {
          e.preventDefault();
          if (v.trim()) {
            set('items', [...data.items, v.trim()]);
            setV('');
          }
        }}
      >
        <label className="min-w-[220px] flex-1">
          <span className="sr-only">{t(`industry.${data.industry}.itemSingular`)}</span>
          <Input value={v} onChange={(e) => setV(e.target.value)} placeholder={t(`industry.${data.industry}.itemPh`)} />
        </label>
        <Button type="submit" variant="secondary" icon="plus">
          {t('addItem')}
        </Button>
      </form>
      <p className="text-xs text-stone">{t('itemsNote')}</p>
    </div>
  );
}

type ConnStatus = 'available' | 'requires_setup' | 'tested' | 'later';
const CONN_OPTS: Record<IndustryKey, [string, ConnStatus][]> = {
  studios: [['keep', 'requires_setup'], ['native', 'later'], ['none', 'available']],
  sports: [['native', 'available'], ['keep', 'later']],
  wellness: [['native', 'available'], ['keep', 'later']],
  commerce: [['keep', 'tested'], ['native', 'later']],
  foods: [['native', 'available'], ['keep', 'later']],
  realty: [['native', 'available'], ['keep', 'later']],
  hospitality: [['native', 'available'], ['keep', 'later']],
};
const CONN_TONE: Record<ConnStatus, 'success' | 'warning' | 'neutral'> = { available: 'success', tested: 'success', requires_setup: 'warning', later: 'neutral' };

function ConnectStep({ data, set }: StepProps) {
  const t = useTranslations('onboarding.connectStep');
  return (
    <div className="flex flex-col gap-6">
      <fieldset className="flex flex-col gap-2.5">
        <legend className="mb-2 text-sm font-bold">{t(`legend.${data.industry}`)}</legend>
        {CONN_OPTS[data.industry].map(([k, st]) => (
          <Choice key={k} name="conn" checked={data.conn === k} onChange={() => set('conn', k)} title={t(`opt.${data.industry}.${k}.title`)} body={t(`opt.${data.industry}.${k}.body`)} badge={<Badge tone={CONN_TONE[st]} icon={st === 'later' ? 'clock' : null}>{t(`status.${st}`)}</Badge>} disabled={st === 'later'} />
        ))}
      </fieldset>
      <div className="flex flex-col gap-3 rounded-lg bg-canvas p-5">
        <div className="flex flex-wrap items-center gap-2">
          <Icon name="card" size={18} />
          <strong className="flex-1">{t('payTitle')}</strong>
          <Badge tone={data.pay === 'enabled' ? 'success' : data.pay === 'pending' ? 'warning' : 'neutral'}>{t(`pay.${data.pay}`)}</Badge>
        </div>
        <p className="text-[13px] text-stone">{t('payBody')}</p>
        {data.pay === 'not' && (
          <Button variant="secondary" className="self-start" onClick={() => set('pay', 'pending')}>
            {t('payStart')}
          </Button>
        )}
        {data.pay === 'pending' && (
          <Button variant="secondary" className="self-start" onClick={() => set('pay', 'enabled')}>
            {t('paySimulate')}
          </Button>
        )}
      </div>
      <p className="text-xs text-stone">{t('nothingCopied')}</p>
    </div>
  );
}

function TeamStep({ data, set }: StepProps) {
  const t = useTranslations('onboarding.teamStep');
  const ta = useTranslations('access.shape');
  const roleName = useRoleName();
  const [email, setEmail] = useState('');
  const [role, setRole] = useState('location_manager');
  const [e, setE] = useState('');
  const network = data.model !== 'independent';
  // Suggested roles follow the team shape: separate teams, combined roles for a small team, or the basics.
  const roles = data.teamShape === 'full'
    ? ['hq_admin', 'development_lead', 'sales_lead', 'marketing_lead', 'operations_lead', 'field_consultant', 'finance_lead', 'location_manager', 'staff']
    : ['hq_admin', 'location_manager', 'staff', 'content_social', 'sales_rep', 'finance_lead'];
  return (
    <div className="flex flex-col gap-4">
      {network && (
        <section className="flex flex-col gap-2" aria-labelledby="onboarding-shape">
          <h3 id="onboarding-shape" className="text-sm font-bold">{ta('onboardingTitle')}</h3>
          <p className="text-xs text-stone">{ta('onboardingIntro')}</p>
          <ShapeChoices value={data.teamShape ?? null} onChange={(s) => set('teamShape', s)} name="onboarding-team-shape" />
          {data.teamShape === 'small' && <p className="text-xs text-stone">{ta('smallNote')}</p>}
        </section>
      )}
      <ul className="flex flex-col gap-1.5">
        {data.invites.map((i, n) => (
          <li key={n} className="flex flex-wrap items-center gap-3 rounded-md bg-canvas-raised px-3.5 py-3 text-sm">
            <Icon name="mail" size={16} />
            <span className="flex-1 font-semibold">{i.email}</span>
            <Badge tone="neutral" icon={null}>{roleName(i.role)}</Badge>
            <span className="text-xs text-stone">{i.location}</span>
            <button type="button" onClick={() => set('invites', data.invites.filter((_, j) => j !== n))} aria-label={t('remove', { email: i.email })} className="rounded-full p-1.5 hover:bg-canvas">
              <Icon name="x" size={14} />
            </button>
          </li>
        ))}
      </ul>
      <div className="grid gap-3 md:grid-cols-[1fr_220px_auto] md:items-end">
        <Field label={t('email')} error={e}>{(p) => <Input id={p.id} type="email" aria-invalid={p.invalid} aria-describedby={p.describedBy} value={email} onChange={(ev) => setEmail(ev.target.value)} />}</Field>
        <Field label={t('role')}>
          {(p) => (
            <Select id={p.id} value={role} onChange={(ev) => setRole(ev.target.value)}>
              {roles.map((r) => (
                <option key={r} value={r}>
                  {roleName(r)}
                </option>
              ))}
            </Select>
          )}
        </Field>
        <Button
          variant="secondary"
          icon="plus"
          onClick={() => {
            if (!/^\S+@\S+\.\S+$/.test(email)) return setE(t('invalid'));
            setE('');
            set('invites', [...data.invites, { email, role, location: data.loc.name }]);
            setEmail('');
          }}
        >
          {t('add')}
        </Button>
      </div>
      <p className="text-xs text-stone">{t('note', { location: data.loc.name })}</p>
    </div>
  );
}

function PublishStep({ data, set, blockers, go, onPublish }: StepProps & { blockers: { label: string; step: OnboardingStep }[]; go: (s: OnboardingStep) => void; onPublish: () => void }) {
  const t = useTranslations('onboarding.publish');
  const ti = useTranslations('onboarding');
  const [testing, setTesting] = useState(false);
  const [publishing, setPublishing] = useState(false);
  const ts = useTranslations('single.onboarding');
  const independent = data.model === 'independent';
  const [publishError, setPublishError] = useState('');
  const errorText = useErrorText();
  const live = data.address === 'domain' && data.domainPrimary && data.domain ? `https://${data.domain}` : independent ? `https://sites.branchharbor.com/${slug(data.biz.name)}` : `https://sites.branchharbor.com/${slug(data.biz.name)}/${slug(data.loc.name)}`;
  const checks = [
    independent
      ? { ok: blockers.every((b) => b.step !== 'business'), label: ts('checkBusiness'), note: [data.loc.line1, data.loc.city, data.biz.timeZone].filter(Boolean).join(' · '), step: 'business' as const }
      : { ok: blockers.every((b) => b.step !== 'location'), label: t('check.location'), note: `${data.loc.name} · ${data.loc.timeZone}`, step: 'location' as const },
    { ok: blockers.every((b) => b.step !== 'website'), label: t('check.website'), note: data.site === 'wordpress' ? t('viaWordPress') : live, step: 'website' as const },
    { ok: data.items.length > 0, label: t('check.items'), note: t('itemsCount', { count: data.items.length }), step: 'data' as const },
    { ok: data.pay === 'enabled', warn: true, label: t('check.payments'), note: data.pay === 'enabled' ? t('payOn') : t('payOff'), step: 'connect' as const },
    { ok: data.tested, warn: true, label: t('check.test'), note: data.tested ? t('tested') : t('notTested'), test: true },
  ];
  if (data.published)
    return (
      <div className="flex flex-col gap-4">
        <Banner tone="success" title={t('publishedTitle')} live="polite">
          {t('publishedBody', { address: live })}
        </Banner>
        <div className="flex flex-wrap gap-2">
          <Link href="/overview" className="inline-flex h-11 items-center gap-2 rounded-full bg-ink px-5 text-sm font-bold text-white">
            {t('goToDashboard')}
            <Icon name="arrow-right" size={16} />
          </Link>
          <Button variant="secondary" onClick={() => set('published', false)}>
            {ti('back')}
          </Button>
        </div>
      </div>
    );
  return (
    <div className="grid gap-5 lg:grid-cols-[1fr_1fr]">
      <div className="rounded-xl p-3.5" style={{ background: INDUSTRY_UI[data.industry].pastel }}>
        <div className="overflow-hidden rounded-card bg-surface">
          <div className="flex items-center gap-1.5 border-b border-line-soft px-3.5 py-2.5 text-xs text-stone">
            <Icon name="eye" size={14} />
            <span className="truncate font-mono">{live}</span>
          </div>
          <div className="flex flex-col gap-3 p-5">
            <div className="text-xs font-bold text-stone">{data.biz.name}</div>
            <div className="text-2xl font-extrabold leading-tight tracking-tight">{t('previewHeadline', { location: data.loc.name.split(' – ').pop() ?? data.loc.name })}</div>
            <ul className="flex flex-col gap-1.5">
              {data.items.slice(0, 3).map((it) => (
                <li key={it} className="flex items-center justify-between gap-2 rounded-md bg-canvas px-3 py-2 text-[13px]">
                  <span className="font-semibold">{it}</span>
                  <span className={cx('rounded-full px-3 py-1 text-xs font-bold', data.pay === 'enabled' ? 'bg-ink text-white' : 'bg-surface text-stone')}>{data.pay === 'enabled' ? t(`cta.${data.industry}`) : t('enquire')}</span>
                </li>
              ))}
            </ul>
            {data.pay !== 'enabled' && <p className="text-[11px] text-stone">{t('purchaseHidden')}</p>}
          </div>
        </div>
      </div>
      <div className="flex flex-col gap-3">
        <h2 className="text-base font-bold">{t('readiness')}</h2>
        <ul className="flex flex-col gap-1.5">
          {checks.map((c) => (
            <li key={c.label} className={cx('flex flex-wrap items-center gap-3 rounded-md px-3.5 py-3 text-sm', c.ok ? 'bg-success-bg' : c.warn ? 'bg-warning-bg' : 'bg-danger-bg')}>
              <Icon name={c.ok ? 'check-circle' : 'alert'} size={18} className={c.ok ? 'text-success' : c.warn ? 'text-warning' : 'text-danger'} />
              <span className="min-w-0 flex-1">
                <span className="block font-bold">{c.label}</span>
                <span className="block truncate text-xs text-graphite">{c.note}</span>
              </span>
              {!c.ok &&
                (c.test ? (
                  <Button
                    size="sm"
                    variant="secondary"
                    loading={testing}
                    onClick={() => {
                      setTesting(true);
                      setTimeout(() => (setTesting(false), set('tested', true)), 900);
                    }}
                  >
                    {t('runTest')}
                  </Button>
                ) : (
                  <Button size="sm" variant="secondary" onClick={() => c.step && go(c.step)}>
                    {c.step === 'connect' ? t('setUp') : t('fix')}
                  </Button>
                ))}
            </li>
          ))}
        </ul>
        {blockers.length > 0 && (
          <Banner tone="danger" title={t('blockedTitle')}>
            <ul className="mt-1 flex flex-col gap-1">
              {blockers.map((b) => (
                <li key={b.label} className="flex flex-wrap items-center gap-2">
                  {b.label}
                  <button type="button" className="text-xs font-bold underline" onClick={() => go(b.step)}>
                    {t('repair')}
                  </button>
                </li>
              ))}
            </ul>
          </Banner>
        )}
        <Button
          size="lg"
          variant="signal"
          disabled={blockers.length > 0}
          loading={publishing}
          onClick={async () => {
            setPublishing(true);
            setPublishError('');
            if (independent) {
              // Independent businesses publish for real: one site, one "Publish".
              try {
                await (await getApi()).business.publish({ industry: data.industry, role: 'hq', scopeId: 'all', business: 'independent' });
              } catch (e) {
                setPublishError(e instanceof ApiError ? errorText(e) : e instanceof Error ? e.message : String(e));
                setPublishing(false);
                return;
              }
            } else {
              await new Promise((r) => setTimeout(r, 900));
            }
            set('published', true);
            setPublishing(false);
            onPublish();
          }}
          data-testid="onboarding-publish"
        >
          {t('publish')}
        </Button>
        {publishError && <Banner tone="danger" live="assertive">{publishError}</Banner>}
        <p className="text-xs text-stone">{t('publishNote')}</p>
      </div>
    </div>
  );
}
