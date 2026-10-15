/** Industry → customer module route under /{brand}/{location}. */
export const MODULE_PATH: Record<string, string> = {
  studios: '/classes',
  foods: '/order',
  wellness: '/book',
  sports: '/programmes',
  commerce: '/shop',
  realty: '/properties',
  hospitality: '/stay',
};

export const MODULE_ICON: Record<string, 'lotus' | 'utensils' | 'leaf' | 'trophy' | 'bag' | 'house' | 'bed'> = {
  studios: 'lotus',
  foods: 'utensils',
  wellness: 'leaf',
  sports: 'trophy',
  commerce: 'bag',
  realty: 'house',
  hospitality: 'bed',
};

/** schema.org type for LocalBusiness JSON-LD. */
export const SCHEMA_TYPE: Record<string, string> = {
  studios: 'ExerciseGym',
  foods: 'Restaurant',
  wellness: 'HealthAndBeautyBusiness',
  sports: 'SportsActivityLocation',
  commerce: 'Store',
  realty: 'RealEstateAgent',
  hospitality: 'LodgingBusiness',
};

export function providerName(p: string | null): string {
  const names: Record<string, string> = { mindbody: 'Mindbody', woocommerce: 'WooCommerce', shopify: 'Shopify', square: 'Square', wordpress: 'WordPress' };
  return p ? names[p] ?? p : '';
}
