import { randomUUID } from 'node:crypto';
import { ASSISTANT_NAME } from '@bh/shared';
import { addDays, localDateParts, weekdayOf, zonedToUtc } from '../lib/tz.ts';
import type { LlmCall, LlmContentBlock, LlmMessage, LlmResult, MarinaLlm } from './llm.ts';

/**
 * Deterministic sandbox engine (no API key, tests, the demo site).
 *
 * It picks a tool from the question with fixed keyword rules, then answers ONLY from the tool results the engine hands
 * back (their `summary` lines). It never states a business fact of its own. Phrases are localised for the app locales.
 */

type Phrases = Record<'found' | 'none' | 'proposed' | 'denied' | 'error' | 'help' | 'outside' | 'opening' | 'noData' | 'checking' | 'briefing' | 'quiet', string>;

/** Marina's voice (docs/MARINA.md): calm, plain-spoken, warm not cute; no exclamation marks in bad news. */
const PHRASES: Record<string, Phrases> = {
  en: {
    found: 'Here’s what I found:',
    none: 'I looked, and nothing matches that. Try different words, or ask me about another area.',
    proposed: 'I’ve prepared this for you to check. Nothing has been changed or sent yet: confirm it on the card when you’re happy with it.',
    denied: 'That’s outside what you can see, so I can’t do it for you. Your head office can help.',
    error: 'I couldn’t finish that:',
    help: 'I’m {name}. I can answer questions about the data you can see (locations, performance, reviews, audits, compliance, royalties, leads, tickets, training) and prepare changes for you to confirm. Try “Which locations missed royalties last month?” or “Revenue by location this quarter vs last”.',
    outside: 'That’s outside what you can see. Ask me about the areas you work in, or your head office can help.',
    opening: 'Opening',
    noData: 'There’s no data for that yet.',
    checking: 'On it.',
    briefing: 'Here’s what needs you today:',
    quiet: 'Nothing needs you today.',
  },
  fr: {
    found: 'Voici ce que j’ai trouvé :',
    none: 'J’ai regardé, et rien ne correspond. Essayez d’autres mots, ou posez-moi une question sur un autre domaine.',
    proposed: 'J’ai préparé ceci pour que vous le vérifiiez. Rien n’a encore été modifié ni envoyé : confirmez sur la carte quand cela vous convient.',
    denied: 'Cela dépasse ce que vous pouvez voir, je ne peux donc pas le faire pour vous. Votre siège peut vous aider.',
    error: 'Je n’ai pas pu terminer :',
    help: 'Je suis {name}. Je réponds aux questions sur les données que vous pouvez voir (sites, performance, avis, audits, conformité, redevances, prospects, tickets, formation) et je prépare des modifications que vous confirmez. Essayez « Quels sites n’ont pas payé leurs redevances le mois dernier ? ».',
    outside: 'Cela dépasse ce que vous pouvez voir. Posez-moi une question sur vos domaines de travail, ou demandez à votre siège.',
    opening: 'Ouverture de',
    noData: 'Il n’y a pas encore de données pour cela.',
    checking: 'Je m’en occupe.',
    briefing: 'Voici ce qui vous attend aujourd’hui :',
    quiet: 'Rien ne vous attend aujourd’hui.',
  },
  es: {
    found: 'Esto es lo que encontré:',
    none: 'He mirado y no hay nada que coincida. Prueba con otras palabras o pregúntame por otra área.',
    proposed: 'Lo he preparado para que lo revises. Aún no se ha cambiado ni enviado nada: confírmalo en la tarjeta cuando te parezca bien.',
    denied: 'Eso está fuera de lo que puedes ver, así que no puedo hacerlo por ti. Tu central puede ayudarte.',
    error: 'No pude terminarlo:',
    help: 'Soy {name}. Respondo preguntas sobre los datos que puedes ver (ubicaciones, rendimiento, reseñas, auditorías, cumplimiento, regalías, leads, tickets, formación) y preparo cambios para que los confirmes. Prueba «¿Qué ubicaciones no pagaron regalías el mes pasado?».',
    outside: 'Eso está fuera de lo que puedes ver. Pregúntame por las áreas en las que trabajas, o tu central puede ayudarte.',
    opening: 'Abriendo',
    noData: 'Todavía no hay datos para eso.',
    checking: 'Me pongo con ello.',
    briefing: 'Esto es lo que te necesita hoy:',
    quiet: 'Hoy no hay nada que te necesite.',
  },
  de: {
    found: 'Das habe ich gefunden:',
    none: 'Ich habe nachgesehen, aber nichts passt dazu. Versuchen Sie andere Worte oder fragen Sie mich zu einem anderen Bereich.',
    proposed: 'Ich habe das zur Prüfung vorbereitet. Es wurde noch nichts geändert oder gesendet: Bestätigen Sie es auf der Karte, wenn es für Sie passt.',
    denied: 'Das liegt außerhalb dessen, was Sie sehen können, deshalb kann ich das nicht für Sie erledigen. Ihre Zentrale kann helfen.',
    error: 'Das konnte ich nicht abschließen:',
    help: 'Ich bin {name}. Ich beantworte Fragen zu den Daten, die Sie sehen können (Standorte, Leistung, Bewertungen, Audits, Compliance, Lizenzgebühren, Leads, Tickets, Schulungen), und bereite Änderungen zur Bestätigung vor. Fragen Sie z. B. „Welche Standorte haben letzten Monat keine Lizenzgebühren gezahlt?“.',
    outside: 'Das liegt außerhalb dessen, was Sie sehen können. Fragen Sie mich zu Ihren Arbeitsbereichen, oder wenden Sie sich an Ihre Zentrale.',
    opening: 'Öffne',
    noData: 'Dazu gibt es noch keine Daten.',
    checking: 'Ich kümmere mich darum.',
    briefing: 'Das braucht Sie heute:',
    quiet: 'Heute braucht Sie nichts.',
  },
  'pt-BR': {
    found: 'Veja o que encontrei:',
    none: 'Procurei e nada corresponde a isso. Tente outras palavras ou me pergunte sobre outra área.',
    proposed: 'Preparei isto para você conferir. Nada foi alterado ou enviado ainda: confirme no cartão quando estiver tudo certo.',
    denied: 'Isso está fora do que você pode ver, então não posso fazer por você. A sua sede pode ajudar.',
    error: 'Não consegui terminar:',
    help: 'Sou a {name}. Respondo perguntas sobre os dados que você pode ver (unidades, desempenho, avaliações, auditorias, conformidade, royalties, leads, chamados, treinamento) e preparo alterações para você confirmar. Experimente “Quais unidades não pagaram royalties no mês passado?”.',
    outside: 'Isso está fora do que você pode ver. Pergunte sobre as áreas em que você trabalha, ou a sua sede pode ajudar.',
    opening: 'Abrindo',
    noData: 'Ainda não há dados para isso.',
    checking: 'Deixa comigo.',
    briefing: 'Veja o que precisa de você hoje:',
    quiet: 'Nada precisa de você hoje.',
  },
};

