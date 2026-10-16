/**
 * BranchHarbor's own billing and trial emails (plan billing, not the business's marketing): trial confirmation, plan
 * started, trial reminders, trial converted, payment failed, plan changes and the data export link. Written in the
 * recipient's language (the app's five locales; other locales fall back to English) and rendered with MJML like the
 * email builder (services/email-render.ts), with a plain-text part. Amounts and dates are formatted for the
 * recipient's locale; the currency is always the subscription's own.
 */
import mjml2html from 'mjml';
import { formatMoney, resolveLocale, type Currency } from '@bh/shared';

export type BillingEmailLocale = 'en' | 'fr' | 'es' | 'de' | 'pt-BR';
export const BILLING_EMAIL_LOCALES: readonly BillingEmailLocale[] = ['en', 'fr', 'es', 'de', 'pt-BR'];

/** The billing email language for a user's locale (en-GB and locales the app doesn't offer read English). */
export function billingLocale(locale: string | null | undefined): BillingEmailLocale {
  const l = resolveLocale(locale);
  return (BILLING_EMAIL_LOCALES as readonly string[]).includes(l) ? (l as BillingEmailLocale) : 'en';
}

export type BillingEmail =
  | { kind: 'trial_started'; business: string; trialFee: Money; planName: string; amount: Money; interval: Interval; startsOn: Date; taxAdded: boolean; billingUrl: string }
  | { kind: 'plan_started'; business: string; planName: string; amount: Money; interval: Interval; billingUrl: string }
  | { kind: 'trial_reminder'; business: string; days: number; planName: string; amount: Money; interval: Interval; startsOn: Date; taxAdded: boolean; last4: string | null; billingUrl: string }
  | { kind: 'trial_converted'; business: string; planName: string; billingUrl: string }
  | { kind: 'payment_failed'; business: string; amount: Money; billingUrl: string; franchisee?: boolean }
  | { kind: 'plan_changed'; business: string; planName: string; amount: Money; interval: Interval; prorationNow: Money | null; billingUrl: string; chargedNow?: boolean }
  | { kind: 'export_ready'; business: string; files: number; sizeKb: number; expiresOn: Date; link: string };

interface Money { amountMinor: number; currency: string }
type Interval = 'month' | 'year';

interface Fmt { money: (m: Money) => string; date: (d: Date) => string }

interface Copy {
  hi: (name: string) => string;
  footer: (business: string) => string;
  interval: Record<Interval, string>;
  button: { billing: string; download: string };
  trialStarted: { subject: string; body: (e: Extract<BillingEmail, { kind: 'trial_started' }>, f: Fmt) => string[] };
  planStarted: { subject: string; body: (e: Extract<BillingEmail, { kind: 'plan_started' }>, f: Fmt) => string[] };
  reminder: { subject: (days: number, date: string) => string; body: (e: Extract<BillingEmail, { kind: 'trial_reminder' }>, f: Fmt) => string[] };
  converted: { subject: string; body: (e: Extract<BillingEmail, { kind: 'trial_converted' }>) => string[] };
  failed: { subject: string; body: (e: Extract<BillingEmail, { kind: 'payment_failed' }>, f: Fmt) => string[] };
  changed: { subject: (plan: string) => string; body: (e: Extract<BillingEmail, { kind: 'plan_changed' }>, f: Fmt) => string[] };
  exportReady: { subject: string; body: (e: Extract<BillingEmail, { kind: 'export_ready' }>, f: Fmt) => string[] };
}

