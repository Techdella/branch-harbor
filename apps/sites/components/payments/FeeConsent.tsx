'use client';

import { useEffect, useState } from 'react';
import { useLocale, useTranslations } from 'next-intl';
import { call } from '@/lib/client';
import { FeePolicyLines } from './CardPayment';

type Policy = Parameters<typeof FeePolicyLines>[0]['policy'];

/**
 * Fee-charging consent for a booking that needed no card payment (credits, membership, free): shows the late-cancel /
 * no-show policy and records the customer's agreement. Hidden when the booking has no fee policy.
 */
export function FeeConsent({ targetType, targetId, manageToken }: { targetType: 'class_booking' | 'appointment'; targetId: string; manageToken: string }) {
  const t = useTranslations('payment');
  const locale = useLocale();
  const [data, setData] = useState<{ policy: Policy | null; consented: boolean; business: string } | null>(null);
  const [checked, setChecked] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  useEffect(() => {
    void call<{ policy: Policy | null; consented: boolean; business: string }>('GET', `/public/payments/fee-policy?targetType=${targetType}&targetId=${targetId}&manageToken=${encodeURIComponent(manageToken)}`).then((r) => { if (r.ok) setData(r.data); });
  }, [targetType, targetId, manageToken]);
  if (!data?.policy) return null;
  if (data.consented) return <p role="status" className="mt-4 text-sm text-graphite">{t('feeConsentSaved')}</p>;
  const text = t('feeConsentBooking', { business: data.business });
  return (
    <div className="mt-4 space-y-2 text-start text-sm" data-testid="fee-consent">
      <FeePolicyLines policy={data.policy} locale={locale} />
      <label className="flex items-start gap-3">
        <input type="checkbox" className="mt-0.5 size-5 shrink-0 accent-[var(--site-brand)]" checked={checked} onChange={async (e) => {
          setChecked(e.target.checked);
          if (!e.target.checked) return;
          const r = await call('POST', '/public/payments/fee-consent', { targetType, targetId, manageToken, text, locale });
          if (r.ok) setData({ ...data, consented: true });
          else { setChecked(false); setErr(r.error.message); }
        }} />
        <span>{text}</span>
      </label>
      {err && <p role="alert" className="font-semibold text-danger">{err}</p>}
    </div>
  );
}
