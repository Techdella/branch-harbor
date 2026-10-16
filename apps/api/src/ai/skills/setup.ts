import { ASSISTANT_NAME, currencyForCountry, themesForFamily, type AiActionCard } from '@bh/shared';
import type { AssistantContext } from '../context.ts';
import { proposeAction } from '../engine.ts';
import { isSandbox, oneShot } from './_llm.ts';

/**
 * Setup assistant: a new organisation describes itself in a sentence ("I run 12 yoga studios in Canada and the UK…")
 * and gets a plan: locations, team shape and roles, a website theme and first campaigns. Locations, the theme and
 * campaign drafts come back as action cards to confirm; the team shape is advice (invitations need real emails).
 */
export interface SetupPlan {
  summary: string;
  industryMatch: boolean;
  detectedIndustry: string | null;
  locations: Array<{ name: string; country: string; city: string }>;
  team: Array<{ role: string; count: number; why: string }>;
  theme: { id: string; why: string } | null;
  campaigns: Array<{ name: string; subject: string; brief: string }>;
  sandbox: boolean;
}

const COUNTRIES: Array<[RegExp, string]> = [
  [/\bcanada\b/i, 'CA'], [/\b(uk|united kingdom|england|scotland|wales|britain)\b/i, 'GB'], [/\b(us|usa|united states|america)\b/i, 'US'], [/\baustralia\b/i, 'AU'],
  [/\bnew zealand\b/i, 'NZ'], [/\bireland\b/i, 'IE'], [/\bfrance\b/i, 'FR'], [/\bgermany|deutschland\b/i, 'DE'], [/\bspain|españa\b/i, 'ES'], [/\bportugal\b/i, 'PT'],
  [/\bbrazil|brasil\b/i, 'BR'], [/\bnetherlands|holland\b/i, 'NL'], [/\bitaly|italia\b/i, 'IT'], [/\bmexico|méxico\b/i, 'MX'], [/\bsingapore\b/i, 'SG'], [/\b(uae|dubai)\b/i, 'AE'],
];
const INDUSTRIES: Array<[RegExp, string]> = [
  [/yoga|pilates|barre|studio|gym|fitness|boxing|cycle|dance/i, 'studios'], [/restaurant|café|cafe|bakery|pizza|coffee|kitchen|bar\b|food/i, 'foods'], [/spa|clinic|massage|salon|physio|wellness|beauty/i, 'wellness'],
  [/shop|store|retail|boutique/i, 'commerce'], [/hotel|guesthouse|hostel|apartments|b&b/i, 'hospitality'], [/real estate|estate agen|realty|property/i, 'realty'], [/club|academy|football|soccer|swim|league|team/i, 'sports'],
];
const WORDS: Record<string, number> = { one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7, eight: 8, nine: 9, ten: 10, eleven: 11, twelve: 12, fifteen: 15, twenty: 20 };

export function parseSetup(text: string, org: { industry: string; name: string }): Omit<SetupPlan, 'sandbox'> {
  const countries = COUNTRIES.filter(([re]) => re.test(text)).map(([, c]) => c);
  const num = Number(text.match(/\b(\d{1,3})\b/)?.[1] ?? Object.entries(WORDS).find(([w]) => new RegExp(`\\b${w}\\b`, 'i').test(text))?.[1] ?? 1);
  const count = Math.max(1, Math.min(50, num));
  const detectedIndustry = INDUSTRIES.find(([re]) => re.test(text))?.[1] ?? null;
  const cs = countries.length ? countries : ['US'];
  const locations = Array.from({ length: count }, (_, i) => ({ name: `${org.name} ${i + 1}`, country: cs[i % cs.length]!, city: 'To be confirmed' }));
  const regions = cs.length;
  const team: SetupPlan['team'] = [
    { role: 'hq_admin', count: 1, why: 'Runs locations, brand templates, marketing and team access at HQ.' },
    ...(regions > 1 || count > 8 ? [{ role: 'regional_manager', count: Math.max(1, regions), why: `One per country or region to oversee ${Math.ceil(count / Math.max(1, regions))} locations each.` }] : []),
    { role: count > 1 ? 'franchise_owner' : 'location_manager', count: count > 1 ? Math.max(1, Math.round(count / 3)) : 1, why: count > 1 ? 'Franchise owners see the full dashboard for their own locations only.' : 'Runs the location day to day.' },
    { role: 'location_manager', count, why: 'One per location for day-to-day operations, the local website and campaign drafts.' },
    ...(count >= 5 ? [{ role: 'digital_marketer', count: 1, why: 'Network websites, email, social and ads.' }] : []),
  ];
  const family = detectedIndustry && detectedIndustry === org.industry ? org.industry : org.industry;
  const theme = themesForFamily(family)[1] ?? themesForFamily(family)[0] ?? null;
  const campaigns = [
    { name: 'Welcome to new customers', subject: `Welcome to ${org.name}`, brief: `Welcome new customers to ${org.name} and explain how to book or order.` },
    { name: 'Coming soon', subject: `${org.name} is coming soon`, brief: `Announce that ${org.name} is opening new locations; invite people to register interest.` },
  ];
  return {
    summary: `${count} location${count === 1 ? '' : 's'} in ${cs.join(', ')}; ${team.reduce((a, t) => a + t.count, 0)} people across ${team.length} roles; theme ${theme?.id ?? 'classic'}; ${campaigns.length} first campaigns.`,
    industryMatch: !detectedIndustry || detectedIndustry === org.industry, detectedIndustry,
    locations, team, theme: theme ? { id: theme.id, why: `Made for ${family} brands; you can switch themes later without losing content.` } : null, campaigns,
  };
}

