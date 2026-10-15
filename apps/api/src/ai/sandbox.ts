import { randomUUID } from 'node:crypto';
import type { LlmCall, LlmContentBlock, LlmMessage, LlmResult, MarinaLlm } from './llm.ts';

/**
 * Deterministic sandbox engine (no API key, tests, the demo site).
 *
 * It picks a tool from the question with fixed keyword rules, then answers ONLY from the tool results the engine hands
 * back (their `summary` lines). It never states a business fact of its own. Phrases are localised for the app locales.
 */

type Phrases = Record<'found' | 'none' | 'proposed' | 'denied' | 'error' | 'help' | 'outside' | 'opening' | 'noData' | 'checking', string>;

const PHRASES: Record<string, Phrases> = {
  en: {
    found: 'Here is what I found:',
    none: 'I found nothing matching that.',
    proposed: 'I have prepared this for you to review. Nothing has been changed or sent yet: confirm it on the card when you are ready.',
    denied: 'You don’t have access to that, so I can’t do it for you.',
    error: 'I couldn’t complete that:',
    help: 'I can answer questions about the data you can see (locations, performance, reviews, audits, compliance, royalties, leads, tickets, training) and prepare changes for you to confirm. Try “Which locations missed royalties last month?” or “Revenue by location this quarter vs last”.',
    outside: 'That isn’t something I can look up with your access. Try asking about the areas you work in.',
    opening: 'Opening',
    noData: 'There is no data for that yet.',
    checking: 'Let me check.',
  },
  fr: {
    found: 'Voici ce que j’ai trouvé :',
    none: 'Je n’ai rien trouvé de correspondant.',
    proposed: 'J’ai préparé ceci pour que vous le vérifiiez. Rien n’a encore été modifié ni envoyé : confirmez sur la carte quand vous êtes prêt.',
    denied: 'Vous n’avez pas accès à cela, je ne peux donc pas le faire pour vous.',
    error: 'Je n’ai pas pu terminer :',
    help: 'Je réponds aux questions sur les données que vous pouvez voir (sites, performance, avis, audits, conformité, redevances, prospects, tickets, formation) et je prépare des modifications que vous confirmez. Essayez « Quels sites n’ont pas payé leurs redevances le mois dernier ? ».',
    outside: 'Je ne peux pas consulter cela avec vos accès. Posez une question sur vos domaines de travail.',
    opening: 'Ouverture de',
    noData: 'Il n’y a pas encore de données pour cela.',
    checking: 'Je vérifie.',
  },
  es: {
    found: 'Esto es lo que encontré:',
    none: 'No encontré nada que coincida.',
    proposed: 'Lo he preparado para que lo revises. Aún no se ha cambiado ni enviado nada: confírmalo en la tarjeta cuando quieras.',
    denied: 'No tienes acceso a eso, así que no puedo hacerlo por ti.',
    error: 'No pude completarlo:',
    help: 'Respondo preguntas sobre los datos que puedes ver (ubicaciones, rendimiento, reseñas, auditorías, cumplimiento, regalías, leads, tickets, formación) y preparo cambios para que los confirmes. Prueba «¿Qué ubicaciones no pagaron regalías el mes pasado?».',
    outside: 'No puedo consultar eso con tu acceso. Pregunta sobre las áreas en las que trabajas.',
    opening: 'Abriendo',
    noData: 'Todavía no hay datos para eso.',
    checking: 'Lo compruebo.',
  },
  de: {
    found: 'Das habe ich gefunden:',
    none: 'Dazu habe ich nichts gefunden.',
    proposed: 'Ich habe das zur Prüfung vorbereitet. Es wurde noch nichts geändert oder gesendet: Bestätigen Sie es auf der Karte, wenn Sie bereit sind.',
    denied: 'Darauf haben Sie keinen Zugriff, deshalb kann ich das nicht für Sie erledigen.',
    error: 'Das konnte ich nicht abschließen:',
    help: 'Ich beantworte Fragen zu den Daten, die Sie sehen können (Standorte, Leistung, Bewertungen, Audits, Compliance, Lizenzgebühren, Leads, Tickets, Schulungen), und bereite Änderungen zur Bestätigung vor. Fragen Sie z. B. „Welche Standorte haben letzten Monat keine Lizenzgebühren gezahlt?“.',
    outside: 'Das kann ich mit Ihrem Zugriff nicht abrufen. Fragen Sie zu Ihren Arbeitsbereichen.',
    opening: 'Öffne',
    noData: 'Dazu gibt es noch keine Daten.',
    checking: 'Ich sehe nach.',
  },
  'pt-BR': {
    found: 'Veja o que encontrei:',
    none: 'Não encontrei nada correspondente.',
    proposed: 'Preparei isto para você revisar. Nada foi alterado ou enviado ainda: confirme no cartão quando quiser.',
    denied: 'Você não tem acesso a isso, então não posso fazer por você.',
    error: 'Não consegui concluir:',
    help: 'Respondo perguntas sobre os dados que você pode ver (unidades, desempenho, avaliações, auditorias, conformidade, royalties, leads, chamados, treinamento) e preparo alterações para você confirmar. Experimente “Quais unidades não pagaram royalties no mês passado?”.',
    outside: 'Não consigo consultar isso com o seu acesso. Pergunte sobre as áreas em que você trabalha.',
    opening: 'Abrindo',
    noData: 'Ainda não há dados para isso.',
    checking: 'Vou verificar.',
  },
};

