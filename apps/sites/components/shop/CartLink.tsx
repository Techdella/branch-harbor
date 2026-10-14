'use client';

import { useEffect, useState } from 'react';
import { useTranslations } from 'next-intl';
import { Icon } from '@bh/ui';
import { readCart } from '@/lib/shop';

/** Cart button with live item count (cart kept per store in this browser). */
export function CartLink({ locationId, href }: { locationId: string; href: string }) {
  const t = useTranslations('storefront');
  const [n, setN] = useState(0);
  useEffect(() => {
    const sync = () => setN(readCart(locationId).reduce((a, l) => a + l.quantity, 0));
    sync();
    window.addEventListener('bh-cart', sync);
    window.addEventListener('storage', sync);
    return () => { window.removeEventListener('bh-cart', sync); window.removeEventListener('storage', sync); };
  }, [locationId]);
  return <a href={href} className="btn btn-primary h-10 min-h-10 text-sm"><Icon name="cart" size={16} />{t('cart')}{n > 0 && <span aria-label={t('itemsInCart', { n })} className="rounded-full bg-white/25 px-2 tabular">{n}</span>}</a>;
}
