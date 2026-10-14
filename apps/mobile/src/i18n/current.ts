/**
 * Non-React access to the active language for the data layer (labels built while mapping API
 * responses). The provider in ./index registers itself; until then English is used.
 */
type Translate = (key: string, opts?: Record<string, unknown>) => string;
let locale = 'en';
let translate: Translate | null = null;

export function setCurrentI18n(next: string, t: Translate) {
  locale = next;
  translate = t;
}
/** BCP 47 tag of the language the user chose in the app. */
export const currentLocale = () => locale;
/** Translate a catalogue key in the current language; `fallback` is used before the provider mounts. */
export const tNow = (key: string, fallback: string, opts?: Record<string, unknown>) => (translate ? translate(key, opts) : fallback);
