import { createContext, useContext, useMemo, type ReactNode } from 'react';
import { api } from '@/lib/api';
import { useApi, type ApiState } from '@/lib/useApi';
import { useSession } from '@/lib/session';
import type { Brand, Location } from '@/lib/types';

interface CatalogCtx {
  brandsQ: ApiState<Brand[]>;
  locationsQ: ApiState<Location[]>;
  brand: Brand | undefined;
  /** Locations of the active brand. */
  locations: Location[];
  /** Active location (selected, else the first operating one). */
  location: Location | undefined;
  locationById: (id: string) => Location | undefined;
}

const Ctx = createContext<CatalogCtx | null>(null);

export function CatalogProvider({ children }: { children: ReactNode }) {
  const { brandId, locationFor } = useSession();
  const brandsQ = useApi(() => api.brands(), []);
  const locationsQ = useApi(() => api.locations(), []);
  const value = useMemo<CatalogCtx>(() => {
    const brand = brandsQ.data?.find((b) => b.id === brandId) ?? brandsQ.data?.[0];
    const all = locationsQ.data ?? [];
    const locations = all.filter((l) => l.brandId === brand?.id);
    const selected = locations.find((l) => l.id === locationFor(brand?.id ?? ''));
    const location = selected ?? locations.find((l) => l.status === 'operating');
    return { brandsQ, locationsQ, brand, locations, location, locationById: (id) => all.find((l) => l.id === id) };
  }, [brandsQ, locationsQ, brandId, locationFor]);
  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}

export function useCatalog(): CatalogCtx {
  const c = useContext(Ctx);
  if (!c) throw new Error('useCatalog must be used inside CatalogProvider');
  return c;
}
