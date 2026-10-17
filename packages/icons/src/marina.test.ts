import { test } from 'node:test';
import assert from 'node:assert/strict';
import { MARINA_MOODS, marinaAvatarSvg, marinaFigureSvg, type MarinaPose } from './marina.ts';

const POSES: MarinaPose[] = ['wave', 'hold'];
const isSvg = (s: string) => s.startsWith('<svg xmlns="http://www.w3.org/2000/svg"') && s.endsWith('</svg>');

test('every mood renders an avatar, with and without the water disc', () => {
  for (const mood of MARINA_MOODS) {
    const withBg = marinaAvatarSvg(mood);
    const bare = marinaAvatarSvg(mood, { background: false });
    assert.ok(isSvg(withBg), mood);
    assert.ok(isSvg(bare), mood);
    assert.ok(withBg.length > bare.length, `${mood}: the disc adds a shape`);
    assert.match(withBg, /bh-marina-star/, `${mood}: wears the guiding-star clip`);
  }
});

test('moods look different from each other', () => {
  const art = new Set(MARINA_MOODS.map((m) => marinaAvatarSvg(m)));
  assert.equal(art.size, MARINA_MOODS.length);
});

test('every mood renders in both figure poses', () => {
  for (const mood of MARINA_MOODS) {
    for (const pose of POSES) assert.ok(isSvg(marinaFigureSvg(mood, pose)), `${mood}/${pose}`);
  }
  assert.match(marinaFigureSvg('happy', 'wave'), /bh-marina-paw/);
  assert.doesNotMatch(marinaFigureSvg('happy', 'hold'), /bh-marina-paw/);
});

test('thinking and sleep carry their extra marks', () => {
  assert.match(marinaAvatarSvg('thinking'), /bh-marina-dots/);
  assert.doesNotMatch(marinaAvatarSvg('happy'), /bh-marina-dots/);
});

test('the markup has no ids, gradients or scripts, so many copies can share a page', () => {
  const all = [...MARINA_MOODS.flatMap((m) => [marinaAvatarSvg(m), marinaAvatarSvg(m, { background: false }), ...POSES.map((p) => marinaFigureSvg(m, p))])];
  for (const svg of all) {
    assert.doesNotMatch(svg, /\sid="/);
    assert.doesNotMatch(svg, /url\(#/);
    assert.doesNotMatch(svg, /<(linearGradient|radialGradient|script|defs|use)\b/);
    assert.doesNotMatch(svg, /\son\w+="/);
  }
});
