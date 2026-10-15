import Anthropic from '@anthropic-ai/sdk';
import type { FastifyBaseLogger } from 'fastify';
import type { AiUsage } from '@bh/shared';
import type { Config } from '../config.ts';
import { createSandboxLlm } from './sandbox.ts';

export type LlmMessage = Anthropic.Beta.BetaMessageParam;
export type LlmContentBlock = Anthropic.Beta.BetaContentBlock;
export type LlmTool = Anthropic.Beta.BetaTool;

export interface LlmCall {
  /** main = the assistant's agent loop, vision and long-form writing; fast = classification and summaries. */
  tier: 'main' | 'fast';
  /** Stable instructions, identical for everyone (cached together with the tool definitions). */
  system: string;
  /** Per-person, per-request context placed after the cache breakpoint. */
  context?: string;
  tools?: LlmTool[];
  messages: LlmMessage[];
  maxTokens?: number;
  effort?: 'low' | 'medium' | 'high' | 'xhigh' | 'max';
  /** Streams text deltas as they are generated. */
  onText?: (delta: string) => void;
  /** Locale the reply should be in (the sandbox uses it for its fixed phrases). */
  locale?: string;
  /** Structured output: the reply is JSON matching this schema (output_config.format). */
  jsonSchema?: Record<string, unknown>;
}

export interface LlmResult {
  content: LlmContentBlock[];
  stopReason: string | null;
  model: string;
  usage: AiUsage;
}

export interface MarinaLlm {
  readonly mode: 'live' | 'sandbox';
  readonly models: { main: string; fast: string };
  call(c: LlmCall): Promise<LlmResult>;
}

/**
 * The assistant's model layer.
 *
 * Live (ANTHROPIC_API_KEY set and MARINA_SANDBOX off): Claude Messages API with streaming. Prompt caching covers the
 * tool definitions and the stable system prompt (the per-person context comes after the breakpoint), and the last
 * message so long conversations re-use their prefix. Refusals use the server-side `fallbacks: "default"` mode on models
 * that support it. Tool inputs stream eagerly; the engine validates every input against the tool's zod schema.
 *
 * Sandbox: a deterministic scripted engine (sandbox.ts) for tests and the demo, which only ever answers from real tool
 * results.
 */
export function createMarinaLlm(cfg: Config, log: FastifyBaseLogger): MarinaLlm {
  const models = { main: cfg.ANTHROPIC_MODEL, fast: cfg.ANTHROPIC_FAST_MODEL };
  if (!cfg.ANTHROPIC_API_KEY || cfg.MARINA_SANDBOX) {
    if (!cfg.ANTHROPIC_API_KEY) log.info('[ai] assistant runs on the sandbox engine (no ANTHROPIC_API_KEY)');
    return createSandboxLlm();
  }
  const client = new Anthropic({ apiKey: cfg.ANTHROPIC_API_KEY, timeout: 300_000, maxRetries: 2 });
  const supportsFallback = (model: string) => /^claude-(opus-5|sonnet-5-5|fable)/.test(model);
  return {
    mode: 'live',
    models,
    async call(c) {
      const model = c.tier === 'main' ? models.main : models.fast;
      const tools = c.tools?.length
        ? c.tools.map((t, i, all) => ({ ...t, eager_input_streaming: true, ...(i === all.length - 1 ? { cache_control: { type: 'ephemeral' as const } } : {}) }))
        : undefined;
      const system: Anthropic.Beta.BetaTextBlockParam[] = [
        { type: 'text', text: c.system, cache_control: { type: 'ephemeral' } },
        ...(c.context ? [{ type: 'text' as const, text: c.context }] : []),
      ];
      // Cache the conversation so far: mark the last content block of the last message.
      const messages = c.messages.map((m, i, all) => {
        if (i !== all.length - 1 || typeof m.content === 'string' || !m.content.length) return m;
        const content = [...m.content];
        const last = content[content.length - 1]!;
        if (last.type === 'text' || last.type === 'tool_result' || last.type === 'image' || last.type === 'document') content[content.length - 1] = { ...last, cache_control: { type: 'ephemeral' } } as typeof last;
        return { ...m, content };
      });
      const params = {
        model,
        max_tokens: c.maxTokens ?? cfg.MARINA_MAX_TOKENS,
        system,
        messages,
        ...(tools ? { tools, tool_choice: { type: 'auto' as const } } : {}),
        output_config: { effort: c.effort ?? (c.tier === 'main' ? cfg.ANTHROPIC_EFFORT : 'low'), ...(c.jsonSchema ? { format: { type: 'json_schema' as const, schema: c.jsonSchema } } : {}) },
        ...(cfg.ANTHROPIC_REFUSAL_FALLBACK && supportsFallback(model) ? { betas: ['server-side-fallback-2026-07-01'], fallbacks: 'default' as const } : {}),
      };
      for (let attempt = 0; ; attempt++) {
        try {
          const stream = client.beta.messages.stream(params);
          if (c.onText) stream.on('text', c.onText);
          const msg = await stream.finalMessage();
          return {
            content: msg.content,
            stopReason: msg.stop_reason,
            model: msg.model,
            usage: {
              inputTokens: msg.usage.input_tokens,
              outputTokens: msg.usage.output_tokens,
              cacheReadTokens: msg.usage.cache_read_input_tokens ?? 0,
              cacheWriteTokens: msg.usage.cache_creation_input_tokens ?? 0,
            },
          };
        } catch (err) {
          // Only a tool input the SDK could not parse at all is re-issued; API errors (auth, rate limit…) are rethrown.
          if (err instanceof Anthropic.APIError || attempt >= 2) throw err;
          log.warn({ attempt }, '[ai] unparseable tool input, re-issuing the turn');
        }
      }
    },
  };
}
