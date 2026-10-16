import type { z } from 'zod';
import type { AccessAction, AiActionRisk, AiBlock, AiCitation, AiToolArea } from '@bh/shared';
import type { AssistantContext } from './context.ts';

/**
 * A tool the assistant can call. One file per module under `src/ai/tools/` exports `default` an array of tools; the
 * registry loads every file automatically (see registry.ts and docs/AI.md "Adding tools").
 *
 * Tools run AS THE SIGNED-IN PERSON: they call the REST API through `ctx.api` with that person's token, so every call
 * goes through exactly the same capability, scope and field filtering as the app. A tool must never read the database
 * directly for data a REST route already serves.
 */
export interface ToolPresentation {
  /** One-line summary for the model and the audit log (counts, not personal data). */
  summary?: string;
  blocks?: AiBlock[];
  citations?: AiCitation[];
  navigate?: { path: string; label: string };
}

export interface ActionPreview {
  title: string;
  summary: string;
  details?: Array<{ label: string; value: string }>;
  /** App path to open the affected record after it is done. */
  link?: string | null;
  /** Inputs the person may edit on the card before confirming. */
  editable?: Array<{ key: string; label: string; kind: 'text' | 'textarea' | 'date' | 'number' }>;
}

interface ToolBase<I> {
  name: string;
  /** Workspace area (organisations can switch areas off in their AI controls). */
  area: AiToolArea;
  /**
   * Module(s) whose view (read tools) or `action` (write tools) the person needs somewhere for the tool to be offered
   * at all. Any one of them is enough. null = everyone who may use the assistant. The REST route still decides.
   */
  modules: string[] | null;
  description: string;
  input: z.ZodType<I>;
  /** Limit to industries (operations tools). */
  industries?: string[];
  /** Hidden for independent (single-location) businesses. */
  networkOnly?: boolean;
  /** Offered only to people with an organisation-wide (HQ) assignment, for tools whose REST route is HQ only. */
  hqOnly?: boolean;
}

export interface ReadTool<I = any> extends ToolBase<I> {
  kind: 'read';
  /** The result carries text written by customers, guests, franchisees or third parties (reviews, messages, documents). */
  untrustedOutput?: boolean;
  run(ctx: AssistantContext, input: I): Promise<unknown>;
  present?(result: any, input: I, ctx: AssistantContext): ToolPresentation;
}

export interface WriteTool<I = any> extends ToolBase<I> {
  kind: 'write';
  /** Capability action needed on `modules` to propose (default edit). */
  action?: AccessAction;
  risk: AiActionRisk | ((input: I) => AiActionRisk);
  preview(ctx: AssistantContext, input: I): Promise<ActionPreview>;
  /** Runs only after the person confirmed the card (and an approver, when the organisation requires one). */
  execute(ctx: AssistantContext, input: I): Promise<{ result: Record<string, unknown>; link?: string | null }>;
}

export type MarinaTool = ReadTool | WriteTool;

export function defineTool<I>(t: ReadTool<I>): ReadTool<I>;
export function defineTool<I>(t: WriteTool<I>): WriteTool<I>;
export function defineTool(t: MarinaTool): MarinaTool {
  return t;
}

/** A failure the assistant reports back to the model and the person (never a stack trace). */
export class ToolError extends Error {
  constructor(public code: string, message: string, public status = 400) {
    super(message);
  }
}
