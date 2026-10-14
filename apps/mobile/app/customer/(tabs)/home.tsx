import { Image, View } from 'react-native';
import { router } from 'expo-router';
import { Avatar, Card, Icon, MoneyText, Screen, ScopeChipView, SectionHeader, SkeletonCard, Tag, Text, DataStatus, type IconName } from '@/components';
import { RealtyEntry } from '@/features/realty/RealtyEntry';
import { useCatalog } from '@/features/customer/catalog';
import { useLocationScope } from '@/features/customer/useLocationScope';
import { useI18n } from '@/i18n';
import { api } from '@/lib/api';
import { fmtDateTime, fmtTime, fmtZone, localDateKey } from '@/lib/format';
import { useSession } from '@/lib/session';
import { useApi } from '@/lib/useApi';
import { orderStatusCopy } from '@/features/customer/orderStatus';
import { color, pastel, radius } from '@/theme';

export default function Home() {
  const { t, intlLocale } = useI18n();
  const { me, setBrandId } = useSession();
  const { brand, location, locations, brandsQ, locationsQ } = useCatalog();
  const scope = useLocationScope(location);
  const foods = brand?.industry === 'foods';

  const bookingsQ = useApi(() => api.myBookings(), []);
  const ordersQ = useApi(() => api.myOrders(), []);
  const classesQ = useApi(
    () => (location && !foods ? api.classes(location.id, localDateKey(new Date(), location.timeZone)) : Promise.resolve([])),
    [location?.id, foods],
  );
  const menuQ = useApi(() => (location && foods ? api.menu(location.id) : Promise.resolve([])), [location?.id, foods]);

  const hour = location ? Number(new Intl.DateTimeFormat('en-US', { hour: 'numeric', hourCycle: 'h23', timeZone: location.timeZone }).format(new Date())) : 9;
  const greeting = hour < 12 ? t('customer.goodMorning') : hour < 18 ? t('customer.goodAfternoon') : t('customer.goodEvening');
  const next = bookingsQ.data?.find((b) => b.status === 'confirmed' && new Date(b.startsAt).getTime() > Date.now());
  const nextLoc = next ? locationsQ.data?.find((l) => l.id === next.locationId) : undefined;
  const activeOrder = ordersQ.data?.find((o) => !['collected', 'cancelled', 'rejected'].includes(o.status));

  const quick: { label: string; icon: IconName; go: () => void; bg: string }[] = [
    foods
      ? { label: t('customer.quickOrder'), icon: 'utensils', go: () => router.push('/customer/order'), bg: pastel.blush }
      : { label: t('customer.quickBook'), icon: 'calendar', go: () => router.push('/customer/book'), bg: pastel.lilac },
    ...(foods ? [] : [
      { label: t('studio.quickPass'), icon: 'wallet' as IconName, go: () => router.push('/customer/pass'), bg: pastel.butter },
      { label: t('studio.quickOnline'), icon: 'play' as IconName, go: () => router.push('/customer/online'), bg: pastel.aqua },
    ]),
    { label: t('customer.quickBookings'), icon: 'receipt', go: () => router.push('/customer/bookings'), bg: color.surface },
    { label: t('customer.quickInbox'), icon: 'message', go: () => router.push('/customer/inbox'), bg: color.surface },
    // Single-location businesses skip the location picker.
    ...(locations.length > 1 ? [{ label: t('tabs.locations'), icon: 'pin' as IconName, go: () => router.push('/customer/locations'), bg: color.surface }] : []),
    { label: 'Spa & wellness', icon: 'leaf' as IconName, go: () => router.push('/customer/wellness'), bg: color.surface },
  ];

  return (
    <Screen onRefresh={() => { void bookingsQ.refresh(); void classesQ.refresh(); void ordersQ.refresh(); }} refreshing={bookingsQ.refreshing}>
      <View style={{ flexDirection: 'row', alignItems: 'center', gap: 12 }}>
        <Avatar name={me?.user.name ?? t('customer.guest')} uri={me?.user.avatar} size={44} />
        <View style={{ flex: 1 }}>
          <Text variant="small" tone="muted">{greeting}</Text>
          <Text variant="h2" accessibilityRole="header">{me?.guest ? t('customer.guest') : me?.user.name}</Text>
        </View>
      </View>

      {scope ? <ScopeChipView {...scope} /> : null}

      <View style={{ gap: 6 }}>
        <Text variant="label" tone="muted">{t('customer.brandSwitch')} · {t('common.sampleData')}</Text>
        <View style={{ flexDirection: 'row', gap: 8, flexWrap: 'wrap' }}>
          {(brandsQ.data ?? []).map((b) => (
            <Tag key={b.id} label={b.name} icon={b.industry === 'foods' ? 'utensils' : 'lotus'} selected={b.id === brand?.id} onPress={() => setBrandId(b.id)} />
          ))}
        </View>
      </View>

      <DataStatus q={locationsQ} />

      {brand ? (
        <View style={{ height: 190, borderRadius: radius.xl, overflow: 'hidden', backgroundColor: color.ink }}>
          <Image source={{ uri: brand.hero }} style={{ position: 'absolute', width: '100%', height: '100%' }} accessibilityIgnoresInvertColors />
          <View style={{ position: 'absolute', inset: 0, backgroundColor: 'rgba(0,0,0,0.38)' }} />
          <View style={{ position: 'absolute', left: 16, right: 16, bottom: 14, gap: 2 }}>
            <Text variant="small" weight={800} color={color.lime}>{brand.name}</Text>
            <Text variant="h2" tone="inverse">{brand.offer}</Text>
          </View>
        </View>
      ) : (
        <SkeletonCard />
      )}

      {foods && activeOrder ? (() => {
        const ol = locationsQ.data?.find((l) => l.id === activeOrder.locationId);
        const c = orderStatusCopy(activeOrder, t, ol ? fmtTime(activeOrder.pickupAt, ol.timeZone, intlLocale) : '', ol?.name ?? '');
        return (
          <Card dark onPress={() => router.push(`/customer/orders/${activeOrder.id}`)} accessibilityLabel={`${t('order.orderNo', { number: activeOrder.number })}. ${c.title}`}>
            <NextRow icon={c.icon} kicker={t('order.orderNo', { number: activeOrder.number })} title={c.title} sub={ol?.name ?? ''} />
          </Card>
        );
      })() : null}
      {!foods && next && nextLoc ? (
        <Card dark onPress={() => router.push('/customer/bookings')}>
          <NextRow icon="lotus" kicker={t('customer.comingUp')} title={next.className} sub={`${fmtDateTime(next.startsAt, nextLoc.timeZone, intlLocale)} ${fmtZone(nextLoc.timeZone, intlLocale)} · ${nextLoc.name}`} />
        </Card>
      ) : null}

      <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 8 }}>
        {quick.map((q) => (
          <Card key={q.label} bg={q.bg} onPress={q.go} padding={12} style={{ flexGrow: 1, flexBasis: '45%', alignItems: 'center' }} accessibilityLabel={q.label}>
            <Icon name={q.icon} size={22} />
            <Text variant="small" weight={700} align="center">{q.label}</Text>
          </Card>
        ))}
      </View>

      {!foods && location ? (
        <>
          <SectionHeader title={t('book.title', { location: location.name })} sub={t('common.timesIn', { zone: fmtZone(location.timeZone, intlLocale) })} action={t('common.seeAll')} onAction={() => router.push('/customer/book')} />
          {classesQ.loading ? <SkeletonCard lines={2} /> : null}
          {(classesQ.data ?? []).filter((c) => new Date(c.startsAt).getTime() > Date.now()).slice(0, 3).map((c) => (
            <Card key={c.id} onPress={() => router.push(`/customer/class/${encodeURIComponent(c.id)}`)} padding={10} accessibilityLabel={`${c.name}, ${fmtTime(c.startsAt, location.timeZone, intlLocale)}`}>
              <View style={{ flexDirection: 'row', gap: 12, alignItems: 'center' }}>
                <Image source={{ uri: c.image }} style={{ width: 60, height: 60, borderRadius: 16 }} accessibilityIgnoresInvertColors />
                <View style={{ flex: 1 }}>
                  <Text weight={700}>{c.name}</Text>
                  <Text variant="small" tone="muted">{fmtTime(c.startsAt, location.timeZone, intlLocale)} · {t('book.minutes', { count: c.durationMin })} · {c.instructor}</Text>
                </View>
                <MoneyText value={c.price} weight={800} />
              </View>
            </Card>
          ))}
          {classesQ.data && classesQ.data.length === 0 && location.status !== 'operating' ? <Text tone="muted">{t('customer.openingSoon')}</Text> : null}
        </>
      ) : null}

      {foods && location ? (
        <>
          <SectionHeader title={t('order.menu')} action={t('common.seeAll')} onAction={() => router.push('/customer/order')} />
          {(menuQ.data ?? []).filter((m) => !m.soldOut).slice(0, 3).map((m) => (
            <Card key={m.id} onPress={() => router.push('/customer/order')} padding={10} accessibilityLabel={m.name}>
              <View style={{ flexDirection: 'row', gap: 12, alignItems: 'center' }}>
                <Image source={{ uri: m.image }} style={{ width: 60, height: 60, borderRadius: 16 }} accessibilityIgnoresInvertColors />
                <View style={{ flex: 1 }}>
                  <Text weight={700}>{m.name}</Text>
                  <Text variant="small" tone="muted">{m.description}</Text>
                </View>
                <MoneyText value={m.price} weight={800} />
              </View>
            </Card>
          ))}
        </>
      ) : null}
      <RealtyEntry kind="buyer" />
    </Screen>
  );
}

function NextRow({ icon, kicker, title, sub }: { icon: IconName; kicker: string; title: string; sub: string }) {
  return (
    <View style={{ flexDirection: 'row', alignItems: 'center', gap: 12 }}>
      <View style={{ width: 44, height: 44, borderRadius: 14, backgroundColor: color.lime, alignItems: 'center', justifyContent: 'center' }}>
        <Icon name={icon} size={20} />
      </View>
      <View style={{ flex: 1 }}>
        <Text variant="label" color={color.lime}>{kicker}</Text>
        <Text variant="h3" tone="inverse">{title}</Text>
        {sub ? <Text variant="small" color="#C9C9C3">{sub}</Text> : null}
      </View>
      <Icon name="chevron-right" size={18} color={color.surface} />
    </View>
  );
}
