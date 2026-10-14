import { resolveLocale, type Locale } from '@bh/shared';

interface DemoCopy {
  nextStep: string;
  subject: string;
  body: (name: string, business: string) => string;
}

/** Requester-facing demo request copy. Explains the next step without promising a response time. */
const COPY: Record<Locale, DemoCopy> = {
  en: {
    nextStep: 'Our team will review your request and contact you by email to arrange a demo.',
    subject: 'Thanks for your interest in BranchHarbor',
    body: (n, b) => `Hi ${n},\n\nThanks for telling us about ${b}. A member of our team will review your request and contact you by email to arrange a demo.\n\n— BranchHarbor`,
  },
  'en-GB': {
    nextStep: 'Our team will review your request and contact you by email to arrange a demo.',
    subject: 'Thanks for your interest in BranchHarbor',
    body: (n, b) => `Hi ${n},\n\nThanks for telling us about ${b}. A member of our team will review your request and contact you by email to arrange a demo.\n\n— BranchHarbor`,
  },
  fr: {
    nextStep: 'Notre équipe va examiner votre demande et vous contactera par e-mail pour organiser une démo.',
    subject: 'Merci de votre intérêt pour BranchHarbor',
    body: (n, b) => `Bonjour ${n},\n\nMerci de nous avoir présenté ${b}. Un membre de notre équipe va examiner votre demande et vous contactera par e-mail pour organiser une démo.\n\n— BranchHarbor`,
  },
  es: {
    nextStep: 'Nuestro equipo revisará tu solicitud y te escribirá por correo para organizar una demo.',
    subject: 'Gracias por tu interés en BranchHarbor',
    body: (n, b) => `Hola ${n}:\n\nGracias por hablarnos de ${b}. Una persona de nuestro equipo revisará tu solicitud y te escribirá por correo para organizar una demo.\n\n— BranchHarbor`,
  },
  de: {
    nextStep: 'Unser Team prüft Ihre Anfrage und meldet sich per E-Mail, um eine Demo zu vereinbaren.',
    subject: 'Vielen Dank für Ihr Interesse an BranchHarbor',
    body: (n, b) => `Hallo ${n},\n\nvielen Dank, dass Sie uns von ${b} erzählt haben. Jemand aus unserem Team prüft Ihre Anfrage und meldet sich per E-Mail, um eine Demo zu vereinbaren.\n\n— BranchHarbor`,
  },
  'pt-BR': {
    nextStep: 'Nossa equipe vai analisar sua solicitação e entrar em contato por e-mail para agendar uma demonstração.',
    subject: 'Obrigado pelo seu interesse na BranchHarbor',
    body: (n, b) => `Olá, ${n},\n\nObrigado por nos contar sobre ${b}. Uma pessoa da nossa equipe vai analisar sua solicitação e entrar em contato por e-mail para agendar uma demonstração.\n\n— BranchHarbor`,
  },
  nl: {
    nextStep: 'Ons team bekijkt je aanvraag en neemt per e-mail contact op om een demo in te plannen.',
    subject: 'Bedankt voor je interesse in BranchHarbor',
    body: (n, b) => `Hoi ${n},\n\nBedankt dat je ons over ${b} hebt verteld. Iemand van ons team bekijkt je aanvraag en neemt per e-mail contact op om een demo in te plannen.\n\n— BranchHarbor`,
  },
  it: {
    nextStep: 'Il nostro team esaminerà la tua richiesta e ti contatterà via email per organizzare una demo.',
    subject: 'Grazie per il tuo interesse in BranchHarbor',
    body: (n, b) => `Ciao ${n},\n\ngrazie per averci parlato di ${b}. Una persona del nostro team esaminerà la tua richiesta e ti contatterà via email per organizzare una demo.\n\n— BranchHarbor`,
  },
  ar: {
    nextStep: 'سيراجع فريقنا طلبك ويتواصل معك عبر البريد الإلكتروني لترتيب عرض توضيحي.',
    subject: 'شكرًا لاهتمامك بـ BranchHarbor',
    body: (n, b) => `مرحبًا ${n}،\n\nشكرًا لإخبارنا عن ${b}. سيراجع أحد أعضاء فريقنا طلبك ويتواصل معك عبر البريد الإلكتروني لترتيب عرض توضيحي.\n\n— BranchHarbor`,
  },
};

export function demoRequestCopy(locale: string | null | undefined): DemoCopy {
  return COPY[resolveLocale(locale)];
}
