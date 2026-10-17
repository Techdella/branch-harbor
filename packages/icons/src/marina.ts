/**
 * Marina, BranchHarbor's assistant, drawn as a sea otter: the harbour's friendliest local. Clever, uses tools,
 * keeps her things close and floats calmly through choppy water. She wears a lime guiding-star clip (the brand
 * signal, and the light she shines on your business).
 *
 * The artwork is plain SVG markup so every surface draws the same character: React on the web (`@bh/ui`
 * `MarinaAvatar` / `MarinaFigure`) and React Native (`SvgXml`) in the mobile app. No gradients or ids, so many
 * copies can sit on one page.
 */

export type MarinaMood = 'happy' | 'thinking' | 'celebrate' | 'concerned' | 'sleep';
export type MarinaPose = 'wave' | 'hold';

export const MARINA_MOODS: readonly MarinaMood[] = ['happy', 'thinking', 'celebrate', 'concerned', 'sleep'];

export const MARINA_COLORS = {
  fur: '#6E5240',
  furDark: '#4E3A2D',
  cream: '#F4E7D3',
  muzzle: '#FBF3E6',
  ink: '#141414',
  lime: '#D6F26B',
  blush: '#F2B8B5',
  whisker: '#B59C84',
  water: '#CDEEEE',
  waterMid: '#9FDCDC',
  waterDeep: '#7CCBCB',
} as const;

const C = MARINA_COLORS;

/** The head, in a 120×120 box (head spans roughly x 16–104, y 22–96). */
function headParts(mood: MarinaMood): string {
  const p: string[] = [];
  for (const x of [24, 96]) p.push(`<circle cx="${x}" cy="47" r="8" fill="${C.fur}"/><circle cx="${x}" cy="47" r="4" fill="${C.furDark}"/>`);
  p.push(`<path d="M60 31c25 0 41 13 41 33 0 20-17 32-41 32S19 84 19 64c0-20 16-33 41-33Z" fill="${C.fur}"/>`);
  p.push(`<path d="M60 54c-8 0-15-6-23-4-9 2-11 13-7 21 5 10 17 17 30 17s25-7 30-17c4-8 2-19-7-21-8-2-15 4-23 4Z" fill="${C.cream}"/>`);
  p.push(`<circle cx="52.5" cy="76" r="8.5" fill="${C.muzzle}"/><circle cx="67.5" cy="76" r="8.5" fill="${C.muzzle}"/>`);
  p.push(`<circle cx="36" cy="72" r="5" fill="${C.blush}" opacity=".85"/><circle cx="84" cy="72" r="5" fill="${C.blush}" opacity=".85"/>`);
  if (mood === 'celebrate') {
    p.push(`<path d="M41 61q5-6 10 0M69 61q5-6 10 0" fill="none" stroke="${C.ink}" stroke-width="3.4" stroke-linecap="round"/>`);
  } else if (mood === 'sleep') {
    p.push(`<path d="M41 61q5 5 10 0M69 61q5 5 10 0" fill="none" stroke="${C.ink}" stroke-width="3" stroke-linecap="round"/>`);
  } else {
    const [dx, dy] = mood === 'thinking' ? [1.6, -1.8] : [0, 0];
    for (const x of [46, 74]) p.push(`<circle cx="${x}" cy="61" r="6" fill="${C.ink}"/><circle cx="${x + 1.8 + dx}" cy="${59.2 + dy}" r="2" fill="#fff"/>`);
    // Worried brows: the inner ends lift.
    if (mood === 'concerned') p.push(`<path d="M38 52l11-4M82 52l-11-4" stroke="${C.furDark}" stroke-width="3" stroke-linecap="round"/>`);
  }
  p.push(`<path d="M53 69.2c0-2.4 3-3.4 7-3.4s7 1 7 3.4c0 2.8-3.6 5.2-7 5.2s-7-2.4-7-5.2Z" fill="${C.ink}"/><ellipse cx="57.6" cy="68.4" rx="1.8" ry="1" fill="#fff" opacity=".55"/>`);
  if (mood === 'celebrate') p.push(`<path d="M52 78q8 10 16 0Z" fill="${C.ink}"/><path d="M55.5 81.5q4.5 3 9 0" fill="none" stroke="#E87C79" stroke-width="2.4" stroke-linecap="round"/>`);
  else if (mood === 'concerned') p.push(`<path d="M54 81q6-3 12 0" fill="none" stroke="${C.ink}" stroke-width="2.4" stroke-linecap="round"/>`);
  else if (mood === 'thinking') p.push(`<path d="M56 80.5q4 1.5 8-1" fill="none" stroke="${C.ink}" stroke-width="2.4" stroke-linecap="round"/>`);
  else p.push(`<path d="M53 79q3.5 4 7 0q3.5 4 7 0" fill="none" stroke="${C.ink}" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"/>`);
  p.push(`<path d="M44 75l-17-3M44 79l-16 2M76 75l17-3M76 79l16 2" stroke="${C.whisker}" stroke-width="1.5" stroke-linecap="round"/>`);
  // The guiding-star clip.
  p.push(`<path class="bh-marina-star" d="M88 27c.8 4.4 2.9 6.5 7.3 7.3-4.4.8-6.5 2.9-7.3 7.3-.8-4.4-2.9-6.5-7.3-7.3 4.4-.8 6.5-2.9 7.3-7.3Z" fill="${C.lime}" stroke="${C.ink}" stroke-width="1.6" stroke-linejoin="round"/>`);
  if (mood === 'thinking') p.push(`<g class="bh-marina-dots"><circle cx="99" cy="20" r="2.2" fill="${C.lime}"/><circle cx="105" cy="14" r="1.6" fill="${C.lime}" opacity=".7"/></g>`);
  if (mood === 'sleep') p.push(`<path d="M99 17h5l-5 6h5" fill="none" stroke="${C.furDark}" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" opacity=".7"/>`);
  return p.join('');
}

