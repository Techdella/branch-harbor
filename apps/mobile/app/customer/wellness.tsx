import { useState } from 'react';
import { View } from 'react-native';
import { Badge, Banner, Button, Card, EmptyState, ErrorState, ScreenHeader, Screen, SkeletonCard, Tag, Text, TextField } from '@/components';
import { wellnessApi, type MyAppointment, type WService, type WSlot } from '@/features/wellness/api';
import { useWT } from '@/features/wellness/strings';
import { ApiError } from '@/lib/errors';
import { addDaysKey, fmtDateTime, fmtDay, fmtMoney as fmtMoneyRaw, fmtTime, fmtZone, localDateKey } from '@/lib/format';

const fmtMoney = (m: { amount: number; currency: string }, locale: string) => fmtMoneyRaw(m as Parameters<typeof fmtMoneyRaw>[0], locale);
import { useSession } from '@/lib/session';
import { useApi } from '@/lib/useApi';

type Tab = 'book' | 'mine' | 'packages';

/** Customer wellness: book (service → length → day → slot → details → deposit), manage appointments, packages & vouchers. */
export default function WellnessCustomer() {
  const { t } = useWT();
  const [tab, setTab] = useState<Tab>('book');
  return (
    <Screen tabs={false}>
      <ScreenHeader title={t('title')} back />
      <View style={{ flexDirection: 'row', gap: 8, flexWrap: 'wrap' }}>
        {(['book', 'mine', 'packages'] as const).map((k) => <Tag key={k} label={t(k)} selected={tab === k} onPress={() => setTab(k)} />)}
      </View>
      {tab === 'book' ? <BookFlow onBooked={() => setTab('mine')} /> : tab === 'mine' ? <Mine /> : <Packages />}
    </Screen>
  );
}

