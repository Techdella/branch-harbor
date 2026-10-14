'use client';

import type { ReactNode } from 'react';
import { AvailabilityScreen } from './AvailabilityScreen';
import { BuilderScreen } from './BuilderScreen';
import { CateringScreen } from './CateringScreen';
import { DeliveryScreen } from './DeliveryScreen';
import { FoodReportsScreen } from './FoodReportsScreen';
import { IngredientsScreen } from './IngredientsScreen';
import { KdsScreen } from './KdsScreen';
import { MealPlansScreen } from './MealPlansScreen';
import { OrderingSettingsScreen } from './OrderingSettingsScreen';
import { TablesScreen } from './TablesScreen';

/** Foods full-product screens by ops key (null → handled by the shared router). */
export function foodsScreen(key: string): ReactNode | null {
  switch (key) {
    case 'builder': return <BuilderScreen />;
    case 'availability': return <AvailabilityScreen />;
    case 'kitchen': return <KdsScreen />;
    case 'delivery': return <DeliveryScreen />;
    case 'tables': return <TablesScreen />;
    case 'catering': return <CateringScreen />;
    case 'mealplans': return <MealPlansScreen />;
    case 'ingredients': return <IngredientsScreen />;
    case 'ordering': return <OrderingSettingsScreen />;
    case 'foodreports': return <FoodReportsScreen />;
    default: return null;
  }
}
