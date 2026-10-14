import { useI18n } from '@/i18n';

/** Commerce strings (English complete; French for Montréal shoppers and staff; other locales fall back to English). */
const en: Record<string, string> = {
  shopTitle: 'Shop', chooseStore: 'Choose a store', stockAt: 'Stock and prices for %{store}', external: 'Orders for this store are placed on its %{provider} shop.', openExternal: 'Open the online shop',
  inStock: 'In stock', lowStock: 'Low stock', outOfStock: 'Out of stock', backorder: 'Backorder', notHere: 'Not sold here', add: 'Add', cart: 'Cart (%{n})', emptyCart: 'Your cart is empty.',
  checkout: 'Checkout · pickup at %{store}', name: 'Name', email: 'Email', subtotal: 'Subtotal', tax: '%{name} %{rate}%', taxIncl: 'Includes %{name} %{rate}%', total: 'Total', placeOrder: 'Place order · %{amount}',
  held: 'Items held for 15 minutes while you pay.', pay: 'Pay %{amount}', testMode: 'Test mode — simulated card payment', myOrders: 'My shop orders', noOrders: 'No shop orders yet.',
  order: 'Order %{number}', requestReturn: 'Request a return', returnSent: 'Return requested', returnClosed: 'Return window closed', returns: 'Returns',
  'fs.unfulfilled': 'Confirmed', 'fs.picking': 'Being prepared', 'fs.packed': 'Packed', 'fs.ready_for_pickup': 'Ready for pickup', 'fs.fulfilled': 'Completed', 'fs.backordered': 'Backordered', 'fs.awaiting_transfer': 'On its way to the store', 'fs.stock_conflict': 'The store will contact you', 'fs.cancelled': 'Cancelled', 'fs.partially_fulfilled': 'Partly ready', 'fs.out_for_delivery': 'Out for delivery',
  'ps.pending': 'Awaiting payment', 'ps.paid': 'Paid', 'ps.expired': 'Payment window ended', 'ps.failed': 'Payment failed', 'ps.refunded': 'Refunded', 'ps.partially_refunded': 'Partly refunded', 'ps.cancelled': 'Cancelled',
  floorTitle: 'Shop floor', toPick: 'Orders to prepare', nothingToPick: 'No orders waiting.', startPicking: 'Start picking', pickedAll: 'All picked', 'to.packed': 'Packed', 'to.ready': 'Ready for pickup', 'to.collected': 'Collected', 'to.shipped': 'Shipped', 'to.out_for_delivery': 'Out for delivery', 'to.delivered': 'Delivered',
  transfersIn: 'Transfers to receive', transfersOut: 'Transfers to ship', receive: 'Receive', ship: 'Ship', counts: 'Stock counts', count: 'Count', saveCount: 'Save', submitCount: 'Submit count', counted: 'Counted',
  salesTitle: 'Shop sales', today: 'Today', last7: 'Last 7 days', orders7: '%{n} orders', notCombined: 'Each currency is shown on its own — never added together.', toFulfil: 'To fulfil', ready: 'Ready', attention: 'Needs attention', lowStock2: 'Low stock', out: 'Out of stock', byStore: 'By store',
  shopEntry: 'Fieldnote Goods shop', shopEntrySub: 'Browse, order for pickup and track',
};
const fr: Record<string, string> = {
  shopTitle: 'Boutique', chooseStore: 'Choisir une boutique', stockAt: 'Stock et prix pour %{store}', external: 'Les commandes de cette boutique se font sur sa boutique %{provider}.', openExternal: 'Ouvrir la boutique en ligne',
  inStock: 'En stock', lowStock: 'Stock faible', outOfStock: 'Rupture de stock', backorder: 'En commande', notHere: 'Non vendu ici', add: 'Ajouter', cart: 'Panier (%{n})', emptyCart: 'Votre panier est vide.',
  checkout: 'Commande · ramassage à %{store}', name: 'Nom', email: 'Courriel', subtotal: 'Sous-total', tax: '%{name} %{rate} %', taxIncl: 'Inclut %{name} %{rate} %', total: 'Total', placeOrder: 'Commander · %{amount}',
  held: 'Articles réservés 15 minutes pendant le paiement.', pay: 'Payer %{amount}', testMode: 'Mode test — paiement simulé', myOrders: 'Mes commandes boutique', noOrders: 'Aucune commande.',
  order: 'Commande %{number}', requestReturn: 'Demander un retour', returnSent: 'Retour demandé', returnClosed: 'Période de retour terminée', returns: 'Retours',
  'fs.unfulfilled': 'Confirmée', 'fs.picking': 'En préparation', 'fs.ready_for_pickup': 'Prête pour le ramassage', 'fs.fulfilled': 'Terminée', 'fs.backordered': 'En commande', 'fs.awaiting_transfer': 'En route vers la boutique', 'fs.cancelled': 'Annulée',
  'ps.pending': 'En attente de paiement', 'ps.paid': 'Payée', 'ps.expired': 'Délai de paiement écoulé',
  floorTitle: 'Plancher', toPick: 'Commandes à préparer', nothingToPick: 'Aucune commande en attente.', startPicking: 'Commencer la préparation', pickedAll: 'Tout prélevé', 'to.packed': 'Emballée', 'to.ready': 'Prête', 'to.collected': 'Récupérée',
  transfersIn: 'Transferts à recevoir', transfersOut: 'Transferts à expédier', receive: 'Recevoir', ship: 'Expédier', counts: 'Inventaires', count: 'Compter', saveCount: 'Enregistrer', submitCount: 'Soumettre', counted: 'Compté',
  salesTitle: 'Ventes boutique', today: 'Aujourd’hui', last7: '7 derniers jours', orders7: '%{n} commandes', notCombined: 'Chaque devise est affichée séparément, jamais additionnée.', toFulfil: 'À préparer', ready: 'Prêtes', attention: 'À traiter', out: 'Rupture', byStore: 'Par boutique',
  shopEntry: 'Boutique Fieldnote Goods', shopEntrySub: 'Parcourir, commander et suivre',
};

export function useCt() {
  const { locale, intlLocale } = useI18n();
  const table = locale === 'fr' ? fr : null;
  const ct = (key: string, vars: Record<string, string | number> = {}) => {
    const s = table?.[key] ?? en[key] ?? key;
    return s.replace(/%\{(\w+)\}/g, (_, k: string) => String(vars[k] ?? ''));
  };
  return { ct, intlLocale };
}