export async function planSetup(ctx: AssistantContext, message: string): Promise<{ plan: SetupPlan; actions: AiActionCard[] }> {
  let plan: SetupPlan = { ...parseSetup(message, ctx.org), sandbox: isSandbox(ctx.s) };
  if (!isSandbox(ctx.s)) {
    const themes = themesForFamily(ctx.org.industry).map((t) => t.id);
    const r = await oneShot<Omit<SetupPlan, 'sandbox' | 'industryMatch' | 'detectedIndustry'>>(ctx.s, ctx.orgId, 'setup', {
      tier: 'main', effort: 'low', locale: ctx.locale,
      system: `You are ${ASSISTANT_NAME}, helping a new ${ctx.org.industry} business set up BranchHarbor. From their description, propose: locations (name, ISO country, city if stated or "To be confirmed"), team roles (from: hq_admin, regional_manager, franchise_owner, location_manager, digital_marketer, operations_manager, finance, staff) with counts and a one-line reason, a website theme id from [${themes.join(', ')}], and 2–3 first email campaigns (name, subject, brief). Never invent addresses, people or offers.`,
      messages: [{ role: 'user', content: message.slice(0, 4000) }],
      jsonSchema: {
        type: 'object', additionalProperties: false, required: ['summary', 'locations', 'team', 'theme', 'campaigns'],
        properties: {
          summary: { type: 'string' },
          locations: { type: 'array', items: { type: 'object', additionalProperties: false, required: ['name', 'country', 'city'], properties: { name: { type: 'string' }, country: { type: 'string' }, city: { type: 'string' } } } },
          team: { type: 'array', items: { type: 'object', additionalProperties: false, required: ['role', 'count', 'why'], properties: { role: { type: 'string' }, count: { type: 'integer' }, why: { type: 'string' } } } },
          theme: { type: 'object', additionalProperties: false, required: ['id', 'why'], properties: { id: { type: 'string', enum: themes.length ? themes : ['classic'] }, why: { type: 'string' } } },
          campaigns: { type: 'array', items: { type: 'object', additionalProperties: false, required: ['name', 'subject', 'brief'], properties: { name: { type: 'string' }, subject: { type: 'string' }, brief: { type: 'string' } } } },
        },
      },
      maxTokens: 4000,
    }).catch(() => null);
    if (r?.json) plan = { ...plan, ...r.json, locations: r.json.locations.slice(0, 50), sandbox: false };
  }
  const actions: AiActionCard[] = [];
  const tryPropose = async (tool: string, input: unknown) => {
    try {
      actions.push(await proposeAction(ctx.s, ctx, tool, input, 'setup'));
    } catch {
      /* not in this person's access: the plan still shows it as advice */
    }
  };
  if (plan.locations.length) await tryPropose('create_locations', { locations: plan.locations.map((l) => ({ ...l, country: l.country.toUpperCase().slice(0, 2), currency: currencyForCountry(l.country) })) });
  if (plan.theme) await tryPropose('set_site_theme', { themeId: plan.theme.id });
  for (const c of plan.campaigns.slice(0, 3)) await tryPropose('create_email_campaign_draft', { name: c.name, subject: c.subject, brief: c.brief });
  return { plan, actions };
}
