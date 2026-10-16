import Anthropic from '@anthropic-ai/sdk';
import type { FastifyBaseLogger } from 'fastify';
import type { Config } from '../config.ts';

export type AiMessage = Anthropic.Beta.BetaMessage;
export type AiMessageParam = Anthropic.Beta.BetaMessageParam;
export type AiTool = Anthropic.Beta.BetaTool;

export interface AiProvider {
  readonly enabled: boolean;
  readonly model: string;
  createMessage(input: { system: string; messages: AiMessageParam[]; tools: AiTool[] }): Promise<AiMessage>;
}

/**
 * Anthropic Messages API adapter for Marina. Disabled (enabled=false) without
 * ANTHROPIC_API_KEY; routes return a 503 "AI unavailable" and nothing else is affected.
 *
 * Refusal handling: when ANTHROPIC_REFUSAL_FALLBACK is on (default), requests opt into the
 * server-side `fallbacks: "default"` mode so a safety-classifier decline is re-run on Anthropic's
 * recommended fallback model instead of returning an empty refusal.
 */
export function createAi(cfg: Config, log: FastifyBaseLogger): AiProvider {
  if (!cfg.ANTHROPIC_API_KEY) {
    log.warn('[ai] ANTHROPIC_API_KEY not set — the assistant runs its sandbox engine (answers only from real tool results); legacy AI drafting endpoints return 503')
    return {
      enabled: false,
      model: cfg.ANTHROPIC_MODEL,
      async createMessage() {
        throw new Error('AI disabled');
      },
    };
  }
  const client = new Anthropic({ apiKey: cfg.ANTHROPIC_API_KEY, timeout: 120_000, maxRetries: 2 });
  return {
    enabled: true,
    model: cfg.ANTHROPIC_MODEL,
    async createMessage({ system, messages, tools }) {
      return client.beta.messages.create({
        model: cfg.ANTHROPIC_MODEL,
        max_tokens: cfg.ANTHROPIC_MAX_TOKENS,
        system,
        messages,
        tools,
        tool_choice: { type: 'auto' },
        ...(cfg.ANTHROPIC_REFUSAL_FALLBACK ? { betas: ['server-side-fallback-2026-07-01'], fallbacks: 'default' as const } : {}),
      });
    },
  };
}
