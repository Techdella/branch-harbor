export * from './paths';

/** The harbour mark: two posts (HQ and location) joined by one line; the lime hub is the platform. */
export function logoSvg({ size = 40, dark = false, stem = true }: { size?: number; dark?: boolean; stem?: boolean } = {}) {
  const bg = dark ? '#FFFFFF' : '#141414';
  const fg = dark ? '#141414' : '#FFFFFF';
  return `<svg width="${size}" height="${size}" viewBox="0 0 40 40" xmlns="http://www.w3.org/2000/svg" aria-hidden="true"><rect width="40" height="40" rx="12" fill="${bg}"/><path d="M11 11v18M29 11v18M11 20h18" stroke="${fg}" stroke-width="3.4" stroke-linecap="round" fill="none"/>${stem ? `<path d="M20 20 20 11" stroke="${fg}" stroke-width="3.4" stroke-linecap="round" opacity=".35"/>` : ''}<circle cx="20" cy="20" r="4.2" fill="#D6F26B"/></svg>`;
}
