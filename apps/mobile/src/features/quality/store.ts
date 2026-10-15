import { Directory, File, Paths } from 'expo-file-system';

/**
 * Durable storage for offline audits (native): one JSON file per audit in the app's document directory, which the
 * system never clears. Photos taken offline live inside the draft (base64, already scaled down) until they upload.
 * The web preview uses localStorage instead (store.web.ts).
 */
const dir = () => {
  const d = new Directory(Paths.document, 'audit-drafts');
  if (!d.exists) d.create({ intermediates: true, idempotent: true });
  return d;
};

export const draftStore = {
  async read(key: string): Promise<string | null> {
    try {
      const f = new File(dir(), `${key}.json`);
      return f.exists ? await f.text() : null;
    } catch {
      return null;
    }
  },
  async write(key: string, value: string): Promise<void> {
    const f = new File(dir(), `${key}.json`);
    if (!f.exists) f.create({ intermediates: true, overwrite: true });
    f.write(value);
  },
  async remove(key: string): Promise<void> {
    try {
      const f = new File(dir(), `${key}.json`);
      if (f.exists) f.delete();
    } catch {
      /* already gone */
    }
  },
  async keys(): Promise<string[]> {
    try {
      return dir().list().filter((x): x is File => x instanceof File).map((f) => f.name.replace(/\.json$/, ''));
    } catch {
      return [];
    }
  },
};
