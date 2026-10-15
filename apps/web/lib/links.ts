/** External destinations used by calls to action across the site. */
export const APP_URL = (process.env.NEXT_PUBLIC_APP_URL ?? 'http://localhost:3001').replace(/\/+$/, '');
/** Public demo site with a sample business ("Try the demo"). */
export const DEMO_URL = (process.env.NEXT_PUBLIC_DEMO_URL ?? 'https://demo.branchharbor.com').replace(/\/+$/, '');
/** Address shown as text for requests the forms don't cover (e.g. an industry we don't list yet). */
export const CONTACT_EMAIL = process.env.NEXT_PUBLIC_CONTACT_EMAIL ?? 'demo@branchharbor.com';

/** Self-service sign-up ("Start your plan"), optionally pre-selecting the industry, business model and plan. */
export function signUpUrl(opts: { industry?: string; model?: 'independent' | 'network'; plan?: string } = {}): string {
  const q = new URLSearchParams();
  if (opts.model) q.set('model', opts.model);
  if (opts.industry) q.set('industry', opts.industry);
  if (opts.plan) q.set('plan', opts.plan);
  const s = q.toString();
  return `${APP_URL}/sign-up${s ? `?${s}` : ''}`;
}

/** mailto: link for "Need another industry? Tell us". */
export function otherIndustryMailto(subject: string): string {
  return `mailto:${CONTACT_EMAIL}?subject=${encodeURIComponent(subject)}`;
}
