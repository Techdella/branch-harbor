import { useCallback, useEffect, useState } from 'react';
import { Image, View } from 'react-native';
import { router, useLocalSearchParams } from 'expo-router';
import { Banner, Button, Card, EmptyState, Icon, ListItem, MoneyText, PaymentStep, Screen, ScreenHeader, SkeletonCard, Text, TextField } from '@/components';
import { useCatalog } from '@/features/customer/catalog';
import { useI18n } from '@/i18n';
import { api, guestContact } from '@/lib/api';
import { ApiError } from '@/lib/errors';
import { fmtDateTime, fmtMoney, fmtZone } from '@/lib/format';
import { announce } from '@/lib/motion';
import { useApi } from '@/lib/useApi';
import type { Booking } from '@/lib/types';
import { color, pastel, radius } from '@/theme';

type Phase = 'holding' | 'held' | 'expired' | 'full' | 'done' | 'waitlisted' | 'error' | 'contact';

export default function ClassBooking() {
  const { id: raw } = useLocalSearchParams<{ id: string }>();
  const id = decodeURIComponent(String(raw));
  const { t, intlLocale } = useI18n();
  const { locationById, brand } = useCatalog();
  const occ = useApi(() => api.occurrence(id), [id]);
  const c = occ.data;
  const loc = c ? locationById(c.locationId) : undefined;
  const full = c ? c.booked >= c.capacity : false;

  const [phase, setPhase] = useState<Phase>('holding');
  const [booking, setBooking] = useState<Booking | null>(null);
  const [err, setErr] = useState<ApiError | null>(null);
  const [now, setNow] = useState(Date.now());
  const [busy, setBusy] = useState(false);
  // Live API only: guests give a name + email once so the business can send the confirmation.
  const [contact, setContact] = useState({ name: '', email: '', next: 'hold' as 'hold' | 'waitlist' });
  const [contactErrors, setContactErrors] = useState<Record<string, string>>({});

  const hold = useCallback(async () => {
    setPhase('holding');
    setErr(null);
    try {
      const b = await api.holdBooking(id);
      setBooking(b);
      // Free classes are confirmed straight away (no hold, no payment).
      setPhase(b.status === 'confirmed' ? 'done' : 'held');
    } catch (e) {
      const ae = e as ApiError;
      setErr(ae);
      if (ae.code === 'contact_required') {
        setContact((c) => ({ ...c, next: 'hold' }));
        setPhase('contact');
      } else setPhase(ae.code === 'class_full' ? 'full' : 'error');
    }
  }, [id]);

  const joinWaitlist = async () => {
    setBusy(true);
    try {
      setBooking(await api.joinWaitlist(c!.id));
      setPhase('waitlisted');
    } catch (e) {
      const ae = e as ApiError;
      setErr(ae);
      if (ae.code === 'contact_required') {
        setContact((x) => ({ ...x, next: 'waitlist' }));
        setPhase('contact');
      }
    } finally {
      setBusy(false);
    }
  };

  useEffect(() => {
    if (phase !== 'contact') return;
    void guestContact.get().then((g) => g && setContact((x) => ({ ...x, name: x.name || g.name, email: x.email || g.email })));
  }, [phase]);

  const submitContact = async () => {
    const e: Record<string, string> = {};
    if (!contact.name.trim()) e.name = t('order.fieldRequired');
    if (!/\S+@\S+\.\S+/.test(contact.email)) e.email = t('order.fieldRequired');
    setContactErrors(e);
    if (Object.keys(e).length) return;
    await guestContact.set({ name: contact.name.trim(), email: contact.email.trim() });
    if (contact.next === 'waitlist') {
      setPhase('full');
      await joinWaitlist();
    } else await hold();
  };

  // Hold a spot as soon as the class is open for booking; full classes go straight to waitlist.
  useEffect(() => {
    if (!c) return;
    if (full) setPhase('full');
    else void hold();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [c?.id]);

  useEffect(() => {
    if (phase !== 'held') return;
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, [phase]);

  const remaining = booking?.holdExpiresAt ? Math.max(0, new Date(booking.holdExpiresAt).getTime() - now) : 0;
  useEffect(() => {
    if (phase === 'held' && booking?.holdExpiresAt && remaining === 0) {
      setPhase('expired');
      announce(t('book.holdExpired'));
    }
  }, [remaining, phase, booking, t]);

  if (occ.loading || !c || !loc) {
    return (
      <Screen tabs={false}>
        <ScreenHeader title={t('book.confirmTitle')} back />
        {occ.error ? <EmptyState icon="alert" title={t('common.errorTitle')} body={occ.error.message} action={t('common.retry')} onAction={occ.refresh} /> : <SkeletonCard lines={5} />}
      </Screen>
    );
  }

  const when = `${fmtDateTime(c.startsAt, loc.timeZone, intlLocale)} ${fmtZone(loc.timeZone, intlLocale)}`;
  const price = fmtMoney(c.price, intlLocale);
  const mm = Math.floor(remaining / 60000);
  const ss = String(Math.floor((remaining % 60000) / 1000)).padStart(2, '0');

  if (phase === 'done' || phase === 'waitlisted') {
    const ok = phase === 'done';
    return (
      <Screen tabs={false}>
        <View accessibilityRole="summary" style={{ gap: 14, paddingTop: 24 }}>
          <View style={{ width: 72, height: 72, borderRadius: 36, backgroundColor: ok ? color.lime : pastel.butter, alignItems: 'center', justifyContent: 'center' }}>
            <Icon name={ok ? 'check' : 'clock'} size={32} strokeWidth={2.6} />
          </View>
          <Text variant="display" accessibilityRole="header">{ok ? t('book.bookedDone') : t('book.waitlistDone')}</Text>
          <Text variant="bodyL" color={color.graphite}>
            {ok
              ? t('book.bookedDoneBody', { name: c.name, when, location: `${brand?.name ?? ''} ${loc.name}`, amount: price })
              : t('book.waitlistDoneBody', { position: booking?.waitlistPosition ?? 1, name: c.name })}
          </Text>
          <Card><Text variant="small">{brand?.name} {loc.name} · {loc.address}</Text></Card>
          <Button label={t('book.viewBookings')} size="lg" onPress={() => router.replace('/customer/bookings')} />
        </View>
      </Screen>
    );
  }

  return (
    <Screen tabs={false}>
      <ScreenHeader title={phase === 'full' ? t('book.joinWaitlistTitle') : t('book.confirmTitle')} back />
      <View style={{ height: 150, borderRadius: radius.xl, overflow: 'hidden' }}>
        <Image source={{ uri: c.image }} style={{ width: '100%', height: '100%' }} accessibilityIgnoresInvertColors />
      </View>
      <Text variant="h1">{c.name}</Text>

      {phase === 'held' ? <Banner tone="success" icon="clock" title={t('book.holdActive', { time: `${mm}:${ss}` })} /> : null}
      {phase === 'expired' ? <Banner tone="warning" icon="clock" title={t('book.holdExpired')} body={t('book.holdExpiredBody')} action={t('book.recheck')} onAction={hold} /> : null}
      {phase === 'error' && err ? (
        err.code === 'duplicate_booking'
          ? <Banner tone="info" icon="check-circle" title={err.message} action={t('book.viewBookings')} onAction={() => router.replace('/customer/bookings')} />
          : <Banner tone="danger" title={err.message} action={t('common.retry')} onAction={hold} />
      ) : null}
      {phase === 'full' ? <Banner tone="info" icon="users" title={t('book.full')} body={t('book.waitlistBody')} /> : null}
      {phase === 'full' && err && err.code !== 'class_full' ? <Banner tone="danger" title={err.message} /> : null}
      {phase === 'contact' ? (
        <Card>
          <Text variant="h3">{t('book.contactTitle')}</Text>
          <Text variant="small" tone="muted">{t('book.contactBody')}</Text>
          <TextField label={t('book.contactName')} value={contact.name} onChangeText={(v) => setContact((x) => ({ ...x, name: v }))} error={contactErrors.name} autoComplete="name" textContentType="name" />
          <TextField label={t('book.contactEmail')} value={contact.email} onChangeText={(v) => setContact((x) => ({ ...x, email: v }))} error={contactErrors.email} keyboardType="email-address" autoCapitalize="none" autoComplete="email" textContentType="emailAddress" />
          <Button label={t('book.contactCta')} size="lg" onPress={submitContact} />
        </Card>
      ) : null}

      <View style={{ gap: 8 }}>
        <ListItem icon="calendar" iconBg={pastel.lilac} title={t('book.when')} subtitle={`${when} · ${t('book.minutes', { count: c.durationMin })}`} />
        <ListItem icon="pin" iconBg={pastel.sage} title={t('book.location')} subtitle={`${brand?.name ?? ''} ${loc.name} · ${loc.address}`} />
        <ListItem icon="user" iconBg={pastel.butter} title={t('book.instructor')} subtitle={`${c.instructor} · ${c.room}`} />
        <ListItem icon="tag" iconBg={pastel.aqua} title={t('book.price')} subtitle={loc.tax ? `${loc.tax.inclusive ? t('order.taxIncluded', { label: loc.tax.label }) : loc.tax.label} · ${t('order.taxNote')}` : undefined} trailing={<MoneyText value={c.price} variant="h3" />} />
      </View>

      <Card bg={pastel.sand}>
        <Text variant="h3">{t('book.policy')}</Text>
        <Text variant="small" color={color.graphite}>{t('book.policyText', { hours: loc.cancellationHours })}</Text>
      </Card>

      {phase === 'full' ? (
        <Button
          label={t('book.waitlistCta')}
          size="lg"
          icon="clock"
          loading={busy}
          onPress={joinWaitlist}
        />
      ) : phase === 'contact' ? null : (
        <PaymentStep
          amount={c.price}
          label={t('book.payAndBook', { amount: price })}
          disabled={phase !== 'held' || !booking}
          createIntent={() => api.createPaymentIntent({ kind: 'booking', id: booking!.id })}
          onPaid={async (pi) => {
            try {
              setBooking(await api.confirmBooking(booking!.id, pi));
              setPhase('done');
              announce(t('book.bookedDone'));
            } catch (e) {
              const ae = e as ApiError;
              if (ae.code === 'hold_expired') setPhase('expired');
              else {
                setErr(ae);
                setPhase('error');
              }
            }
          }}
        />
      )}
    </Screen>
  );
}
