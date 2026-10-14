import { Badge, DataStatus, EmptyState, ListItem, Screen, ScreenHeader, SectionHeader, SkeletonCard } from '@/components';
import { realtyApi } from '@/features/realty/api';
import { ListingRow } from '@/features/realty/ListingRow';
import { useRealtyStrings } from '@/features/realty/strings';
import { fmtDateTime } from '@/lib/format';
import { useApi } from '@/lib/useApi';

/** Buyer: saved homes and my viewings (signed-in; guests see empty states). */
export default function RealtySaved() {
  const { s, intlLocale } = useRealtyStrings();
  const favs = useApi(() => realtyApi.favourites(), []);
  const vs = useApi(() => realtyApi.myViewings(), []);
  return (
    <Screen tabs={false} onRefresh={() => { void favs.refresh(); void vs.refresh(); }} refreshing={favs.refreshing}>
      <ScreenHeader title={s('saved')} back />
      <SectionHeader title={s('myViewings')} />
      <DataStatus q={vs} />
      {vs.loading ? <SkeletonCard /> : null}
      {!vs.loading && !(vs.data ?? []).length ? <EmptyState icon="calendar" title={s('noViewings')} /> : null}
      {(vs.data ?? []).map((v) => (
        <ListItem key={v.id} icon="key" title={v.listing?.title ?? ''} subtitle={`${fmtDateTime(v.startsAt, v.timeZone ?? 'UTC', intlLocale)} · ${v.agentName ?? ''}`} trailing={<Badge label={v.status} tone={v.status === 'confirmed' ? 'success' : v.status === 'cancelled' ? 'neutral' : 'warning'} />} />
      ))}
      <SectionHeader title={s('myHomes')} />
      <DataStatus q={favs} />
      {favs.loading ? <SkeletonCard /> : null}
      {!favs.loading && !(favs.data ?? []).length ? <EmptyState icon="heart" title={s('noSaved')} /> : null}
      {(favs.data ?? []).map((l) => <ListingRow key={l.id} l={l} />)}
    </Screen>
  );
}