function BookFlow({ onBooked }: { onBooked: () => void }) {
  const { t, locale } = useWT();
  const { me } = useSession();
  const locs = useApi(() => wellnessApi.locations(), []);
  const [locId, setLocId] = useState<string | null>(null);
  const loc = locs.data?.find((l) => l.id === locId) ?? locs.data?.[0];
  const services = useApi(() => (loc ? wellnessApi.services(loc.id) : Promise.resolve([] as WService[])), [loc?.id]);
  const [svc, setSvc] = useState<WService | null>(null);
  const [variantId, setVariantId] = useState<string | undefined>();
  const [day, setDay] = useState(0);
  const date = loc ? addDaysKey(localDateKey(new Date(), loc.timeZone), day) : '';
  const slots = useApi(() => (loc && svc ? wellnessApi.slots(loc.id, svc.id, date, variantId) : Promise.resolve([] as WSlot[])), [loc?.id, svc?.id, variantId, date]);
  const [slot, setSlot] = useState<WSlot | null>(null);
  const [contact, setContact] = useState({ name: me?.guest ? '' : me?.user.name ?? '', email: me?.guest ? '' : me?.user.email ?? '' });
  const [voucher, setVoucher] = useState('');
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [result, setResult] = useState<Awaited<ReturnType<typeof wellnessApi.book>> | null>(null);
  const [paid, setPaid] = useState(false);

  if (locs.loading && !locs.data) return <SkeletonCard />;
  if (locs.error && !locs.data) return <ErrorState title={t('error')} body={locs.error.message} retryLabel={t('retry')} onRetry={() => void locs.refresh()} />;
  if (!loc) return <EmptyState title={t('none')} />;
  if (result) {
    return (
      <Card>
        <Badge label={t('booked')} tone="success" />
        {result.summary.depositDue.amount > 0 && <Text>{t('depositDue')}: {fmtMoney(result.summary.depositDue, locale)}</Text>}
        <Text>{t('dueAtVisit')}: {fmtMoney(result.summary.dueAtVisit, locale)}</Text>
        {result.payment && !paid ? <Button label={t('paySandbox')} onPress={async () => { await wellnessApi.confirmSandbox(result.payment!.id); setPaid(true); }} /> : null}
        {paid && <Badge label={t('paid')} tone="success" />}
        <Button label={t('mine')} variant="secondary" onPress={onBooked} />
      </Card>
    );
  }
  const v = svc?.variants.find((x) => x.id === variantId);
  return (
    <View style={{ gap: 14 }}>
      <View style={{ flexDirection: 'row', gap: 8, flexWrap: 'wrap' }}>
        {(locs.data ?? []).map((l) => <Tag key={l.id} label={`${l.city || l.name} · ${l.currency}`} icon="pin" selected={l.id === loc.id} onPress={() => { setLocId(l.id); setSvc(null); setSlot(null); }} />)}
      </View>
      <Text variant="small" tone="muted">{t('timesIn')} {fmtZone(loc.timeZone, locale)} ({loc.timeZone})</Text>
      {(services.data ?? []).map((s) => (
        <Card key={s.id} onPress={() => { setSvc(s); setVariantId(s.variants[0]?.id); setSlot(null); }} bg={svc?.id === s.id ? '#E2F5A6' : undefined} accessibilityLabel={s.name}>
          <Text weight={700}>{s.name}</Text>
          <Text variant="small" tone="muted">{s.variants.length ? s.variants.map((x) => `${x.name} ${fmtMoney(x.price, locale)}`).join(' · ') : `${t('minutes', { n: s.durationMinutes })} · ${fmtMoney(s.price, locale)}`}</Text>
        </Card>
      ))}
      {svc && svc.variants.length > 1 && (
        <View style={{ flexDirection: 'row', gap: 8, flexWrap: 'wrap' }}>{svc.variants.map((x) => <Tag key={x.id} label={`${x.name} · ${fmtMoney(x.price, locale)}`} selected={x.id === variantId} onPress={() => { setVariantId(x.id); setSlot(null); }} />)}</View>
      )}
      {svc && (
        <>
          <View style={{ flexDirection: 'row', gap: 8, flexWrap: 'wrap' }}>
            {Array.from({ length: 7 }, (_, i) => i).map((i) => <Tag key={i} label={fmtDay(`${addDaysKey(localDateKey(new Date(), loc.timeZone), i)}T12:00:00Z`, 'UTC', locale)} selected={i === day} onPress={() => { setDay(i); setSlot(null); }} />)}
          </View>
          {slots.loading && !slots.data ? <SkeletonCard lines={1} /> : (slots.data ?? []).length === 0 ? <Text tone="muted">{t('noSlots')}</Text> : (
            <View style={{ flexDirection: 'row', gap: 8, flexWrap: 'wrap' }}>{(slots.data ?? []).map((s) => <Tag key={s.startsAt} label={fmtTime(s.startsAt, loc.timeZone, locale)} selected={slot?.startsAt === s.startsAt} onPress={() => setSlot(s)} />)}</View>
          )}
        </>
      )}
      {svc && slot && (
        <Card>
          <Text weight={700}>{svc.name}{v ? ` · ${v.name}` : ''} — {fmtDateTime(slot.startsAt, loc.timeZone, locale)}</Text>
          {svc.cancellationPolicy ? <Text variant="small" tone="muted">{svc.cancellationPolicy}</Text> : null}
          <Text variant="small" tone="muted">{t('adminOnly')}</Text>
          <TextField label={t('name')} value={contact.name} onChangeText={(x) => setContact({ ...contact, name: x })} />
          <TextField label={t('email')} keyboardType="email-address" autoCapitalize="none" value={contact.email} onChangeText={(x) => setContact({ ...contact, email: x })} />
          <TextField label={t('voucher')} autoCapitalize="characters" value={voucher} onChangeText={setVoucher} />
          {err ? <Banner tone="danger" title={err} /> : null}
          <Button label={t('confirm')} loading={busy} disabled={!contact.name || !contact.email} onPress={async () => {
            setBusy(true); setErr(null);
            try { setResult(await wellnessApi.book(loc.id, { serviceId: svc.id, variantId, startsAt: slot.startsAt, contact, ...(voucher.trim() ? { voucherCode: voucher.trim() } : {}) })); }
            catch (e) { setErr((e as ApiError).message); setSlot(null); void slots.refresh(); }
            finally { setBusy(false); }
          }} />
        </Card>
      )}
    </View>
  );
}