const COPY: Record<BillingEmailLocale, Copy> = {
  en: {
    hi: (n) => `Hi ${n},`,
    footer: (b) => `You are receiving this email because you manage billing for ${b} on BranchHarbor.`,
    interval: { month: 'month', year: 'year' },
    button: { billing: 'Open Settings → Billing', download: 'Download your data' },
    trialStarted: {
      subject: 'Your 14-day BranchHarbor trial has started',
      body: (e, f) => [
        `Thanks for starting your 14-day trial of ${e.business} on BranchHarbor. We charged ${f.money(e.trialFee)} for the trial.`,
        `Your ${e.planName} plan starts automatically on ${f.date(e.startsOn)} at ${f.money(e.amount)} per ${COPY.en.interval[e.interval]}${e.taxAdded ? ' plus applicable tax' : ''}, unless you cancel before then in Settings → Billing. We’ll remind you 3 days and 1 day before.`,
        'There is no cancellation fee, and you can export your data for free at any time.',
      ],
    },
    planStarted: {
      subject: 'Your BranchHarbor plan has started',
      body: (e, f) => [
        `Your ${e.planName} plan for ${e.business} has started (a trial was already used for this business, card or email domain). We charged ${f.money(e.amount)} for the first ${COPY.en.interval[e.interval]}.`,
        'Cancel any time in Settings → Billing; there is no cancellation fee.',
      ],
    },
    reminder: {
      subject: (d, date) => (d === 1 ? `Your BranchHarbor trial ends tomorrow (${date})` : `Your BranchHarbor trial ends in ${d} days (${date})`),
      body: (e, f) => [
        `Your 14-day trial of BranchHarbor for ${e.business} ends on ${f.date(e.startsOn)}. Your ${e.planName} plan then starts automatically and we will charge ${f.money(e.amount)} per ${COPY.en.interval[e.interval]}${e.taxAdded ? ' plus applicable tax' : ''} to the card ending ${e.last4 ?? '••••'}.`,
        `Don’t want to continue? Cancel before ${f.date(e.startsOn)} in Settings → Billing. There is no cancellation fee, and you can export your data for free.`,
      ],
    },
    converted: {
      subject: 'Your BranchHarbor plan has started',
      body: (e) => [`Your trial has ended and your ${e.planName} plan for ${e.business} has started. Invoices are in Settings → Billing.`, 'Cancel any time; there is no cancellation fee.'],
    },
    failed: {
      subject: 'We couldn’t take your BranchHarbor payment',
      body: (e, f) => [
        e.franchisee ? `We couldn’t charge ${f.money(e.amount)} for your location fees in ${e.business}.` : `We couldn’t charge ${f.money(e.amount)} for your BranchHarbor plan for ${e.business}.`,
        'Please update your card in Settings → Billing. We’ll try again automatically; your data stays safe in the meantime.',
      ],
    },
    changed: {
      subject: (p) => `Your BranchHarbor plan is now ${p}`,
      body: (e, f) => [
        `${e.business} is now on the ${e.planName} plan at ${f.money(e.amount)} per ${COPY.en.interval[e.interval]}.`,
        e.chargedNow && e.prorationNow && e.prorationNow.amountMinor > 0 ? `Your new billing period starts today: we charged ${f.money(e.prorationNow)} now, less the unused part of your previous period.`
          : e.prorationNow && e.prorationNow.amountMinor > 0 ? `The difference for the rest of this period, ${f.money(e.prorationNow)}, is added to your next invoice.` : 'Any unused time on your previous plan is credited to your next invoice.',
      ],
    },
    exportReady: {
      subject: 'Your BranchHarbor data export is ready',
      body: (e, f) => [
        `Your data export for ${e.business} is ready: ${e.files} CSV files in one ZIP (${e.sizeKb} KB).`,
        `The download link works until ${f.date(e.expiresOn)}. You can also download it from Settings → Export your data while it is valid. Exports are free.`,
      ],
    },
  },
  fr: {
    hi: (n) => `Bonjour ${n},`,
    footer: (b) => `Vous recevez cet e-mail car vous gérez la facturation de ${b} sur BranchHarbor.`,
    interval: { month: 'mois', year: 'an' },
    button: { billing: 'Ouvrir Paramètres → Facturation', download: 'Télécharger vos données' },
    trialStarted: {
      subject: 'Votre essai BranchHarbor de 14 jours a commencé',
      body: (e, f) => [
        `Merci d’avoir commencé votre essai de 14 jours pour ${e.business} sur BranchHarbor. Nous avons prélevé ${f.money(e.trialFee)} pour l’essai.`,
        `Votre formule ${e.planName} démarre automatiquement le ${f.date(e.startsOn)} à ${f.money(e.amount)} par ${COPY.fr.interval[e.interval]}${e.taxAdded ? ', taxes applicables en sus' : ''}, sauf si vous résiliez avant dans Paramètres → Facturation. Nous vous le rappellerons 3 jours et 1 jour avant.`,
        'Aucuns frais de résiliation, et vous pouvez exporter vos données gratuitement à tout moment.',
      ],
    },
    planStarted: {
      subject: 'Votre formule BranchHarbor a démarré',
      body: (e, f) => [
        `Votre formule ${e.planName} pour ${e.business} a démarré (un essai a déjà été utilisé pour cette entreprise, cette carte ou ce domaine e-mail). Nous avons prélevé ${f.money(e.amount)} pour le premier ${COPY.fr.interval[e.interval]}.`,
        'Résiliez à tout moment dans Paramètres → Facturation ; aucuns frais de résiliation.',
      ],
    },
    reminder: {
      subject: (d, date) => (d === 1 ? `Votre essai BranchHarbor se termine demain (${date})` : `Votre essai BranchHarbor se termine dans ${d} jours (${date})`),
      body: (e, f) => [
        `Votre essai de 14 jours de BranchHarbor pour ${e.business} se termine le ${f.date(e.startsOn)}. Votre formule ${e.planName} démarre alors automatiquement et nous prélèverons ${f.money(e.amount)} par ${COPY.fr.interval[e.interval]}${e.taxAdded ? ', taxes applicables en sus' : ''} sur la carte se terminant par ${e.last4 ?? '••••'}.`,
        `Vous ne souhaitez pas continuer ? Résiliez avant le ${f.date(e.startsOn)} dans Paramètres → Facturation. Aucuns frais de résiliation, et l’export de vos données est gratuit.`,
      ],
    },
    converted: {
      subject: 'Votre formule BranchHarbor a démarré',
      body: (e) => [`Votre essai est terminé et votre formule ${e.planName} pour ${e.business} a démarré. Les factures sont dans Paramètres → Facturation.`, 'Résiliez à tout moment ; aucuns frais de résiliation.'],
    },
    failed: {
      subject: 'Nous n’avons pas pu encaisser votre paiement BranchHarbor',
      body: (e, f) => [
        e.franchisee ? `Nous n’avons pas pu prélever ${f.money(e.amount)} pour les frais de vos sites chez ${e.business}.` : `Nous n’avons pas pu prélever ${f.money(e.amount)} pour votre formule BranchHarbor de ${e.business}.`,
        'Mettez à jour votre carte dans Paramètres → Facturation. Nous réessaierons automatiquement ; vos données restent en sécurité entre-temps.',
      ],
    },
    changed: {
      subject: (p) => `Votre formule BranchHarbor est maintenant ${p}`,
      body: (e, f) => [
        `${e.business} est maintenant en formule ${e.planName} à ${f.money(e.amount)} par ${COPY.fr.interval[e.interval]}.`,
        e.chargedNow && e.prorationNow && e.prorationNow.amountMinor > 0 ? `Votre nouvelle période de facturation commence aujourd’hui : nous avons prélevé ${f.money(e.prorationNow)} maintenant, déduction faite de la partie non utilisée de votre période précédente.`
          : e.prorationNow && e.prorationNow.amountMinor > 0 ? `La différence pour le reste de cette période, ${f.money(e.prorationNow)}, est ajoutée à votre prochaine facture.` : 'Le temps non utilisé de votre formule précédente est crédité sur votre prochaine facture.',
      ],
    },
    exportReady: {
      subject: 'Votre export de données BranchHarbor est prêt',
      body: (e, f) => [
        `Votre export de données pour ${e.business} est prêt : ${e.files} fichiers CSV dans un ZIP (${e.sizeKb} Ko).`,
        `Le lien de téléchargement fonctionne jusqu’au ${f.date(e.expiresOn)}. Vous pouvez aussi le télécharger depuis Paramètres → Exporter vos données tant qu’il est valide. Les exports sont gratuits.`,
      ],
    },
  },
  es: {
    hi: (n) => `Hola ${n}:`,
    footer: (b) => `Recibes este correo porque gestionas la facturación de ${b} en BranchHarbor.`,
    interval: { month: 'mes', year: 'año' },
    button: { billing: 'Abrir Ajustes → Facturación', download: 'Descargar tus datos' },
    trialStarted: {
      subject: 'Tu prueba de 14 días de BranchHarbor ha comenzado',
      body: (e, f) => [
        `Gracias por empezar tu prueba de 14 días de ${e.business} en BranchHarbor. Hemos cobrado ${f.money(e.trialFee)} por la prueba.`,
        `Tu plan ${e.planName} empieza automáticamente el ${f.date(e.startsOn)} por ${f.money(e.amount)} al ${COPY.es.interval[e.interval]}${e.taxAdded ? ' más los impuestos aplicables' : ''}, salvo que lo canceles antes en Ajustes → Facturación. Te lo recordaremos 3 días y 1 día antes.`,
        'No hay penalización por cancelar y puedes exportar tus datos gratis en cualquier momento.',
      ],
    },
    planStarted: {
      subject: 'Tu plan de BranchHarbor ha comenzado',
      body: (e, f) => [
        `Tu plan ${e.planName} para ${e.business} ha comenzado (ya se usó una prueba para este negocio, esta tarjeta o este dominio de correo). Hemos cobrado ${f.money(e.amount)} por el primer ${COPY.es.interval[e.interval]}.`,
        'Cancela cuando quieras en Ajustes → Facturación; no hay penalización.',
      ],
    },
    reminder: {
      subject: (d, date) => (d === 1 ? `Tu prueba de BranchHarbor termina mañana (${date})` : `Tu prueba de BranchHarbor termina en ${d} días (${date})`),
      body: (e, f) => [
        `Tu prueba de 14 días de BranchHarbor para ${e.business} termina el ${f.date(e.startsOn)}. Entonces tu plan ${e.planName} empieza automáticamente y cobraremos ${f.money(e.amount)} al ${COPY.es.interval[e.interval]}${e.taxAdded ? ' más los impuestos aplicables' : ''} en la tarjeta terminada en ${e.last4 ?? '••••'}.`,
        `¿No quieres continuar? Cancela antes del ${f.date(e.startsOn)} en Ajustes → Facturación. No hay penalización y puedes exportar tus datos gratis.`,
      ],
    },
    converted: {
      subject: 'Tu plan de BranchHarbor ha comenzado',
      body: (e) => [`Tu prueba ha terminado y tu plan ${e.planName} para ${e.business} ha comenzado. Las facturas están en Ajustes → Facturación.`, 'Cancela cuando quieras; no hay penalización.'],
    },
    failed: {
      subject: 'No pudimos cobrar tu pago de BranchHarbor',
      body: (e, f) => [
        e.franchisee ? `No pudimos cobrar ${f.money(e.amount)} por las cuotas de tus ubicaciones en ${e.business}.` : `No pudimos cobrar ${f.money(e.amount)} por tu plan de BranchHarbor para ${e.business}.`,
        'Actualiza tu tarjeta en Ajustes → Facturación. Lo intentaremos de nuevo automáticamente; tus datos siguen seguros mientras tanto.',
      ],
    },
    changed: {
      subject: (p) => `Tu plan de BranchHarbor ahora es ${p}`,
      body: (e, f) => [
        `${e.business} está ahora en el plan ${e.planName} por ${f.money(e.amount)} al ${COPY.es.interval[e.interval]}.`,
        e.chargedNow && e.prorationNow && e.prorationNow.amountMinor > 0 ? `Tu nuevo periodo de facturación empieza hoy: hemos cobrado ${f.money(e.prorationNow)} ahora, descontando la parte no usada de tu periodo anterior.`
          : e.prorationNow && e.prorationNow.amountMinor > 0 ? `La diferencia por el resto de este periodo, ${f.money(e.prorationNow)}, se añade a tu próxima factura.` : 'El tiempo no usado de tu plan anterior se abona en tu próxima factura.',
      ],
    },
    exportReady: {
      subject: 'Tu exportación de datos de BranchHarbor está lista',
      body: (e, f) => [
        `Tu exportación de datos de ${e.business} está lista: ${e.files} archivos CSV en un ZIP (${e.sizeKb} KB).`,
        `El enlace de descarga funciona hasta el ${f.date(e.expiresOn)}. También puedes descargarla en Ajustes → Exportar tus datos mientras sea válida. Las exportaciones son gratuitas.`,
      ],
    },
  },
  de: {
    hi: (n) => `Hallo ${n},`,
    footer: (b) => `Sie erhalten diese E-Mail, weil Sie die Abrechnung von ${b} bei BranchHarbor verwalten.`,
    interval: { month: 'Monat', year: 'Jahr' },
    button: { billing: 'Einstellungen → Abrechnung öffnen', download: 'Daten herunterladen' },
    trialStarted: {
      subject: 'Ihr 14-tägiger BranchHarbor-Test hat begonnen',
      body: (e, f) => [
        `Danke, dass Sie Ihren 14-tägigen Test für ${e.business} bei BranchHarbor gestartet haben. Wir haben ${f.money(e.trialFee)} für den Test berechnet.`,
        `Ihr Tarif ${e.planName} beginnt automatisch am ${f.date(e.startsOn)} für ${f.money(e.amount)} pro ${COPY.de.interval[e.interval]}${e.taxAdded ? ' zuzüglich anfallender Steuern' : ''}, sofern Sie nicht vorher unter Einstellungen → Abrechnung kündigen. Wir erinnern Sie 3 Tage und 1 Tag vorher.`,
        'Es gibt keine Kündigungsgebühr, und Sie können Ihre Daten jederzeit kostenlos exportieren.',
      ],
    },
    planStarted: {
      subject: 'Ihr BranchHarbor-Tarif hat begonnen',
      body: (e, f) => [
        `Ihr Tarif ${e.planName} für ${e.business} hat begonnen (für dieses Unternehmen, diese Karte oder diese E-Mail-Domain wurde bereits ein Test genutzt). Wir haben ${f.money(e.amount)} für den ersten ${COPY.de.interval[e.interval]} berechnet.`,
        'Sie können jederzeit unter Einstellungen → Abrechnung kündigen; es gibt keine Kündigungsgebühr.',
      ],
    },
    reminder: {
      subject: (d, date) => (d === 1 ? `Ihr BranchHarbor-Test endet morgen (${date})` : `Ihr BranchHarbor-Test endet in ${d} Tagen (${date})`),
      body: (e, f) => [
        `Ihr 14-tägiger BranchHarbor-Test für ${e.business} endet am ${f.date(e.startsOn)}. Danach beginnt Ihr Tarif ${e.planName} automatisch und wir berechnen ${f.money(e.amount)} pro ${COPY.de.interval[e.interval]}${e.taxAdded ? ' zuzüglich anfallender Steuern' : ''} auf die Karte mit der Endung ${e.last4 ?? '••••'}.`,
        `Sie möchten nicht weitermachen? Kündigen Sie vor dem ${f.date(e.startsOn)} unter Einstellungen → Abrechnung. Es gibt keine Kündigungsgebühr, und der Datenexport ist kostenlos.`,
      ],
    },
    converted: {
      subject: 'Ihr BranchHarbor-Tarif hat begonnen',
      body: (e) => [`Ihr Test ist beendet und Ihr Tarif ${e.planName} für ${e.business} hat begonnen. Rechnungen finden Sie unter Einstellungen → Abrechnung.`, 'Sie können jederzeit kündigen; es gibt keine Kündigungsgebühr.'],
    },
    failed: {
      subject: 'Wir konnten Ihre BranchHarbor-Zahlung nicht einziehen',
      body: (e, f) => [
        e.franchisee ? `Wir konnten ${f.money(e.amount)} für Ihre Standortgebühren bei ${e.business} nicht einziehen.` : `Wir konnten ${f.money(e.amount)} für Ihren BranchHarbor-Tarif für ${e.business} nicht einziehen.`,
        'Bitte aktualisieren Sie Ihre Karte unter Einstellungen → Abrechnung. Wir versuchen es automatisch erneut; Ihre Daten bleiben in der Zwischenzeit sicher.',
      ],
    },
    changed: {
      subject: (p) => `Ihr BranchHarbor-Tarif ist jetzt ${p}`,
      body: (e, f) => [
        `${e.business} nutzt jetzt den Tarif ${e.planName} für ${f.money(e.amount)} pro ${COPY.de.interval[e.interval]}.`,
        e.chargedNow && e.prorationNow && e.prorationNow.amountMinor > 0 ? `Ihr neuer Abrechnungszeitraum beginnt heute: Wir haben jetzt ${f.money(e.prorationNow)} abgebucht, abzüglich des nicht genutzten Teils Ihres bisherigen Zeitraums.`
          : e.prorationNow && e.prorationNow.amountMinor > 0 ? `Die Differenz für den Rest dieses Zeitraums, ${f.money(e.prorationNow)}, kommt auf Ihre nächste Rechnung.` : 'Nicht genutzte Zeit Ihres bisherigen Tarifs wird Ihrer nächsten Rechnung gutgeschrieben.',
      ],
    },
    exportReady: {
      subject: 'Ihr BranchHarbor-Datenexport ist fertig',
      body: (e, f) => [
        `Ihr Datenexport für ${e.business} ist fertig: ${e.files} CSV-Dateien in einer ZIP-Datei (${e.sizeKb} KB).`,
        `Der Download-Link funktioniert bis zum ${f.date(e.expiresOn)}. Solange er gültig ist, finden Sie den Export auch unter Einstellungen → Daten exportieren. Exporte sind kostenlos.`,
      ],
    },
  },
  'pt-BR': {
    hi: (n) => `Olá, ${n},`,
    footer: (b) => `Você recebe este e-mail porque gerencia o faturamento de ${b} na BranchHarbor.`,
    interval: { month: 'mês', year: 'ano' },
    button: { billing: 'Abrir Configurações → Faturamento', download: 'Baixar seus dados' },
    trialStarted: {
      subject: 'Seu teste de 14 dias da BranchHarbor começou',
      body: (e, f) => [
        `Obrigado por começar seu teste de 14 dias de ${e.business} na BranchHarbor. Cobramos ${f.money(e.trialFee)} pelo teste.`,
        `Seu plano ${e.planName} começa automaticamente em ${f.date(e.startsOn)} por ${f.money(e.amount)} por ${COPY['pt-BR'].interval[e.interval]}${e.taxAdded ? ' mais os impostos aplicáveis' : ''}, a menos que você cancele antes em Configurações → Faturamento. Vamos lembrar você 3 dias e 1 dia antes.`,
        'Não há multa de cancelamento, e você pode exportar seus dados gratuitamente a qualquer momento.',
      ],
    },
    planStarted: {
      subject: 'Seu plano da BranchHarbor começou',
      body: (e, f) => [
        `Seu plano ${e.planName} para ${e.business} começou (um teste já foi usado para esta empresa, este cartão ou este domínio de e-mail). Cobramos ${f.money(e.amount)} pelo primeiro ${COPY['pt-BR'].interval[e.interval]}.`,
        'Cancele quando quiser em Configurações → Faturamento; não há multa de cancelamento.',
      ],
    },
    reminder: {
      subject: (d, date) => (d === 1 ? `Seu teste da BranchHarbor termina amanhã (${date})` : `Seu teste da BranchHarbor termina em ${d} dias (${date})`),
      body: (e, f) => [
        `Seu teste de 14 dias da BranchHarbor para ${e.business} termina em ${f.date(e.startsOn)}. Depois disso, seu plano ${e.planName} começa automaticamente e cobraremos ${f.money(e.amount)} por ${COPY['pt-BR'].interval[e.interval]}${e.taxAdded ? ' mais os impostos aplicáveis' : ''} no cartão final ${e.last4 ?? '••••'}.`,
        `Não quer continuar? Cancele antes de ${f.date(e.startsOn)} em Configurações → Faturamento. Não há multa de cancelamento, e exportar seus dados é gratuito.`,
      ],
    },
    converted: {
      subject: 'Seu plano da BranchHarbor começou',
      body: (e) => [`Seu teste terminou e seu plano ${e.planName} para ${e.business} começou. As faturas estão em Configurações → Faturamento.`, 'Cancele quando quiser; não há multa de cancelamento.'],
    },
    failed: {
      subject: 'Não conseguimos cobrar seu pagamento da BranchHarbor',
      body: (e, f) => [
        e.franchisee ? `Não conseguimos cobrar ${f.money(e.amount)} pelas taxas das suas unidades em ${e.business}.` : `Não conseguimos cobrar ${f.money(e.amount)} pelo seu plano da BranchHarbor para ${e.business}.`,
        'Atualize seu cartão em Configurações → Faturamento. Tentaremos de novo automaticamente; seus dados continuam seguros enquanto isso.',
      ],
    },
    changed: {
      subject: (p) => `Seu plano da BranchHarbor agora é ${p}`,
      body: (e, f) => [
        `${e.business} agora está no plano ${e.planName} por ${f.money(e.amount)} por ${COPY['pt-BR'].interval[e.interval]}.`,
        e.chargedNow && e.prorationNow && e.prorationNow.amountMinor > 0 ? `Seu novo período de cobrança começa hoje: cobramos ${f.money(e.prorationNow)} agora, descontada a parte não usada do período anterior.`
          : e.prorationNow && e.prorationNow.amountMinor > 0 ? `A diferença pelo restante deste período, ${f.money(e.prorationNow)}, entra na sua próxima fatura.` : 'O tempo não usado do seu plano anterior é creditado na sua próxima fatura.',
      ],
    },
    exportReady: {
      subject: 'Sua exportação de dados da BranchHarbor está pronta',
      body: (e, f) => [
        `Sua exportação de dados de ${e.business} está pronta: ${e.files} arquivos CSV em um ZIP (${e.sizeKb} KB).`,
        `O link de download funciona até ${f.date(e.expiresOn)}. Você também pode baixá-la em Configurações → Exportar seus dados enquanto for válida. As exportações são gratuitas.`,
      ],
    },
  },
};

