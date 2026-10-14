import { useState } from 'react';
import { View } from 'react-native';
import { router } from 'expo-router';
import { Badge, Button, Card, ConfirmSheet, DataStatus, EmptyState, ListItem, Screen, ScreenHeader, SectionHeader, SkeletonCard, Tag, Text, useToast, type Tone, type IconName } from '@/components';
import { useCatalog } from '@/features/customer/catalog';
import { orderStatusCopy } from '@/features/customer/orderStatus';
import { useI18n } from '@/i18n';
import { api } from '@/lib/api';
import { ApiError } from '@/lib/errors';
import { fmtDateTime, fmtMoney, fmtTime, fmtZone } from '@/lib/format';
import { useApi } from '@/lib/useApi';
import type { Booking } from '@/lib/types';
import { pastel } from '@/theme';

export default function Bookings() {
  const { t, intlLocale } = useI18n();
  const toast = useToast();
  const { locationById, brand } = useCatalog();
  const q = useApi(() => api.myBookings(), []);
  const ordersQ = useApi(() => api.myOrders(), []);
  const [tab, setTab] = useState<'upcoming' | 'past'>('upcoming');
  const [cancelling, setCancelling] = useState<Booking | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const foods = brand?.industry === 'foods';

  const now = Date.now();
  const list = (q.data ?? []).filter((b) => (tab === 'upcoming' ? new Date(b.startsAt).getTime() >= now && b.status !== 'cancelled' : new Date(b.startsAt).getTime() < now || b.status === 'cancelled'));
  if (tab === 'past') list.reverse();

  const statusOf = (b: Booking): { label: string; tone: Tone; icon: IconName } => {
    switch (b.status) {
      case 'confirmed': return { label: t('bookings.confirmed'), tone: 'success', icon: 'check-circle' };
      case 'waitlisted': return { label: t('bookings.waitlisted', { position: b.waitlistPosition ?? '—' }), tone: 'warning', icon: 'clock' };
      case 'cancelled': return { label: t('bookings.cancelled'), tone: 'neutral', icon: 'x' };
      case 'attended': return { label: t('bookings.attended'), tone: 'info', icon: 'check' };
      default: return { label: t('common.pending'), tone: 'neutral', icon: 'clock' };
    }
  };

  const cl = cancelling ? locationById(cancelling.locationId) : undefined;
  const hoursLeft = cancelling ? (new Date(cancelling.startsAt).getTime() - now) / 3_600_000 : 0;
  const late = cl ? hoursLeft < cl.cancellationHours : false;

  return (
    <Screen onRefresh={() => { void q.refresh(); void ordersQ.refresh(); }} refreshing={q.refreshing}>
      <ScreenHeader title={foods ? t('bookings.orders') : t('bookings.title')} />

      {foods || (ordersQ.data?.length ?? 0) > 0 ? (
        <>
          {!foods ? <SectionHeader title={t('bookings.orders')} /> : null}
          {(ordersQ.data ?? []).map((o) => {
            const ol = locationById(o.locationId);
            const c = orderStatusCopy(o, t, ol ? fmtTime(o.pickupAt, ol.timeZone, intlLocale) : '', ol?.name ?? '');
            return (
              <ListItem key={o.id} icon="utensils" iconBg={pastel.blush} title={`${t('order.orderNo', { number: o.number })} · ${ol?.name ?? ''}`} subtitle={`${fmtMoney(o.total, intlLocale)} · ${ol ? `${fmtTime(o.pickupAt, ol.timeZone, intlLocale)} ${fmtZone(ol.timeZone, intlLocale)}` : ''}`} trailing={<Badge label={c.title} tone={c.tone} icon={c.icon} />} onPress={() => router.push(`/customer/orders/${o.id}`)} />
            );
          })}
          {foods && ordersQ.data?.length === 0 ? <EmptyState icon="utensils" title={t('order.emptyCart')} action={t('customer.quickOrder')} onAction={() => router.push('/customer/order')} /> : null}
        </>
      ) : null}

      {!foods ? (
        <>
          <View style={{ flexDirection: 'row', gap: 8 }} accessibilityRole="tablist">
            <Tag label={t('bookings.upcoming')} selected={tab === 'upcoming'} onPress={() => setTab('upcoming')} />
            <Tag label={t('bookings.past')} selected={tab === 'past'} onPress={() => setTab('past')} />
          </View>
          <DataStatus q={q} />
          {q.loading ? <><SkeletonCard /><SkeletonCard /></> : null}
          {!q.loading && list.length === 0 ? (
            tab === 'upcoming' ? <EmptyState icon="calendar" bg={pastel.lilac} title={t('bookings.empty')} body={t('bookings.emptySub')} action={t('customer.quickBook')} onAction={() => router.push('/customer/book')} /> : <EmptyState icon="calendar" title={t('bookings.emptyPast')} />
          ) : null}
          {list.map((b) => {
            const l = locationById(b.locationId);
            const st = statusOf(b);
            const manageable = tab === 'upcoming' && (b.status === 'confirmed' || b.status === 'waitlisted');
            return (
              <Card key={b.id}>
                <View style={{ flexDirection: 'row', gap: 10, alignItems: 'flex-start' }}>
                  <View style={{ flex: 1, gap: 2 }}>
                    <Text variant="h3">{b.className}</Text>
                    <Text variant="small" tone="muted">{l ? `${fmtDateTime(b.startsAt, l.timeZone, intlLocale)} ${fmtZone(l.timeZone, intlLocale)}` : ''}</Text>
                    <Text variant="small" tone="muted">{brand?.name} {l?.name} · {b.instructor}</Text>
                  </View>
                  <Badge label={st.label} tone={st.tone} icon={st.icon} />
                </View>
                {manageable ? (
                  <Button label={b.status === 'waitlisted' ? t('bookings.leaveWaitlist') : t('bookings.cancel')} variant="soft" size="sm" style={{ alignSelf: 'flex-start' }} onPress={() => { setErr(null); setCancelling(b); }} />
                ) : null}
              </Card>
            );
          })}
        </>
      ) : null}

      <ConfirmSheet
        visible={!!cancelling}
        title={cancelling?.status === 'waitlisted' ? t('bookings.leaveWaitlist') : t('bookings.cancelTitle')}
        body={cancelling && cl ? (cancelling.status === 'waitlisted' ? t('book.waitlistBody') : late ? t('bookings.cancelLate', { hours: cl.cancellationHours, location: `${brand?.name ?? ''} ${cl.name}` }) : t('bookings.cancelFree', { amount: fmtMoney(cancelling.price, intlLocale) })) : undefined}
        confirmLabel={cancelling?.status === 'waitlisted' ? t('bookings.leaveWaitlist') : t('bookings.cancel')}
        confirmVariant="danger"
        error={err}
        onCancel={() => setCancelling(null)}
        onConfirm={async () => {
          try {
            await api.cancelBooking(cancelling!.id);
            setCancelling(null);
            toast(t('bookings.cancelled_toast'));
            await q.refresh();
          } catch (e) {
            setErr((e as ApiError).message);
          }
        }}
      >
        {cancelling && cl ? (
          <Card bg={pastel.sand} padding={12}>
            <Text variant="small" weight={700}>{t('book.policy')}</Text>
            <Text variant="small">{t('book.policyText', { hours: cl.cancellationHours })}</Text>
          </Card>
        ) : null}
      </ConfirmSheet>
    </Screen>
  );
}
