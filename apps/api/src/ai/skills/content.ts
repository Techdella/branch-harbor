import { applyGuardrails, type AiBrandVoice, type GuardrailReport } from '@bh/shared';
import type { AssistantContext } from '../context.ts';
import { itemsOf } from '../present.ts';
import { loadAiSettings, saveAiSettings } from '../settings.ts';
import { isSandbox, languageName, oneShot } from './_llm.ts';

/**
 * Content studio: brand-voice copy (emails, social posts, ads, website sections, coming-soon campaigns), translation
 * into the organisation's locales, a brand voice profile learned from approved content, and HQ guardrails (banned
 * claims removed, required disclaimers added) applied to everything generated.
 */
export type CopyKind = 'email' | 'social' | 'ad' | 'website_section' | 'coming_soon';

const KIND_BRIEF: Record<CopyKind, string> = {
  email: 'a marketing email body (greeting, 2–3 short paragraphs, a clear call to action). Use {{first_name|there}} for the greeting.',
  social: 'one social media post (max 2 short paragraphs, up to 3 relevant hashtags, no more than 2 emoji).',
  ad: 'ad copy: a headline (max 40 characters), a primary text (max 125 characters) and a call to action, each on its own line.',
  website_section: 'a website section: a heading line, then 1–2 short paragraphs.',
  coming_soon: 'a "coming soon" announcement for a new location opening: excitement, what people can expect, and how to register interest.',
};

export interface CopyResult { kind: CopyKind; locale: string; text: string; guardrails: GuardrailReport; sandbox: boolean }

function voiceText(v: AiBrandVoice) {
  return [
    v.tone ? `Tone: ${v.tone}.` : '',
    v.preferredWords.length ? `Words the brand likes: ${v.preferredWords.join(', ')}.` : '',
    v.avoidWords.length ? `Never use: ${v.avoidWords.join(', ')}.` : '',
    v.examples.length ? `Approved examples:\n${v.examples.slice(0, 3).map((e) => `- ${e.slice(0, 300)}`).join('\n')}` : '',
  ].filter(Boolean).join('\n');
}

/** Sandbox copy: built only from the brief (no invented offers, prices or dates). */
function sandboxCopy(kind: CopyKind, brief: string, orgName: string): string {
  const b = brief.trim().replace(/\s+/g, ' ');
  const sentence = b ? b.charAt(0).toUpperCase() + b.slice(1).replace(/[.!?]*$/, '.') : '';
  switch (kind) {
    case 'email': return `Hello {{first_name|there}},\n\n${sentence}\n\nWe would love to see you soon.\n\nThe ${orgName} team`;
    case 'social': return `${sentence}\n\n#${orgName.replace(/[^A-Za-z0-9]/g, '')}`;
    case 'ad': return `${orgName}\n${sentence.slice(0, 125)}\nLearn more`;
    case 'website_section': return `${orgName}\n\n${sentence}`;
    case 'coming_soon': return `Coming soon: ${orgName}\n\n${sentence}\n\nRegister your interest to hear first when we open.`;
  }
}

export async function generateCopy(ctx: AssistantContext, input: { kind: CopyKind; brief: string; locale?: string }): Promise<CopyResult> {
  const settings = await loadAiSettings(ctx.s.db, ctx.orgId);
  const locale = input.locale ?? ctx.locale;
  let text: string;
  const sandbox = isSandbox(ctx.s);
  if (sandbox) text = sandboxCopy(input.kind, input.brief, ctx.org.name);
  else {
    const r = await oneShot(ctx.s, ctx.orgId, 'content', {
      tier: 'main', effort: 'low', locale,
      system: 'You write marketing copy for a multi-location business. Use only facts given in the brief or the brand profile: never invent prices, dates, offers, guarantees, health claims or results. If a needed detail is missing, leave a clear placeholder in square brackets. Output only the copy, no commentary.',
      context: `<brand name="${ctx.org.name}" industry="${ctx.org.industry}">\n${voiceText(settings.brandVoice)}\n</brand>\nBanned claims: ${settings.guardrails.bannedClaims.join('; ') || 'none'}.\nRequired disclaimers: ${settings.guardrails.requiredDisclaimers.join(' | ') || 'none'}.`,
      messages: [{ role: 'user', content: `Write ${KIND_BRIEF[input.kind]}\nLanguage: ${languageName(locale)}.\nBrief: ${input.brief}` }],
      maxTokens: 2000,
    });
    text = r.text;
  }
  const g = applyGuardrails(text, settings.guardrails);
  return { kind: input.kind, locale, text: g.text, guardrails: g.report, sandbox };
}

export async function translateContent(ctx: AssistantContext, input: { text: string; targetLocales: string[]; sourceLocale?: string }) {
  const targets = [...new Set(input.targetLocales)].filter((l) => l !== input.sourceLocale).slice(0, 9);
  if (isSandbox(ctx.s)) {
    return { sandbox: true, translations: targets.map((locale) => ({ locale, text: input.text, translated: false })), note: 'Translation needs the live AI connection; the original text is shown.' };
  }
  const settings = await loadAiSettings(ctx.s.db, ctx.orgId);
  const r = await oneShot<{ translations: Array<{ locale: string; text: string }> }>(ctx.s, ctx.orgId, 'content', {
    tier: 'fast', effort: 'low',
    system: 'You translate marketing and operational content for a business. Keep meaning, tone, formatting, placeholders such as {{first_name|there}} and [brackets], brand names and URLs exactly. Do not add or remove claims.',
    context: `Brand: ${ctx.org.name}. Words never to use: ${settings.brandVoice.avoidWords.join(', ') || 'none'}.`,
    messages: [{ role: 'user', content: `Translate into: ${targets.map((l) => `${l} (${languageName(l)})`).join(', ')}.\n\n<text>\n${input.text}\n</text>` }],
    jsonSchema: { type: 'object', properties: { translations: { type: 'array', items: { type: 'object', properties: { locale: { type: 'string' }, text: { type: 'string' } }, required: ['locale', 'text'], additionalProperties: false } } }, required: ['translations'], additionalProperties: false },
    maxTokens: 8000,
  });
  const out = r.json?.translations ?? [];
  return { sandbox: false, translations: targets.map((locale) => ({ locale, text: applyGuardrails(out.find((t) => t.locale === locale)?.text ?? input.text, settings.guardrails).text, translated: out.some((t) => t.locale === locale) })) };
}

