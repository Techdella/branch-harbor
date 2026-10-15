import { ASSISTANT_NAME } from '@bh/shared';
import { useI18n } from '@/i18n';

/** The AI assistant on mobile — complete in every app locale. The name always comes from ASSISTANT_NAME ({name}). */
const en = {
  tab: '{name}', entry: 'Ask {name}', entrySub: 'Your briefing, questions about your locations and actions to confirm',
  title: '{name}', kicker: 'Your AI assistant', briefing: 'Today’s briefing', nothing: 'Nothing needs your attention right now.', refresh: 'Refresh',
  askLabel: 'Ask {name}', askPlaceholder: 'Ask {name} anything you can see…', send: 'Send', thinking: '{name} is checking…',
  intro: '{name} only sees what you can see, and changes nothing until you confirm.', suggestion1: 'Which locations missed royalties last month?', suggestion2: 'Any overdue corrective actions?', suggestion3: 'Show me this week’s bad reviews',
  waiting: 'Waiting for you', prepared: 'Prepared for you · not done yet', confirm: 'Confirm', cancel: 'Cancel', done: 'Done.', cancelled: 'Cancelled. Nothing was changed.', pendingApproval: 'Waiting for an HQ approver.', failed: 'It didn’t work: {reason}',
  untrusted: 'This followed text written by other people. Make sure you want it.', sources: 'Sources', notLegal: 'General information, not legal advice.', rows: '{n} rows', more: 'Open in the web app for the full table',
  noAccess: '{name} is not part of your access.', error: 'Something went wrong', retry: 'Retry', voiceHint: 'Tip: use your keyboard’s dictation to speak to {name}.',
};
export type MKey = keyof typeof en;
const fr: typeof en = {
  tab: '{name}', entry: 'Demander à {name}', entrySub: 'Votre point du jour, vos questions sur vos sites et les actions à confirmer',
  title: '{name}', kicker: 'Votre assistante IA', briefing: 'Le point du jour', nothing: 'Rien ne demande votre attention pour l’instant.', refresh: 'Actualiser',
  askLabel: 'Demander à {name}', askPlaceholder: 'Demandez à {name} tout ce que vous voyez…', send: 'Envoyer', thinking: '{name} vérifie…',
  intro: '{name} ne voit que ce que vous voyez et ne change rien sans votre confirmation.', suggestion1: 'Quels sites n’ont pas payé leurs redevances le mois dernier ?', suggestion2: 'Y a-t-il des actions correctives en retard ?', suggestion3: 'Montre-moi les mauvais avis de la semaine',
  waiting: 'En attente de votre part', prepared: 'Préparé pour vous · pas encore fait', confirm: 'Confirmer', cancel: 'Annuler', done: 'Fait.', cancelled: 'Annulé. Rien n’a été modifié.', pendingApproval: 'En attente d’un approbateur du siège.', failed: 'Échec : {reason}',
  untrusted: 'Ceci fait suite à un texte écrit par d’autres. Assurez-vous de le vouloir.', sources: 'Sources', notLegal: 'Informations générales, pas un conseil juridique.', rows: '{n} lignes', more: 'Ouvrez l’application web pour le tableau complet',
  noAccess: '{name} ne fait pas partie de vos accès.', error: 'Un problème est survenu', retry: 'Réessayer', voiceHint: 'Astuce : utilisez la dictée du clavier pour parler à {name}.',
};
const es: typeof en = {
  tab: '{name}', entry: 'Preguntar a {name}', entrySub: 'Tu resumen, preguntas sobre tus ubicaciones y acciones por confirmar',
  title: '{name}', kicker: 'Tu asistente de IA', briefing: 'Resumen de hoy', nothing: 'Ahora mismo nada requiere tu atención.', refresh: 'Actualizar',
  askLabel: 'Preguntar a {name}', askPlaceholder: 'Pregunta a {name} lo que quieras de lo que ves…', send: 'Enviar', thinking: '{name} está comprobando…',
  intro: '{name} solo ve lo que tú ves y no cambia nada hasta que lo confirmes.', suggestion1: '¿Qué ubicaciones no pagaron regalías el mes pasado?', suggestion2: '¿Hay acciones correctivas vencidas?', suggestion3: 'Muéstrame las malas reseñas de esta semana',
  waiting: 'Pendiente de ti', prepared: 'Preparado para ti · aún no hecho', confirm: 'Confirmar', cancel: 'Cancelar', done: 'Hecho.', cancelled: 'Cancelado. No se cambió nada.', pendingApproval: 'Esperando a un aprobador de la central.', failed: 'No funcionó: {reason}',
  untrusted: 'Esto siguió a un texto escrito por otras personas. Asegúrate de que lo quieres.', sources: 'Fuentes', notLegal: 'Información general, no asesoramiento legal.', rows: '{n} filas', more: 'Abre la aplicación web para ver la tabla completa',
  noAccess: '{name} no forma parte de tu acceso.', error: 'Algo salió mal', retry: 'Reintentar', voiceHint: 'Consejo: usa el dictado del teclado para hablar con {name}.',
};
const de: typeof en = {
  tab: '{name}', entry: '{name} fragen', entrySub: 'Ihr Briefing, Fragen zu Ihren Standorten und Aktionen zum Bestätigen',
  title: '{name}', kicker: 'Ihre KI-Assistentin', briefing: 'Briefing für heute', nothing: 'Gerade braucht nichts Ihre Aufmerksamkeit.', refresh: 'Aktualisieren',
  askLabel: '{name} fragen', askPlaceholder: 'Fragen Sie {name} zu allem, was Sie sehen…', send: 'Senden', thinking: '{name} prüft…',
  intro: '{name} sieht nur, was Sie sehen, und ändert nichts ohne Ihre Bestätigung.', suggestion1: 'Welche Standorte haben letzten Monat keine Lizenzgebühren gezahlt?', suggestion2: 'Gibt es überfällige Korrekturmaßnahmen?', suggestion3: 'Zeig mir die schlechten Bewertungen dieser Woche',
  waiting: 'Wartet auf Sie', prepared: 'Für Sie vorbereitet · noch nicht ausgeführt', confirm: 'Bestätigen', cancel: 'Abbrechen', done: 'Erledigt.', cancelled: 'Abgebrochen. Nichts wurde geändert.', pendingApproval: 'Wartet auf eine Freigabe durch die Zentrale.', failed: 'Das hat nicht geklappt: {reason}',
  untrusted: 'Das folgte auf Text, den andere geschrieben haben. Prüfen Sie, ob Sie es wollen.', sources: 'Quellen', notLegal: 'Allgemeine Informationen, keine Rechtsberatung.', rows: '{n} Zeilen', more: 'Für die ganze Tabelle die Web-App öffnen',
  noAccess: '{name} gehört nicht zu Ihrem Zugriff.', error: 'Etwas ist schiefgelaufen', retry: 'Erneut versuchen', voiceHint: 'Tipp: Nutzen Sie die Diktierfunktion der Tastatur, um mit {name} zu sprechen.',
};
const ptBR: typeof en = {
  tab: '{name}', entry: 'Perguntar à {name}', entrySub: 'Seu resumo, perguntas sobre suas unidades e ações para confirmar',
  title: '{name}', kicker: 'Sua assistente de IA', briefing: 'Resumo de hoje', nothing: 'Nada precisa da sua atenção agora.', refresh: 'Atualizar',
  askLabel: 'Perguntar à {name}', askPlaceholder: 'Pergunte à {name} sobre o que você vê…', send: 'Enviar', thinking: '{name} está verificando…',
  intro: 'A {name} só vê o que você vê e não muda nada sem a sua confirmação.', suggestion1: 'Quais unidades não pagaram royalties no mês passado?', suggestion2: 'Há ações corretivas atrasadas?', suggestion3: 'Mostre as avaliações ruins desta semana',
  waiting: 'Aguardando você', prepared: 'Preparado para você · ainda não feito', confirm: 'Confirmar', cancel: 'Cancelar', done: 'Feito.', cancelled: 'Cancelado. Nada foi alterado.', pendingApproval: 'Aguardando um aprovador da sede.', failed: 'Não funcionou: {reason}',
  untrusted: 'Isto veio depois de um texto escrito por outras pessoas. Confirme que você quer isso.', sources: 'Fontes', notLegal: 'Informação geral, não é aconselhamento jurídico.', rows: '{n} linhas', more: 'Abra o aplicativo web para ver a tabela completa',
  noAccess: 'A {name} não faz parte do seu acesso.', error: 'Algo deu errado', retry: 'Tentar de novo', voiceHint: 'Dica: use o ditado do teclado para falar com a {name}.',
};

export const STRINGS: Record<string, typeof en> = { en, fr, es, de, 'pt-BR': ptBR };

export function useMT() {
  const { locale } = useI18n();
  const table = STRINGS[locale] ?? en;
  const t = (key: MKey, vars: Record<string, string | number> = {}) =>
    (table[key] ?? en[key]).replace(/\{(\w+)\}/g, (_m, k: string) => String(k === 'name' ? ASSISTANT_NAME : vars[k] ?? `{${k}}`));
  return { t, locale };
}