function Mine() {
  const { t, locale } = useWT();
  const { me } = useSession();
  const q = useApi(() => (me?.guest ? Promise.resolve([] as MyAppointment[]) : wellnessApi.myAppointments()), [me?.guest]);
  const [open, setOpen] = useState<string | null>(null);
  const [msg, setMsg] = useState<string | null>(null);
  if (me?.guest) return <EmptyState icon="lock" title={t('signInNeeded')} />;
  if (q.loading && !q.data) return <SkeletonCard />;
  if (q.error && !q.data) return <ErrorState title={t('error')} body={q.error.message} retryLabel={t('retry')} onRetry={() => void q.refresh()} />;
  const up = (q.data ?? []).filter((a) => a.status === 'confirmed' && Date.parse(a.startsAt) > Date.now());
  const past = (q.data ?? []).filter((a) => !up.includes(a));
  if (!q.data?.length) return <EmptyState icon="calendar" title={t('none')} />;
  return (
    <View style={{ gap: 12 }}>
      {msg ? <Banner tone="success" title={msg} /> : null}
      <Text variant="h3">{t('upcoming')}</Text>
      {up.map((a) => <AppointmentCard key={a.id} a={a} open={open === a.id} onToggle={() => setOpen(open === a.id ? null : a.id)} onDone={(m) => { setMsg(m); setOpen(null); void q.refresh(); }} />)}
      <Text variant="h3">{t('past')}</Text>
      {past.slice(0, 10).map((a) => (
        <Card key={a.id}><Text weight={700}>{a.serviceName}</Text><Text variant="small" tone="muted">{fmtDateTime(a.startsAt, a.location.timeZone, locale)} · {a.location.name} · {a.status}</Text></Card>
      ))}
    </View>
  );
}

