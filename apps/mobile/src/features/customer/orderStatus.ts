import type { TFn } from '@/i18n';
import type { IconName, Tone } from '@/components';
import type { FoodOrder } from '@/lib/types';

/**
 * Customer-facing copy for a food order. "Awaiting acceptance" and "Accepted" are deliberately
 * different in title, icon and tone so nobody mistakes a sent order for a confirmed one.
 */
export function orderStatusCopy(o: FoodOrder, t: TFn, pickupTime: string, locationName: string): { title: string; body: string; icon: IconName; tone: Tone; step: number } {
  switch (o.status) {
    case 'awaiting_acceptance':
      return { title: t('order.awaitingTitle'), body: t('order.awaitingBody', { location: locationName }), icon: 'clock', tone: 'warning', step: 0 };
    case 'accepted':
      return { title: t('order.acceptedTitle', { time: pickupTime }), body: t('order.acceptedBody', { location: locationName }), icon: 'check-circle', tone: 'success', step: 1 };
    case 'preparing':
      return { title: t('order.preparingTitle'), body: t('order.preparingBody'), icon: 'chef', tone: 'info', step: 2 };
    case 'ready':
    case 'collected':
      return { title: t('order.readyTitle'), body: t('order.readyBody'), icon: 'bag', tone: 'success', step: 3 };
    default:
      return { title: t('order.rejectedTitle'), body: t('order.rejectedBody'), icon: 'alert', tone: 'danger', step: -1 };
  }
}