export function sandboxPhrases(locale: string | undefined): Phrases {
  const l = locale ?? 'en';
  return PHRASES[l] ?? PHRASES[l.split('-')[0]!] ?? PHRASES.en!;
}

type Period = 'this_month' | 'last_month' | 'this_quarter' | 'last_quarter' | 'year_to_date' | 'last_30_days';

function periodOf(q: string): Period {
  if (/last quarter|previous quarter|trimestre dernier|dernier trimestre|trimestre pasado|letztes quartal|último trimestre|trimestre passado/.test(q)) return 'last_quarter';
  if (/quarter|trimestre|quartal/.test(q)) return 'this_quarter';
  if (/last month|previous month|mois dernier|mes pasado|letzten monat|letzter monat|mês passado/.test(q)) return 'last_month';
  if (/this month|ce mois|este mes|diesen monat|este mês/.test(q)) return 'this_month';
  if (/year|ytd|année|año|jahr|ano/.test(q)) return 'year_to_date';
  return 'last_30_days';
}

const quoted = (q: string) => q.match(/["“«„']([^"”»“']{2,200})["”»“']/)?.[1] ?? null;

function whenOf(q: string): string {
  const d = new Date();
  const inDays = q.match(/in (\d+) days?/);
  if (inDays) d.setUTCDate(d.getUTCDate() + Number(inDays[1]));
  else if (/next week|semaine prochaine|próxima semana|nächste woche/.test(q)) d.setUTCDate(d.getUTCDate() + 7);
  else d.setUTCDate(d.getUTCDate() + 1);
  d.setUTCHours(9, 0, 0, 0);
  return d.toISOString();
}

interface Rule {
  test: RegExp;
  tool: string;
  input: (q: string, raw: string) => Record<string, unknown>;
}

