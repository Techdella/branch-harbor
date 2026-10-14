/** robots.txt for the bare included host. Each brand serves its own at /{brand}/robots.txt (and /robots.txt on its domains). */
export function GET() {
  return new Response('User-agent: *\nDisallow: /api/\n', { headers: { 'content-type': 'text/plain; charset=utf-8' } });
}
