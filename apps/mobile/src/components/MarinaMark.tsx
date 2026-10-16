import { memo } from 'react';
import { SvgXml } from 'react-native-svg';

/** Marina's mark (same artwork as `MarinaMark` in @bh/ui): a guiding light over the harbour, with its reflection. */
const xml = (small: boolean) => `<svg viewBox="0 0 40 40" xmlns="http://www.w3.org/2000/svg">
<defs>
<linearGradient id="bg" x1="8" y1="3" x2="32" y2="38" gradientUnits="userSpaceOnUse"><stop offset="0" stop-color="#253533"/><stop offset=".6" stop-color="#171A19"/><stop offset="1" stop-color="#141414"/></linearGradient>
<radialGradient id="glow" cx="20" cy="16" r="12.5" gradientUnits="userSpaceOnUse"><stop offset="0" stop-color="#D6F26B" stop-opacity=".5"/><stop offset="1" stop-color="#D6F26B" stop-opacity="0"/></radialGradient>
</defs>
<circle cx="20" cy="20" r="20" fill="url(#bg)"/>
<circle cx="20" cy="16" r="12.5" fill="url(#glow)"/>
<path d="M20 7c.9 5 3.3 7.4 8.3 8.3-5 .9-7.4 3.3-8.3 8.3-.9-5-3.3-7.4-8.3-8.3 5-.9 7.4-3.3 8.3-8.3Z" fill="#D6F26B"/>
${small ? '' : '<path d="M28.4 8.2c.22 1.25.82 1.85 2.07 2.07-1.25.22-1.85.82-2.07 2.07-.22-1.25-.82-1.85-2.07-2.07 1.25-.22 1.85-.82 2.07-2.07Z" fill="#FFFFFF" opacity=".85"/>'}
<path d="M7.8 26.6c4.1-2 8.1-2 12.2 0s8.1 2 12.2 0" fill="none" stroke="#FFFFFF" stroke-width="${small ? 2.4 : 1.8}" stroke-linecap="round"/>
<path d="M16.6 30.2h6.8" stroke="#D6F26B" stroke-width="${small ? 2.2 : 1.6}" stroke-linecap="round" opacity=".75"/>
${small ? '' : '<path d="M18.4 33.2h3.2" stroke="#D6F26B" stroke-width="1.4" stroke-linecap="round" opacity=".4"/>'}
</svg>`;
const SMALL = xml(true);
const LARGE = xml(false);

export const MarinaMark = memo(function MarinaMark({ size = 32 }: { size?: number }) {
  return <SvgXml xml={size < 24 ? SMALL : LARGE} width={size} height={size} accessible={false} />;
});
