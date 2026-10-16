import { ASSISTANT_NAME } from '@bh/shared';
import type { Services } from '../../context.ts';
import { AppError } from '../../lib/errors.ts';
import type { LlmCall } from '../llm.ts';
import { recordUsage } from '../settings.ts';

/** True when skills should use their deterministic sandbox path (no key, MARINA_SANDBOX, tests, demo). */
export const isSandbox = (s: Services) => s.marina.mode === 'sandbox';

/**
 * One metered model call for a skill. Returns the text (and parsed JSON when `jsonSchema` is set). Refusals and
 * failures become a clear 4xx/5xx; callers fall back to their deterministic output where they have one.
 */
export async function oneShot<T = unknown>(s: Services, orgId: string, feature: string, call: LlmCall): Promise<{ text: string; json: T | null; model: string }> {
  let res;
  try {
    res = await s.marina.call(call);
  } catch (err) {
    s.log.error({ err, feature }, '[ai] skill call failed');
    throw new AppError(503, 'ai_unavailable', `${ASSISTANT_NAME} could not respond right now. Please try again; everything else keeps working.`);
  }
  await recordUsage(s.db, orgId, feature, res.model, res.usage);
  if (res.stopReason === 'refusal') throw new AppError(422, 'ai_refused', `${ASSISTANT_NAME} can’t help with that request.`);
  const text = res.content.filter((b) => b.type === 'text').map((b) => (b as { text: string }).text).join('\n').trim();
  let json: T | null = null;
  if (call.jsonSchema) {
    try {
      json = JSON.parse(text) as T;
    } catch {
      json = null;
    }
  }
  return { text, json, model: res.model };
}

/** Wraps text written by other people so the model treats it as data. */
export function untrusted(label: string, text: string) {
  return `<untrusted_data source="${label}">${text.replace(/<\/?\s*untrusted_data[^>]*>/gi, '[tag removed]')}</untrusted_data>`;
}

export const LANGUAGE_NAMES: Record<string, string> = {
  en: 'English', 'en-GB': 'British English', fr: 'French', es: 'Spanish', de: 'German', 'pt-BR': 'Brazilian Portuguese', it: 'Italian', nl: 'Dutch', ar: 'Arabic', pt: 'Portuguese',
};
export const languageName = (l: string) => LANGUAGE_NAMES[l] ?? LANGUAGE_NAMES[l.split('-')[0]!] ?? l;