const esc = (v: string) => v.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

export interface RenderedBillingEmail { subject: string; text: string; html: string; locale: BillingEmailLocale }

/** Renders a billing email for one recipient in their language. */
export async function renderBillingEmail(e: BillingEmail, to: { name: string; locale: string | null | undefined }): Promise<RenderedBillingEmail> {
  const locale = billingLocale(to.locale);
  const c = COPY[locale];
  const f: Fmt = {
    money: (m) => formatMoney({ amount: m.amountMinor, currency: m.currency as Currency }, locale),
    date: (d) => new Intl.DateTimeFormat(locale, { day: 'numeric', month: 'long', year: 'numeric', timeZone: 'UTC' }).format(d),
  };
  let subject: string;
  let paras: string[];
  let cta: { label: string; url: string } | null = null;
  switch (e.kind) {
    case 'trial_started': subject = c.trialStarted.subject; paras = c.trialStarted.body(e, f); cta = { label: c.button.billing, url: e.billingUrl }; break;
    case 'plan_started': subject = c.planStarted.subject; paras = c.planStarted.body(e, f); cta = { label: c.button.billing, url: e.billingUrl }; break;
    case 'trial_reminder': subject = c.reminder.subject(e.days, f.date(e.startsOn)); paras = c.reminder.body(e, f); cta = { label: c.button.billing, url: e.billingUrl }; break;
    case 'trial_converted': subject = c.converted.subject; paras = c.converted.body(e); cta = { label: c.button.billing, url: e.billingUrl }; break;
    case 'payment_failed': subject = c.failed.subject; paras = c.failed.body(e, f); cta = { label: c.button.billing, url: e.billingUrl }; break;
    case 'plan_changed': subject = c.changed.subject(e.planName); paras = c.changed.body(e, f); cta = { label: c.button.billing, url: e.billingUrl }; break;
    case 'export_ready': subject = c.exportReady.subject; paras = c.exportReady.body(e, f); cta = { label: c.button.download, url: e.link }; break;
  }
  const out = await renderSimpleEmail({ locale, subject, greeting: c.hi(to.name), paragraphs: paras, cta, footer: c.footer(e.business) });
  return { ...out, locale };
}

