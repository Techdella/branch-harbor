// Minimal static server for the Expo web export (single-page app: unknown paths fall back to index.html).
//   node serve-static.mjs <dist-dir> <port>
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';

const [rootArg, port = '6404'] = process.argv.slice(2);
const root = path.resolve(rootArg ?? 'dist');
const types = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.css': 'text/css', '.json': 'application/json', '.png': 'image/png', '.jpg': 'image/jpeg', '.svg': 'image/svg+xml', '.ttf': 'font/ttf', '.ico': 'image/x-icon', '.woff2': 'font/woff2' };

http
  .createServer((req, res) => {
    const p = decodeURIComponent(new URL(req.url, 'http://x').pathname);
    for (const c of [p, `${p}.html`, path.join(p, 'index.html'), '/index.html']) {
      const f = path.join(root, c);
      if (f.startsWith(root) && fs.existsSync(f) && fs.statSync(f).isFile()) {
        res.writeHead(200, { 'content-type': types[path.extname(f)] ?? 'application/octet-stream' });
        fs.createReadStream(f).pipe(res);
        return;
      }
    }
    res.writeHead(404);
    res.end('not found');
  })
  .listen(Number(port), () => console.log(`serving ${root} on :${port}`));
