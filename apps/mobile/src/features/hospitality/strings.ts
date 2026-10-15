import { useI18n } from '@/i18n';

/** Hospitality strings, kept with the feature (complete in every app locale). */
const en = {
  stays: 'Stays', staysKicker: 'Book a room', properties: 'Where would you like to stay?',
  arrival: 'Check-in (YYYY-MM-DD)', departure: 'Check-out (YYYY-MM-DD)', adults: 'Adults', search: 'Check availability', noRooms: 'Nothing is available for these dates.', left: '{n} left', soldOut: 'Sold out',
  breakfast: 'Breakfast included', nonRefundable: 'Non-refundable', freeUntil: 'Free cancellation until {h} h before arrival', choose: 'Choose', name: 'Full name', email: 'Email', consentEmail: 'Email me arrival information before my stay',
  book: 'Book', payDeposit: 'Pay {amount} deposit', depositNone: 'Nothing to pay now', confirmed: 'Your stay is confirmed. Booking {code}.', held: 'Your room is held while you pay.', total: 'Total {amount}', dates: 'Check your dates.',
  myStays: 'My stays', noStays: 'No stays yet.', nights: '{n} nights', cancel: 'Cancel stay', cancelFree: 'Cancel for free', cancelFee: 'Cancel ({fee} fee)', cancelled: 'Stay cancelled.', dueAtProperty: 'Due at the property: {amount}',
  status: { hold: 'Awaiting deposit', confirmed: 'Confirmed', checked_in: 'In house', checked_out: 'Completed', cancelled: 'Cancelled', no_show: 'No-show', expired: 'Expired' } as Record<string, string>,
  staffTitle: 'Housekeeping & arrivals', tasks: 'My rooms today', noTasks: 'No rooms to service right now.', start: 'Start', done: 'Done', taskDone: 'Room marked as done.', arrivals: 'Arriving today', noArrivals: 'No arrivals today.',
  taskKinds: { departure_clean: 'Departure clean', stayover: 'Stayover', inspection: 'Inspection', maintenance: 'Maintenance', turndown: 'Turndown' } as Record<string, string>,
  room: 'Room {n}', unassigned: 'Room not assigned', mine: 'Assigned to you',
  pulseTitle: 'Hotel pulse', pulseSub: 'Tonight per property', occupancy: 'Occupancy', adr: 'ADR', revpar: 'RevPAR', inHouse: '{n} in house', arrivalsN: '{n} arrivals', dirty: '{n} to clean', perCurrency: 'Each property in its own currency — never combined.', unavailable: 'Unavailable',
};
type S = typeof en;
const fr: S = {
  stays: 'Séjours', staysKicker: 'Réserver une chambre', properties: 'Où souhaitez-vous séjourner ?',
  arrival: 'Arrivée (AAAA-MM-JJ)', departure: 'Départ (AAAA-MM-JJ)', adults: 'Adultes', search: 'Voir les disponibilités', noRooms: 'Rien n’est disponible à ces dates.', left: 'plus que {n}', soldOut: 'Complet',
  breakfast: 'Petit-déjeuner inclus', nonRefundable: 'Non remboursable', freeUntil: 'Annulation gratuite jusqu’à {h} h avant l’arrivée', choose: 'Choisir', name: 'Nom complet', email: 'E-mail', consentEmail: 'M’envoyer par e-mail les informations d’arrivée',
  book: 'Réserver', payDeposit: 'Payer l’acompte de {amount}', depositNone: 'Rien à payer maintenant', confirmed: 'Votre séjour est confirmé. Réservation {code}.', held: 'Votre chambre est bloquée pendant le paiement.', total: 'Total {amount}', dates: 'Vérifiez vos dates.',
  myStays: 'Mes séjours', noStays: 'Aucun séjour pour l’instant.', nights: '{n} nuits', cancel: 'Annuler le séjour', cancelFree: 'Annuler gratuitement', cancelFee: 'Annuler (frais de {fee})', cancelled: 'Séjour annulé.', dueAtProperty: 'À régler sur place : {amount}',
  status: { hold: 'Acompte en attente', confirmed: 'Confirmé', checked_in: 'Sur place', checked_out: 'Terminé', cancelled: 'Annulé', no_show: 'Non présenté', expired: 'Expiré' },
  staffTitle: 'Entretien et arrivées', tasks: 'Mes chambres aujourd’hui', noTasks: 'Aucune chambre à faire pour l’instant.', start: 'Commencer', done: 'Terminé', taskDone: 'Chambre terminée.', arrivals: 'Arrivées du jour', noArrivals: 'Aucune arrivée aujourd’hui.',
  taskKinds: { departure_clean: 'Ménage départ', stayover: 'Recouche', inspection: 'Inspection', maintenance: 'Maintenance', turndown: 'Couverture' },
  room: 'Chambre {n}', unassigned: 'Chambre non attribuée', mine: 'Attribuée à vous',
  pulseTitle: 'Pouls hôtelier', pulseSub: 'Ce soir par établissement', occupancy: 'Occupation', adr: 'Prix moyen', revpar: 'RevPAR', inHouse: '{n} sur place', arrivalsN: '{n} arrivées', dirty: '{n} à nettoyer', perCurrency: 'Chaque établissement dans sa devise — jamais additionnées.', unavailable: 'Non disponible',
};
const es: S = {
  stays: 'Estancias', staysKicker: 'Reserva una habitación', properties: '¿Dónde quieres alojarte?',
  arrival: 'Llegada (AAAA-MM-DD)', departure: 'Salida (AAAA-MM-DD)', adults: 'Adultos', search: 'Ver disponibilidad', noRooms: 'No hay disponibilidad para esas fechas.', left: 'quedan {n}', soldOut: 'Agotado',
  breakfast: 'Desayuno incluido', nonRefundable: 'No reembolsable', freeUntil: 'Cancelación gratuita hasta {h} h antes de la llegada', choose: 'Elegir', name: 'Nombre completo', email: 'Correo electrónico', consentEmail: 'Enviarme por correo la información de llegada',
  book: 'Reservar', payDeposit: 'Pagar depósito de {amount}', depositNone: 'Nada que pagar ahora', confirmed: 'Tu estancia está confirmada. Reserva {code}.', held: 'Tu habitación queda retenida mientras pagas.', total: 'Total {amount}', dates: 'Revisa las fechas.',
  myStays: 'Mis estancias', noStays: 'Aún no tienes estancias.', nights: '{n} noches', cancel: 'Cancelar estancia', cancelFree: 'Cancelar gratis', cancelFee: 'Cancelar (cargo de {fee})', cancelled: 'Estancia cancelada.', dueAtProperty: 'A pagar en el alojamiento: {amount}',
  status: { hold: 'Depósito pendiente', confirmed: 'Confirmada', checked_in: 'Alojado', checked_out: 'Finalizada', cancelled: 'Cancelada', no_show: 'No presentado', expired: 'Caducada' },
  staffTitle: 'Limpieza y llegadas', tasks: 'Mis habitaciones hoy', noTasks: 'No hay habitaciones pendientes ahora.', start: 'Empezar', done: 'Hecho', taskDone: 'Habitación terminada.', arrivals: 'Llegadas de hoy', noArrivals: 'No hay llegadas hoy.',
  taskKinds: { departure_clean: 'Limpieza de salida', stayover: 'Repaso', inspection: 'Revisión', maintenance: 'Mantenimiento', turndown: 'Preparación nocturna' },
  room: 'Habitación {n}', unassigned: 'Sin habitación asignada', mine: 'Asignada a ti',
  pulseTitle: 'Pulso hotelero', pulseSub: 'Esta noche por alojamiento', occupancy: 'Ocupación', adr: 'ADR', revpar: 'RevPAR', inHouse: '{n} alojados', arrivalsN: '{n} llegadas', dirty: '{n} por limpiar', perCurrency: 'Cada alojamiento en su moneda; nunca se suman.', unavailable: 'No disponible',
};
const de: S = {
  stays: 'Aufenthalte', staysKicker: 'Zimmer buchen', properties: 'Wo möchten Sie übernachten?',
  arrival: 'Anreise (JJJJ-MM-TT)', departure: 'Abreise (JJJJ-MM-TT)', adults: 'Erwachsene', search: 'Verfügbarkeit prüfen', noRooms: 'Für diese Daten ist nichts frei.', left: 'noch {n}', soldOut: 'Ausgebucht',
  breakfast: 'Frühstück inklusive', nonRefundable: 'Nicht erstattungsfähig', freeUntil: 'Kostenlose Stornierung bis {h} Std. vor Anreise', choose: 'Auswählen', name: 'Vollständiger Name', email: 'E-Mail', consentEmail: 'Anreiseinfos per E-Mail erhalten',
  book: 'Buchen', payDeposit: '{amount} Anzahlung zahlen', depositNone: 'Jetzt nichts zu zahlen', confirmed: 'Ihr Aufenthalt ist bestätigt. Buchung {code}.', held: 'Ihr Zimmer ist während der Zahlung reserviert.', total: 'Gesamt {amount}', dates: 'Bitte Daten prüfen.',
  myStays: 'Meine Aufenthalte', noStays: 'Noch keine Aufenthalte.', nights: '{n} Nächte', cancel: 'Aufenthalt stornieren', cancelFree: 'Kostenlos stornieren', cancelFee: 'Stornieren ({fee} Gebühr)', cancelled: 'Aufenthalt storniert.', dueAtProperty: 'Vor Ort zu zahlen: {amount}',
  status: { hold: 'Anzahlung ausstehend', confirmed: 'Bestätigt', checked_in: 'Im Haus', checked_out: 'Abgeschlossen', cancelled: 'Storniert', no_show: 'Nicht erschienen', expired: 'Abgelaufen' },
  staffTitle: 'Housekeeping & Anreisen', tasks: 'Meine Zimmer heute', noTasks: 'Gerade keine Zimmer zu machen.', start: 'Starten', done: 'Erledigt', taskDone: 'Zimmer erledigt.', arrivals: 'Anreisen heute', noArrivals: 'Heute keine Anreisen.',
  taskKinds: { departure_clean: 'Abreisereinigung', stayover: 'Bleibereinigung', inspection: 'Kontrolle', maintenance: 'Wartung', turndown: 'Abendservice' },
  room: 'Zimmer {n}', unassigned: 'Kein Zimmer zugewiesen', mine: 'Ihnen zugewiesen',
  pulseTitle: 'Hotel-Überblick', pulseSub: 'Heute Nacht je Unterkunft', occupancy: 'Auslastung', adr: 'Durchschnittsrate', revpar: 'RevPAR', inHouse: '{n} im Haus', arrivalsN: '{n} Anreisen', dirty: '{n} zu reinigen', perCurrency: 'Jede Unterkunft in eigener Währung – nie addiert.', unavailable: 'Nicht verfügbar',
};
const ptBR: S = {
  stays: 'Estadias', staysKicker: 'Reserve um quarto', properties: 'Onde você quer se hospedar?',
  arrival: 'Chegada (AAAA-MM-DD)', departure: 'Saída (AAAA-MM-DD)', adults: 'Adultos', search: 'Ver disponibilidade', noRooms: 'Nada disponível para essas datas.', left: 'restam {n}', soldOut: 'Esgotado',
  breakfast: 'Café da manhã incluído', nonRefundable: 'Não reembolsável', freeUntil: 'Cancelamento grátis até {h} h antes da chegada', choose: 'Escolher', name: 'Nome completo', email: 'E-mail', consentEmail: 'Receber por e-mail as informações de chegada',
  book: 'Reservar', payDeposit: 'Pagar depósito de {amount}', depositNone: 'Nada a pagar agora', confirmed: 'Sua estadia está confirmada. Reserva {code}.', held: 'Seu quarto fica reservado enquanto você paga.', total: 'Total {amount}', dates: 'Confira as datas.',
  myStays: 'Minhas estadias', noStays: 'Nenhuma estadia ainda.', nights: '{n} noites', cancel: 'Cancelar estadia', cancelFree: 'Cancelar grátis', cancelFee: 'Cancelar (taxa de {fee})', cancelled: 'Estadia cancelada.', dueAtProperty: 'A pagar na propriedade: {amount}',
  status: { hold: 'Aguardando depósito', confirmed: 'Confirmada', checked_in: 'Hospedado', checked_out: 'Concluída', cancelled: 'Cancelada', no_show: 'Não compareceu', expired: 'Expirada' },
  staffTitle: 'Governança e chegadas', tasks: 'Meus quartos hoje', noTasks: 'Nenhum quarto para arrumar agora.', start: 'Iniciar', done: 'Concluído', taskDone: 'Quarto concluído.', arrivals: 'Chegadas de hoje', noArrivals: 'Nenhuma chegada hoje.',
  taskKinds: { departure_clean: 'Limpeza de saída', stayover: 'Arrumação diária', inspection: 'Inspeção', maintenance: 'Manutenção', turndown: 'Arrumação noturna' },
  room: 'Quarto {n}', unassigned: 'Quarto não atribuído', mine: 'Atribuído a você',
  pulseTitle: 'Pulso do hotel', pulseSub: 'Hoje por propriedade', occupancy: 'Ocupação', adr: 'Diária média', revpar: 'RevPAR', inHouse: '{n} hospedados', arrivalsN: '{n} chegadas', dirty: '{n} para limpar', perCurrency: 'Cada propriedade na própria moeda — nunca somadas.', unavailable: 'Indisponível',
};

export const STRINGS: Record<string, S> = { en, fr, es, de, 'pt-BR': ptBR };

export function useHospStrings() {
  const { locale, intlLocale } = useI18n();
  const dict = { ...en, ...(STRINGS[locale] ?? {}) } as S;
  const s = <K extends keyof S>(k: K, vars: Record<string, string | number> = {}) => {
    const v = dict[k];
    return typeof v === 'string' ? v.replace(/\{(\w+)\}/g, (_, n: string) => String(vars[n] ?? '')) : (v as unknown as string);
  };
  return { s, dict, intlLocale };
}