export function sandboxPhrases(locale: string | undefined): Phrases {
  const l = locale ?? 'en';
  const p = PHRASES[l] ?? PHRASES[l.split('-')[0]!] ?? PHRASES.en!;
  return { ...p, help: p.help.replace('{name}', ASSISTANT_NAME) };
}

type Period = 'this_month' | 'last_month' | 'this_quarter' | 'last_quarter' | 'year_to_date' | 'last_30_days';

function periodOf(q: string): Period {
  // "this quarter vs last quarter" asks about this quarter (the tool always compares with the previous period).
  if (/this quarter|ce trimestre|este trimestre|dieses quartal|diesem quartal|neste trimestre/.test(q)) return 'this_quarter';
  if (/last quarter|previous quarter|trimestre dernier|dernier trimestre|trimestre pasado|letztes quartal|último trimestre|trimestre passado/.test(q)) return 'last_quarter';
  if (/quarter|trimestre|quartal/.test(q)) return 'this_quarter';
  if (/last month|previous month|mois dernier|mes pasado|letzten monat|letzter monat|mês passado/.test(q)) return 'last_month';
  if (/this month|ce mois|este mes|diesen monat|este mês/.test(q)) return 'this_month';
  if (/year|ytd|année|año|jahr|ano/.test(q)) return 'year_to_date';
  return 'last_30_days';
}

