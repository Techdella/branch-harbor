'use client';

import { useEffect, useState } from 'react';
import { useLocale, useTranslations } from 'next-intl';
import { Badge, Button, Field, Input, Select, Toggle } from '@bh/ui';
import { SUPPORTED_CURRENCIES } from '@bh/shared';
import type { OrgSettings } from '@/lib/types';
import { useApi, useMutation } from '@/lib/useApi';
import { currencyName } from '@/lib/format';
import { APP_LOCALES, APP_LOCALE_LABELS } from '@/i18n/config';
import { useApp } from '../shell/AppContext';
import { PageHeader } from '../shell/PageHeader';
import { LanguageSelect } from '../shell/TopBar';
import { Async, Banner, DeniedState, LoadingBlock, SectionCard } from '../ui/States';
import { COUNTRY_ZONES } from './LocationWizard';
import { AddLocationCard, BusinessLocationCard, WebsiteApprovalsCard } from './independent/BusinessSettings';
import { BillingLinkCard } from './billing/BillingLinkCard';
import { DataExportCard } from './billing/DataExportCard';
import { MarinaSettingsCard } from '../marina/MarinaSettings';

export function SettingsScreen() {
  const t = useTranslations('settings');
  const locale = useLocale();
  const app = useApp();
  const res = useApi((api) => api.settings.get(app.ctx), [app.industry, app.role], app.can('org.manage'));
  const [form, setForm] = useState<OrgSettings | null>(null);
  const [ok, setOk] = useState(false);
  const save = useMutation((api, s: Partial<OrgSettings>) => api.settings.save(app.ctx, s));
  // Independent businesses: location details, Solo billing, website approvals and "Add a location" live here.
  const independent = app.org.model === 'independent';
  useEffect(() => {
    if (res.status === 'ready') setForm(res.data);
  }, [res.status, res.data]);

  return (
    <>
      <PageHeader icon="settings" title={t('title')} scope={false} />
      <SectionCard title={t('personal')}>
        <div className="max-w-sm">
          <p className="mb-2 text-sm text-stone">{t('languageHint')}</p>
          <LanguageSelect />
        </div>
      </SectionCard>
      {app.hasModule('ai.assistant') && <MarinaSettingsCard />}
      {!app.can('org.manage') ? (
        <DeniedState permission="org.manage" detail={t('orgDenied')} />
      ) : (
        <Async res={res} permission="org.manage" loading={<LoadingBlock variant="detail" />}>
          {() =>
            form && (
              <>
                {ok && <Banner tone="success" live="polite">{t('saved')}</Banner>}
                {save.error && <Banner tone="danger" live="assertive">{save.error.message}</Banner>}
                <SectionCard title={t('business')}>
                  <div className="grid gap-3.5 md:grid-cols-2">
                    <Field label={t('businessName')}>{(p) => <Input id={p.id} value={form.businessName} onChange={(e) => setForm({ ...form, businessName: e.target.value })} />}</Field>
                    <Field label={t('legalName')}>{(p) => <Input id={p.id} value={form.legalName} onChange={(e) => setForm({ ...form, legalName: e.target.value })} />}</Field>
                  </div>
                </SectionCard>
                {independent && <BusinessLocationCard />}
                {!independent && (
                <SectionCard title={t('defaults')} aside={<span className="text-xs text-stone">{t('defaultsHint')}</span>}>
                  <div className="grid gap-3.5 md:grid-cols-3">
                    <Field label={t('defaultLanguage')}>
                      {(p) => (
                        <Select id={p.id} value={form.defaultLocale} onChange={(e) => setForm({ ...form, defaultLocale: e.target.value })}>
                          {APP_LOCALES.map((l) => (
                            <option key={l} value={l}>
                              {APP_LOCALE_LABELS[l]}
                            </option>
                          ))}
                        </Select>
                      )}
                    </Field>
                    <Field label={t('defaultCurrency')} hint={t('currencyHint')}>
                      {(p) => (
                        <Select id={p.id} aria-describedby={p.describedBy} value={form.defaultCurrency} onChange={(e) => setForm({ ...form, defaultCurrency: e.target.value as OrgSettings['defaultCurrency'] })}>
                          {SUPPORTED_CURRENCIES.map((c) => (
                            <option key={c} value={c}>
                              {c} · {currencyName(c, locale)}
                            </option>
                          ))}
                        </Select>
                      )}
                    </Field>
                    <Field label={t('defaultTimeZone')} error={save.error?.fields?.defaultTimeZone}>
                      {(p) => (
                        <Select id={p.id} value={form.defaultTimeZone} onChange={(e) => setForm({ ...form, defaultTimeZone: e.target.value })}>
                          {[...new Set(Object.values(COUNTRY_ZONES).flat())].map((z) => (
                            <option key={z} value={z}>
                              {z.replace(/_/g, ' ')}
                            </option>
                          ))}
                        </Select>
                      )}
                    </Field>
                  </div>
                </SectionCard>
                )}
                <SectionCard title={t('dataPolicies')}>
                  <div className="flex flex-col gap-4">
                    <div className="flex flex-wrap items-center justify-between gap-3">
                      <div>
                        <div className="text-sm font-bold">{t('dataRegion')}</div>
                        <div className="text-xs text-stone">{t('dataRegionHint')}</div>
                      </div>
                      <Badge tone="neutral" icon="lock">{t(`region.${form.dataRegion}`)}</Badge>
                    </div>
                    {!independent && (
                    <Field label={t('sharing')} hint={t('sharingHint')}>
                      {(p) => (
                        <Select id={p.id} aria-describedby={p.describedBy} value={form.customerSharing} onChange={(e) => setForm({ ...form, customerSharing: e.target.value as OrgSettings['customerSharing'] })}>
                          {(['off', 'totals_only', 'shared'] as const).map((k) => (
                            <option key={k} value={k}>
                              {t(`sharingOpt.${k}`)}
                            </option>
                          ))}
                        </Select>
                      )}
                    </Field>
                    )}
                    <div className="flex items-center justify-between gap-3">
                      <div>
                        <div className="text-sm font-bold">{t('aiTraining')}</div>
                        <div className="text-xs text-stone">{t('aiTrainingHint')}</div>
                      </div>
                      <Toggle checked={form.aiTraining} onChange={(v) => setForm({ ...form, aiTraining: v })} label={t('aiTraining')} />
                    </div>
                  </div>
                </SectionCard>
                <div className="flex justify-end">
                  <Button
                    loading={save.pending}
                    onClick={async () => {
                      setOk(false);
                      const r = await save.run(form);
                      if (r) setOk(true);
                    }}
                  >
                    {t('save')}
                  </Button>
                </div>
                {independent && <WebsiteApprovalsCard />}
                {independent && <AddLocationCard startOpen={typeof window !== 'undefined' && window.location.hash === '#add-location'} />}
                <BillingLinkCard />
              </>
            )
          }
        </Async>
      )}
      <DataExportCard />
    </>
  );
}
