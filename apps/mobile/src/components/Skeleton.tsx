import { useEffect, useRef } from 'react';
import { Animated, View, type DimensionValue } from 'react-native';
import { color, radius } from '@/theme';
import { useReducedMotion } from '@/lib/motion';
import { useI18n } from '@/i18n';

/** Placeholder block that preserves layout while loading. Pulses unless reduced motion is on. */
export function Skeleton({ height = 16, width = '100%', r = radius.xs }: { height?: number; width?: DimensionValue; r?: number }) {
  const reduced = useReducedMotion();
  const v = useRef(new Animated.Value(0.55)).current;
  useEffect(() => {
    if (reduced) return;
    const loop = Animated.loop(
      Animated.sequence([
        Animated.timing(v, { toValue: 1, duration: 700, useNativeDriver: true }),
        Animated.timing(v, { toValue: 0.55, duration: 700, useNativeDriver: true }),
      ]),
    );
    loop.start();
    return () => loop.stop();
  }, [reduced, v]);
  return <Animated.View style={{ height, width, borderRadius: r, backgroundColor: color.lineSoft, opacity: reduced ? 0.8 : v }} />;
}

export function SkeletonCard({ lines = 3 }: { lines?: number }) {
  const { t } = useI18n();
  return (
    <View accessibilityLabel={t('common.loading')} accessible style={{ backgroundColor: color.surface, borderRadius: radius.card, padding: 16, gap: 10 }}>
      <Skeleton height={18} width="60%" />
      {Array.from({ length: lines - 1 }, (_, i) => (
        <Skeleton key={i} height={12} width={i % 2 ? '40%' : '85%'} />
      ))}
    </View>
  );
}
