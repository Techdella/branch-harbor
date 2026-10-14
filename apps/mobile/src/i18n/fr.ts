import type { PartialDict } from './types';
/** Français — core strings. Missing keys fall back to English. */
const fr: PartialDict = {
  common: { continue: 'Continuer', cancel: 'Annuler', confirm: 'Confirmer', close: 'Fermer', back: 'Retour', retry: 'Réessayer', save: 'Enregistrer', send: 'Envoyer', done: 'Terminé', loading: 'Chargement…', unavailable: 'Indisponible', notConnected: 'Non connecté', today: 'Aujourd’hui', tomorrow: 'Demain', approve: 'Approuver', reject: 'Refuser', approved: 'Approuvé', rejected: 'Refusé', pending: 'En attente', refresh: 'Actualiser', lastUpdated: 'Mis à jour %{time}', timesIn: 'Heures en %{zone}', errorTitle: 'Une erreur est survenue', offlineTitle: 'Vous êtes hors ligne', offlineBody: 'Données du %{time}. Elles peuvent être obsolètes — les actions attendront la reconnexion.', sampleData: 'Données d’exemple' },
  welcome: { tagline: 'Un seul foyer pour chaque établissement.', signIn: 'Se connecter', email: 'E-mail', password: 'Mot de passe', guest: 'Continuer en invité', chooseExperience: 'Choisir une expérience', customer: 'Client', staff: 'Équipe', owner: 'Propriétaire / Siège' },
  tabs: { home: 'Accueil', book: 'Réserver', order: 'Commander', bookings: 'Réservations', inbox: 'Messages', profile: 'Profil', today: 'Aujourd’hui', checkin: 'Pointage', kitchen: 'Cuisine', messages: 'Messages', cover: 'Remplacement', pulse: 'Aperçu', approvals: 'Validations', locations: 'Sites', alerts: 'Alertes' },
  customer: { goodMorning: 'Bonjour', goodAfternoon: 'Bon après-midi', goodEvening: 'Bonsoir', chooseLocation: 'Choisir un établissement', nextClass: 'Prochain cours', offers: 'Offres' },
  book: { spotsLeft: { one: '1 place restante', other: '%{count} places restantes' }, started: 'Commencé', full: 'Complet · liste d’attente ouverte', bookCta: 'Réserver', waitlistCta: 'Liste d’attente', booked: 'Réservé', policy: 'Conditions d’annulation', bookedDone: 'C’est réservé', waitlistDone: 'Vous êtes sur la liste d’attente' },
  pay: { notConfigured: 'Paiements non configurés', processing: 'Paiement en cours…', failed: 'Le paiement a échoué' },
  order: { title: 'Commande à emporter', chooseTime: 'Choisissez une heure de retrait', soldOut: 'Épuisé', add: 'Ajouter', subtotal: 'Sous-total', tax: 'Taxes', taxNote: 'Taxes selon la configuration du commerce', total: 'Total', awaitingTitle: 'En attente d’acceptation par le restaurant', readyTitle: 'Prête à récupérer' },
  bookings: { title: 'Mes réservations', upcoming: 'À venir', past: 'Passées', confirmed: 'Confirmée', cancelled: 'Annulée', cancel: 'Annuler la réservation' },
  inbox: { title: 'Messages', you: 'Vous' },
  profile: { title: 'Profil', language: 'Langue', notifications: 'Notifications', push: 'Notifications push', email: 'E-mail', sms: 'SMS', privacy: 'Confidentialité et données', exportData: 'Demander une copie de mes données', deleteData: 'Demander la suppression du compte', signOut: 'Se déconnecter' },
  staff: { present: 'Présent', absent: 'Absent', accept: 'Accepter', rejectOrder: 'Refuser', markReady: 'Marquer prête', waitingServer: 'En attente du serveur…' },
  owner: { pulseTitle: 'Aperçu du réseau', approvalsTitle: 'Validations', refund: 'Remboursement', shiftSwap: 'Échange de service', locationsTitle: 'Établissements' },
};
export default fr;
