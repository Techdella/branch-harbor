// Web / default implementation. Native builds resolve PaymentStep.native.tsx (Stripe PaymentSheet).
import { useState, type ReactNode } from 'react';
import { PaymentFallback, SecureNote, type PaymentStepProps } from './PaymentStep.shared';

export type { PaymentStepProps };

export function PaymentStep(props: PaymentStepProps) {
  const [busy, setBusy] = useState(false);
  return (
    <>
      <PaymentFallback {...props} busy={busy} setBusy={setBusy} reason="not_configured" />
      <SecureNote />
    </>
  );
}

export function PaymentsProvider({ children }: { children: ReactNode }) {
  return <>{children}</>;
}
