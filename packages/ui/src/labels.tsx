'use client';

import { createContext, useContext, type ReactNode } from 'react';

/** The few words the shared components render themselves. Apps pass translations with `UiLabelsProvider`. */
export interface UiLabels {
  /** Suffix after an optional field's label, e.g. "optional" (rendered in parentheses). */
  optional: string;
  /** Accessible name of the drawer's close button. */
  close: string;
  /** Screen-reader label of the scope selector. */
  scope: string;
  /** Metric value placeholder when its source is not connected (StatCard). */
  notConnected: string;
  /** Metric value placeholder when it can't be computed (StatCard) — never a fabricated zero. */
  unavailable: string;
  /** OriginTag: where a value comes from. */
  originHq: string;
  originLocal: string;
  originLocked: string;
  originApproval: string;
}

export const DEFAULT_UI_LABELS: UiLabels = { optional: 'optional', close: 'Close', scope: 'Scope', notConnected: 'Not connected', unavailable: 'Unavailable', originHq: 'From headquarters', originLocal: 'Set locally', originLocked: 'Locked by HQ', originApproval: 'Approval required' };

const Ctx = createContext<UiLabels>(DEFAULT_UI_LABELS);

export function UiLabelsProvider({ labels, children }: { labels: Partial<UiLabels>; children: ReactNode }) {
  return <Ctx.Provider value={{ ...DEFAULT_UI_LABELS, ...labels }}>{children}</Ctx.Provider>;
}

export const useUiLabels = () => useContext(Ctx);
