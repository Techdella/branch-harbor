import { getTranslations } from 'next-intl/server';
import { Icon } from '@bh/ui';
import { apiGet } from '@/lib/api';
import type { MenuX } from '@/lib/foods-ext';

/** Extra foods entries in the location navigation, only for channels the location has switched on. */
export async function FoodsLinks({ locationId, href }: { locationId: string; href: (path: string) => string }) {
  const t = await getTranslations('foodsite');
  let menu: MenuX | null = null;
  try {
    menu = await apiGet<MenuX>(`/v1/public/foods/${locationId}/menu`, { revalidate: 30 });
  } catch {
    return null;
  }
  const items: Array<[string, string, 'truck' | 'calendar' | 'gift' | 'repeat']> = [];
  if (menu.channels.delivery) items.push(['/order?channel=delivery', t('nav.delivery'), 'truck']);
  if (menu.channels.preorder) items.push(['/preorder', t('nav.preorder'), 'calendar']);
  if (menu.channels.catering) items.push(['/catering', t('nav.catering'), 'gift']);
  if (menu.channels.mealPlans) items.push(['/meal-plans', t('nav.mealPlans'), 'repeat']);
  return (
    <>
      {items.map(([path, label, icon]) => (
        <a key={path} href={href(path)} className="flex h-10 shrink-0 items-center gap-1.5 rounded-full px-3 hover:bg-white">
          <Icon name={icon} size={15} />{label}
        </a>
      ))}
    </>
  );
}
