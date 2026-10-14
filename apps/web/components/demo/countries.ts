import { LAUNCH_COUNTRIES } from '@bh/shared';

/** Additional ISO 3166-1 alpha-2 codes offered after the launch countries. Names come from Intl.DisplayNames. */
const OTHER_CODES = [
  'AR', 'AT', 'BE', 'BG', 'CH', 'CL', 'CO', 'CR', 'CY', 'CZ', 'DK', 'DO', 'EC', 'EE', 'EG', 'FI', 'GR', 'HK', 'HR', 'HU',
  'ID', 'IL', 'IN', 'IS', 'JM', 'JP', 'KE', 'KR', 'KW', 'LT', 'LU', 'LV', 'MA', 'MT', 'MY', 'NO', 'OM', 'PA', 'PE', 'PH',
  'PL', 'PR', 'PT', 'QA', 'RO', 'RS', 'SA', 'SE', 'SI', 'SK', 'TH', 'TR', 'TT', 'TW', 'UA', 'UY', 'VN', 'ZA',
];

export function countryOptions(locale: string) {
  let dn: Intl.DisplayNames | null = null;
  try {
    dn = new Intl.DisplayNames([locale], { type: 'region' });
  } catch {
    dn = null;
  }
  const name = (code: string) => dn?.of(code) ?? code;
  const collator = new Intl.Collator(locale);
  const launch = LAUNCH_COUNTRIES.map((c) => ({ code: c.code as string, name: name(c.code) })).sort((a, b) => collator.compare(a.name, b.name));
  const launchCodes = new Set(launch.map((c) => c.code));
  const other = OTHER_CODES.filter((c) => !launchCodes.has(c))
    .map((code) => ({ code, name: name(code) }))
    .sort((a, b) => collator.compare(a.name, b.name));
  return { launch, other };
}