function AppointmentCard({ a, open, onToggle, onDone }: { a: MyAppointment; open: boolean; onToggle: () => void; onDone: (m: string) => void }) {
  const { t, locale } = useWT();
  const tz = a.location.timeZone;
  const [mode, setMode] = useState<'cancel' | 'move' | null>(null);
  const [day, setDay] = useState(1);
  const date = addDaysKey(localDateKey(new Date(), tz), day);
  const slots = useApi(() => (mode === 'move' ? wellnessApi.slots(a.location.id, a.serviceId, date, a.variantId ?? undefined) : Promise.resolve([] as WSlot[])), [mode, date]);
  const [err, setErr] = useState<string | null>(null);
  const p = a.cancellation;
  return (
    <Card onPress={onToggle} accessibilityLabel={a.serviceName}>
      <Text weight={700}>{a.serviceName} · {a.practitionerName}</Text>
      <Text variant="small" tone="muted">{fmtDateTime(a.startsAt, tz, locale)} ({fmtZone(tz, locale)}) · {a.location.name} · {fmtMoney(a.price, locale)}</Text>
      {open && (
        <View style={{ gap: 10, marginTop: 8 }}>
          {p && <Badge label={p.window === 'free' ? t('cancelFree') : `${t('cancelLate')}: ${fmtMoney(p.fee, locale)}`} tone={p.window === 'free' ? 'success' : 'warning'} />}
          {p && p.deposit.paid > 0 && <Text variant="small">{t('refund')}: {fmtMoney({ amount: p.deposit.refund, currency: p.deposit.currency }, locale)} · {t('kept')}: {fmtMoney({ amount: p.deposit.retained, currency: p.deposit.currency }, locale)}</Text>}
          {err ? <Banner tone="danger" title={err} /> : null}
          {mode === null && (
            <View style={{ flexDirection: 'row', gap: 8, flexWrap: 'wrap' }}>
              {a.canReschedule ? <Button size="sm" label={t('reschedule')} onPress={() => setMode('move')} /> : <Text variant="small" tone="muted">{t('rescheduleBlocked')}</Text>}
              <Button size="sm" variant="danger" label={t('cancel')} onPress={() => setMode('cancel')} />
            </View>
          )}
          {mode === 'cancel' && (
            <View style={{ flexDirection: 'row', gap: 8 }}>
              <Button size="sm" variant="danger" label={t('confirmCancel')} onPress={async () => { try { await wellnessApi.cancel(a.id, true); onDone(t('confirmCancel')); } catch (e) { setErr((e as ApiError).message); } }} />
              <Button size="sm" variant="secondary" label={t('keep')} onPress={() => setMode(null)} />
            </View>
          )}
          {mode === 'move' && (
            <>
              <View style={{ flexDirection: 'row', gap: 6, flexWrap: 'wrap' }}>{[1, 2, 3, 4, 5, 6, 7].map((i) => <Tag key={i} label={fmtDay(`${addDaysKey(localDateKey(new Date(), tz), i)}T12:00:00Z`, 'UTC', locale)} selected={i === day} onPress={() => setDay(i)} />)}</View>
              <View style={{ flexDirection: 'row', gap: 6, flexWrap: 'wrap' }}>
                {(slots.data ?? []).map((s) => <Tag key={s.startsAt} label={fmtTime(s.startsAt, tz, locale)} onPress={async () => { try { await wellnessApi.reschedule(a.id, s.startsAt); onDone(t('moved')); } catch (e) { setErr((e as ApiError).message); } }} />)}
                {slots.data && !slots.data.length ? <Text variant="small" tone="muted">{t('noSlots')}</Text> : null}
              </View>
              <Button size="sm" variant="secondary" label={t('keep')} onPress={() => setMode(null)} />
            </>
          )}
        </View>
      )}
    </Card>
  );
}

function Packages() {
  const { t, locale } = useWT();
  const { me } = useSession();
  const q = useApi(() => (me?.guest ? Promise.resolve({ packages: [], vouchers: [] }) : wellnessApi.myPackages()), [me?.guest]);
  if (me?.guest) return <EmptyState icon="lock" title={t('signInNeeded')} />;
  if (q.loading && !q.data) return <SkeletonCard />;
  if (q.error && !q.data) return <ErrorState title={t('error')} body={q.error.message} retryLabel={t('retry')} onRetry={() => void q.refresh()} />;
  if (!q.data?.packages.length && !q.data?.vouchers.length) return <EmptyState icon="gift" title={t('noPackages')} />;
  return (
    <View style={{ gap: 10 }}>
      {q.data!.packages.map((p) => (
        <Card key={p.id}>
          <Text weight={700}>{p.name}</Text>
          <Text>{t('sessionsLeft', { n: p.sessionsRemaining, total: p.sessionsTotal })}</Text>
          <Text variant="small" tone="muted">{p.expiresAt ? `${t('expires')} ${fmtDay(p.expiresAt, 'UTC', locale)}` : ''} · {p.status}</Text>
        </Card>
      ))}
      {q.data!.vouchers.length > 0 && <Text variant="h3">{t('vouchers')}</Text>}
      {q.data!.vouchers.map((v) => (
        <Card key={v.id}><Text weight={700}>{v.code}</Text><Text>{t('balance')}: {fmtMoney(v.balance, locale)}</Text><Text variant="small" tone="muted">{t('expires')} {fmtDay(v.expiresAt, 'UTC', locale)}</Text></Card>
      ))}
    </View>
  );
}
