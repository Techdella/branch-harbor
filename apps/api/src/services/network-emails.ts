/**
 * Network emails written in each recipient's own language (the app's five locales; other locales read English):
 * compliance document expiry reminders and escalations, missing required documents, and survey invitations. Rendered
 * with the same MJML layout and plain-text part as the billing emails (services/billing-emails.ts); dates are formatted
 * for the recipient's locale. Each recipient gets their own message through the email queue.
 */
import { inArray } from 'drizzle-orm';
import type { Services } from '../context.ts';
import type { Exec } from '../db/client.ts';
import { users } from '../db/schema/index.ts';
import { billingLocale, renderSimpleEmail, type BillingEmailLocale } from './billing-emails.ts';

export type NetworkEmail =
  | { kind: 'compliance_expiring'; business: string; label: string; expiresOn: string; daysLeft: number; url: string }
  | { kind: 'compliance_expired'; business: string; label: string; expiresOn: string; url: string }
  | { kind: 'compliance_expired_escalation'; business: string; label: string; expiresOn: string; url: string }
  | { kind: 'compliance_missing'; business: string; label: string; url: string }
  | { kind: 'compliance_missing_escalation'; business: string; label: string; days: number; url: string }
  | { kind: 'survey_invite'; business: string; title: string; closesOn: string; anonymous: boolean; url: string };

interface Copy {
  hi: (name: string) => string;
  footer: (business: string) => string;
  button: { upload: string; matrix: string; survey: string };
  expiring: { subject: (days: number, label: string) => string; body: (label: string, date: string) => string[] };
  expired: { subject: (label: string) => string; body: (label: string) => string[] };
  escalation: { subject: (label: string) => string; body: (label: string, date: string) => string[] };
  missing: { subject: (label: string) => string; body: (label: string) => string[] };
  missingEscalation: { subject: (label: string, days: number) => string; body: (label: string, days: number) => string[] };
  survey: { subject: (title: string) => string; body: (title: string, business: string, date: string, anonymous: boolean) => string[] };
}