/** Keyword rules, most specific first. Inputs are only taken from the question itself. */
const RULES: Rule[] = [
  { test: /remind me|reminder|rappelle|recuérdame|erinnere|lembre/, tool: 'remind_me', input: (q, raw) => ({ title: quoted(raw) ?? (raw.replace(/^.*?(remind me( to)?|rappelle-moi( de)?|recuérdame|erinnere mich( an)?|lembre-me( de)?)\s*/i, '').slice(0, 120) || raw.slice(0, 120)), remindAt: whenOf(q) }) },
  { test: /(create|add|new) (a )?(task|to-?do)|crée une tâche|crear tarea|aufgabe/, tool: 'create_task', input: (_q, raw) => ({ title: quoted(raw) ?? raw.slice(0, 120) }) },
  { test: /(draft|write|create|prepare).*(email|newsletter)|(email|newsletter).*(draft|campaign)|rédige.*e-?mail|redacta.*correo/, tool: 'create_email_campaign_draft', input: (_q, raw) => ({ name: quoted(raw) ?? raw.slice(0, 80), subject: quoted(raw) ?? raw.slice(0, 80) }) },
  { test: /(draft|write|create|prepare).*(social|post|instagram|facebook)/, tool: 'create_social_post_draft', input: (_q, raw) => ({ text: quoted(raw) ?? raw.slice(0, 280) }) },
  { test: /(draft|write|create).*announcement|annonce/, tool: 'create_announcement_draft', input: (_q, raw) => ({ title: quoted(raw) ?? raw.slice(0, 80), body: raw }) },
  { test: /visit brief|brief for|before my visit|préparer (ma )?visite|visita/, tool: 'prepare_visit_brief', input: (_q, raw) => ({ location: quoted(raw) ?? raw.replace(/^.*?(brief|visit|visite|visita)( for| de| para| für)?\s*/i, '').replace(/[?.!]+$/, '').trim() }) },
  { test: /statement|relevé|estado de cuenta|abrechnung|extrato/, tool: 'list_royalty_statements', input: () => ({}) },
  { test: /royalt|redevance|regalía|lizenzgebühr|lizenzgebuhr/, tool: 'royalty_status', input: (q) => ({ period: periodOf(q), onlyOverdue: /miss|overdue|late|unpaid|retard|impay|atras|überfällig|nicht bezahlt|não pag|no pag/.test(q) }) },
  { test: /fund|fonds|fondo|werbefonds|fundo/, tool: 'marketing_fund_summary', input: () => ({}) },
  { test: /(revenue|sales|turnover|chiffre d|ingreso|ventas|umsatz|receita|faturamento)/, tool: 'revenue_by_location', input: (q) => ({ period: periodOf(q) }) },
  { test: /league|rank|best|worst|top|classement|clasificación|rangliste|ranking/, tool: 'league_table', input: (q) => ({ period: periodOf(q), sort: /audit/.test(q) ? 'auditScore' : /review|rating|avis/.test(q) ? 'reviewRating' : 'revenue' }) },
  { test: /insight|anomal|unusual|drop|decline|baisse|caída|rückgang|queda/, tool: 'list_insights', input: () => ({}) },
  { test: /corrective|action items?|actions correctives|acciones correctivas|korrekturma|ações corretivas/, tool: 'list_corrective_actions', input: (q) => ({ overdueOnly: /overdue|late|retard|atras|überfällig/.test(q) }) },
  { test: /audit|inspection|visite terrain/, tool: 'audit_overview', input: () => ({}) },
  { test: /insurance|certificate|licen[cs]e|permit|complian|expir|assurance|seguro|versicherung|conformit|cumplimiento/, tool: 'list_compliance_documents', input: (q) => ({ expiringWithinDays: /expir|expire|vence|abl/.test(q) ? 60 : undefined }) },
  { test: /review|rating|avis|reseña|bewertung|avalia/, tool: 'list_reviews', input: (q) => ({ maxRating: /bad|negative|low|poor|mauvais|négatif|mala|negativ|ruim/.test(q) ? 2 : undefined }) },
  { test: /candidate|prospect|franchise pipeline|candidat|candidato|kandidat/, tool: 'list_franchise_prospects', input: () => ({}) },
  { test: /lead|enquir|demande|consulta|anfrage/, tool: 'list_leads', input: () => ({}) },
  { test: /ticket|help ?desk|support request|assistance|chamado|soporte/, tool: 'list_tickets', input: (q) => ({ openOnly: !/all|tous|todos|alle/.test(q) }) },
  { test: /inbox|conversation|messages?|boîte|bandeja|posteingang|caixa/, tool: 'list_inbox_conversations', input: () => ({}) },
  { test: /(course|training|formation|curso|schulung|treinamento).*(complet|progress|progrès|progreso|fortschritt|overdue)|(complet|progress).*(course|training)/, tool: 'training_completion', input: () => ({}) },
  { test: /course|training|formation|curso|schulung|treinamento/, tool: 'list_courses', input: () => ({}) },
  { test: /announcement|annonce|anuncio|ankündigung|comunicado/, tool: 'list_announcements', input: () => ({}) },
  { test: /campaign|campagne|campaña|kampagne|campanha/, tool: 'list_email_campaigns', input: () => ({}) },
  { test: /automation|journey|automatisation|automatización|automatisierung|automação/, tool: 'list_automations', input: () => ({}) },
  { test: /social|instagram|facebook/, tool: 'list_social_posts', input: () => ({}) },
  { test: /website|page|site web|sitio web|webseite/, tool: 'list_website_pages', input: () => ({}) },
  { test: /booking|class|order|reservation|appointment|registration|réservation|cours|commande|reserva|pedido|cita|buchung|bestellung|termin|agendamento/, tool: 'list_bookings', input: () => ({}) },
  { test: /customer|client|contact|kunde|cliente/, tool: 'list_customers', input: (_q, raw) => ({ query: quoted(raw) ?? undefined }) },
  { test: /team|people|staff|member|équipe|equipo|mitarbeiter|equipe/, tool: 'list_people', input: () => ({}) },
  { test: /approval|approbation|aprobación|freigabe|aprovaç/, tool: 'list_approvals', input: () => ({}) },
  { test: /new location|opening|ouverture|apertura|eröffnung|inaugura/, tool: 'list_new_location_projects', input: () => ({}) },
  { test: /my tasks|to-?dos?|mes tâches|mis tareas|meine aufgaben|minhas tarefas/, tool: 'list_my_tasks', input: () => ({}) },
  { test: /location|studio|store|branch|site|unit|ubicaci|standort|unidade|établissement/, tool: 'list_locations', input: () => ({}) },
  { test: /how (do|to|should)|what is|policy|procedure|manual|guideline|comment|cómo|wie |como /, tool: 'search_knowledge', input: (_q, raw) => ({ query: raw.slice(0, 300) }) },
];

