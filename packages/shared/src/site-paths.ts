/**
 * Customer sites: first path segments under `/{brand}/…` that belong to brand-level pages (franchise enquiry and
 * disclosure pages, property search, …), never to a location. Location slugs avoid them (the API adds a suffix), and
 * the sites app routes them before treating a segment as a location. One list, so features cannot collide.
 */
export const BRAND_RESERVED_PATHS = ['pages', 'sitemap.xml', 'robots.txt', 'properties', 'saved-search', 'franchise', 'courses'] as const;

export function isBrandReservedPath(segment: string): boolean {
  return (BRAND_RESERVED_PATHS as readonly string[]).includes(segment.toLowerCase());
}
