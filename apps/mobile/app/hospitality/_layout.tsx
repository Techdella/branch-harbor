import { Stack } from 'expo-router';
import { color } from '@/theme';

/** Hospitality: guest booking and stays, staff housekeeping & arrivals, owner pulse. */
export default function HospitalityLayout() {
  return <Stack screenOptions={{ headerShown: false, contentStyle: { backgroundColor: color.canvas } }} />;
}
