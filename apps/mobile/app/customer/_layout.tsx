import { Redirect, Stack } from 'expo-router';
import { CatalogProvider } from '@/features/customer/catalog';
import { CartProvider } from '@/features/customer/cart';
import { useSession } from '@/lib/session';
import { color } from '@/theme';

export default function CustomerLayout() {
  const { status } = useSession();
  if (status === 'signedOut') return <Redirect href="/" />;
  return (
    <CatalogProvider>
      <CartProvider>
        <Stack screenOptions={{ headerShown: false, contentStyle: { backgroundColor: color.canvas } }}>
          <Stack.Screen name="locations" options={{ presentation: 'modal' }} />
        </Stack>
      </CartProvider>
    </CatalogProvider>
  );
}
