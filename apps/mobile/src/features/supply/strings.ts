import { useI18n } from '@/i18n';

/** Receiving deliveries and self-checks on mobile — complete in every app locale. */
const en = {
  entry: 'Deliveries & daily checks', entrySub: 'Receive supplier deliveries, run opening, closing and temperature checks',
  title: 'Deliveries & checks', kicker: 'Today', checks: 'Today’s checks', noChecks: 'Nothing to check today.', deliveries: 'Deliveries to receive', noDeliveries: 'No deliveries expected.',
  due: 'Due {time}', late: 'Late', done: 'Done', missed: 'Missed', passed: 'Passed', failed: 'Failed', progress: '{done} of {total} answered', doneBy: 'Done by {name}',
  expected: 'Expected {date}', packs: '{received} of {ordered} packs', receive: 'Receive', receiveTitle: 'Receive {number}', from: 'From {supplier}',
  expecting: 'Expecting {n}', good: 'Good', damaged: 'Damaged', less: 'One less: {label}', more: 'One more: {label}', issue: 'What was wrong?', short: 'Short', wrong_item: 'Wrong item', quality: 'Quality',
  note: 'Note', notePlaceholder: 'What happened?', deliveryNote: 'Delivery note', closeShort: 'Nothing more is coming', closeShortSub: 'Close the order with what arrived',
  confirm: 'Confirm delivery', received: 'Delivery recorded', restocked: '{n} item(s) restocked in inventory', allReceived: 'Everything on this order has arrived.',
  yes: 'Yes', no: 'No', na: 'N/A', range: '{min} to {max}', max: 'max {max}', min: 'min {min}', critical: 'Critical', criticalLive: 'A critical item is failing. Fix it now and tell your manager.',
  submit: 'Submit check', answerAll: 'Answer every item (or N/A) to submit.', submitted: 'Check submitted', failedItems: 'Failed: {items}', addNote: 'Add note',
  error: 'Something went wrong', retry: 'Retry', back: 'Back', noAccess: 'Deliveries and daily checks are not part of your access.', needsConnection: 'This needs a connection.',
  offline: 'Offline: your answers are kept on this phone and sync when you’re back online', savedHere: 'Saved on this phone', syncing: 'Syncing…', synced: 'All answers synced',
  pendingSync: '{n} change(s) waiting to sync', syncError: 'Could not sync yet. We’ll try again.', submitQueued: 'Will be submitted as soon as you’re back online',
  addPhoto: 'Take photo', photoRequired: 'Photo required', photoPending: 'Will upload when online',
};
export type SKey = keyof typeof en;
const fr: typeof en = {
  entry: 'Livraisons et contrôles du jour', entrySub: 'Réceptionner les livraisons, faire les contrôles d’ouverture, de fermeture et de températures',
  title: 'Livraisons et contrôles', kicker: 'Aujourd’hui', checks: 'Contrôles du jour', noChecks: 'Rien à contrôler aujourd’hui.', deliveries: 'Livraisons à réceptionner', noDeliveries: 'Aucune livraison attendue.',
  due: 'Pour {time}', late: 'En retard', done: 'Fait', missed: 'Manqué', passed: 'Conforme', failed: 'Non conforme', progress: '{done} réponses sur {total}', doneBy: 'Fait par {name}',
  expected: 'Prévue le {date}', packs: '{received} colis reçus sur {ordered}', receive: 'Réceptionner', receiveTitle: 'Réception {number}', from: 'De {supplier}',
  expecting: '{n} attendus', good: 'Bon état', damaged: 'Abîmés', less: 'Un de moins : {label}', more: 'Un de plus : {label}', issue: 'Quel problème ?', short: 'Manquant', wrong_item: 'Mauvais article', quality: 'Qualité',
  note: 'Remarque', notePlaceholder: 'Que s’est-il passé ?', deliveryNote: 'Remarque sur la livraison', closeShort: 'Rien d’autre n’arrivera', closeShortSub: 'Clôturer la commande avec ce qui est arrivé',
  confirm: 'Confirmer la réception', received: 'Livraison enregistrée', restocked: '{n} article(s) réapprovisionné(s) en stock', allReceived: 'Tout ce qui a été commandé est arrivé.',
  yes: 'Oui', no: 'Non', na: 'N/A', range: 'de {min} à {max}', max: 'max. {max}', min: 'min. {min}', critical: 'Critique', criticalLive: 'Un point critique n’est pas conforme. Corrigez-le maintenant et prévenez votre responsable.',
  submit: 'Envoyer le contrôle', answerAll: 'Répondez à chaque point (ou N/A) pour envoyer.', submitted: 'Contrôle envoyé', failedItems: 'Non conforme : {items}', addNote: 'Ajouter une remarque',
  error: 'Une erreur s’est produite', retry: 'Réessayer', back: 'Retour', noAccess: 'Les livraisons et contrôles du jour ne font pas partie de votre accès.', needsConnection: 'Une connexion est nécessaire.',
  offline: 'Hors ligne : vos réponses sont gardées sur ce téléphone et synchronisées dès le retour du réseau', savedHere: 'Enregistré sur ce téléphone', syncing: 'Synchronisation…', synced: 'Toutes les réponses sont synchronisées',
  pendingSync: '{n} modification(s) en attente de synchronisation', syncError: 'Synchronisation impossible pour l’instant. Nouvel essai bientôt.', submitQueued: 'Sera envoyé dès le retour du réseau',
  addPhoto: 'Prendre une photo', photoRequired: 'Photo obligatoire', photoPending: 'Sera envoyée une fois en ligne',
};
const es: typeof en = {
  entry: 'Entregas y controles del día', entrySub: 'Recibir entregas de proveedores y hacer los controles de apertura, cierre y temperatura',
  title: 'Entregas y controles', kicker: 'Hoy', checks: 'Controles de hoy', noChecks: 'Nada que controlar hoy.', deliveries: 'Entregas por recibir', noDeliveries: 'No hay entregas previstas.',
  due: 'Antes de las {time}', late: 'Con retraso', done: 'Hecho', missed: 'No realizado', passed: 'Correcto', failed: 'Con fallos', progress: '{done} de {total} respondidas', doneBy: 'Hecho por {name}',
  expected: 'Prevista el {date}', packs: '{received} de {ordered} bultos', receive: 'Recibir', receiveTitle: 'Recibir {number}', from: 'De {supplier}',
  expecting: 'Se esperan {n}', good: 'Buen estado', damaged: 'Dañados', less: 'Uno menos: {label}', more: 'Uno más: {label}', issue: '¿Qué estaba mal?', short: 'Falta', wrong_item: 'Artículo equivocado', quality: 'Calidad',
  note: 'Nota', notePlaceholder: '¿Qué pasó?', deliveryNote: 'Nota de la entrega', closeShort: 'No llegará nada más', closeShortSub: 'Cerrar el pedido con lo que llegó',
  confirm: 'Confirmar entrega', received: 'Entrega registrada', restocked: '{n} artículo(s) repuesto(s) en el inventario', allReceived: 'Ha llegado todo lo de este pedido.',
  yes: 'Sí', no: 'No', na: 'N/A', range: 'de {min} a {max}', max: 'máx. {max}', min: 'mín. {min}', critical: 'Crítico', criticalLive: 'Un punto crítico está fallando. Corrígelo ahora y avisa a tu responsable.',
  submit: 'Enviar control', answerAll: 'Responde a cada punto (o N/A) para enviar.', submitted: 'Control enviado', failedItems: 'Con fallos: {items}', addNote: 'Añadir nota',
  error: 'Algo salió mal', retry: 'Reintentar', back: 'Volver', noAccess: 'Las entregas y los controles del día no forman parte de tu acceso.', needsConnection: 'Hace falta conexión.',
  offline: 'Sin conexión: tus respuestas se guardan en este teléfono y se sincronizan al volver la conexión', savedHere: 'Guardado en este teléfono', syncing: 'Sincronizando…', synced: 'Todas las respuestas sincronizadas',
  pendingSync: '{n} cambio(s) pendientes de sincronizar', syncError: 'Aún no se pudo sincronizar. Lo intentaremos de nuevo.', submitQueued: 'Se enviará en cuanto vuelvas a tener conexión',
  addPhoto: 'Hacer foto', photoRequired: 'Foto obligatoria', photoPending: 'Se subirá con conexión',
};
const de: typeof en = {
  entry: 'Lieferungen & Tageskontrollen', entrySub: 'Lieferungen annehmen, Öffnungs-, Schließ- und Temperaturkontrollen durchführen',
  title: 'Lieferungen & Kontrollen', kicker: 'Heute', checks: 'Heutige Kontrollen', noChecks: 'Heute nichts zu kontrollieren.', deliveries: 'Anzunehmende Lieferungen', noDeliveries: 'Keine Lieferungen erwartet.',
  due: 'Fällig {time}', late: 'Verspätet', done: 'Erledigt', missed: 'Versäumt', passed: 'Bestanden', failed: 'Nicht bestanden', progress: '{done} von {total} beantwortet', doneBy: 'Erledigt von {name}',
  expected: 'Erwartet am {date}', packs: '{received} von {ordered} Gebinden', receive: 'Annehmen', receiveTitle: 'Annahme {number}', from: 'Von {supplier}',
  expecting: '{n} erwartet', good: 'Einwandfrei', damaged: 'Beschädigt', less: 'Eins weniger: {label}', more: 'Eins mehr: {label}', issue: 'Was war falsch?', short: 'Fehlmenge', wrong_item: 'Falscher Artikel', quality: 'Qualität',
  note: 'Notiz', notePlaceholder: 'Was ist passiert?', deliveryNote: 'Notiz zur Lieferung', closeShort: 'Es kommt nichts mehr', closeShortSub: 'Bestellung mit dem Gelieferten abschließen',
  confirm: 'Lieferung bestätigen', received: 'Lieferung erfasst', restocked: '{n} Artikel im Bestand aufgefüllt', allReceived: 'Alles aus dieser Bestellung ist angekommen.',
  yes: 'Ja', no: 'Nein', na: 'N/A', range: '{min} bis {max}', max: 'max. {max}', min: 'min. {min}', critical: 'Kritisch', criticalLive: 'Ein kritischer Punkt ist nicht erfüllt. Beheben Sie ihn sofort und informieren Sie Ihre Leitung.',
  submit: 'Kontrolle absenden', answerAll: 'Beantworten Sie jeden Punkt (oder N/A), um abzusenden.', submitted: 'Kontrolle abgesendet', failedItems: 'Nicht erfüllt: {items}', addNote: 'Notiz hinzufügen',
  error: 'Etwas ist schiefgelaufen', retry: 'Erneut versuchen', back: 'Zurück', noAccess: 'Lieferungen und Tageskontrollen gehören nicht zu Ihrem Zugriff.', needsConnection: 'Dafür ist eine Verbindung nötig.',
  offline: 'Offline: Ihre Antworten bleiben auf diesem Telefon und werden synchronisiert, sobald Sie wieder online sind', savedHere: 'Auf diesem Telefon gespeichert', syncing: 'Wird synchronisiert…', synced: 'Alle Antworten synchronisiert',
  pendingSync: '{n} Änderung(en) warten auf Synchronisierung', syncError: 'Noch keine Synchronisierung möglich. Wir versuchen es erneut.', submitQueued: 'Wird gesendet, sobald Sie wieder online sind',
  addPhoto: 'Foto aufnehmen', photoRequired: 'Foto erforderlich', photoPending: 'Wird online hochgeladen',
};
const ptBR: typeof en = {
  entry: 'Entregas e verificações do dia', entrySub: 'Receber entregas de fornecedores e fazer as verificações de abertura, fechamento e temperatura',
  title: 'Entregas e verificações', kicker: 'Hoje', checks: 'Verificações de hoje', noChecks: 'Nada para verificar hoje.', deliveries: 'Entregas a receber', noDeliveries: 'Nenhuma entrega prevista.',
  due: 'Até {time}', late: 'Atrasada', done: 'Feita', missed: 'Não feita', passed: 'Aprovada', failed: 'Com falhas', progress: '{done} de {total} respondidas', doneBy: 'Feita por {name}',
  expected: 'Prevista para {date}', packs: '{received} de {ordered} volumes', receive: 'Receber', receiveTitle: 'Receber {number}', from: 'De {supplier}',
  expecting: '{n} esperados', good: 'Bom estado', damaged: 'Avariados', less: 'Um a menos: {label}', more: 'Um a mais: {label}', issue: 'O que estava errado?', short: 'Faltou', wrong_item: 'Item errado', quality: 'Qualidade',
  note: 'Observação', notePlaceholder: 'O que aconteceu?', deliveryNote: 'Observação da entrega', closeShort: 'Não virá mais nada', closeShortSub: 'Encerrar o pedido com o que chegou',
  confirm: 'Confirmar recebimento', received: 'Entrega registrada', restocked: '{n} item(ns) reposto(s) no estoque', allReceived: 'Tudo deste pedido já chegou.',
  yes: 'Sim', no: 'Não', na: 'N/A', range: 'de {min} a {max}', max: 'máx. {max}', min: 'mín. {min}', critical: 'Crítico', criticalLive: 'Um item crítico está falhando. Corrija agora e avise seu gerente.',
  submit: 'Enviar verificação', answerAll: 'Responda a todos os itens (ou N/A) para enviar.', submitted: 'Verificação enviada', failedItems: 'Com falha: {items}', addNote: 'Adicionar observação',
  error: 'Algo deu errado', retry: 'Tentar de novo', back: 'Voltar', noAccess: 'Entregas e verificações do dia não fazem parte do seu acesso.', needsConnection: 'É preciso ter conexão.',
  offline: 'Sem conexão: suas respostas ficam neste celular e sincronizam quando a conexão voltar', savedHere: 'Salvo neste celular', syncing: 'Sincronizando…', synced: 'Todas as respostas sincronizadas',
  pendingSync: '{n} alteração(ões) aguardando sincronização', syncError: 'Ainda não foi possível sincronizar. Vamos tentar de novo.', submitQueued: 'Será enviada assim que a conexão voltar',
  addPhoto: 'Tirar foto', photoRequired: 'Foto obrigatória', photoPending: 'Será enviada quando houver conexão',
};
export const STRINGS: Record<string, typeof en> = { en, fr, es, de, 'pt-BR': ptBR };

export function useST() {
  const { locale, intlLocale } = useI18n();
  const table = STRINGS[locale] ?? en;
  return {
    locale: intlLocale,
    t: (k: SKey, vars: Record<string, string | number> = {}) => (table[k] ?? en[k]).replace(/\{(\w+)\}/g, (_, v: string) => String(vars[v] ?? '')),
  };
}
