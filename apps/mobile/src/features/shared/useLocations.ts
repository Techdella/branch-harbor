import { api } from '@/lib/api';
import { useApi } from '@/lib/useApi';

/** All locations the signed-in user may see (server scopes the list). */
export function useLocations() {
  const q = useApi(() => api.locations(), []);
  return { q, byId: (id: string) => q.data?.find((l) => l.id === id) };
}