const COPY: Record<BillingEmailLocale, Copy> = {
  en: {
    hi: (n) => `Hi ${n},`,
    footer: (b) => `You are receiving this email because you are part of ${b} on BranchHarbor.`,
    button: { upload: 'Upload the document', matrix: 'Open the compliance matrix', survey: 'Answer the survey' },
    expiring: {
      subject: (d, l) => `Expires in ${d} days: ${l}`,
      body: (l, date) => [`${l} expires on ${date}.`, 'Upload the renewed document before then so the location stays compliant.'],
    },
    expired: { subject: (l) => `Expired: ${l}`, body: (l) => [`${l} has expired.`, 'Upload the renewed document as soon as you can.'] },
    escalation: {
      subject: (l) => `Compliance: ${l} has expired`,
      body: (l, date) => [`${l} expired on ${date} and no renewed document has been approved.`, 'Review the compliance matrix to follow up with the location.'],
    },
    missing: { subject: (l) => `Missing: ${l}`, body: (l) => [`HQ requires ${l} and nothing has been uploaded yet.`, 'Upload it so the location is compliant.'] },
    missingEscalation: {
      subject: (l, d) => `Compliance: ${l} missing for ${d} days`,
      body: (l, d) => [`${l} is required and has been missing for ${d} days.`, 'Review the compliance matrix to follow up with the location.'],
    },
    survey: {
      subject: (t) => `Survey: ${t}`,
      body: (t, b, date, anon) => [`${b} asks for your views in “${t}”. It takes about three minutes.`, `${anon ? 'Your answers are anonymous. ' : ''}The survey closes on ${date}.`],
    },
  },
  fr: {
    hi: (n) => `Bonjour ${n},`,
    footer: (b) => `Vous recevez cet e-mail car vous faites partie de ${b} sur BranchHarbor.`,
    button: { upload: 'Déposer le document', matrix: 'Ouvrir la matrice de conformité', survey: 'Répondre à l’enquête' },
    expiring: {
      subject: (d, l) => `Expire dans ${d} jours : ${l}`,
      body: (l, date) => [`${l} expire le ${date}.`, 'Déposez le document renouvelé avant cette date pour que le site reste en conformité.'],
    },
    expired: { subject: (l) => `Expiré : ${l}`, body: (l) => [`${l} a expiré.`, 'Déposez le document renouvelé dès que possible.'] },
    escalation: {
      subject: (l) => `Conformité : ${l} a expiré`,
      body: (l, date) => [`${l} a expiré le ${date} et aucun document renouvelé n’a été approuvé.`, 'Consultez la matrice de conformité pour relancer le site.'],
    },
    missing: { subject: (l) => `Manquant : ${l}`, body: (l) => [`Le siège exige ${l} et rien n’a encore été déposé.`, 'Déposez-le pour que le site soit en conformité.'] },
    missingEscalation: {
      subject: (l, d) => `Conformité : ${l} manquant depuis ${d} jours`,
      body: (l, d) => [`${l} est obligatoire et manque depuis ${d} jours.`, 'Consultez la matrice de conformité pour relancer le site.'],
    },
    survey: {
      subject: (t) => `Enquête : ${t}`,
      body: (t, b, date, anon) => [`${b} souhaite connaître votre avis dans « ${t} ». Cela prend environ trois minutes.`, `${anon ? 'Vos réponses sont anonymes. ' : ''}L’enquête se termine le ${date}.`],
    },
  },
  es: {
    hi: (n) => `Hola ${n}:`,
    footer: (b) => `Recibes este correo porque formas parte de ${b} en BranchHarbor.`,
    button: { upload: 'Subir el documento', matrix: 'Abrir la matriz de cumplimiento', survey: 'Responder la encuesta' },
    expiring: {
      subject: (d, l) => `Vence en ${d} días: ${l}`,
      body: (l, date) => [`${l} vence el ${date}.`, 'Sube el documento renovado antes de esa fecha para que la ubicación siga cumpliendo.'],
    },
    expired: { subject: (l) => `Vencido: ${l}`, body: (l) => [`${l} ha vencido.`, 'Sube el documento renovado lo antes posible.'] },
    escalation: {
      subject: (l) => `Cumplimiento: ${l} ha vencido`,
      body: (l, date) => [`${l} venció el ${date} y no se ha aprobado ningún documento renovado.`, 'Revisa la matriz de cumplimiento para hacer seguimiento con la ubicación.'],
    },
    missing: { subject: (l) => `Falta: ${l}`, body: (l) => [`La central exige ${l} y todavía no se ha subido nada.`, 'Súbelo para que la ubicación cumpla.'] },
    missingEscalation: {
      subject: (l, d) => `Cumplimiento: falta ${l} desde hace ${d} días`,
      body: (l, d) => [`${l} es obligatorio y falta desde hace ${d} días.`, 'Revisa la matriz de cumplimiento para hacer seguimiento con la ubicación.'],
    },
    survey: {
      subject: (t) => `Encuesta: ${t}`,
      body: (t, b, date, anon) => [`${b} quiere conocer tu opinión en «${t}». Lleva unos tres minutos.`, `${anon ? 'Tus respuestas son anónimas. ' : ''}La encuesta cierra el ${date}.`],
    },
  },
  de: {
    hi: (n) => `Hallo ${n},`,
    footer: (b) => `Sie erhalten diese E-Mail, weil Sie zu ${b} auf BranchHarbor gehören.`,
    button: { upload: 'Dokument hochladen', matrix: 'Compliance-Übersicht öffnen', survey: 'Umfrage beantworten' },
    expiring: {
      subject: (d, l) => `Läuft in ${d} Tagen ab: ${l}`,
      body: (l, date) => [`${l} läuft am ${date} ab.`, 'Laden Sie das erneuerte Dokument vorher hoch, damit der Standort compliant bleibt.'],
    },
    expired: { subject: (l) => `Abgelaufen: ${l}`, body: (l) => [`${l} ist abgelaufen.`, 'Laden Sie das erneuerte Dokument so bald wie möglich hoch.'] },
    escalation: {
      subject: (l) => `Compliance: ${l} ist abgelaufen`,
      body: (l, date) => [`${l} ist am ${date} abgelaufen und es wurde kein erneuertes Dokument freigegeben.`, 'Prüfen Sie die Compliance-Übersicht und haken Sie beim Standort nach.'],
    },
    missing: { subject: (l) => `Fehlt: ${l}`, body: (l) => [`Die Zentrale verlangt ${l} und es wurde noch nichts hochgeladen.`, 'Laden Sie es hoch, damit der Standort compliant ist.'] },
    missingEscalation: {
      subject: (l, d) => `Compliance: ${l} fehlt seit ${d} Tagen`,
      body: (l, d) => [`${l} ist erforderlich und fehlt seit ${d} Tagen.`, 'Prüfen Sie die Compliance-Übersicht und haken Sie beim Standort nach.'],
    },
    survey: {
      subject: (t) => `Umfrage: ${t}`,
      body: (t, b, date, anon) => [`${b} bittet um Ihre Meinung in „${t}“. Das dauert etwa drei Minuten.`, `${anon ? 'Ihre Antworten sind anonym. ' : ''}Die Umfrage endet am ${date}.`],
    },
  },
  'pt-BR': {
    hi: (n) => `Olá, ${n},`,
    footer: (b) => `Você está recebendo este e-mail porque faz parte de ${b} na BranchHarbor.`,
    button: { upload: 'Enviar o documento', matrix: 'Abrir a matriz de conformidade', survey: 'Responder à pesquisa' },
    expiring: {
      subject: (d, l) => `Vence em ${d} dias: ${l}`,
      body: (l, date) => [`${l} vence em ${date}.`, 'Envie o documento renovado antes disso para a unidade continuar em conformidade.'],
    },
    expired: { subject: (l) => `Vencido: ${l}`, body: (l) => [`${l} venceu.`, 'Envie o documento renovado assim que puder.'] },
    escalation: {
      subject: (l) => `Conformidade: ${l} venceu`,
      body: (l, date) => [`${l} venceu em ${date} e nenhum documento renovado foi aprovado.`, 'Veja a matriz de conformidade para acompanhar a unidade.'],
    },
    missing: { subject: (l) => `Faltando: ${l}`, body: (l) => [`A matriz exige ${l} e nada foi enviado ainda.`, 'Envie o documento para a unidade ficar em conformidade.'] },
    missingEscalation: {
      subject: (l, d) => `Conformidade: ${l} faltando há ${d} dias`,
      body: (l, d) => [`${l} é obrigatório e está faltando há ${d} dias.`, 'Veja a matriz de conformidade para acompanhar a unidade.'],
    },
    survey: {
      subject: (t) => `Pesquisa: ${t}`,
      body: (t, b, date, anon) => [`${b} quer saber sua opinião em “${t}”. Leva cerca de três minutos.`, `${anon ? 'Suas respostas são anônimas. ' : ''}A pesquisa fecha em ${date}.`],
    },
  },
};

