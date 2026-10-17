#!/usr/bin/env node
/**
 * Writes Marina's press and social artwork to public/marina/: the round avatar in every mood and the full figure in
 * both poses, as standalone SVG files drawn from the same source as the product (packages/icons/src/marina.ts).
 * Usage: node --experimental-strip-types scripts/export-marina-art.mjs
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { MARINA_MOODS, marinaAvatarSvg, marinaFigureSvg } from '../../../packages/icons/src/marina.ts';

const out = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'public', 'marina');
fs.mkdirSync(out, { recursive: true });

/** Adds a size and an accessible title, so the file stands on its own outside the product. */
const standalone = (svg, w, h, title) => svg.replace('<svg ', `<svg width="${w}" height="${h}" role="img" aria-label="${title}" `).replace(/>/, `><title>${title}</title>`);

const files = [];
for (const mood of MARINA_MOODS) {
  files.push([`marina-avatar-${mood}.svg`, standalone(marinaAvatarSvg(mood), 512, 512, `Marina, the BranchHarbor assistant (${mood})`)]);
}
for (const pose of ['wave', 'hold']) {
  files.push([`marina-figure-${pose}.svg`, standalone(marinaFigureSvg('happy', pose), 960, 760, `Marina, the BranchHarbor assistant, ${pose === 'wave' ? 'waving' : 'holding her tablet'}`)]);
}
for (const [name, svg] of files) fs.writeFileSync(path.join(out, name), `${svg}\n`);
console.log(`Wrote ${files.length} files to ${path.relative(process.cwd(), out)}`);
