import type { Money } from '@bh/shared';
import { useI18n } from '@/i18n';
import { fmtMoney } from '@/lib/format';
import { Text, type AppTextProps } from './Text';

/** Formats with Intl in the amount's own currency. `null` renders "Unavailable", never 0. */
export function MoneyText({ value, ...rest }: { value: Money | null | undefined } & AppTextProps) {
  const { intlLocale, t } = useI18n();
  if (!value) return <Text tone="muted" {...rest}>{t('common.unavailable')}</Text>;
  return (
    <Text tabular {...rest}>
      {fmtMoney(value, intlLocale)}
    </Text>
  );
}
