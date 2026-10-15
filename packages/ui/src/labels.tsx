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
}

export const DEFAULT_UI_LABELS: UiLabels = { optional: 'optional', close: 'Close', scope: 'Scope' };

const Ctx = createContext<UiLabels>(DEFAULT_UI_LABELS);

export function UiLabelsProvider({ labels, children }: { labels: Partial<UiLabels>; children: ReactNode }) {
  return <Ctx.Provider value={{ ...DEFAULT_UI_LABELS, ...labels }}>{children}</Ctx.Provider>;
}

export const useUiLabels = () => useContext(Ctx);
