import { readdirSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { z } from 'zod';
import type { AiOrgSettings } from '@bh/shared';
import type { AssistantContext } from './context.ts';
import type { LlmTool } from './llm.ts';
import type { MarinaTool } from './types.ts';

/**
 * Tool registry. Every file in `src/ai/tools/` (except files starting with `_`) is loaded automatically and must
 * `export default` an array of tools built with `defineTool`. To add tools for a module, add one file there; nothing
 * else needs registering (docs/AI.md "Adding tools").
 */
const toolsDir = path.join(path.dirname(fileURLToPath(import.meta.url)), 'tools');

let loading: Promise<Map<string, MarinaTool>> | null = null;

export function loadTools(): Promise<Map<string, MarinaTool>> {
  loading ??= (async () => {
    const map = new Map<string, MarinaTool>();
    const files = readdirSync(toolsDir).filter((f) => /\.(ts|js)$/.test(f) && !f.startsWith('_') && !f.endsWith('.d.ts')).sort();
    for (const f of files) {
      const mod = (await import(pathToFileURL(path.join(toolsDir, f)).href)) as { default?: MarinaTool[] };
      for (const t of mod.default ?? []) {
        if (map.has(t.name)) throw new Error(`Duplicate assistant tool name ${t.name} (${f})`);
        if (!/^[a-z][a-z0-9_]{1,63}$/.test(t.name)) throw new Error(`Invalid assistant tool name ${t.name} (${f})`);
        map.set(t.name, t);
      }
    }
    return map;
  })();
  return loading;
}

/** Is the tool offered to this person (industry, organisation model, areas switched on, capabilities)? */
export function toolAvailable(t: MarinaTool, ctx: AssistantContext, settings: AiOrgSettings): boolean {
  if (t.industries && !t.industries.includes(ctx.org.industry)) return false;
  if (t.networkOnly && ctx.org.model === 'independent') return false;
  if (settings.allowedAreas && !settings.allowedAreas.includes(t.area) && t.area !== 'general') return false;
  if (t.kind === 'write' && !ctx.can('ai.assistant', 'edit')) return false;
  if (!t.modules) return true;
  const action = t.kind === 'write' ? (t.action ?? 'edit') : 'view';
  return t.modules.some((m) => ctx.can(m, action));
}

export async function toolsFor(ctx: AssistantContext, settings: AiOrgSettings): Promise<MarinaTool[]> {
  const all = await loadTools();
  // Sorted by name: the tool list is part of the cached prompt prefix, so it must be deterministic.
  return [...all.values()].filter((t) => toolAvailable(t, ctx, settings)).sort((a, b) => a.name.localeCompare(b.name));
}

/** Claude tool definitions (JSON Schema from the zod input). */
export function toLlmTools(tools: MarinaTool[]): LlmTool[] {
  return tools.map((t) => {
    const schema = z.toJSONSchema(t.input, { target: 'draft-7', io: 'input' }) as Record<string, unknown>;
    delete schema.$schema;
    const description = t.kind === 'write'
      ? `${t.description}\n\nThis prepares an action card. Nothing happens until the person confirms it in the app.`
      : t.description;
    return { name: t.name, description, input_schema: { type: 'object', ...schema } as LlmTool['input_schema'] };
  });
}
