import { useState } from 'react';
import { View } from 'react-native';
import { useLocalSearchParams } from 'expo-router';
import { Badge, Banner, Button, Card, DataStatus, EmptyState, Screen, ScreenHeader, SkeletonCard, Text, TextField, type Tone } from '@/components';
import { qualityApi, type Requirement } from '@/features/quality/api';
import { pickDocument, takePhoto, type Picked } from '@/features/quality/capture';
import { useQT, type QKey } from '@/features/quality/strings';
import { useOnline } from '@/lib/network';
import { useApi } from '@/lib/useApi';

const TONE: Record<string, Tone> = { valid: 'success', expiring: 'warning', expired: 'danger', missing: 'danger', pending: 'info', below_minimum: 'warning', not_applicable: 'neutral' };

/** Compliance documents for my locations: what HQ requires, what's valid or missing, and uploads from the phone. */
export default function ComplianceScreen() {
  const { org } = useLocalSearchParams<{ org: string }>();
  const { t, locale } = useQT();
  const q = useApi(() => qualityApi.matrix(org!), [org]);
  const [open, setOpen] = useState<{ locationId: string; locationName: string; req: Requirement } | null>(null);
  const date = (ymd: string) => new Date(`${ymd}T12:00:00Z`).toLocaleDateString(locale, { day: 'numeric', month: 'short', year: 'numeric' });
  return (
    <Screen tabs={false} onRefresh={q.refresh} refreshing={q.refreshing}>
      <ScreenHeader title={t('compliance')} kicker={t('complianceSub')} back />
      <DataStatus q={q} />
      {q.loading && !q.data ? <SkeletonCard /> : null}
      {q.data && !q.data.requirements.length ? <EmptyState icon="shield" title={t('noRequirements')} /> : null}
      {(q.data?.rows ?? []).map((row) => (
        <Card key={row.location.id}>
          <View style={{ flexDirection: 'row', alignItems: 'center', gap: 8 }}>
            <Text variant="h3" style={{ flex: 1 }}>{row.location.name}</Text>
            <Badge label={`${row.compliant}/${row.applicable}`} tone={row.compliant === row.applicable ? 'success' : 'warning'} />
          </View>
          {row.cells.filter((c) => c.state !== 'not_applicable').map((c) => {
            const req = q.data!.requirements.find((r) => r.id === c.requirementId)!;
            const needs = c.state !== 'valid' && c.state !== 'pending';
            return (
              <View key={c.requirementId} style={{ gap: 4, paddingVertical: 6 }}>
                <Text weight={700}>{req.name}</Text>
                <View style={{ flexDirection: 'row', gap: 6, flexWrap: 'wrap', alignItems: 'center' }}>
                  <Badge label={t(c.state as QKey)} tone={TONE[c.state] ?? 'neutral'} />
                  {c.expiresOn ? <Text variant="small" tone="muted">{t('expires', { date: date(c.expiresOn) })}</Text> : null}
                </View>
                {needs && q.data!.can.upload ? <Button label={t('upload')} size="sm" variant="secondary" icon="plus" onPress={() => setOpen({ locationId: row.location.id, locationName: row.location.name, req })} /> : null}
                {open && open.locationId === row.location.id && open.req.id === req.id ? <UploadForm orgId={org!} target={open} onDone={() => { setOpen(null); void q.refresh(); }} /> : null}
              </View>
            );
          })}
        </Card>
      ))}
    </Screen>
  );
}

function UploadForm({ orgId, target, onDone }: { orgId: string; target: { locationId: string; locationName: string; req: Requirement }; onDone: () => void }) {
  const { t } = useQT();
  const online = useOnline();
  const [title, setTitle] = useState(target.req.name);
  const [issuer, setIssuer] = useState('');
  const [expires, setExpires] = useState('');
  const [amount, setAmount] = useState('');
  const [file, setFile] = useState<Picked | null>(null);
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<{ tone: 'success' | 'danger'; text: string } | null>(null);
  const validDate = !expires || /^\d{4}-\d{2}-\d{2}$/.test(expires);
  const amountMinor = amount ? Math.round(Number(amount.replace(/[\s,]/g, '')) * 100) : null;
  const ready = !!file && !!title && validDate && (!target.req.requiresExpiry || !!expires) && (amountMinor === null || Number.isFinite(amountMinor)) && online;
  return (
    <View style={{ gap: 8, paddingTop: 6 }}>
      <Text weight={700}>{t('uploadTitle', { name: target.req.name })}</Text>
      {!online ? <Banner tone="warning" title={t('needsConnection')} /> : null}
      <TextField label={t('docTitle')} value={title} onChangeText={setTitle} />
      <TextField label={t('issuer')} value={issuer} onChangeText={setIssuer} />
      {target.req.minAmount ? <TextField label={`${t('amount')} (${target.req.minAmount.currency})`} keyboardType="decimal-pad" value={amount} onChangeText={setAmount} /> : null}
      <TextField label={t('expiresOn')} value={expires} onChangeText={setExpires} placeholder="2027-06-30" error={validDate ? undefined : t('expiresOn')} autoCapitalize="none" />
      <View style={{ flexDirection: 'row', gap: 8, flexWrap: 'wrap' }}>
        <Button label={t('takePhoto')} icon="image" size="sm" variant="secondary" onPress={async () => { const f = await takePhoto(); if (f) setFile(f); }} />
        <Button label={t('pickFile')} icon="file" size="sm" variant="secondary" onPress={async () => { const f = await pickDocument(); if (f) setFile(f); }} />
      </View>
      {file ? <Text variant="small">{t('fileChosen', { name: file.name })}</Text> : null}
      {msg ? <Banner tone={msg.tone} title={msg.text} /> : null}
      <Button label={t('send')} icon="check" disabled={!ready} loading={busy} onPress={async () => {
        setBusy(true);
        setMsg(null);
        try {
          await qualityApi.uploadDocument(orgId, {
            requirementId: target.req.id, locationId: target.locationId, category: target.req.category, title, issuer: issuer || null, coverageType: target.req.coverageType,
            coverageAmountMinor: amountMinor, currency: amountMinor !== null ? target.req.minAmount?.currency ?? null : null, expiresOn: expires || null,
            file: { filename: file!.name, contentType: file!.mime, dataBase64: file!.base64 },
          });
          setMsg({ tone: 'success', text: t('sent') });
          setTimeout(onDone, 800);
        } catch (e) {
          setMsg({ tone: 'danger', text: e instanceof Error ? e.message : t('error') });
        } finally {
          setBusy(false);
        }
      }} />
    </View>
  );
}
