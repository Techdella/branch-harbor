import type { PartialDict } from './types';
/** Deutsch — core strings. Missing keys fall back to English. */
const de: PartialDict = {
  common: { continue: 'Weiter', cancel: 'Abbrechen', confirm: 'Bestätigen', close: 'Schließen', back: 'Zurück', retry: 'Erneut versuchen', save: 'Speichern', send: 'Senden', done: 'Fertig', loading: 'Wird geladen…', unavailable: 'Nicht verfügbar', notConnected: 'Nicht verbunden', today: 'Heute', tomorrow: 'Morgen', approve: 'Genehmigen', reject: 'Ablehnen', approved: 'Genehmigt', rejected: 'Abgelehnt', pending: 'Ausstehend', refresh: 'Aktualisieren', lastUpdated: 'Aktualisiert %{time}', timesIn: 'Zeiten in %{zone}', errorTitle: 'Etwas ist schiefgelaufen', offlineTitle: 'Du bist offline', offlineBody: 'Daten von %{time}. Sie sind evtl. veraltet – Aktionen warten, bis du wieder online bist.', sampleData: 'Beispieldaten' },
  welcome: { tagline: 'Ein Zuhause für jeden Standort.', signIn: 'Anmelden', email: 'E-Mail', password: 'Passwort', guest: 'Als Gast fortfahren', chooseExperience: 'Ansicht wählen', customer: 'Kunde', staff: 'Team', owner: 'Inhaber / Zentrale' },
  tabs: { home: 'Start', book: 'Buchen', order: 'Bestellen', bookings: 'Buchungen', inbox: 'Nachrichten', profile: 'Profil', today: 'Heute', checkin: 'Check-in', kitchen: 'Küche', messages: 'Nachrichten', cover: 'Vertretung', pulse: 'Überblick', approvals: 'Freigaben', locations: 'Standorte', alerts: 'Hinweise' },
  customer: { goodMorning: 'Guten Morgen', goodAfternoon: 'Guten Tag', goodEvening: 'Guten Abend', chooseLocation: 'Standort wählen', nextClass: 'Nächster Kurs', offers: 'Angebote' },
  book: { spotsLeft: { one: 'Noch 1 Platz', other: 'Noch %{count} Plätze' }, started: 'Begonnen', full: 'Ausgebucht · Warteliste offen', bookCta: 'Buchen', waitlistCta: 'Auf die Warteliste', booked: 'Gebucht', policy: 'Stornobedingungen', bookedDone: 'Du bist gebucht', waitlistDone: 'Du stehst auf der Warteliste' },
  pay: { notConfigured: 'Zahlungen nicht eingerichtet', processing: 'Zahlung wird verarbeitet…', failed: 'Zahlung fehlgeschlagen' },
  order: { title: 'Zum Abholen bestellen', chooseTime: 'Abholzeit wählen', soldOut: 'Ausverkauft', add: 'Hinzufügen', subtotal: 'Zwischensumme', tax: 'Steuer', taxNote: 'Steuer wie vom Betrieb konfiguriert', total: 'Gesamt', awaitingTitle: 'Warten auf Annahme durch das Restaurant', readyTitle: 'Abholbereit' },
  bookings: { title: 'Meine Buchungen', upcoming: 'Anstehend', past: 'Vergangen', confirmed: 'Bestätigt', cancelled: 'Storniert', cancel: 'Buchung stornieren' },
  inbox: { title: 'Nachrichten', you: 'Du' },
  profile: { title: 'Profil', language: 'Sprache', notifications: 'Benachrichtigungen', push: 'Push-Mitteilungen', email: 'E-Mail', sms: 'SMS', privacy: 'Datenschutz & meine Daten', exportData: 'Kopie meiner Daten anfordern', deleteData: 'Kontolöschung beantragen', signOut: 'Abmelden' },
  staff: { present: 'Anwesend', absent: 'Abwesend', accept: 'Annehmen', rejectOrder: 'Ablehnen', markReady: 'Als fertig markieren', waitingServer: 'Warte auf Server…' },
  owner: { pulseTitle: 'Netzwerk-Überblick', businessPulseTitle: 'Tagesüberblick', noLocationYet: 'Füge in der BranchHarbor-App die Adresse deines Unternehmens hinzu, um deinen Überblick zu sehen.', approvalsTitle: 'Freigaben', refund: 'Erstattung', shiftSwap: 'Schichttausch', locationsTitle: 'Standorte' },
};
export default de;
