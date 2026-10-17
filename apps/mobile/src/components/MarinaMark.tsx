import { memo, useMemo } from 'react';
import { SvgXml } from 'react-native-svg';
import { marinaAvatarSvg, marinaFigureSvg, type MarinaMood, type MarinaPose } from '@bh/icons';

/** Marina, the otter (same artwork as `MarinaAvatar` in @bh/ui). */
export const MarinaAvatar = memo(function MarinaAvatar({ size = 32, mood = 'happy', bare }: { size?: number; mood?: MarinaMood; bare?: boolean }) {
  const xml = useMemo(() => marinaAvatarSvg(mood, { background: !bare }), [mood, bare]);
  return <SvgXml xml={xml} width={size} height={size} accessible={false} />;
});

/** Earlier name, kept so existing screens show Marina. */
export const MarinaMark = MarinaAvatar;

/** Marina rising from the harbour, for welcomes and empty states. */
export const MarinaFigure = memo(function MarinaFigure({ width = 200, mood = 'happy', pose = 'wave' }: { width?: number; mood?: MarinaMood; pose?: MarinaPose }) {
  const xml = useMemo(() => marinaFigureSvg(mood, pose), [mood, pose]);
  return <SvgXml xml={xml} width={width} height={Math.round(width * (190 / 240))} accessible={false} />;
});
