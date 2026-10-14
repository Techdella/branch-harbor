import type { Metadata } from 'next';
import { notFound } from 'next/navigation';
import { getLocale, getTranslations } from 'next-intl/server';
import { BuyButton } from '@/components/studios/Commerce';
import { apiGet } from '@/lib/api';
import { money } from '@/lib/format';
import { getRouting, loadLocation, makeLinks } from '@/lib/site';

type Money = { amount: number; currency: string };
interface Pricing {
  location: { id: string; name: string; currency: string; paymentsEnabled: boolean };
  packs: Array<{ id: string; name: string; description: string | null; credits: number; validityDays: number; price: Money; perClass: Money; access: string }>;
  memberships: Array<{ id: string; name: string; description: string | null; classesPerPeriod: number | null; price: Money & { interval: string }; access: string; terms: string[] }>;
  offers: Array<{ id: string; name: string; description: string | null; kind: string; credits: number | null; validDays: number; price: Money; newCustomersOnly: boolean }>;
  policy: { lines: string[] };
}
type Props = { params: Promise<{ brand: string; location: string }> };

export async function generateMetadata({ params }: Props): Promise<Metadata> {
  const { brand, location } = await params;
  const data = await loadLocation(brand, location);
  const t = await getTranslations('studio');
  const links = makeLinks(await getRouting(), brand, { brandPrimaryHost: data.site.brandPrimaryHost });
  return { title: `${t('pricingTitle')} · ${data.brand.name} ${data.location.name}`, alternates: { canonical: links.locationCanonical(location, data.site.primaryHost, '/pricing') } };
}

export default async function PricingPage({ params }: Props) {
  const { brand, location } = await params;
  const data = await loadLocation(brand, location);
  if (data.module.kind !== 'studios' || data.module.mode !== 'native') notFound();
  const t = await getTranslations('studio');
  const locale = await getLocale();
  const links = makeLinks(await getRouting(), brand, { brandPrimaryHost: data.site.brandPrimaryHost });
  const p = await apiGet<Pricing>(`/v1/public/studios/${data.location.id}/pricing`);
  const account = links.location(location, '/account');
  const sellable = p.location.paymentsEnabled;
  const Card = ({ title, price, lines, children }: { title: string; price: string; lines: Array<string | null>; children: React.ReactNode }) => (
    <article className="card flex flex-col gap-3 p-5">
      <h3 className="text-lg font-extrabold">{title}</h3>
      <p className="text-2xl font-extrabold tabular">{price}</p>
      <ul className="flex-1 space-y-1 text-sm text-graphite">{lines.filter(Boolean).map((l) => <li key={l!}>{l}</li>)}</ul>
      {children}
    </article>
  );
  return (
    <main id="main" className="mx-auto max-w-5xl space-y-8 px-4 py-10">
      <div>
        <h1 className="text-3xl font-extrabold tracking-tight">{t('pricingTitle')}</h1>
        <p className="mt-1 text-graphite">{t('pricingIntro', { location: `${data.brand.name} ${data.location.name}`, currency: p.location.currency })}</p>
        {!sellable && <p className="mt-3 rounded-2xl bg-warning-bg p-4 text-sm text-warning">{t('notSellable')}</p>}
      </div>
      {p.offers.length > 0 && (
        <section aria-labelledby="offers-h" className="space-y-3">
          <h2 id="offers-h" className="text-xl font-extrabold">{t('introOffers')}</h2>
          <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
            {p.offers.map((o) => (
              <Card key={o.id} title={o.name} price={o.price.amount ? money(o.price, locale) : t('free')} lines={[o.description, o.credits ? t('creditsValid', { n: o.credits, days: o.validDays }) : t('unlimitedDays', { days: o.validDays }), o.newCustomersOnly ? t('newOnly') : null]}>
                <BuyButton brand={brand} locationId={data.location.id} kind="offer" offerId={o.id} label={t('getOffer')} accountPath={account} disabled={!sellable && o.price.amount > 0} />
              </Card>
            ))}
          </div>
        </section>
      )}
      <section aria-labelledby="mem-h" className="space-y-3">
        <h2 id="mem-h" className="text-xl font-extrabold">{t('memberships')}</h2>
        <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
          {p.memberships.map((m) => (
            <Card key={m.id} title={m.name} price={`${money(m.price, locale)} / ${t('month')}`} lines={[m.description, m.access, ...m.terms]}>
              <BuyButton brand={brand} locationId={data.location.id} kind="membership" productId={m.id} label={t('join')} accountPath={account} disabled={!sellable} />
            </Card>
          ))}
          {p.memberships.length === 0 && <p className="text-graphite">{t('noneHere')}</p>}
        </div>
      </section>
      <section aria-labelledby="packs-h" className="space-y-3">
        <h2 id="packs-h" className="text-xl font-extrabold">{t('packs')}</h2>
        <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
          {p.packs.map((k) => (
            <Card key={k.id} title={k.name} price={money(k.price, locale)} lines={[k.description, t('creditsValid', { n: k.credits, days: k.validityDays }), t('perClass', { amount: money(k.perClass, locale) }), k.access]}>
              <BuyButton brand={brand} locationId={data.location.id} kind="pack" productId={k.id} label={t('buy')} accountPath={account} disabled={!sellable} />
            </Card>
          ))}
          {p.packs.length === 0 && <p className="text-graphite">{t('noneHere')}</p>}
        </div>
      </section>
      <section className="card p-5">
        <h2 className="font-extrabold">{t('policyTitle')}</h2>
        <ul className="mt-2 list-disc space-y-1 ps-5 text-sm text-graphite">{p.policy.lines.map((l) => <li key={l}>{l}</li>)}</ul>
      </section>
    </main>
  );
}
