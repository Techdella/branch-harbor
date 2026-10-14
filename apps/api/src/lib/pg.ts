/** Postgres error helpers (drizzle wraps driver errors in `cause`). */
export function pgCode(err: unknown): string | undefined {
  const e = err as { code?: string; cause?: { code?: string } };
  return e?.cause?.code ?? e?.code;
}
export const isExclusionViolation = (err: unknown) => pgCode(err) === '23P01';
export const isUniqueViolation = (err: unknown) => pgCode(err) === '23505';
