import { router } from 'expo-router';
import { useI18n } from '@/i18n';
import { fmtTime, fmtZone } from '@/lib/format';
import type { Location } from '@/lib/types';
import type { ScopeChip } from '@/components';
import { useCatalog } from './catalog';

const regionName = (code: string, locale: string) => {
  try {
    return new Intl.DisplayNames([locale], { type: 'region' }).of(code) ?? code;
  } catch {
    return code;
  }
};

/** Location chip: name, city + country, local time and zone. Tapping opens the picker. */
export function useLocationScope(location: Location | undefined, brandName?: string): ScopeChip | undefined {
  const { t, intlLocale } = useI18n();
  const { locations } = useCatalog();
  if (!location) return undefined;
  // A business with a single location: nothing to choose, so the chip isn't a picker.
  const single = locations.length <= 1;
  const now = new Date().toISOString();
  return {
    label: `${brandName ? `${brandName} · ` : ''}${location.name}`,
    sub: `${location.city}, ${regionName(location.country, intlLocale)} · ${fmtTime(now, location.timeZone, intlLocale)} ${fmtZone(location.timeZone, intlLocale)}`,
    ...(single ? {} : { onPress: () => router.push('/customer/locations'), hint: t('customer.chooseLocation') }),
  };
}

export { regionName };
