import { Platform } from 'react-native';
import * as SecureStore from 'expo-secure-store';

/**
 * Small key/value store. Native: expo-secure-store (Keychain / Keystore).
 * Web: localStorage (expo-secure-store has no web implementation) — fine for preview builds,
 * production web uses the separate apps/app with HTTP-only cookies.
 */
const web = {
  async get(k: string) {
    try {
      return globalThis.localStorage?.getItem(k) ?? null;
    } catch {
      return null;
    }
  },
  async set(k: string, v: string) {
    try {
      globalThis.localStorage?.setItem(k, v);
    } catch {
      /* ignore */
    }
  },
  async remove(k: string) {
    try {
      globalThis.localStorage?.removeItem(k);
    } catch {
      /* ignore */
    }
  },
};

const native = {
  async get(k: string) {
    try {
      return await SecureStore.getItemAsync(k);
    } catch {
      return null;
    }
  },
  async set(k: string, v: string) {
    try {
      await SecureStore.setItemAsync(k, v);
    } catch {
      /* ignore */
    }
  },
  async remove(k: string) {
    try {
      await SecureStore.deleteItemAsync(k);
    } catch {
      /* ignore */
    }
  },
};

export const storage = Platform.OS === 'web' ? web : native;

const TOKEN_KEY = 'bh.token';
export const tokenStore = {
  get: () => storage.get(TOKEN_KEY),
  set: (t: string) => storage.set(TOKEN_KEY, t),
  clear: () => storage.remove(TOKEN_KEY),
};
