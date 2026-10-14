import { createContext, useCallback, useContext, useMemo, useState, type ReactNode } from 'react';
import type { Money, OrderLineInput, PickupSlot } from '@/lib/types';

export interface CartLine {
  key: string;
  itemId: string;
  name: string;
  quantity: number;
  optionIds: string[];
  optionNames: string[];
  unitPrice: Money;
}

interface CartCtx {
  locationId: string | null;
  slot: PickupSlot | null;
  lines: CartLine[];
  count: number;
  /** Client-side estimate only; the server quote is authoritative (checked again before payment). */
  estimate: Money | null;
  setSlot: (locationId: string, slot: PickupSlot | null) => void;
  add: (locationId: string, line: Omit<CartLine, 'key'>) => void;
  setQty: (key: string, qty: number) => void;
  clear: () => void;
  toInput: () => OrderLineInput[];
}

const Ctx = createContext<CartCtx | null>(null);

export function CartProvider({ children }: { children: ReactNode }) {
  const [locationId, setLocationId] = useState<string | null>(null);
  const [slot, setSlotState] = useState<PickupSlot | null>(null);
  const [lines, setLines] = useState<CartLine[]>([]);

  const ensureLocation = useCallback((id: string) => {
    setLocationId((prev) => {
      if (prev && prev !== id) {
        // Menus, prices and currency differ per location: switching location starts a new cart.
        setLines([]);
        setSlotState(null);
      }
      return id;
    });
  }, []);

  const value = useMemo<CartCtx>(() => {
    const count = lines.reduce((a, l) => a + l.quantity, 0);
    const currency = lines[0]?.unitPrice.currency;
    const estimate = currency ? { amount: lines.reduce((a, l) => a + l.unitPrice.amount * l.quantity, 0), currency } : null;
    return {
      locationId, slot, lines, count, estimate,
      setSlot: (id, s) => {
        ensureLocation(id);
        setSlotState(s);
      },
      add: (id, line) => {
        ensureLocation(id);
        const key = `${line.itemId}:${[...line.optionIds].sort().join(',')}`;
        setLines((prev) => {
          const ex = prev.find((l) => l.key === key);
          if (ex) return prev.map((l) => (l.key === key ? { ...l, quantity: l.quantity + line.quantity } : l));
          return [...prev, { ...line, key }];
        });
      },
      setQty: (key, qty) => setLines((prev) => (qty <= 0 ? prev.filter((l) => l.key !== key) : prev.map((l) => (l.key === key ? { ...l, quantity: qty } : l)))),
      clear: () => setLines([]),
      toInput: () => lines.map((l) => ({ itemId: l.itemId, quantity: l.quantity, optionIds: l.optionIds })),
    };
  }, [locationId, slot, lines, ensureLocation]);

  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}

export function useCart(): CartCtx {
  const c = useContext(Ctx);
  if (!c) throw new Error('useCart must be used inside CartProvider');
  return c;
}