const STOP = new Set('the and for with your you our are this that from have will was were has not but all can just more about into out new get now one two its it’s it\'s their they them what when where which who how than then also very been being each per les des une est pour avec vous nous los las por para con que una der die das und mit für ein eine ist sie wir uma com para não seu sua'.split(' '));

/** Learns a brand voice profile from approved content: sent emails, published posts, published website text. */
export async function learnBrandVoice(ctx: AssistantContext) {
  const samples: string[] = [];
  const emails = itemsOf(await ctx.api.get(ctx.o('/email/campaigns')).catch(() => ({ items: [] }))).filter((c) => ['sent', 'sending', 'scheduled'].includes(c.status));
  for (const c of emails.slice(0, 10)) {
    const d = await ctx.api.get(ctx.o(`/email/campaigns/${c.id}`)).catch(() => null);
    const blocks = (d?.content?.document?.blocks ?? []) as Array<{ type: string; text?: string }>;
    const t = blocks.filter((b) => b.type === 'text').map((b) => b.text).join('\n');
    if (t) samples.push(t);
  }
  const posts = itemsOf(await ctx.api.get(ctx.o('/social/posts')).catch(() => ({ items: [] }))).filter((p) => ['published', 'sandboxed', 'scheduled'].includes(p.status));
  for (const p of posts.slice(0, 20)) if (p.body) samples.push(p.body);
  const ann = itemsOf(await ctx.api.get(ctx.o('/community/announcements')).catch(() => ({ items: [] }))).filter((a) => a.status === 'published');
  for (const a of ann.slice(0, 5)) samples.push(String(a.body).slice(0, 800));
  if (!samples.length) return { learned: false, reason: 'No approved content yet: send an email, publish a post or an announcement first.', voice: (await loadAiSettings(ctx.s.db, ctx.orgId)).brandVoice };

  let voice: Omit<AiBrandVoice, 'learnedAt' | 'learnedFrom' | 'examples'>;
  if (isSandbox(ctx.s)) {
    const words = samples.join(' ').toLocaleLowerCase().match(/\p{L}{4,}/gu) ?? [];
    const freq = new Map<string, number>();
    for (const w of words) if (!STOP.has(w)) freq.set(w, (freq.get(w) ?? 0) + 1);
    const top = [...freq.entries()].filter(([, n]) => n > 1).sort((a, b) => b[1] - a[1]).slice(0, 8).map(([w]) => w);
    const all = samples.join(' ');
    const sentences = all.split(/[.!?]+/).filter((x) => x.trim());
    const avgLen = sentences.length ? Math.round(all.split(/\s+/).length / sentences.length) : 0;
    const excl = (all.match(/!/g) ?? []).length / Math.max(1, sentences.length);
    voice = { tone: [avgLen <= 14 ? 'concise' : 'detailed', excl > 0.3 ? 'energetic' : 'calm', /\byou\b|\bvous\b|\bdu\b/i.test(all) ? 'speaks directly to the reader' : 'informational'].join(', '), preferredWords: top, avoidWords: [] };
  } else {
    const r = await oneShot<{ tone: string; preferredWords: string[]; avoidWords: string[] }>(ctx.s, ctx.orgId, 'content', {
      tier: 'main', effort: 'low',
      system: 'Describe the brand voice of the approved content you are given. Base everything on the samples only.',
      messages: [{ role: 'user', content: `Approved samples:\n${samples.slice(0, 20).map((x, i) => `<sample n="${i + 1}">${x.slice(0, 1200)}</sample>`).join('\n')}` }],
      jsonSchema: { type: 'object', properties: { tone: { type: 'string', description: '3–8 words' }, preferredWords: { type: 'array', items: { type: 'string' } }, avoidWords: { type: 'array', items: { type: 'string' } } }, required: ['tone', 'preferredWords', 'avoidWords'], additionalProperties: false },
      maxTokens: 1500,
    });
    voice = { tone: r.json?.tone ?? '', preferredWords: (r.json?.preferredWords ?? []).slice(0, 12), avoidWords: (r.json?.avoidWords ?? []).slice(0, 12) };
  }
  const current = await loadAiSettings(ctx.s.db, ctx.orgId);
  const brandVoice: AiBrandVoice = { ...voice, avoidWords: [...new Set([...current.brandVoice.avoidWords, ...voice.avoidWords])], examples: samples.slice(0, 3).map((x) => x.slice(0, 300)), learnedAt: new Date().toISOString(), learnedFrom: samples.length };
  await saveAiSettings(ctx.s.db, ctx.orgId, { brandVoice }, ctx.user.id);
  return { learned: true, voice: brandVoice };
}
