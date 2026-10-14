'use client';

import { AssortmentScreen } from './AssortmentScreen';
import { CatalogueScreen } from './CatalogueScreen';
import { CommerceOverviewScreen } from './CommerceOverviewScreen';
import { GiftCardsScreen } from './GiftCardsScreen';
import { InsightsScreen } from './InsightsScreen';
import { InventoryScreen } from './InventoryScreen';
import { OrderDeskScreen } from './OrderDeskScreen';
import { PurchasingScreen } from './PurchasingScreen';
import { ReturnsScreen } from './ReturnsScreen';
import { StorefrontScreen } from './StorefrontScreen';
import { TransfersScreen } from './TransfersScreen';

/** Commerce operations screens (ops/[screen]). */
export function CommerceRoutes({ screen }: { screen: string }) {
  switch (screen) {
    case 'pulse': return <CommerceOverviewScreen />;
    case 'catalogue': return <CatalogueScreen />;
    case 'assortment': return <AssortmentScreen />;
    case 'orders': return <OrderDeskScreen />;
    case 'inventory': return <InventoryScreen />;
    case 'transfers': return <TransfersScreen />;
    case 'purchasing': return <PurchasingScreen />;
    case 'returns': return <ReturnsScreen />;
    case 'giftcards': return <GiftCardsScreen />;
    case 'storefront': return <StorefrontScreen />;
    case 'insights': return <InsightsScreen />;
  }
  return null;
}