/** Round avatar: Marina's head on a water-blue disc, cropped so her face fills it. */
export function marinaAvatarSvg(mood: MarinaMood = 'happy', opts: { background?: boolean } = {}): string {
  const bg = opts.background === false ? '' : `<circle cx="60" cy="62" r="48" fill="${C.water}"/>`;
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="12 14 96 96">${bg}${headParts(mood)}</svg>`;
}

/** Marina rising from the harbour, waving (or holding her tablet with both paws), for welcomes and empty states. */
export function marinaFigureSvg(mood: MarinaMood = 'happy', pose: MarinaPose = 'wave'): string {
  const p: string[] = [];
  p.push(`<path d="M78 210c-6-40 2-78 42-82 40 4 48 42 42 82Z" fill="${C.fur}"/>`);
  p.push(`<path d="M98 210c-3-28 4-55 22-57 18 2 25 29 22 57Z" fill="${C.cream}"/>`);
  p.push(`<g transform="rotate(-8 160 160)"><rect x="140" y="138" width="44" height="54" rx="8" fill="${C.ink}"/><rect x="145" y="143" width="34" height="40" rx="4" fill="${C.lime}"/><path d="M150 172l7-8 6 5 9-11" fill="none" stroke="${C.ink}" stroke-width="2.6" stroke-linecap="round" stroke-linejoin="round"/></g>`);
  p.push(`<ellipse cx="150" cy="172" rx="9" ry="8" fill="${C.fur}"/>`);
  if (pose === 'wave') {
    p.push(`<path d="M90 150c-14-10-23-26-26-42" fill="none" stroke="${C.fur}" stroke-width="15" stroke-linecap="round"/>`);
    p.push(`<g class="bh-marina-paw"><circle cx="63" cy="104" r="11" fill="${C.fur}"/><circle cx="57.5" cy="99" r="2.4" fill="${C.cream}"/><circle cx="63" cy="96.5" r="2.4" fill="${C.cream}"/><circle cx="68.5" cy="99" r="2.4" fill="${C.cream}"/><ellipse cx="63" cy="106" rx="4.5" ry="3.6" fill="${C.cream}"/></g>`);
    p.push(`<path d="M44 92q-6 8 0 16M38 86q-10 14 0 28" fill="none" stroke="${C.furDark}" stroke-width="2" stroke-linecap="round" opacity=".45"/>`);
  } else {
    p.push(`<ellipse cx="128" cy="176" rx="9" ry="8" fill="${C.fur}"/>`);
  }
  p.push(`<g transform="translate(60 38)">${headParts(mood)}</g>`);
  p.push(`<path d="M0 188c20-8 40-8 60 0s40 8 60 0 40-8 60 0 40 8 60 0V220H0Z" fill="${C.waterMid}"/>`);
  p.push(`<path d="M0 200c20-7 40-7 60 0s40 7 60 0 40-7 60 0 40 7 60 0V220H0Z" fill="${C.waterDeep}"/>`);
  p.push(`<path d="M96 192h22M132 198h14" stroke="#fff" stroke-width="3" stroke-linecap="round" opacity=".7"/>`);
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 30 240 190">${p.join('')}</svg>`;
}
