import { useI18n } from '@/i18n';

/** Audits and compliance documents on mobile — complete in every app locale. */
const en = {
  entry: 'Audits & compliance', entrySub: 'Conduct audits, fix corrective actions, upload certificates',
  title: 'Audits', kicker: 'Field visits', myAudits: 'Assigned to me', noMine: 'No audits assigned to you.', recent: 'Reports', noRecent: 'No audit reports yet.',
  actions: 'Corrective actions', noActions: 'Nothing to fix right now.', due: 'Due {date}', overdue: 'Overdue', critical: 'Critical', photoRequired: 'Photo required',
  scheduled: 'Scheduled', in_progress: 'In progress', completed: 'Completed', cancelled: 'Cancelled', open: 'To fix', submitted: 'Waiting for verification', verified: 'Verified',
  start: 'Start audit', resume: 'Continue audit', report: 'View report', back: 'Back',
  yes: 'Yes', no: 'No', na: 'N/A', addPhoto: 'Take photo', choosePhoto: 'Choose photo', note: 'Note', notePlaceholder: 'What did you see?', addNote: 'Add note',
  progress: '{done} of {total} answered', score: 'Score {pct}', passMark: 'Pass mark {pct}%', failedCritical: 'A critical item failed: this audit fails whatever the score.',
  savedHere: 'Saved on this phone', syncing: 'Syncing…', synced: 'All changes synced', offline: 'Offline: everything is kept on this phone and syncs when you’re back online',
  pendingSync: '{n} change(s) waiting to sync', syncError: 'Could not sync yet. We’ll try again.', photoPending: 'Will upload when online',
  summary: 'Summary for the location', complete: 'Complete audit', completeQueued: 'Will complete as soon as you’re back online', answerAll: 'Answer every question (or N/A) to complete.',
  passed: 'Passed', failed: 'Failed', completedOn: 'Completed {date}', reaudit: 'Re-audit due {date}', noActionsReport: 'No corrective actions: every item passed.',
  whatFixed: 'What did you fix?', markDone: 'Mark as fixed', evidenceNeeded: 'Add a photo of the fix first.', addEvidence: 'Add evidence photo',
  verify: 'Verify', reopen: 'Reopen', reviewNote: 'Note to the location', reopened: 'Reopened: {note}', done: 'Saved',
  compliance: 'Compliance documents', complianceSub: 'Your certificates, licences and permits', valid: 'Valid', expiring: 'Expiring soon', expired: 'Expired', missing: 'Missing',
  pending: 'Waiting for review', below_minimum: 'Below the minimum', not_applicable: 'Not needed', expires: 'Expires {date}', upload: 'Upload', uploadTitle: 'Upload {name}',
  docTitle: 'Title', expiresOn: 'Expiry date (YYYY-MM-DD)', issuer: 'Insurer or issuer', amount: 'Amount', pickFile: 'Choose PDF or photo', takePhoto: 'Photograph the document',
  fileChosen: 'File: {name}', send: 'Send to HQ', sent: 'Sent. HQ will review it.', noRequirements: 'HQ has not set any requirements yet.', error: 'Something went wrong', retry: 'Retry',
  needsConnection: 'Uploading needs a connection.', noAccess: 'Audits are not part of your access.',
};
export type QKey = keyof typeof en;
const fr: typeof en = {
  entry: 'Audits et conformité', entrySub: 'Réaliser des audits, corriger les actions, déposer les attestations',
  title: 'Audits', kicker: 'Visites terrain', myAudits: 'Qui me sont attribués', noMine: 'Aucun audit ne vous est attribué.', recent: 'Rapports', noRecent: 'Pas encore de rapport d’audit.',
  actions: 'Actions correctives', noActions: 'Rien à corriger pour l’instant.', due: 'Échéance {date}', overdue: 'En retard', critical: 'Critique', photoRequired: 'Photo obligatoire',
  scheduled: 'Planifié', in_progress: 'En cours', completed: 'Terminé', cancelled: 'Annulé', open: 'À corriger', submitted: 'En attente de vérification', verified: 'Vérifiée',
  start: 'Commencer l’audit', resume: 'Reprendre l’audit', report: 'Voir le rapport', back: 'Retour',
  yes: 'Oui', no: 'Non', na: 'N/A', addPhoto: 'Prendre une photo', choosePhoto: 'Choisir une photo', note: 'Note', notePlaceholder: 'Qu’avez-vous constaté ?', addNote: 'Ajouter une note',
  progress: '{done} sur {total} répondues', score: 'Score {pct}', passMark: 'Seuil de réussite {pct} %', failedCritical: 'Un point critique n’est pas conforme : l’audit échoue quel que soit le score.',
  savedHere: 'Enregistré sur ce téléphone', syncing: 'Synchronisation…', synced: 'Tout est synchronisé', offline: 'Hors ligne : tout reste sur ce téléphone et se synchronise au retour de la connexion',
  pendingSync: '{n} modification(s) en attente de synchronisation', syncError: 'Synchronisation impossible pour l’instant. Nouvel essai bientôt.', photoPending: 'Envoi dès le retour en ligne',
  summary: 'Synthèse pour l’établissement', complete: 'Terminer l’audit', completeQueued: 'Sera terminé dès le retour de la connexion', answerAll: 'Répondez à chaque question (ou N/A) pour terminer.',
  passed: 'Réussi', failed: 'Échoué', completedOn: 'Terminé le {date}', reaudit: 'Contre-audit prévu le {date}', noActionsReport: 'Aucune action corrective : tous les points sont conformes.',
  whatFixed: 'Qu’avez-vous corrigé ?', markDone: 'Marquer comme corrigée', evidenceNeeded: 'Ajoutez d’abord une photo de la correction.', addEvidence: 'Ajouter une photo de preuve',
  verify: 'Valider', reopen: 'Rouvrir', reviewNote: 'Note pour l’établissement', reopened: 'Rouverte : {note}', done: 'Enregistré',
  compliance: 'Documents de conformité', complianceSub: 'Vos attestations, licences et permis', valid: 'Valide', expiring: 'Expire bientôt', expired: 'Expiré', missing: 'Manquant',
  pending: 'En attente de vérification', below_minimum: 'Sous le minimum', not_applicable: 'Non requis', expires: 'Expire le {date}', upload: 'Déposer', uploadTitle: 'Déposer : {name}',
  docTitle: 'Titre', expiresOn: 'Date d’échéance (AAAA-MM-JJ)', issuer: 'Assureur ou émetteur', amount: 'Montant', pickFile: 'Choisir un PDF ou une photo', takePhoto: 'Photographier le document',
  fileChosen: 'Fichier : {name}', send: 'Envoyer au siège', sent: 'Envoyé. Le siège va le vérifier.', noRequirements: 'Le siège n’a encore défini aucune exigence.', error: 'Un problème est survenu', retry: 'Réessayer',
  needsConnection: 'Le dépôt nécessite une connexion.', noAccess: 'Les audits ne font pas partie de vos accès.',
};
const es: typeof en = {
  entry: 'Auditorías y cumplimiento', entrySub: 'Realiza auditorías, corrige acciones y sube certificados',
  title: 'Auditorías', kicker: 'Visitas de campo', myAudits: 'Asignadas a mí', noMine: 'No tienes auditorías asignadas.', recent: 'Informes', noRecent: 'Todavía no hay informes de auditoría.',
  actions: 'Acciones correctivas', noActions: 'Nada que corregir ahora mismo.', due: 'Vence el {date}', overdue: 'Vencida', critical: 'Crítico', photoRequired: 'Foto obligatoria',
  scheduled: 'Programada', in_progress: 'En curso', completed: 'Completada', cancelled: 'Cancelada', open: 'Por corregir', submitted: 'Pendiente de verificación', verified: 'Verificada',
  start: 'Empezar auditoría', resume: 'Seguir con la auditoría', report: 'Ver informe', back: 'Volver',
  yes: 'Sí', no: 'No', na: 'N/A', addPhoto: 'Hacer foto', choosePhoto: 'Elegir foto', note: 'Nota', notePlaceholder: '¿Qué has visto?', addNote: 'Añadir nota',
  progress: '{done} de {total} respondidas', score: 'Puntuación {pct}', passMark: 'Nota de aprobado {pct} %', failedCritical: 'Un punto crítico no se ha superado: la auditoría suspende sea cual sea la puntuación.',
  savedHere: 'Guardado en este teléfono', syncing: 'Sincronizando…', synced: 'Todo sincronizado', offline: 'Sin conexión: todo se guarda en este teléfono y se sincroniza al volver la conexión',
  pendingSync: '{n} cambio(s) pendientes de sincronizar', syncError: 'Aún no se pudo sincronizar. Lo intentaremos de nuevo.', photoPending: 'Se subirá al volver la conexión',
  summary: 'Resumen para el local', complete: 'Completar auditoría', completeQueued: 'Se completará en cuanto vuelva la conexión', answerAll: 'Responde a todas las preguntas (o N/A) para completar.',
  passed: 'Aprobada', failed: 'Suspendida', completedOn: 'Completada el {date}', reaudit: 'Reauditoría prevista el {date}', noActionsReport: 'Sin acciones correctivas: todos los puntos se superaron.',
  whatFixed: '¿Qué has corregido?', markDone: 'Marcar como corregida', evidenceNeeded: 'Primero añade una foto de la corrección.', addEvidence: 'Añadir foto de prueba',
  verify: 'Verificar', reopen: 'Reabrir', reviewNote: 'Nota para el local', reopened: 'Reabierta: {note}', done: 'Guardado',
  compliance: 'Documentos de cumplimiento', complianceSub: 'Tus certificados, licencias y permisos', valid: 'Vigente', expiring: 'Vence pronto', expired: 'Vencido', missing: 'Falta',
  pending: 'Pendiente de revisión', below_minimum: 'Por debajo del mínimo', not_applicable: 'No requerido', expires: 'Vence el {date}', upload: 'Subir', uploadTitle: 'Subir {name}',
  docTitle: 'Título', expiresOn: 'Fecha de vencimiento (AAAA-MM-DD)', issuer: 'Aseguradora o emisor', amount: 'Importe', pickFile: 'Elegir PDF o foto', takePhoto: 'Fotografiar el documento',
  fileChosen: 'Archivo: {name}', send: 'Enviar a la central', sent: 'Enviado. La central lo revisará.', noRequirements: 'La central todavía no ha definido requisitos.', error: 'Algo salió mal', retry: 'Reintentar',
  needsConnection: 'Para subir hace falta conexión.', noAccess: 'Las auditorías no forman parte de tu acceso.',
};
const de: typeof en = {
  entry: 'Audits & Compliance', entrySub: 'Audits durchführen, Korrekturmaßnahmen erledigen, Nachweise hochladen',
  title: 'Audits', kicker: 'Standortbesuche', myAudits: 'Mir zugewiesen', noMine: 'Ihnen sind keine Audits zugewiesen.', recent: 'Berichte', noRecent: 'Noch keine Audit-Berichte.',
  actions: 'Korrekturmaßnahmen', noActions: 'Gerade nichts zu beheben.', due: 'Fällig {date}', overdue: 'Überfällig', critical: 'Kritisch', photoRequired: 'Foto erforderlich',
  scheduled: 'Geplant', in_progress: 'Läuft', completed: 'Abgeschlossen', cancelled: 'Storniert', open: 'Zu beheben', submitted: 'Wartet auf Prüfung', verified: 'Bestätigt',
  start: 'Audit starten', resume: 'Audit fortsetzen', report: 'Bericht ansehen', back: 'Zurück',
  yes: 'Ja', no: 'Nein', na: 'Entfällt', addPhoto: 'Foto aufnehmen', choosePhoto: 'Foto auswählen', note: 'Notiz', notePlaceholder: 'Was haben Sie gesehen?', addNote: 'Notiz hinzufügen',
  progress: '{done} von {total} beantwortet', score: 'Bewertung {pct}', passMark: 'Bestehensgrenze {pct} %', failedCritical: 'Ein kritischer Punkt ist nicht bestanden: Das Audit besteht unabhängig von der Bewertung nicht.',
  savedHere: 'Auf diesem Telefon gespeichert', syncing: 'Wird synchronisiert…', synced: 'Alles synchronisiert', offline: 'Offline: Alles bleibt auf diesem Telefon und wird synchronisiert, sobald Sie wieder online sind',
  pendingSync: '{n} Änderung(en) warten auf Synchronisierung', syncError: 'Synchronisierung noch nicht möglich. Wir versuchen es erneut.', photoPending: 'Wird hochgeladen, sobald Sie online sind',
  summary: 'Zusammenfassung für den Standort', complete: 'Audit abschließen', completeQueued: 'Wird abgeschlossen, sobald Sie wieder online sind', answerAll: 'Beantworten Sie jede Frage (oder Entfällt), um abzuschließen.',
  passed: 'Bestanden', failed: 'Nicht bestanden', completedOn: 'Abgeschlossen am {date}', reaudit: 'Nachaudit fällig am {date}', noActionsReport: 'Keine Korrekturmaßnahmen: Alle Punkte bestanden.',
  whatFixed: 'Was haben Sie behoben?', markDone: 'Als behoben markieren', evidenceNeeded: 'Fügen Sie zuerst ein Foto der Behebung hinzu.', addEvidence: 'Nachweisfoto hinzufügen',
  verify: 'Bestätigen', reopen: 'Wieder öffnen', reviewNote: 'Notiz an den Standort', reopened: 'Wieder geöffnet: {note}', done: 'Gespeichert',
  compliance: 'Compliance-Dokumente', complianceSub: 'Ihre Nachweise, Lizenzen und Genehmigungen', valid: 'Gültig', expiring: 'Läuft bald ab', expired: 'Abgelaufen', missing: 'Fehlt',
  pending: 'Wartet auf Prüfung', below_minimum: 'Unter dem Minimum', not_applicable: 'Nicht erforderlich', expires: 'Läuft ab am {date}', upload: 'Hochladen', uploadTitle: '{name} hochladen',
  docTitle: 'Titel', expiresOn: 'Ablaufdatum (JJJJ-MM-TT)', issuer: 'Versicherer oder Aussteller', amount: 'Betrag', pickFile: 'PDF oder Foto auswählen', takePhoto: 'Dokument fotografieren',
  fileChosen: 'Datei: {name}', send: 'An die Zentrale senden', sent: 'Gesendet. Die Zentrale prüft es.', noRequirements: 'Die Zentrale hat noch keine Anforderungen festgelegt.', error: 'Etwas ist schiefgelaufen', retry: 'Erneut versuchen',
  needsConnection: 'Zum Hochladen brauchen Sie eine Verbindung.', noAccess: 'Audits gehören nicht zu Ihrem Zugriff.',
};
const ptBR: typeof en = {
  entry: 'Auditorias e conformidade', entrySub: 'Faça auditorias, resolva ações corretivas, envie certificados',
  title: 'Auditorias', kicker: 'Visitas de campo', myAudits: 'Atribuídas a mim', noMine: 'Nenhuma auditoria atribuída a você.', recent: 'Relatórios', noRecent: 'Ainda não há relatórios de auditoria.',
  actions: 'Ações corretivas', noActions: 'Nada para corrigir agora.', due: 'Prazo {date}', overdue: 'Atrasada', critical: 'Crítico', photoRequired: 'Foto obrigatória',
  scheduled: 'Agendada', in_progress: 'Em andamento', completed: 'Concluída', cancelled: 'Cancelada', open: 'A corrigir', submitted: 'Aguardando verificação', verified: 'Verificada',
  start: 'Iniciar auditoria', resume: 'Continuar auditoria', report: 'Ver relatório', back: 'Voltar',
  yes: 'Sim', no: 'Não', na: 'N/A', addPhoto: 'Tirar foto', choosePhoto: 'Escolher foto', note: 'Observação', notePlaceholder: 'O que você viu?', addNote: 'Adicionar observação',
  progress: '{done} de {total} respondidas', score: 'Nota {pct}', passMark: 'Nota mínima {pct}%', failedCritical: 'Um item crítico foi reprovado: a auditoria é reprovada qualquer que seja a nota.',
  savedHere: 'Salvo neste celular', syncing: 'Sincronizando…', synced: 'Tudo sincronizado', offline: 'Sem conexão: tudo fica neste celular e sincroniza quando você voltar a ficar online',
  pendingSync: '{n} alteração(ões) aguardando sincronização', syncError: 'Ainda não foi possível sincronizar. Vamos tentar de novo.', photoPending: 'Será enviada quando houver conexão',
  summary: 'Resumo para a unidade', complete: 'Concluir auditoria', completeQueued: 'Será concluída assim que houver conexão', answerAll: 'Responda a todas as perguntas (ou N/A) para concluir.',
  passed: 'Aprovada', failed: 'Reprovada', completedOn: 'Concluída em {date}', reaudit: 'Reauditoria prevista para {date}', noActionsReport: 'Nenhuma ação corretiva: todos os itens foram aprovados.',
  whatFixed: 'O que você corrigiu?', markDone: 'Marcar como corrigida', evidenceNeeded: 'Adicione primeiro uma foto da correção.', addEvidence: 'Adicionar foto de evidência',
  verify: 'Verificar', reopen: 'Reabrir', reviewNote: 'Observação para a unidade', reopened: 'Reaberta: {note}', done: 'Salvo',
  compliance: 'Documentos de conformidade', complianceSub: 'Seus certificados, licenças e alvarás', valid: 'Válido', expiring: 'Vence em breve', expired: 'Vencido', missing: 'Faltando',
  pending: 'Aguardando revisão', below_minimum: 'Abaixo do mínimo', not_applicable: 'Não exigido', expires: 'Vence em {date}', upload: 'Enviar', uploadTitle: 'Enviar {name}',
  docTitle: 'Título', expiresOn: 'Data de vencimento (AAAA-MM-DD)', issuer: 'Seguradora ou emissor', amount: 'Valor', pickFile: 'Escolher PDF ou foto', takePhoto: 'Fotografar o documento',
  fileChosen: 'Arquivo: {name}', send: 'Enviar para a franqueadora', sent: 'Enviado. A franqueadora vai revisar.', noRequirements: 'A franqueadora ainda não definiu exigências.', error: 'Algo deu errado', retry: 'Tentar de novo',
  needsConnection: 'Para enviar é preciso ter conexão.', noAccess: 'Auditorias não fazem parte do seu acesso.',
};
export const STRINGS: Record<string, typeof en> = { en, fr, es, de, 'pt-BR': ptBR };

export function useQT() {
  const { locale, intlLocale } = useI18n();
  const table = STRINGS[locale] ?? en;
  return {
    locale: intlLocale,
    t: (k: QKey, vars: Record<string, string | number> = {}) => (table[k] ?? en[k]).replace(/\{(\w+)\}/g, (_, v: string) => String(vars[v] ?? '')),
  };
}