const quoted = (q: string) => q.match(/["“«„']([^"”»“']{2,200})["”»“']/)?.[1] ?? null;

// Weekday names (Sunday first) in the five app languages.
const WEEKDAYS: RegExp[] = [
  /sunday|dimanche|domingo|sonntag/, /monday|lundi|lunes|montag|segunda/, /tuesday|mardi|martes|dienstag|terça/,
  /wednesday|mercredi|miércoles|mittwoch|quarta/, /thursday|jeudi|jueves|donnerstag|quinta/,
  /friday|vendredi|viernes|freitag|sexta/, /saturday|samedi|sábado|samstag/,
];

/** "on Friday", "in 3 days", "next week" → 09:00 that day in the organisation's time zone (default: tomorrow). */
function whenOf(q: string, timeZone = 'UTC'): string {
  const today = localDateParts(new Date(), timeZone).date;
  const inDays = q.match(/in (\d+) (?:days?|jours?|días?|tagen?|dias?)/);
  const named = WEEKDAYS.findIndex((re) => re.test(q));
  let date = addDays(today, 1);
  if (inDays) date = addDays(today, Number(inDays[1]));
  else if (named >= 0) date = addDays(today, ((named - weekdayOf(today) + 6) % 7) + 1);
  else if (/next week|semaine prochaine|próxima semana|nächste woche/.test(q)) date = addDays(today, 7);
  return zonedToUtc(date, '09:00', timeZone).toISOString();
}

interface Rule {
  test: RegExp;
  tool: string;
  input: (q: string, raw: string, timeZone: string) => Record<string, unknown>;
}