const NAV: Array<[RegExp, string]> = [
  [/league/, '/league-table'], [/audit/, '/audits'], [/complian/, '/compliance'], [/review/, '/marketing/reviews'], [/inbox/, '/marketing/inbox'],
  [/email/, '/marketing/email'], [/automation/, '/marketing/automations'], [/social/, '/marketing/social'], [/website/, '/marketing/websites'],
  [/royalt/, '/finance/royalties'], [/statement/, '/finance/statements'], [/fund/, '/finance/marketing-fund'], [/help|ticket/, '/help'],
  [/training|course/, '/training'], [/community|announcement/, '/community'], [/team|people/, '/team'], [/location/, '/locations'],
  [/lead/, '/sales/leads'], [/franchise|prospect/, '/franchise/pipeline'], [/setting/, '/settings'], [/approval/, '/approvals'], [/marina|insight/, '/marina'],
];

function lastUserText(messages: LlmMessage[]): { text: string; toolResults: Array<{ content: string; isError: boolean }> } {
  const m = messages[messages.length - 1];
  if (!m || m.role !== 'user' || typeof m.content === 'string') return { text: typeof m?.content === 'string' ? m.content : '', toolResults: [] };
  const toolResults = m.content.filter((b) => b.type === 'tool_result').map((b) => {
    const r = b as { content?: unknown; is_error?: boolean };
    const content = typeof r.content === 'string' ? r.content : Array.isArray(r.content) ? r.content.map((x: { text?: string }) => x.text ?? '').join('') : '';
    return { content, isError: !!r.is_error };
  });
  const texts = m.content.filter((b) => b.type === 'text').map((b) => (b as { text: string }).text);
  return { text: texts[texts.length - 1] ?? '', toolResults };
}

