/** Offline audit drafts on the web preview: localStorage (the native app uses the document directory). */
const PREFIX = 'bh.auditDraft.';

export const draftStore = {
  async read(key: string): Promise<string | null> {
    try {
      return globalThis.localStorage?.getItem(PREFIX + key) ?? null;
    } catch {
      return null;
    }
  },
  async write(key: string, value: string): Promise<void> {
    try {
      globalThis.localStorage?.setItem(PREFIX + key, value);
    } catch {
      /* storage full or unavailable: the draft stays in memory */
    }
  },
  async remove(key: string): Promise<void> {
    try {
      globalThis.localStorage?.removeItem(PREFIX + key);
    } catch {
      /* ignore */
    }
  },
  async keys(): Promise<string[]> {
    try {
      const ls = globalThis.localStorage;
      if (!ls) return [];
      return Array.from({ length: ls.length }, (_, i) => ls.key(i)).filter((k): k is string => !!k && k.startsWith(PREFIX)).map((k) => k.slice(PREFIX.length));
    } catch {
      return [];
    }
  },
};