/** A place named in the question ("in Seattle", "à Lyon", "en Madrid", "in München"), keeping its capitals. */
const placeIn = (raw: string) => quoted(raw) ?? raw.match(/(?:^|\s)(?:in|à|a|en|em|im|near|around|près de|cerca de|perto de|bei)\s+(\p{Lu}[\p{L}'.-]*(?:\s+\p{Lu}[\p{L}'.-]*){0,3})/u)?.[1]?.trim() ?? undefined;
/** The person or record named after "for"/"to" ("for Sofia Marquez", "to Atlantic Hot Yoga"). */
const namedAfter = (raw: string) => quoted(raw) ?? raw.match(/(?:^|\s)(?:for|to|pour|à|para|für|an)\s+(\p{Lu}[\p{L}'&. -]{1,80}?)\s*(?:[?.!,:]|\s(?:about|because|for|pour|por|wegen|sobre)\b|$)/u)?.[1]?.trim() ?? undefined;
const daysOf = (q: string) => (/today|aujourd|hoy|heute|hoje/.test(q) ? 1 : /month|mois|mes\b|monat|mês/.test(q) ? 30 : 7);
const noticeReason = (q: string) => (/insurance|assurance|seguro|versicherung/.test(q) ? 'insurance' : /pay|royalt|paiement|pago|zahlung|pagamento/.test(q) ? 'non_payment' : /report|déclar|informe|bericht|relat/.test(q) ? 'reporting' : /standard|norme|estándar|standards|padr/.test(q) ? 'brand_standards' : 'other');

/**
 * Rules for the modules added after the first release (local marketing, data platform, supply, audits phase 2,
 * franchise development, brands, billing). They sit before the general rules so that, for example, "sales variance"
 * reaches the reconciliation and not revenue, and "missed calls" reaches call tracking and not the inbox.
 */
const MODULE_RULES: Rule[] = [
  // Franchise development (legal drafts first: they are the most specific).
  { test: /(draft|prepare|write).*(notice of default|default notice)|rédige.*mise en demeure|(redacta|prepara).*(aviso|notificación) de incumplimiento|(entwirf|erstelle).*(abmahnung|verzugsmitteilung)|(redija|prepare).*notificação de inadimplemento/, tool: 'draft_notice_of_default', input: (q, raw) => ({ franchisee: namedAfter(raw) ?? raw.slice(0, 120), reason: noticeReason(q), details: raw.slice(0, 1000) }) },
  { test: /renewal|renouvel|renovaci|verlängerung|renova[çc]|cure period|délais? de (correction|remédiation)|períodos? de (subsanación|cura)|prazos? de (correção|saneamento)|heilungsfrist|notices? of default|mise en demeure|incumplimiento|abmahnung|inadimplemento/, tool: 'due_renewals_and_cures', input: () => ({}) },
  { test: /development (schedule|agreement)|area develop|calendriers? de développement|calendarios? de desarrollo|entwicklungs(pl|vertr)|cronogramas? de desenvolvimento/, tool: 'development_schedule_status', input: () => ({}) },
  { test: /validator|validation call|appels? de validation|llamadas? de validación|validierungs|chamadas? de validação/, tool: 'suggest_validators', input: (_q, raw) => ({ candidate: [namedAfter(raw)].find((n) => n && !/valid/i.test(n)) }) },
  { test: /split statement|master (franchise|statement)|répartition|reparto de regal|aufteilung|divisão de royalt|master-?franchis/, tool: 'explain_split_statement', input: (_q, raw) => ({ statement: raw.match(/\bMS-[\w-]+/)?.[0] }) },
  { test: /territ(or|oir|ór)/, tool: 'territory_overlaps_and_scores', input: (q, raw) => ({ search: placeIn(raw), status: /available|disponible|verfügbar|dispon[íi]ve|libre|frei/.test(q) ? 'available' : 'all', overlapsOnly: /overlap|chevauch|solap|überschneid|sobrepo/.test(q) }) },
  { test: /survey|sondage|enquête|encuesta|umfrage|pesquisa|\benps\b|satisfaction des franchisés|zufriedenheit/, tool: 'survey_summary', input: () => ({}) },
  // Brands and billing.
  { test: /compar\w* (the |our |les |nos |las |los |nuestras |nuestros |nossas |nossos |unsere )?(brands|marques|marcas|marken)|brand comparison|(brands|marques|marcas|marken)\s+(vs|versus|compar|vergleich)|markenvergleich/, tool: 'brand_comparison', input: () => ({}) },
  { test: /\b(brands|marques|marcas|marken)\b/, tool: 'list_brands', input: () => ({}) },
  { test: /billing|subscription|(our|my|which|current|what) plan\b|plan (are|is) (we|it) on|plan status|qué plan|qual (é o nosso )?plano|free trial|trial (days|ends)|who pays|facturation|abonnement|forfait|qui paie|facturación|suscripción|período de prueba|quién paga|testphase|wer zahlt|cobrança|assinatura|período de teste|quem paga/, tool: 'plan_status', input: () => ({}) },
  // Local marketing.
  { test: /drift|edited (outside|on google)|modifiée?s? hors|modific\w* fuera|außerhalb .{0,40}geändert|alterad[oa]s? fora/, tool: 'listing_drifts', input: () => ({}) },
  { test: /listing|\bfiches?\b(?! de visite)|\bfichas?\b(?! de visita)|brancheneintr|einträge|eintrag|listagens?|out of date|holiday hours|horaires? (des )?jours fériés|horario(s)? festivo|feiertagsöffnungszeiten|horário de feriado/, tool: 'listing_health', input: () => ({}) },
  { test: /co-?op.*(claim|réclamation|remboursement|reclamaci|anspr|erstattung|reembolso)|(claim|réclamation|remboursement|reclamaci|anspr|erstattung|reembolso).*co-?op/, tool: 'explain_coop_claim', input: () => ({}) },
  { test: /co-?op|coopérati|cooperativ|kooperativ|werbekostenzuschuss/, tool: 'coop_burn_down', input: () => ({}) },
  { test: /missed calls?|unanswered calls?|appels? (manqués|en absence)|llamadas? perdidas|verpasste anrufe|chamadas? perdidas/, tool: 'missed_calls_without_follow_up', input: (q) => ({ days: daysOf(q) }) },
  { test: /\bcalls?\b|call tracking|appels?\b|llamadas?|anrufe|chamadas?/, tool: 'call_report', input: (q) => ({ period: /week|semaine|semana|woche/.test(q) ? 'last_7_days' : 'last_30_days' }) },
  { test: /(content|social|posting|editorial) calendar|calendrier (éditorial|social|de contenu)|calendario (de contenidos|social|editorial)|redaktionsplan|content-?kalender|calendário (de conteúdo|editorial)/, tool: 'social_calendar_preview', input: () => ({}) },
  // Data platform.
  { test: /variance|écarts? (de|des|sur les) (ventes|chiffre)|varianza|desviaci|abweichung|divergênc|variação de vendas/, tool: 'list_variance_flags', input: () => ({}) },
  { test: /reconcil|rapprochement|conciliaci|abgleich|concilia[çc]/, tool: 'get_reconciliation', input: () => ({}) },
  { test: /connector|\bpos\b sync|sync(hronisation)? (fail|error)|connecteur|conector|konnektor|synchroni[sz]/, tool: 'get_sales_connector_health', input: () => ({}) },
  { test: /\bimports?\b|importations?|importaci[oó]n(es)?|importa[çc](ão|ões)/, tool: 'get_import_status', input: () => ({}) },
  { test: /bulk launch|launch board|launches|lancements?|lanzamientos?|massenstart|lançamentos?/, tool: 'get_launch_board', input: () => ({}) },
  { test: /benchmark|percentile|percentil|perzentil|réseaux similaires|redes similares|ähnliche netzwerke/, tool: 'get_benchmarks', input: () => ({}) },
  // Supply.
  { test: /late deliver|supplier deliver|purchase orders?|livraisons? (en retard|fournisseur)|bons? de commande|entregas? (atrasadas|retrasadas|de proveedor|de fornecedor)|órdenes de compra|ordens? de compra|pedidos? de compra|(verspätete|ausstehende) lieferungen|lieferungen.*verspätet|bestellungen? (beim|an) lieferant/, tool: 'list_purchase_orders', input: (q) => ({ lateOnly: /late|retard|atras|retras|verspät|tard/.test(q) }) },
  { test: /scorecard|on-?time|fill rate|taux de service|tasa de cumplimiento|liefertreue|pontualidade/, tool: 'supplier_scorecards', input: () => ({}) },
  { test: /rebate|ristourne|remise fournisseur|bonificaci|rückvergütung|bonifica[çc]/, tool: 'rebate_status', input: () => ({}) },
  { test: /off-?contract|hors contrat|fuera de contrato|außerhalb des vertrags|fora do contrato/, tool: 'off_contract_summary', input: () => ({}) },
  { test: /supplier|supply|fournisseur|approvisionnement|proveedor|suministro|lieferant|fornecedor|suprimento/, tool: 'supply_overview', input: () => ({}) },
  // Audits phase 2.
  { test: /most failed|failed items|failing items|(items?|points?) (les plus )?(souvent )?échoués|más fallad|am häufigsten (nicht bestanden|durchgefallen)|mais (reprovad|falhad)/, tool: 'most_failed_items', input: () => ({}) },
  { test: /plan (my |the )?visits|visit plan|my visits|tournée|planificar (mis )?visitas|besuchsplan|besuche planen|planejar (minhas )?visitas|plano de visitas/, tool: 'plan_visits', input: () => ({}) },
  { test: /self-?checks?|temperature log|opening checklist|auto-?contr[ôo]les?|autocontrol(es)?|selbstkontroll|autoavalia[çc]|autoverifica/, tool: 'self_check_status', input: () => ({}) },
];

/** Keyword rules, most specific first. Inputs are only taken from the question itself. */
const RULES: Rule[] = [
  // Audit trends first: “Comment évoluent…”, “Wie entwickeln sich…” would otherwise read as how-to questions.
  { test: /audit.*(trend|tendance|tendencia|entwicklung|tendência)|(trend|tendance|tendencia|tendência|évolu|evolucion|entwickel|evolu[íi]n?do).*audit/, tool: 'audit_trends', input: () => ({}) },
  { test: /^(how (do|should|can) (we|i)|how to|what('s| is) (our|the) (policy|procedure|process|rule)|what does (our|the) (manual|handbook|policy|guide)|where do (we|i)|comment |cómo |wie |como |que dit |qué dice |was sagt |o que diz )/, tool: 'search_knowledge', input: (_q, raw) => ({ query: raw.slice(0, 300) }) },
  { test: /remind me|reminder|rappelle|recuérdame|erinnere|lembre/, tool: 'remind_me', input: (q, raw, tz) => ({ title: quoted(raw) ?? (raw.replace(/^.*?(remind me( to)?|rappelle-moi( de)?|recuérdame|erinnere mich( an)?|lembre-me( de)?)\s*/i, '').slice(0, 120) || raw.slice(0, 120)), remindAt: whenOf(q, tz) }) },
  { test: /(create|add|new) (a )?(task|to-?do)|crée une tâche|crear tarea|aufgabe/, tool: 'create_task', input: (_q, raw) => ({ title: quoted(raw) ?? raw.slice(0, 120) }) },
  ...MODULE_RULES,
  { test: /(draft|write|create|prepare).*(email|newsletter)|(email|newsletter).*(draft|campaign)|rédige.*e-?mail|redacta.*correo/, tool: 'create_email_campaign_draft', input: (_q, raw) => ({ name: quoted(raw) ?? raw.slice(0, 80), subject: quoted(raw) ?? raw.slice(0, 80) }) },
  { test: /(draft|write|create|prepare).*(social|post|instagram|facebook)|(rédige|écris|prépare).*(publication|post)|(redacta|escribe|prepara).*(publicación|post)|(entwirf|schreib|erstelle).*(beitrag|post)|(escreva|redija|prepare).*(publicação|post)/, tool: 'create_social_post_draft', input: (_q, raw) => ({ text: quoted(raw) ?? raw.slice(0, 280) }) },
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
  [/listing/, '/marketing/listings'], [/co-?op/, '/marketing/coop'], [/call/, '/marketing/calls'], [/calendar/, '/marketing/social/calendar'], [/reconcil/, '/sales-connectors/reconciliation'],
  [/connector/, '/sales-connectors'], [/import/, '/import'], [/launch/, '/launch'], [/benchmark/, '/benchmarks'], [/rebate/, '/finance/supplier-rebates'], [/supplier|purchase order/, '/suppliers'],
  [/self-?check/, '/self-checks'], [/survey/, '/surveys'], [/territ(or|oir|ór)/, '/franchise/territories'], [/lifecycle|renewal|notice/, '/franchise/lifecycle'], [/validation/, '/franchise/validation'],
  [/development/, '/franchise/development'], [/master/, '/franchise/master'], [/brand comparison|compare brands/, '/reports/brands'], [/brands/, '/settings/brands'], [/billing|plan/, '/settings/billing'],
  [/visit brief|visite|visita|besuch/, '/marina/visit-brief'], [/studio|content/, '/marina/studio'], [/league/, '/league-table'], [/audit/, '/audits'], [/complian/, '/compliance'], [/review/, '/marketing/reviews'], [/inbox/, '/marketing/inbox'],
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

      const q = text.toLocaleLowerCase().replace(/^[¿¡\s]+/, '');
      if (/^(go to|open the|take me to|navigate to|show me the .*(page|screen)|ouvre|abre|abra|ve a|öffne|ir para)\b/.test(q) && offered.has('navigate')) {
        const path = NAV.find(([re]) => re.test(q))?.[1];
        if (path) {
          return done([{ type: 'tool_use', id: `toolu_${randomUUID().replace(/-/g, '')}`, name: 'navigate', input: { path }, caller: { type: 'direct' } } as unknown as LlmContentBlock], 'tool_use');
        }
      }
      for (const r of RULES) {
        if (!r.test.test(q)) continue;
        // The first matching rule decides: a tool outside the person's access is never replaced by another one.
        if (!offered.has(r.tool)) break;
        const input = Object.fromEntries(Object.entries(r.input(q, text.trim(), c.context?.match(/time zone ([A-Za-z0-9_/+-]+)\)/)?.[1] ?? 'UTC')).filter(([, v]) => v !== undefined));
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