/** Turns tool results (as the engine serialises them) into a reply built only from their summaries. */
function answerFromResults(results: Array<{ content: string; isError: boolean }>, p: Phrases): string {
  const lines: string[] = [];
  let proposed = false;
  let denied = false;
  for (const r of results) {
    let j: { summary?: string; status?: string; error?: string; denied?: string; data?: unknown } = {};
    try {
      j = JSON.parse(r.content);
    } catch {
      /* not JSON */
    }
    if (j.status === 'awaiting_confirmation') proposed = true;
    else if (j.denied) denied = true;
    else if (r.isError || j.error) lines.push(`${p.error} ${j.error ?? ''}`.trim());
    else if (j.summary) lines.push(j.summary);
  }
  const out: string[] = [];
  if (lines.length) out.push(lines.length === 1 ? lines[0]! : `${p.found}\n${lines.map((l) => `- ${l}`).join('\n')}`);
  if (proposed) out.push(p.proposed);
  if (denied) out.push(p.denied);
  return out.join('\n\n') || p.none;
}

function words(text: string, onText?: (d: string) => void) {
  if (!onText) return;
  for (const w of text.split(/(?<=\s)/)) onText(w);
}

const estimate = (s: string) => Math.ceil(s.length / 4);

export function createSandboxLlm(): MarinaLlm {
  return {
    mode: 'sandbox',
    models: { main: 'sandbox', fast: 'sandbox' },
    async call(c: LlmCall): Promise<LlmResult> {
      const p = sandboxPhrases(c.locale);
      const offered = new Set((c.tools ?? []).map((t) => t.name));
      const { text, toolResults } = lastUserText(c.messages);
      const inputTokens = estimate(c.system + (c.context ?? '') + JSON.stringify(c.messages));
      const done = (content: LlmContentBlock[], stopReason: string): LlmResult => ({
        content, stopReason, model: 'sandbox',
        usage: { inputTokens, outputTokens: estimate(JSON.stringify(content)) },
      });
      const textBlock = (t: string) => ({ type: 'text', text: t, citations: null }) as unknown as LlmContentBlock;

      // After tools ran: answer from their results only.
      if (toolResults.length) {
        const answer = answerFromResults(toolResults, p);
        words(answer, c.onText);
        return done([textBlock(answer)], 'end_turn');
      }

      // No tools offered (single-shot skills such as summaries): echo nothing new, the caller formats its own data.
      if (!c.tools?.length) {
        const answer = p.noData;
        words(answer, c.onText);
        return done([textBlock(answer)], 'end_turn');
      }

      const q = text.toLocaleLowerCase();
      if (/^(go to|open the|take me to|navigate to|show me the .*(page|screen)|ouvre|abre|öffne|ir para)\b/.test(q) && offered.has('navigate')) {
        const path = NAV.find(([re]) => re.test(q))?.[1];
        if (path) {
          return done([{ type: 'tool_use', id: `toolu_${randomUUID().replace(/-/g, '')}`, name: 'navigate', input: { path }, caller: { type: 'direct' } } as unknown as LlmContentBlock], 'tool_use');
        }
      }
      for (const r of RULES) {
        if (!r.test.test(q)) continue;
        if (!offered.has(r.tool)) continue;
        const input = Object.fromEntries(Object.entries(r.input(q, text.trim())).filter(([, v]) => v !== undefined));
        words(p.checking + ' ', c.onText);
        return done([textBlock(p.checking), { type: 'tool_use', id: `toolu_${randomUUID().replace(/-/g, '')}`, name: r.tool, input, caller: { type: 'direct' } } as unknown as LlmContentBlock], 'tool_use');
      }
      const matchedButNotOffered = RULES.some((r) => r.test.test(q));
      const answer = matchedButNotOffered ? p.outside : p.help;
      words(answer, c.onText);
      return done([textBlock(answer)], 'end_turn');
    },
  };
}
