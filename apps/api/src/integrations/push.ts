import type { FastifyBaseLogger } from 'fastify';
import type { Config } from '../config.ts';

export interface PushMessage {
  to: string;
  title: string;
  body: string;
  data?: Record<string, unknown>;
  sound?: 'default' | null;
  channelId?: string;
}

export interface PushSendResult {
  /** Per-message outcome in the same order as the input. */
  tickets: Array<{ status: 'ok' | 'error'; id?: string; message?: string; details?: Record<string, unknown> }>;
}

export interface PushProvider {
  readonly mode: 'live' | 'sandbox';
  send(messages: PushMessage[]): Promise<PushSendResult>;
}

/**
 * Expo Push API adapter. Live when EXPO_ACCESS_TOKEN or ENABLE_EXPO_PUSH is set; otherwise every
 * message is logged (sandbox) and reported as delivered-to-log so flows can be exercised locally.
 */
export function createPushProvider(cfg: Config, log: FastifyBaseLogger): PushProvider {
  const live = !!cfg.EXPO_ACCESS_TOKEN || cfg.ENABLE_EXPO_PUSH;
  if (!live) {
    return {
      mode: 'sandbox',
      async send(messages) {
        for (const m of messages) log.info({ to: `${m.to.slice(0, 22)}…`, title: m.title }, '[push:sandbox] notification logged, not sent');
        return { tickets: messages.map(() => ({ status: 'ok' as const, id: 'sandbox' })) };
      },
    };
  }
  return {
    mode: 'live',
    async send(messages) {
      const tickets: PushSendResult['tickets'] = [];
      // Expo accepts up to 100 messages per request.
      for (let i = 0; i < messages.length; i += 100) {
        const chunk = messages.slice(i, i + 100);
        const res = await fetch(cfg.EXPO_PUSH_URL, {
          method: 'POST',
          headers: {
            Accept: 'application/json',
            'Accept-Encoding': 'gzip, deflate',
            'Content-Type': 'application/json',
            ...(cfg.EXPO_ACCESS_TOKEN ? { Authorization: `Bearer ${cfg.EXPO_ACCESS_TOKEN}` } : {}),
          },
          body: JSON.stringify(chunk.map((m) => ({ sound: 'default', ...m }))),
        });
        if (!res.ok) {
          const text = await res.text().catch(() => '');
          log.error({ status: res.status, text: text.slice(0, 300) }, '[push] Expo push request failed');
          tickets.push(...chunk.map(() => ({ status: 'error' as const, message: `Expo push HTTP ${res.status}` })));
          continue;
        }
        const json = (await res.json()) as { data?: PushSendResult['tickets'] };
        tickets.push(...(json.data ?? chunk.map(() => ({ status: 'error' as const, message: 'Empty response' }))));
      }
      return { tickets };
    },
  };
}
