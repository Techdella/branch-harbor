import { useState } from 'react';
import { View } from 'react-native';
import { Badge, Button, Icon, Card, ConfirmSheet, DataStatus, EmptyState, MoneyText, Screen, ScreenHeader, SectionHeader, SkeletonCard, Text, useToast, type IconName } from '@/components';
import { useI18n } from '@/i18n';
import { api } from '@/lib/api';
import { ApiError } from '@/lib/errors';
import { fmtMoney, relativeAgo } from '@/lib/format';
import { useApi } from '@/lib/useApi';
import type { Approval, ApprovalKind } from '@/lib/types';
import { pastel } from '@/theme';

const KIND: Record<ApprovalKind, { icon: IconName; bg: string; key: string }> = {
  ad_spend: { icon: 'megaphone', bg: pastel.lilac, key: 'owner.adSpend' },
  refund: { icon: 'undo', bg: pastel.blush, key: 'owner.refund' },
  shift_swap: { icon: 'repeat', bg: pastel.aqua, key: 'owner.shiftSwap' },
  website: { icon: 'globe', bg: pastel.butter, key: 'owner.websiteChange' },
};

export default function Approvals() {
  const { t, intlLocale } = useI18n();
  const toast = useToast();
  const q = useApi(() => api.approvals(), []);
  const [deciding, setDeciding] = useState<{ a: Approval; decision: 'approved' | 'rejected' } | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const pending = (q.data ?? []).filter((a) => a.status === 'pending');
  const done = (q.data ?? []).filter((a) => a.status !== 'pending');

  const consequence = (a: Approval, decision: 'approved' | 'rejected') => {
    if (decision === 'rejected') return t('owner.rejectConsequence');
    if (a.kind === 'refund' && a.amount) return t('owner.refundConsequence', { amount: fmtMoney(a.amount, intlLocale), location: a.locationName });
    if (a.kind === 'ad_spend' && a.amount) return t('owner.adConsequence', { amount: fmtMoney(a.amount, intlLocale), channel: a.channel ?? '', location: a.locationName, days: a.days ?? 0 });
    if (a.kind === 'shift_swap' && a.swap) return t('owner.swapConsequence', { a: a.swap.a, b: a.swap.b, session: a.swap.session });
    if (a.kind === 'website') return t('owner.websiteConsequence', { location: a.locationName });
    return '';
  };

  const card = (a: Approval) => {
    const k = KIND[a.kind];
    return (
      <Card key={a.id}>
        <View style={{ flexDirection: 'row', gap: 10, alignItems: 'center' }}>
          <View style={{ flexDirection: 'row', alignItems: 'center', gap: 6, backgroundColor: k.bg, borderRadius: 999, paddingHorizontal: 12, paddingVertical: 6 }}>
            <Icon name={k.icon} size={15} />
            <Text variant="small" weight={800}>{t(k.key)}</Text>
          </View>
          <Text variant="small" tone="muted" style={{ flex: 1 }} align="right">{relativeAgo(a.requestedAt, intlLocale)}</Text>
        </View>
        <Text variant="h3">{a.title}</Text>
        <Text variant="small" tone="muted">{a.locationName} · {a.requestedBy}</Text>
        {a.amount ? (
          <View style={{ flexDirection: 'row', alignItems: 'baseline', gap: 8 }}>
            <MoneyText value={a.amount} variant="h1" />
            <Text weight={800}>{a.amount.currency}</Text>
          </View>
        ) : null}
        {a.kind === 'ad_spend' ? <Text variant="small">{a.channel} · {t('owner.days', { count: a.days ?? 0 })}</Text> : null}
        {a.swap ? <Text>{a.swap.a} ↔ {a.swap.b} · {a.swap.session}</Text> : null}
        {a.reason ? <Text variant="small" tone="muted">{a.reason}</Text> : null}
        {a.status === 'pending' ? (
          <View style={{ flexDirection: 'row', gap: 8 }}>
            <Button label={t('common.reject')} variant="secondary" icon="x" style={{ flex: 1 }} onPress={() => { setErr(null); setDeciding({ a, decision: 'rejected' }); }} accessibilityLabel={`${t('common.reject')}: ${t(k.key)}, ${a.title}`} />
            <Button label={t('common.approve')} icon="check" style={{ flex: 1 }} onPress={() => { setErr(null); setDeciding({ a, decision: 'approved' }); }} accessibilityLabel={`${t('common.approve')}: ${t(k.key)}, ${a.title}`} />
          </View>
        ) : (
          <Badge label={t('owner.decided', { result: a.status === 'approved' ? t('common.approved') : t('common.rejected') })} tone={a.status === 'approved' ? 'success' : 'neutral'} icon={a.status === 'approved' ? 'check-circle' : 'x'} />
        )}
      </Card>
    );
  };

  return (
    <Screen onRefresh={q.refresh} refreshing={q.refreshing}>
      <ScreenHeader title={t('owner.approvalsTitle')} scope={{ label: t('owner.allLocations'), icon: 'building' }} />
      <DataStatus q={q} />
      {q.loading ? <><SkeletonCard lines={4} /><SkeletonCard lines={4} /></> : null}
      {!q.loading && pending.length === 0 && q.data ? <EmptyState icon="check-circle" bg={pastel.lime} title={t('owner.nothingPending')} body={t('owner.nothingPendingSub')} /> : null}
      {pending.map(card)}
      {done.length ? <SectionHeader title={t('common.done')} /> : null}
      {done.map(card)}

      <ConfirmSheet
        visible={!!deciding}
        title={deciding ? t(deciding.decision === 'approved' ? 'owner.approveTitle' : 'owner.rejectTitle', { kind: t(KIND[deciding.a.kind].key).toLowerCase() }) : ''}
        body={deciding ? consequence(deciding.a, deciding.decision) : undefined}
        confirmLabel={deciding?.decision === 'approved' ? t('common.approve') : t('common.reject')}
        confirmVariant={deciding?.decision === 'approved' ? 'primary' : 'danger'}
        withReason={deciding?.decision === 'rejected' ? t('owner.reason') : undefined}
        error={err}
        onCancel={() => setDeciding(null)}
        onConfirm={async (reason) => {
          const d = deciding!;
          try {
            const upd = await api.decide(d.a.id, d.decision, reason);
            q.setData((list) => list?.map((x) => (x.id === upd.id ? upd : x)));
            setDeciding(null);
            toast(`${t(KIND[d.a.kind].key)}: ${d.decision === 'approved' ? t('common.approved') : t('common.rejected')}`);
          } catch (e) {
            setErr((e as ApiError).message);
          }
        }}
      >
        {deciding?.a.amount ? (
          <Card bg={pastel.sand} padding={12}>
            <Text variant="small" tone="muted">{deciding.a.locationName}</Text>
            <MoneyText value={deciding.a.amount} variant="h2" />
            <Text variant="small" weight={700}>{deciding.a.amount.currency}</Text>
          </Card>
        ) : null}
      </ConfirmSheet>
    </Screen>
  );
}
