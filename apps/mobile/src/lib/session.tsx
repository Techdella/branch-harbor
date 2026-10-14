import { createContext, useCallback, useContext, useEffect, useMemo, useState, type ReactNode } from 'react';
import { api } from './api';
import { setSessionExpiredHandler } from './http';
import { storage, tokenStore } from './storage';
import type { Experience, Me } from './types';

interface SessionCtx {
  status: 'loading' | 'signedOut' | 'ready';
  me: Me | null;
  experience: Experience | null;
  setExperience: (e: Experience | null) => void;
  signIn: (email: string, password: string) => Promise<void>;
  continueAsGuest: () => Promise<void>;
  signOut: () => Promise<void>;
  /** Customer white-label brand (demo can switch between a studio and a food brand). */
  brandId: string;
  setBrandId: (id: string) => void;
  /** Selected location per brand. */
  locationFor: (brandId: string) => string | undefined;
  setLocation: (brandId: string, locationId: string) => void;
}

const Ctx = createContext<SessionCtx | null>(null);
const K = { exp: 'bh.experience', brand: 'bh.brand', locs: 'bh.locations' };

export function SessionProvider({ children }: { children: ReactNode }) {
  const [status, setStatus] = useState<SessionCtx['status']>('loading');
  const [me, setMe] = useState<Me | null>(null);
  const [experience, setExpState] = useState<Experience | null>(null);
  const [brandId, setBrandState] = useState('stillwater');
  const [locs, setLocs] = useState<Record<string, string>>({});

  useEffect(() => {
    (async () => {
      const [exp, brand, l] = await Promise.all([storage.get(K.exp), storage.get(K.brand), storage.get(K.locs)]);
      if (brand) setBrandState(brand);
      if (l) {
        try {
          setLocs(JSON.parse(l) as Record<string, string>);
        } catch {
          /* ignore */
        }
      }
      const token = await tokenStore.get();
      if (!token) return setStatus('signedOut');
      try {
        const m = await api.me();
        setMe(m);
        if (exp && m.experiences.includes(exp as Experience)) setExpState(exp as Experience);
        setStatus('ready');
      } catch {
        await tokenStore.clear();
        setStatus('signedOut');
      }
    })();
  }, []);

  // Live API: when the refresh token is rejected (expired, revoked, reused) the user must sign in again.
  useEffect(() => {
    setSessionExpiredHandler(() => {
      setMe(null);
      setExpState(null);
      setStatus('signedOut');
    });
    return () => setSessionExpiredHandler(null);
  }, []);

  const setExperience = useCallback((e: Experience | null) => {
    setExpState(e);
    if (e) void storage.set(K.exp, e);
    else void storage.remove(K.exp);
  }, []);

  const accept = useCallback(async (res: { token: string; me: Me }) => {
    await tokenStore.set(res.token);
    setMe(res.me);
    setStatus('ready');
    if (res.me.experiences.length === 1) setExperience(res.me.experiences[0]!);
  }, [setExperience]);

  const value = useMemo<SessionCtx>(() => ({
    status, me, experience, setExperience, brandId,
    signIn: async (email, password) => accept(await api.signIn(email, password)),
    continueAsGuest: async () => accept(await api.guest()),
    signOut: async () => {
      try {
        await api.signOut();
      } catch {
        /* sign out locally regardless */
      }
      await tokenStore.clear();
      setExperience(null);
      setMe(null);
      setStatus('signedOut');
    },
    setBrandId: (id) => {
      setBrandState(id);
      void storage.set(K.brand, id);
    },
    locationFor: (b) => locs[b],
    setLocation: (b, l) => {
      setLocs((prev) => {
        const next = { ...prev, [b]: l };
        void storage.set(K.locs, JSON.stringify(next));
        return next;
      });
    },
  }), [status, me, experience, setExperience, brandId, locs, accept]);

  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}

export function useSession(): SessionCtx {
  const c = useContext(Ctx);
  if (!c) throw new Error('useSession must be used inside SessionProvider');
  return c;
}