/** Renders one network email for one recipient in their language. */
export async function renderNetworkEmail(e: NetworkEmail, to: { name: string; locale: string | null | undefined }) {
  const locale = billingLocale(to.locale);
  const c = COPY[locale];
  const date = (ymd: string) => new Intl.DateTimeFormat(locale, { day: 'numeric', month: 'long', year: 'numeric', timeZone: 'UTC' }).format(new Date(`${ymd.slice(0, 10)}T12:00:00Z`));
  let subject: string;
  let paragraphs: string[];
  let cta: { label: string; url: string };
  switch (e.kind) {
    case 'compliance_expiring': subject = c.expiring.subject(e.daysLeft, e.label); paragraphs = c.expiring.body(e.label, date(e.expiresOn)); cta = { label: c.button.upload, url: e.url }; break;
    case 'compliance_expired': subject = c.expired.subject(e.label); paragraphs = c.expired.body(e.label); cta = { label: c.button.upload, url: e.url }; break;
    case 'compliance_expired_escalation': subject = c.escalation.subject(e.label); paragraphs = c.escalation.body(e.label, date(e.expiresOn)); cta = { label: c.button.matrix, url: e.url }; break;
    case 'compliance_missing': subject = c.missing.subject(e.label); paragraphs = c.missing.body(e.label); cta = { label: c.button.upload, url: e.url }; break;
    case 'compliance_missing_escalation': subject = c.missingEscalation.subject(e.label, e.days); paragraphs = c.missingEscalation.body(e.label, e.days); cta = { label: c.button.matrix, url: e.url }; break;
    case 'survey_invite': subject = c.survey.subject(e.title); paragraphs = c.survey.body(e.title, e.business, date(e.closesOn), e.anonymous); cta = { label: c.button.survey, url: e.url }; break;
  }
  const out = await renderSimpleEmail({ locale, subject, greeting: c.hi(to.name), paragraphs, cta, footer: c.footer(e.business) });
  return { ...out, locale };
}

/** Recipients (email, name, language) of a set of users; deleted accounts are skipped. */
export async function recipientsOf(db: Exec, userIds: readonly string[]) {
  if (!userIds.length) return [];
  const rows = await db.select({ id: users.id, email: users.email, name: users.name, locale: users.locale, deletedAt: users.deletedAt }).from(users).where(inArray(users.id, [...new Set(userIds)]));
  return rows.filter((r) => !r.deletedAt);
}

/** Queues one email per recipient, each in their own language. Never throws (a reminder must not stop the job). */
export async function sendNetworkEmails(s: Pick<Services, 'jobs' | 'log'>, to: { email: string; name: string; locale: string | null }[], tag: string, e: NetworkEmail) {
  let sent = 0;
  for (const r of to) {
    try {
      const m = await renderNetworkEmail(e, r);
      await s.jobs.enqueue('email.send', { to: r.email, subject: m.subject, text: m.text, html: m.html, tag });
      sent++;
    } catch (err) {
      s.log.warn({ err, tag }, '[email] network email failed');
    }
  }
  return sent;
}