/**
 * The BranchHarbor email layout (MJML, the same look as the billing emails) with a plain-text part: a greeting, the
 * paragraphs, an optional button and a footer. Text is escaped; callers pass it already in the recipient's language.
 */
export async function renderSimpleEmail(m: { locale: string; subject: string; greeting: string; paragraphs: string[]; cta: { label: string; url: string } | null; footer: string }): Promise<{ subject: string; text: string; html: string }> {
  const { locale, subject, paragraphs: paras, cta, footer } = m;
  const text = [m.greeting, '', ...paras.flatMap((p) => [p, '']), ...(cta ? [`${cta.label}: ${cta.url}`, ''] : []), '— BranchHarbor', '', footer, ''].join('\n');
  const mjml = `<mjml lang="${esc(locale)}"><mj-head><mj-title>${esc(subject)}</mj-title><mj-attributes><mj-all font-family="Helvetica, Arial, sans-serif" /><mj-text font-size="15px" line-height="1.55" color="#1c1c1a" /></mj-attributes></mj-head>
<mj-body background-color="#f4f2ec"><mj-section padding="24px 0 8px"><mj-column><mj-text font-size="18px" font-weight="700">BranchHarbor</mj-text></mj-column></mj-section>
<mj-section background-color="#ffffff" border-radius="16px" padding="20px 8px"><mj-column>
<mj-text>${esc(m.greeting)}</mj-text>
${paras.map((p) => `<mj-text>${esc(p)}</mj-text>`).join('\n')}
${cta ? `<mj-button href="${esc(cta.url)}" background-color="#1c1c1a" color="#ffffff" border-radius="999px" font-weight="700" align="left">${esc(cta.label)}</mj-button>` : ''}
</mj-column></mj-section>
<mj-section padding="12px 0 24px"><mj-column><mj-text font-size="12px" color="#6b6a64">${esc(footer)}</mj-text></mj-column></mj-section></mj-body></mjml>`;
  const html = (await mjml2html(mjml, { validationLevel: 'soft' })).html;
  return { subject, text, html };
}

/** Sends a billing email to each recipient in their own language. Never throws (billing must not fail on email). */
export async function sendBillingEmails(s: { mailer: { send: (m: { to: string; subject: string; text: string; html?: string; tag?: string }) => Promise<unknown> }; log: { warn: (o: object, m: string) => void } }, to: { email: string; name: string; locale: string | null }[], tag: string, e: BillingEmail) {
  for (const r of to) {
    try {
      const m = await renderBillingEmail(e, r);
      await s.mailer.send({ to: r.email, tag, subject: m.subject, text: m.text, html: m.html });
    } catch (err) {
      s.log.warn({ err, tag }, '[billing] email failed');
    }
  }
}
