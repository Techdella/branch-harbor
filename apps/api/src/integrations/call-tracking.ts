/**
 * Call tracking through Twilio Programmable Voice (docs/API_INTEGRATIONS.md "Call tracking").
 *
 * - Numbers: AvailablePhoneNumbers search + IncomingPhoneNumbers purchase, with the voice webhook pointing at
 *   `/v1/webhooks/call-tracking/twilio/voice`; release deletes the number.
 * - Calls: the voice webhook answers with TwiML — an optional recording disclosure (<Say>), then <Dial> to the
 *   location's phone with the tracking number as caller id; the <Dial action> callback reports the outcome.
 * - Webhooks are verified with X-Twilio-Signature (HMAC-SHA1 of the URL + sorted form params, Twilio auth token).
 * - Sandbox (no TWILIO_ACCOUNT_SID/AUTH_TOKEN, or CALL_TRACKING_LIVE=false): numbers are fictional (reserved
 *   ranges, they never ring), calls are simulated by signing the same webhook payloads with the sandbox secret.
 */
import type { Config } from '../config.ts';
import { sandboxSecret, signTwilio } from './comms-channels.ts';
import { PartnerHttpError, requestJson, type FetchLike } from './partners/http.ts';

export const callTrackingLive = (cfg: Config) => !!(cfg.TWILIO_ACCOUNT_SID && cfg.TWILIO_AUTH_TOKEN && cfg.CALL_TRACKING_LIVE);
export const voiceWebhookUrl = (cfg: Config) => `${cfg.PUBLIC_API_URL.replace(/\/$/, '')}/v1/webhooks/call-tracking/twilio/voice`;
export const statusWebhookUrl = (cfg: Config) => `${cfg.PUBLIC_API_URL.replace(/\/$/, '')}/v1/webhooks/call-tracking/twilio/status`;
const callSecret = (cfg: Config) => (callTrackingLive(cfg) ? cfg.TWILIO_AUTH_TOKEN! : sandboxSecret(cfg));

export function verifyTwilioVoice(cfg: Config, url: string, params: Record<string, string>, signature: string | undefined): boolean {
  if (!signature) return false;
  const expected = signTwilio(callSecret(cfg), url, params);
  return expected.length === signature.length && Buffer.from(expected).equals(Buffer.from(signature));
}

/** Signs a payload as Twilio would (sandbox simulation and tests). */
export const signVoicePayload = (cfg: Config, url: string, params: Record<string, string>) => signTwilio(callSecret(cfg), url, params);

const xml = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

/** TwiML for an incoming call: disclosure (when recording), then forward to the location. */
export function forwardTwiml(input: { forwardTo: string; callerId: string; disclosure: string | null; record: boolean; actionUrl: string; language?: string | null; timeoutSeconds?: number }): string {
  const say = input.disclosure ? `<Say${input.language ? ` language="${xml(input.language)}"` : ''}>${xml(input.disclosure)}</Say>` : '';
  const rec = input.record ? ' record="record-from-answer-dual"' : '';
  return `<?xml version="1.0" encoding="UTF-8"?><Response>${say}<Dial callerId="${xml(input.callerId)}" timeout="${input.timeoutSeconds ?? 20}" action="${xml(input.actionUrl)}" method="POST"${rec}>${xml(input.forwardTo)}</Dial></Response>`;
}
export const hangupTwiml = () => '<?xml version="1.0" encoding="UTF-8"?><Response><Hangup/></Response>';

/** Fictional numbers for sandbox: NANP 555-01xx, Ofcom drama (07700 900xxx), ACMA (0491 570xxx). */
export function sandboxNumber(country: string, seed: number, areaCode?: string | null): string {
  const n = (k: number, len: number) => String(k % 10 ** len).padStart(len, '0');
  if (country === 'US' || country === 'CA') return `+1${areaCode && /^[2-9]\d\d$/.test(areaCode) ? areaCode : '555'}55501${n(seed, 2)}`;
  if (country === 'GB') return `+447700900${n(seed, 3)}`;
  if (country === 'AU') return `+61491570${n(seed, 3)}`;
  return `+1555010${n(seed, 4)}`;
}

export interface CallTrackingProvider {
  readonly live: boolean;
  buyNumber(input: { country: string; areaCode?: string | null }): Promise<{ number: string; sid: string }>;
  releaseNumber(sid: string): Promise<void>;
}

export function createCallTracking(cfg: Config, fetchImpl: FetchLike): CallTrackingProvider {
  const live = callTrackingLive(cfg);
  const base = `https://api.twilio.com/2010-04-01/Accounts/${cfg.TWILIO_ACCOUNT_SID ?? 'sandbox'}`;
  const auth = () => ({ Authorization: `Basic ${Buffer.from(`${cfg.TWILIO_ACCOUNT_SID}:${cfg.TWILIO_AUTH_TOKEN}`).toString('base64')}` });
  return {
    live,
    async buyNumber({ country, areaCode }) {
      if (!live) throw new PartnerHttpError('Twilio', 503, 'Call tracking is in sandbox mode');
      const q = new URLSearchParams({ VoiceEnabled: 'true', PageSize: '1', ...(areaCode ? { AreaCode: areaCode } : {}) });
      const { data } = await requestJson<{ available_phone_numbers?: Array<{ phone_number: string }> }>('Twilio', fetchImpl, `${base}/AvailablePhoneNumbers/${encodeURIComponent(country)}/Local.json?${q}`, { headers: auth() });
      const pick = data.available_phone_numbers?.[0]?.phone_number;
      if (!pick) throw new PartnerHttpError('Twilio', 404, 'No local numbers available for that area');
      const { data: bought } = await requestJson<{ sid: string; phone_number: string }>('Twilio', fetchImpl, `${base}/IncomingPhoneNumbers.json`, {
        headers: auth(), form: { PhoneNumber: pick, VoiceUrl: voiceWebhookUrl(cfg), VoiceMethod: 'POST', FriendlyName: 'BranchHarbor call tracking' },
      });
      return { number: bought.phone_number, sid: bought.sid };
    },
    async releaseNumber(sid) {
      if (!live) return;
      await requestJson('Twilio', fetchImpl, `${base}/IncomingPhoneNumbers/${encodeURIComponent(sid)}.json`, { method: 'DELETE', headers: auth() }).catch((err) => {
        if (!(err instanceof PartnerHttpError && err.status === 404)) throw err;
      });
    },
  };
}
