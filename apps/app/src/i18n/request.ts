import { getRequestConfig } from 'next-intl/server';
import { cookies, headers } from 'next/headers';
import { LOCALE_COOKIE, resolveAppLocale } from './config';
import en from '../../messages/en.json';
import singleEn from '../../messages/single/en.json';
import foodsEn from '../../messages/foods/en.json';
import partnersEn from '../../messages/partners/en.json';
import paymentsEn from '../../messages/payments/en.json';
import dataEn from '../../messages/data/en.json';
import accessEn from '../../messages/access/en.json';
import franchiseEn from '../../messages/franchise/en.json';
import networkEn from '../../messages/network/en.json';
import commsEn from '../../messages/comms/en.json';
import mktEn from '../../messages/mkt/en.json';
import financeEn from '../../messages/finance/en.json';
import reviewsEn from '../../messages/reviews/en.json';
import billingEn from '../../messages/billing/en.json';
import qualityEn from '../../messages/quality/en.json';
import marinaEn from '../../messages/marina/en.json';
import scaleEn from '../../messages/scale/en.json';
import supplyEn from '../../messages/supply/en.json';
import localMktEn from '../../messages/localmkt/en.json';
import brandsEn from '../../messages/brands/en.json';

type Messages = Record<string, unknown>;

/** Deep-merge so any key missing in a translation falls back to English. */
function merge(base: Messages, over: Messages): Messages {
  const out: Messages = { ...base };
  for (const [k, v] of Object.entries(over)) {
    const b = base[k];
    out[k] = v && typeof v === 'object' && !Array.isArray(v) && b && typeof b === 'object' ? merge(b as Messages, v as Messages) : v;
  }
  return out;
}

export default getRequestConfig(async () => {
  const store = await cookies();
  let raw = store.get(LOCALE_COOKIE)?.value;
  if (!raw) {
    const accept = (await headers()).get('accept-language') ?? '';
    raw = accept.split(',')[0]?.split(';')[0];
  }
  const locale = resolveAppLocale(raw);
  // Independent-business strings live in messages/single/*.json (namespace "single") and foods strings in
  // messages/foods/*.json so they merge cleanly.
  // Partner integrations (delivery partners, POS, property portals): namespace "partners" in messages/partners/*.json.
  // Text the data layer builds (metrics, history entries, roles…) is referenced by key: namespace "data" in messages/data/*.json.
  let messages: Messages = merge({ ...(en as Messages), single: singleEn as Messages, partners: partnersEn as Messages, data: dataEn as Messages }, foodsEn as Messages);
  messages = merge(messages, paymentsEn as Messages);
  // Access model (workspaces, modules, roles, Team & access) and the demo site: namespaces "access" and "demo".
  messages = merge(messages, accessEn as Messages);
  // Franchise development, onboarding and legal: messages/franchise/*.json (namespace "franchise" plus its apiError codes).
  messages = merge(messages, franchiseEn as Messages);
  // Network workspaces (Community, Training academy, Help desk): messages/network/*.json, merged at the root.
  messages = merge(messages, networkEn as Messages);
  // Marketing & sales communications (inbox, social, ad campaigns, leads): namespace "comms" plus nav/module/error keys.
  messages = merge(messages, commsEn as Messages);
  // Marketing workspace (website builder, email, automations, forms, brand assets): namespace "mkt" in messages/mkt/*.json.
  messages = merge(messages, mktEn as Messages);
  // Finance workspace (royalties, statements & invoices, marketing fund, payouts): namespace "finance" plus its nav and module names.
  messages = merge(messages, financeEn as Messages);
  // Marketing → Reviews and bank-debit royalty collection / monthly statements: namespaces "reviews" and "royaltyDebit".
  messages = merge(messages, reviewsEn as Messages);
  // BranchHarbor plan billing (paid trial, checkout, who pays per location, data export): namespace "billing" plus shell keys.
  messages = merge(messages, billingEn as Messages);
  // Field audits, compliance documents and the league table: namespace "quality" plus its nav and module names.
  messages = merge(messages, qualityEn as Messages);
  // The AI assistant (panel, command bar, briefing, insights, visit brief, content studio): namespace "marina".
  messages = merge(messages, marinaEn as Messages);
  // Sales connectors and reconciliation, the import wizard, bulk launch and network benchmarks: namespace "scale" plus nav, module and error keys.
  messages = merge(messages, scaleEn as Messages);
  // Suppliers, supplier rebates, audits phase 2 and self-checks: namespaces "supply" and "auditsPlus" plus nav and module names.
  messages = merge(messages, supplyEn as Messages);
  // Local marketing (listings, co-op fund, call tracking, content calendar, reviews in the inbox): namespace "lmk" plus nav, module and error keys.
  messages = merge(messages, localMktEn as Messages);
  // Multi-brand HQ (brand switcher, Settings → Brands, brand comparison): namespace "brands".
  messages = merge(messages, brandsEn as Messages);
  if (locale !== 'en') {
    const translated = (await import(`../../messages/${locale}.json`)).default as Messages;
    const single = (await import(`../../messages/single/${locale}.json`)).default as Messages;
    const partners = (await import(`../../messages/partners/${locale}.json`)).default as Messages;
    const data = (await import(`../../messages/data/${locale}.json`)).default as Messages;
    messages = merge(messages, { ...translated, single, partners, data });
    messages = merge(messages, (await import(`../../messages/foods/${locale}.json`)).default as Messages);
    messages = merge(messages, (await import(`../../messages/payments/${locale}.json`)).default as Messages);
    messages = merge(messages, (await import(`../../messages/access/${locale}.json`)).default as Messages);
    messages = merge(messages, (await import(`../../messages/franchise/${locale}.json`)).default as Messages);
    messages = merge(messages, (await import(`../../messages/network/${locale}.json`)).default as Messages);
    messages = merge(messages, (await import(`../../messages/comms/${locale}.json`)).default as Messages);
    messages = merge(messages, (await import(`../../messages/mkt/${locale}.json`)).default as Messages);
    messages = merge(messages, (await import(`../../messages/finance/${locale}.json`)).default as Messages);
    messages = merge(messages, (await import(`../../messages/reviews/${locale}.json`)).default as Messages);
    messages = merge(messages, (await import(`../../messages/billing/${locale}.json`)).default as Messages);
    messages = merge(messages, (await import(`../../messages/quality/${locale}.json`)).default as Messages);
    messages = merge(messages, (await import(`../../messages/marina/${locale}.json`)).default as Messages);
    messages = merge(messages, (await import(`../../messages/scale/${locale}.json`)).default as Messages);
    messages = merge(messages, (await import(`../../messages/supply/${locale}.json`)).default as Messages);
    messages = merge(messages, (await import(`../../messages/localmkt/${locale}.json`)).default as Messages);
    messages = merge(messages, (await import(`../../messages/brands/${locale}.json`)).default as Messages);
  }
  return { locale, messages, timeZone: 'UTC' };
});
