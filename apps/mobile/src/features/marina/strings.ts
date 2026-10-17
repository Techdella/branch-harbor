import { ASSISTANT_NAME } from '@bh/shared';
import { useI18n } from '@/i18n';

/** The AI assistant on mobile — complete in every app locale. The name always comes from ASSISTANT_NAME ({name}). */
const en = {
  tab: '{name}', entry: 'Ask {name}', entrySub: 'Your briefing, questions about your locations and actions to confirm',
  title: '{name}', kicker: 'Your AI assistant', briefing: 'Today’s briefing', nothing: 'Enjoy the quiet, or ask me to look into something.', refresh: 'Refresh',
  askLabel: 'Ask {name}', askPlaceholder: 'Ask {name} anything you can see…', send: 'Send', thinking: '{name} is on it…',
  intro: 'I can answer questions about anything you can see, and prepare work for you to check. Nothing changes until you confirm it.', suggestion1: 'Which locations missed royalties last month?', suggestion2: 'Any overdue corrective actions?', suggestion3: 'Show me this week’s bad reviews',
  waiting: 'Waiting for you', prepared: 'Prepared for you · not done yet', confirm: 'Confirm', cancel: 'Cancel', done: 'Done.', cancelled: 'Cancelled. Nothing was changed.', pendingApproval: 'Waiting for an HQ approver.', failed: 'That didn’t go through: {reason}',
  untrusted: 'This followed text written by other people. Make sure you want it.', sources: 'Sources', notLegal: 'General information, not legal advice.', rows: '{n} rows', more: 'Open in the web app for the full table',
  noAccess: '{name} isn’t part of your access', error: 'That didn’t go through', retry: 'Retry', voiceHint: 'Tip: use your keyboard’s dictation to speak to {name}.',
  hello: 'Hello, {first}. I’m {name}.', helloAnon: 'Hello, I’m {name}.', nothingTitle: 'Nothing needs you today.', celebrate: 'Done. That’s one less thing on your list.', noAccessBody: 'Your role doesn’t include me in this business. If you need me, ask your head office to add {name} to your access.', sleepOffTitle: '{name} is switched off', sleepOffBody: 'Your organisation has switched me off for now. An AI admin at head office can switch me back on in Settings on the web. Everything else keeps working.', sleepPausedTitle: '{name} is resting', sleepPausedBody: 'Your organisation has used this month’s AI allowance, so I’m taking a break until it resets at the start of next month. Everything else keeps working.',
};
export type MKey = keyof typeof en;
const fr: typeof en = {
  tab: '{name}', entry: 'Demander à {name}', entrySub: 'Votre point du jour, vos questions sur vos sites et les actions à confirmer',
  title: '{name}', kicker: 'Votre assistante IA', briefing: 'Le point du jour', nothing: 'Profitez du calme, ou demandez-moi de regarder quelque chose.', refresh: 'Actualiser',
  askLabel: 'Demander à {name}', askPlaceholder: 'Demandez à {name} tout ce que vous voyez…', send: 'Envoyer', thinking: '{name} s’en occupe…',
  intro: 'Je réponds à vos questions sur tout ce que vous voyez et je prépare le travail pour que vous le vérifiiez. Rien ne change sans votre confirmation.', suggestion1: 'Quels sites n’ont pas payé leurs redevances le mois dernier ?', suggestion2: 'Y a-t-il des actions correctives en retard ?', suggestion3: 'Montre-moi les mauvais avis de la semaine',
  waiting: 'En attente de votre part', prepared: 'Préparé pour vous · pas encore fait', confirm: 'Confirmer', cancel: 'Annuler', done: 'Fait.', cancelled: 'Annulé. Rien n’a été modifié.', pendingApproval: 'En attente d’un approbateur du siège.', failed: 'Cela n’a pas abouti : {reason}',
  untrusted: 'Ceci fait suite à un texte écrit par d’autres. Assurez-vous de le vouloir.', sources: 'Sources', notLegal: 'Informations générales, pas un conseil juridique.', rows: '{n} lignes', more: 'Ouvrez l’application web pour le tableau complet',
  noAccess: '{name} ne fait pas partie de vos accès', error: 'Cela n’a pas abouti', retry: 'Réessayer', voiceHint: 'Astuce : utilisez la dictée du clavier pour parler à {name}.',
  hello: 'Bonjour {first}, je suis {name}.', helloAnon: 'Bonjour, je suis {name}.', nothingTitle: 'Rien ne vous attend aujourd’hui.', celebrate: 'C’est fait. Une chose de moins sur votre liste.', noAccessBody: 'Votre rôle ne m’inclut pas dans cette entreprise. Si vous avez besoin de moi, demandez à votre siège d’ajouter {name} à vos accès.', sleepOffTitle: '{name} est désactivée', sleepOffBody: 'Votre organisation m’a désactivée pour le moment. Un administrateur IA du siège peut me réactiver dans les paramètres sur le web. Tout le reste continue de fonctionner.', sleepPausedTitle: '{name} se repose', sleepPausedBody: 'Votre organisation a utilisé l’allocation IA de ce mois, alors je fais une pause jusqu’à son renouvellement au début du mois prochain. Tout le reste continue de fonctionner.',
};
const es: typeof en = {
  tab: '{name}', entry: 'Preguntar a {name}', entrySub: 'Tu resumen, preguntas sobre tus ubicaciones y acciones por confirmar',
  title: '{name}', kicker: 'Tu asistente de IA', briefing: 'Resumen de hoy', nothing: 'Disfruta de la calma, o pídeme que revise algo.', refresh: 'Actualizar',
  askLabel: 'Preguntar a {name}', askPlaceholder: 'Pregunta a {name} lo que quieras de lo que ves…', send: 'Enviar', thinking: '{name} se pone con ello…',
  intro: 'Respondo preguntas sobre todo lo que puedes ver y preparo el trabajo para que lo revises. Nada cambia hasta que lo confirmas.', suggestion1: '¿Qué ubicaciones no pagaron regalías el mes pasado?', suggestion2: '¿Hay acciones correctivas vencidas?', suggestion3: 'Muéstrame las malas reseñas de esta semana',
  waiting: 'Pendiente de ti', prepared: 'Preparado para ti · aún no hecho', confirm: 'Confirmar', cancel: 'Cancelar', done: 'Hecho.', cancelled: 'Cancelado. No se cambió nada.', pendingApproval: 'Esperando a un aprobador de la central.', failed: 'No salió bien: {reason}',
  untrusted: 'Esto siguió a un texto escrito por otras personas. Asegúrate de que lo quieres.', sources: 'Fuentes', notLegal: 'Información general, no asesoramiento legal.', rows: '{n} filas', more: 'Abre la aplicación web para ver la tabla completa',
  noAccess: '{name} no forma parte de tu acceso', error: 'No salió bien', retry: 'Reintentar', voiceHint: 'Consejo: usa el dictado del teclado para hablar con {name}.',
  hello: 'Hola, {first}. Soy {name}.', helloAnon: 'Hola, soy {name}.', nothingTitle: 'Hoy no hay nada que te necesite.', celebrate: 'Hecho. Una cosa menos en tu lista.', noAccessBody: 'Tu rol no me incluye en este negocio. Si me necesitas, pide a tu central que añada a {name} a tu acceso.', sleepOffTitle: '{name} está desactivada', sleepOffBody: 'Tu organización me ha desactivado por ahora. Un administrador de IA de la central puede volver a activarme en Configuración en la web. Todo lo demás sigue funcionando.', sleepPausedTitle: '{name} está descansando', sleepPausedBody: 'Tu organización ha usado la asignación de IA de este mes, así que descanso hasta que se renueve a principios del mes que viene. Todo lo demás sigue funcionando.',
};
const de: typeof en = {
  tab: '{name}', entry: '{name} fragen', entrySub: 'Ihr Briefing, Fragen zu Ihren Standorten und Aktionen zum Bestätigen',
  title: '{name}', kicker: 'Ihre KI-Assistentin', briefing: 'Briefing für heute', nothing: 'Genießen Sie die Ruhe, oder bitten Sie mich, etwas zu prüfen.', refresh: 'Aktualisieren',
  askLabel: '{name} fragen', askPlaceholder: 'Fragen Sie {name} zu allem, was Sie sehen…', send: 'Senden', thinking: '{name} kümmert sich darum…',
  intro: 'Ich beantworte Fragen zu allem, was Sie sehen, und bereite Arbeit zur Prüfung vor. Nichts ändert sich, bevor Sie bestätigen.', suggestion1: 'Welche Standorte haben letzten Monat keine Lizenzgebühren gezahlt?', suggestion2: 'Gibt es überfällige Korrekturmaßnahmen?', suggestion3: 'Zeig mir die schlechten Bewertungen dieser Woche',
  waiting: 'Wartet auf Sie', prepared: 'Für Sie vorbereitet · noch nicht ausgeführt', confirm: 'Bestätigen', cancel: 'Abbrechen', done: 'Erledigt.', cancelled: 'Abgebrochen. Nichts wurde geändert.', pendingApproval: 'Wartet auf eine Freigabe durch die Zentrale.', failed: 'Das hat nicht geklappt: {reason}',
  untrusted: 'Das folgte auf Text, den andere geschrieben haben. Prüfen Sie, ob Sie es wollen.', sources: 'Quellen', notLegal: 'Allgemeine Informationen, keine Rechtsberatung.', rows: '{n} Zeilen', more: 'Für die ganze Tabelle die Web-App öffnen',
  noAccess: '{name} gehört nicht zu Ihrem Zugriff', error: 'Das hat nicht geklappt', retry: 'Erneut versuchen', voiceHint: 'Tipp: Nutzen Sie die Diktierfunktion der Tastatur, um mit {name} zu sprechen.',
  hello: 'Hallo {first}, ich bin {name}.', helloAnon: 'Hallo, ich bin {name}.', nothingTitle: 'Heute braucht Sie nichts.', celebrate: 'Erledigt. Eine Sache weniger auf Ihrer Liste.', noAccessBody: 'Ihre Rolle umfasst mich in diesem Unternehmen nicht. Wenn Sie mich brauchen, bitten Sie Ihre Zentrale, {name} zu Ihrem Zugriff hinzuzufügen.', sleepOffTitle: '{name} ist ausgeschaltet', sleepOffBody: 'Ihre Organisation hat mich vorerst ausgeschaltet. Eine KI-Administration in der Zentrale kann mich in den Einstellungen im Web wieder einschalten. Alles andere funktioniert weiter.', sleepPausedTitle: '{name} ruht gerade', sleepPausedBody: 'Ihre Organisation hat das KI-Kontingent für diesen Monat aufgebraucht, deshalb pausiere ich, bis es sich Anfang nächsten Monats erneuert. Alles andere funktioniert weiter.',
};
const ptBR: typeof en = {
  tab: '{name}', entry: 'Perguntar à {name}', entrySub: 'Seu resumo, perguntas sobre suas unidades e ações para confirmar',
  title: '{name}', kicker: 'Sua assistente de IA', briefing: 'Resumo de hoje', nothing: 'Aproveite a calma, ou me peça para verificar algo.', refresh: 'Atualizar',
  askLabel: 'Perguntar à {name}', askPlaceholder: 'Pergunte à {name} sobre o que você vê…', send: 'Enviar', thinking: 'A {name} está cuidando disso…',
  intro: 'Respondo perguntas sobre tudo o que você vê e preparo o trabalho para você conferir. Nada muda até você confirmar.', suggestion1: 'Quais unidades não pagaram royalties no mês passado?', suggestion2: 'Há ações corretivas atrasadas?', suggestion3: 'Mostre as avaliações ruins desta semana',
  waiting: 'Aguardando você', prepared: 'Preparado para você · ainda não feito', confirm: 'Confirmar', cancel: 'Cancelar', done: 'Feito.', cancelled: 'Cancelado. Nada foi alterado.', pendingApproval: 'Aguardando um aprovador da sede.', failed: 'Isso não deu certo: {reason}',
  untrusted: 'Isto veio depois de um texto escrito por outras pessoas. Confirme que você quer isso.', sources: 'Fontes', notLegal: 'Informação geral, não é aconselhamento jurídico.', rows: '{n} linhas', more: 'Abra o aplicativo web para ver a tabela completa',
  noAccess: 'A {name} não faz parte do seu acesso', error: 'Isso não deu certo', retry: 'Tentar de novo', voiceHint: 'Dica: use o ditado do teclado para falar com a {name}.',
  hello: 'Olá, {first}. Eu sou a {name}.', helloAnon: 'Olá, eu sou a {name}.', nothingTitle: 'Nada precisa de você hoje.', celebrate: 'Feito. Uma coisa a menos na sua lista.', noAccessBody: 'O seu papel não me inclui neste negócio. Se precisar de mim, peça à sua sede para adicionar a {name} ao seu acesso.', sleepOffTitle: 'A {name} está desativada', sleepOffBody: 'Sua organização me desativou por enquanto. Um administrador de IA da sede pode me reativar nas Configurações na web. Todo o resto continua funcionando.', sleepPausedTitle: 'A {name} está descansando', sleepPausedBody: 'Sua organização usou a cota de IA deste mês, então estou fazendo uma pausa até ela ser renovada no início do mês que vem. Todo o resto continua funcionando.',
};

export const STRINGS: Record<string, typeof en> = { en, fr, es, de, 'pt-BR': ptBR };

export function useMT() {
  const { locale } = useI18n();
  const table = STRINGS[locale] ?? en;
  const t = (key: MKey, vars: Record<string, string | number> = {}) =>
    (table[key] ?? en[key]).replace(/\{(\w+)\}/g, (_m, k: string) => String(k === 'name' ? ASSISTANT_NAME : vars[k] ?? `{${k}}`));
  return { t, locale };
}
