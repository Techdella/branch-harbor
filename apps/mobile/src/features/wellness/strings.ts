import { useI18n } from '@/i18n';

/** Wellness strings (English; other languages fall back to English until translated). */
const en = {
  title: 'Wellness', book: 'Book', mine: 'My appointments', packages: 'Packages', location: 'Location', service: 'Service', option: 'Length', date: 'Date', time: 'Time',
  noSlots: 'No times on this day.', name: 'Your name', email: 'Your email', voucher: 'Gift voucher code (optional)', confirm: 'Book appointment', booked: 'Booked',
  depositDue: 'Deposit to pay now', dueAtVisit: 'Due at your visit', paySandbox: 'Simulate deposit payment (test mode)', paid: 'Deposit paid',
  adminOnly: 'We only ask what is needed to book — please don’t share health information.', timesIn: 'Times in', any: 'Any available practitioner',
  upcoming: 'Upcoming', past: 'Past', none: 'No appointments yet', signInNeeded: 'Sign in to see your appointments and packages.',
  cancel: 'Cancel', cancelFree: 'Free to cancel now', cancelLate: 'Late cancellation fee', confirmCancel: 'Cancel appointment', keep: 'Keep it', refund: 'Deposit refunded', kept: 'Deposit kept',
  reschedule: 'Change time', rescheduleBlocked: 'Changes this close to the appointment need a call to the team.', moved: 'Moved — the original was released after the new time was secured.',
  sessionsLeft: '{n} of {total} sessions left', expires: 'Expires', vouchers: 'Gift vouchers', balance: 'Balance', noPackages: 'No packages or vouchers',
  today: 'Today’s appointments', checkIn: 'Check in', checkedIn: 'Checked in', addNote: 'Add note', notePlaceholder: 'Administrative note (no clinical details)', confidential: 'Confidential (you and managers only)', saveNote: 'Save note', noteSaved: 'Note saved',
  nothingToday: 'No appointments today', notPractitioner: 'You are not set up as a practitioner yet.',
  utilisation: 'Utilisation', last7: 'Last 7 days', practitioners: 'Practitioners', rooms: 'Rooms & equipment', unavailable: 'Unavailable', avg: 'Average',
  error: 'Something went wrong', retry: 'Retry', wellnessCard: 'Spa & wellness appointments', wellnessCardSub: 'Book, reschedule, packages',
};
export type WKey = keyof typeof en;

export function useWT() {
  const { intlLocale } = useI18n();
  return {
    locale: intlLocale,
    t: (k: WKey, vars: Record<string, string | number> = {}) => en[k].replace(/\{(\w+)\}/g, (_, v: string) => String(vars[v] ?? '')),
  };
}
