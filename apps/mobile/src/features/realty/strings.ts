import { useI18n } from '@/i18n';

/** Real Estate strings, kept with the feature. Languages without a key fall back to English. */
const en = {
  homes: 'Homes', homesKicker: 'Keystone Realty', buy: 'Buy', rent: 'Rent', any: 'Any', beds: '{n}+ beds', results: '{n} homes', none: 'No homes match.', saved: 'Saved',
  saveSearch: 'Email me new matches', saveSearchConsent: 'I agree to receive email alerts for this search. I can unsubscribe any time.', email: 'Email', name: 'Name', saveDone: 'Search saved.', saveNoAlerts: 'Search saved without alerts.',
  perMonth: '/ month', perWeek: '/ week', underOffer: 'Under offer', comingSoon: 'Coming soon', available: 'Available',
  bookViewing: 'Book a viewing', chooseDay: 'Choose a day', chooseTime: 'Choose a time', noSlots: 'No times this day.', request: 'Request viewing', requested: 'Viewing requested — the agent confirms by email.', slotTaken: 'That time was just taken. Choose another.',
  save: 'Save', unsave: 'Saved ✓', signInToSave: 'Sign in to save homes.', features: 'Features', disclosures: 'Disclosures (supplied by the agency)', agents: 'Agents', unavailable: 'Unavailable',
  myHomes: 'Saved homes', myViewings: 'My viewings', noSaved: 'No saved homes yet.', noViewings: 'No viewings yet.',
  agentTitle: 'Viewings & leads', today: 'Today’s viewings', noToday: 'No viewings today.', newEnquiries: 'New enquiries', noEnquiries: 'No new enquiries.', pool: 'Office pool', mine: 'Assigned to you', claim: 'Claim', confirm: 'Confirm',
  logFeedback: 'Log feedback', interest: 'Interest', rating: 'Rating', saveFeedback: 'Save feedback', feedbackSaved: 'Feedback saved.', offersWaiting: 'Offers awaiting your response', noAgent: 'You don’t have an agent profile here.',
  pulseTitle: 'Real estate pulse', active: 'Active listings', dom: 'Median days on market', funnel: 'Enquiries → viewings → offers', soldVolume: 'Sold (90 days)', letVolume: 'Let (90 days)', perCurrency: 'Shown per currency — never combined.', awaiting: 'Awaiting HQ approval',
  interestLevels: { none: 'None', low: 'Low', medium: 'Medium', high: 'High' } as Record<string, string>,
  fairHousing: 'Searches use property details only.',
};
type S = typeof en;
const fr: Partial<S> = { homes: 'Biens', buy: 'Acheter', rent: 'Louer', any: 'Tous', beds: '{n}+ ch.', results: '{n} biens', none: 'Aucun bien.', bookViewing: 'Réserver une visite', chooseDay: 'Choisir un jour', chooseTime: 'Choisir une heure', request: 'Demander la visite', myHomes: 'Biens enregistrés', myViewings: 'Mes visites', today: 'Visites du jour', newEnquiries: 'Nouvelles demandes', pulseTitle: 'Immobilier — aperçu', active: 'Annonces actives', perCurrency: 'Par devise — jamais additionné.' };
const es: Partial<S> = { homes: 'Inmuebles', buy: 'Comprar', rent: 'Alquilar', any: 'Todos', beds: '{n}+ dorm.', results: '{n} inmuebles', none: 'Ningún inmueble.', bookViewing: 'Reservar visita', chooseDay: 'Elige un día', chooseTime: 'Elige una hora', request: 'Solicitar visita', myHomes: 'Inmuebles guardados', myViewings: 'Mis visitas', today: 'Visitas de hoy', newEnquiries: 'Nuevas consultas', pulseTitle: 'Inmobiliaria — pulso', active: 'Inmuebles activos', perCurrency: 'Por moneda — nunca sumado.' };
const de: Partial<S> = { homes: 'Immobilien', buy: 'Kaufen', rent: 'Mieten', any: 'Alle', beds: '{n}+ Zi.', results: '{n} Objekte', none: 'Keine Objekte.', bookViewing: 'Besichtigung buchen', chooseDay: 'Tag wählen', chooseTime: 'Uhrzeit wählen', request: 'Besichtigung anfragen', myHomes: 'Gemerkte Objekte', myViewings: 'Meine Besichtigungen', today: 'Heutige Besichtigungen', newEnquiries: 'Neue Anfragen', pulseTitle: 'Immobilien – Überblick', active: 'Aktive Objekte', perCurrency: 'Je Währung – nie addiert.' };
const ptBR: Partial<S> = { homes: 'Imóveis', buy: 'Comprar', rent: 'Alugar', any: 'Todos', beds: '{n}+ quartos', results: '{n} imóveis', none: 'Nenhum imóvel.', bookViewing: 'Agendar visita', chooseDay: 'Escolha o dia', chooseTime: 'Escolha o horário', request: 'Solicitar visita', myHomes: 'Imóveis salvos', myViewings: 'Minhas visitas', today: 'Visitas de hoje', newEnquiries: 'Novos contatos', pulseTitle: 'Imobiliário — pulso', active: 'Imóveis ativos', perCurrency: 'Por moeda — nunca somado.' };
const TABLE: Record<string, Partial<S>> = { en, fr, es, de, 'pt-BR': ptBR };

export function useRealtyStrings() {
  const { locale, intlLocale } = useI18n();
  const dict = { ...en, ...(TABLE[locale] ?? {}) } as S;
  const s = <K extends keyof S>(k: K, vars: Record<string, string | number> = {}) => {
    const v = dict[k];
    return typeof v === 'string' ? v.replace(/\{(\w+)\}/g, (_, n: string) => String(vars[n] ?? '')) : (v as unknown as string);
  };
  return { s, dict, intlLocale };
}
