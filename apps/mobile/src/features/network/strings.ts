import { useI18n } from '@/i18n';

/** Network workspace strings (Community, Training, Help desk) — complete in every app locale. */
const en = {
  entry: 'Community & training', entrySub: 'HQ news, required reads, courses and help',
  title: 'Network', feed: 'From HQ', required: 'Required read', confirmed: 'Confirmed', overdue: 'Overdue', due: 'Confirm by {date}',
  acknowledge: 'I have read and understood', noNews: 'No announcements for you yet.', pendingReads: '{n} required read(s) to confirm',
  training: 'My training', noTraining: 'Nothing assigned to you right now.', progress: '{n}% complete', start: 'Start', continueCourse: 'Continue',
  lesson: 'Lesson', complete: 'Mark complete', next: 'Next lesson', back: 'Back', passMark: 'Pass mark {n}%', submit: 'Submit answers',
  passed: 'Passed with {n}%', failed: 'You scored {n}%. You need {mark}% to pass.', correct: 'Correct', incorrect: 'Not quite', courseDone: 'Course complete — well done!',
  watch: 'Watch the video', open: 'Open file', prerequisites: 'Complete these first: {list}', chooseAll: 'Choose all that apply.',
  help: 'Help desk', raise: 'Ask HQ for help', subject: 'Subject', details: 'What’s happening?', priority: 'Priority', send: 'Send to HQ', sent: 'Sent. HQ will reply here and by notification.',
  myTickets: 'My tickets', noTickets: 'No tickets yet.', low: 'Low', normal: 'Normal', high: 'High', urgent: 'Urgent',
  open_: 'Open', pending: 'Waiting on you', on_hold: 'On hold', resolved: 'Resolved', closed: 'Closed', category: 'Category', anyCategory: 'Something else',
  contact: 'Your HQ contact', bookCall: 'Book a call', error: 'Something went wrong', retry: 'Retry', noNetwork: 'You’re not part of a network team yet.',
};
export type NKey = keyof typeof en;
const fr: typeof en = {
  entry: 'Communauté et formation', entrySub: 'Nouvelles du siège, lectures obligatoires, cours et aide',
  title: 'Réseau', feed: 'Du siège', required: 'Lecture obligatoire', confirmed: 'Confirmée', overdue: 'En retard', due: 'À confirmer avant le {date}',
  acknowledge: 'J’ai lu et compris', noNews: 'Aucune annonce pour vous pour l’instant.', pendingReads: '{n} lecture(s) obligatoire(s) à confirmer',
  training: 'Mes formations', noTraining: 'Rien ne vous est attribué pour l’instant.', progress: '{n} % terminé', start: 'Commencer', continueCourse: 'Continuer',
  lesson: 'Leçon', complete: 'Marquer comme terminée', next: 'Leçon suivante', back: 'Retour', passMark: 'Note de réussite {n} %', submit: 'Valider les réponses',
  passed: 'Réussi avec {n} %', failed: 'Vous avez obtenu {n} %. Il faut {mark} % pour réussir.', correct: 'Correct', incorrect: 'Pas tout à fait', courseDone: 'Cours terminé — bravo !',
  watch: 'Regarder la vidéo', open: 'Ouvrir le fichier', prerequisites: 'Terminez d’abord : {list}', chooseAll: 'Choisissez toutes les bonnes réponses.',
  help: 'Assistance', raise: 'Demander de l’aide au siège', subject: 'Objet', details: 'Que se passe-t-il ?', priority: 'Priorité', send: 'Envoyer au siège', sent: 'Envoyé. Le siège répondra ici et par notification.',
  myTickets: 'Mes tickets', noTickets: 'Aucun ticket pour l’instant.', low: 'Basse', normal: 'Normale', high: 'Haute', urgent: 'Urgente',
  open_: 'Ouvert', pending: 'En attente de votre retour', on_hold: 'En suspens', resolved: 'Résolu', closed: 'Fermé', category: 'Catégorie', anyCategory: 'Autre chose',
  contact: 'Votre contact au siège', bookCall: 'Réserver un appel', error: 'Un problème est survenu', retry: 'Réessayer', noNetwork: 'Vous ne faites pas encore partie d’une équipe du réseau.',
};
const es: typeof en = {
  entry: 'Comunidad y formación', entrySub: 'Noticias de la central, lecturas obligatorias, cursos y ayuda',
  title: 'Red', feed: 'De la central', required: 'Lectura obligatoria', confirmed: 'Confirmado', overdue: 'Atrasado', due: 'Confirmar antes del {date}',
  acknowledge: 'Lo he leído y entendido', noNews: 'Todavía no hay anuncios para ti.', pendingReads: '{n} lectura(s) obligatoria(s) por confirmar',
  training: 'Mi formación', noTraining: 'Ahora mismo no tienes nada asignado.', progress: '{n} % completado', start: 'Empezar', continueCourse: 'Continuar',
  lesson: 'Lección', complete: 'Marcar como hecha', next: 'Siguiente lección', back: 'Volver', passMark: 'Nota para aprobar {n} %', submit: 'Enviar respuestas',
  passed: 'Aprobado con {n} %', failed: 'Has sacado {n} %. Necesitas {mark} % para aprobar.', correct: 'Correcto', incorrect: 'No exactamente', courseDone: '¡Curso completado, enhorabuena!',
  watch: 'Ver el vídeo', open: 'Abrir archivo', prerequisites: 'Completa antes: {list}', chooseAll: 'Elige todas las correctas.',
  help: 'Soporte', raise: 'Pedir ayuda a la central', subject: 'Asunto', details: '¿Qué ocurre?', priority: 'Prioridad', send: 'Enviar a la central', sent: 'Enviado. La central responderá aquí y con una notificación.',
  myTickets: 'Mis tickets', noTickets: 'Todavía no hay tickets.', low: 'Baja', normal: 'Normal', high: 'Alta', urgent: 'Urgente',
  open_: 'Abierto', pending: 'Esperando tu respuesta', on_hold: 'En espera', resolved: 'Resuelto', closed: 'Cerrado', category: 'Categoría', anyCategory: 'Otra cosa',
  contact: 'Tu contacto en la central', bookCall: 'Reservar una llamada', error: 'Algo salió mal', retry: 'Reintentar', noNetwork: 'Todavía no formas parte de un equipo de la red.',
};
const de: typeof en = {
  entry: 'Community & Schulungen', entrySub: 'News der Zentrale, Pflichtlektüre, Kurse und Hilfe',
  title: 'Netzwerk', feed: 'Von der Zentrale', required: 'Pflichtlektüre', confirmed: 'Bestätigt', overdue: 'Überfällig', due: 'Bestätigen bis {date}',
  acknowledge: 'Ich habe dies gelesen und verstanden', noNews: 'Noch keine Mitteilungen für Sie.', pendingReads: '{n} Pflichtlektüre(n) zu bestätigen',
  training: 'Meine Schulungen', noTraining: 'Ihnen ist gerade nichts zugewiesen.', progress: '{n} % erledigt', start: 'Starten', continueCourse: 'Weiter',
  lesson: 'Lektion', complete: 'Als erledigt markieren', next: 'Nächste Lektion', back: 'Zurück', passMark: 'Bestehensgrenze {n} %', submit: 'Antworten abschicken',
  passed: 'Bestanden mit {n} %', failed: 'Sie haben {n} % erreicht. Zum Bestehen brauchen Sie {mark} %.', correct: 'Richtig', incorrect: 'Nicht ganz', courseDone: 'Kurs abgeschlossen – gut gemacht!',
  watch: 'Video ansehen', open: 'Datei öffnen', prerequisites: 'Zuerst abschließen: {list}', chooseAll: 'Alle zutreffenden auswählen.',
  help: 'Helpdesk', raise: 'Die Zentrale um Hilfe bitten', subject: 'Betreff', details: 'Was ist passiert?', priority: 'Priorität', send: 'An die Zentrale senden', sent: 'Gesendet. Die Zentrale antwortet hier und per Benachrichtigung.',
  myTickets: 'Meine Tickets', noTickets: 'Noch keine Tickets.', low: 'Niedrig', normal: 'Normal', high: 'Hoch', urgent: 'Dringend',
  open_: 'Offen', pending: 'Wartet auf Sie', on_hold: 'Zurückgestellt', resolved: 'Gelöst', closed: 'Geschlossen', category: 'Kategorie', anyCategory: 'Etwas anderes',
  contact: 'Ihr Kontakt in der Zentrale', bookCall: 'Gespräch buchen', error: 'Etwas ist schiefgelaufen', retry: 'Erneut versuchen', noNetwork: 'Sie gehören noch zu keinem Netzwerk-Team.',
};
const ptBR: typeof en = {
  entry: 'Comunidade e treinamento', entrySub: 'Notícias da matriz, leituras obrigatórias, cursos e ajuda',
  title: 'Rede', feed: 'Da matriz', required: 'Leitura obrigatória', confirmed: 'Confirmado', overdue: 'Atrasado', due: 'Confirmar até {date}',
  acknowledge: 'Li e entendi', noNews: 'Ainda não há comunicados para você.', pendingReads: '{n} leitura(s) obrigatória(s) para confirmar',
  training: 'Meus treinamentos', noTraining: 'Nada atribuído a você no momento.', progress: '{n}% concluído', start: 'Começar', continueCourse: 'Continuar',
  lesson: 'Lição', complete: 'Marcar como concluída', next: 'Próxima lição', back: 'Voltar', passMark: 'Nota mínima {n}%', submit: 'Enviar respostas',
  passed: 'Aprovado com {n}%', failed: 'Você fez {n}%. É preciso {mark}% para passar.', correct: 'Correto', incorrect: 'Não exatamente', courseDone: 'Curso concluído — parabéns!',
  watch: 'Assistir ao vídeo', open: 'Abrir arquivo', prerequisites: 'Conclua antes: {list}', chooseAll: 'Escolha todas as corretas.',
  help: 'Central de ajuda', raise: 'Pedir ajuda à matriz', subject: 'Assunto', details: 'O que está acontecendo?', priority: 'Prioridade', send: 'Enviar para a matriz', sent: 'Enviado. A matriz responderá aqui e por notificação.',
  myTickets: 'Meus chamados', noTickets: 'Ainda não há chamados.', low: 'Baixa', normal: 'Normal', high: 'Alta', urgent: 'Urgente',
  open_: 'Aberto', pending: 'Aguardando você', on_hold: 'Em espera', resolved: 'Resolvido', closed: 'Fechado', category: 'Categoria', anyCategory: 'Outro assunto',
  contact: 'Seu contato na matriz', bookCall: 'Agendar uma conversa', error: 'Algo deu errado', retry: 'Tentar de novo', noNetwork: 'Você ainda não faz parte de uma equipe da rede.',
};
export const STRINGS: Record<string, typeof en> = { en, fr, es, de, 'pt-BR': ptBR };

export function useNT() {
  const { locale, intlLocale } = useI18n();
  const table = STRINGS[locale] ?? en;
  return {
    locale: intlLocale,
    t: (k: NKey, vars: Record<string, string | number> = {}) => (table[k] ?? en[k]).replace(/\{(\w+)\}/g, (_, v: string) => String(vars[v] ?? '')),
  };
}
