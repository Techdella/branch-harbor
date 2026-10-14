import { hash, verify } from '@node-rs/argon2';
import { and, eq, isNull, sql } from 'drizzle-orm';
import type { FastifyReply, FastifyRequest } from 'fastify';
import type { Services } from '../context.ts';
import type { Exec } from '../db/client.ts';
import { emailVerificationTokens, refreshTokens, users } from '../db/schema/index.ts';
import { randomToken, sha256 } from '../lib/crypto.ts';
import { unauthorized } from '../lib/errors.ts';
import { signAccessToken, type AuthUser } from '../plugins/auth.ts';

export const REFRESH_COOKIE = 'bh_refresh';
const ARGON_OPTS = { memoryCost: 19456, timeCost: 2, parallelism: 1 } as const;
// Hash of a random string used to equalise timing when the email does not exist.
let dummyHash: Promise<string> | null = null;

export const hashPassword = (pw: string) => hash(pw, ARGON_OPTS);
export async function verifyPassword(stored: string | null, pw: string): Promise<boolean> {
  if (!stored) {
    dummyHash ??= hash(randomToken(), ARGON_OPTS);
    await verify(await dummyHash, pw).catch(() => false);
    return false;
  }
  return verify(stored, pw).catch(() => false);
}

export async function findUserByEmail(db: Exec, email: string) {
  const [u] = await db.select().from(users).where(sql`lower(${users.email}) = ${email.toLowerCase()}`);
  return u ?? null;
}

export async function createVerificationToken(db: Exec, userId: string) {
  const token = randomToken();
  await db.insert(emailVerificationTokens).values({ userId, tokenHash: sha256(token), expiresAt: new Date(Date.now() + 48 * 3600_000) });
  return token;
}

export async function sendVerificationEmail(s: Services, to: string, name: string, token: string) {
  const link = `${s.cfg.APP_URL}/verify-email?token=${encodeURIComponent(token)}`;
  await s.jobs.enqueue('email.send', {
    to,
    subject: 'Verify your BranchHarbor email',
    text: `Hi ${name},\n\nConfirm your email address to finish setting up BranchHarbor:\n${link}\n\nThis link expires in 48 hours.`,
    tag: 'verify-email',
  });
}

export interface IssuedTokens {
  accessToken: string;
  accessTokenExpiresIn: number;
  refreshToken: string;
  refreshTokenExpiresAt: Date;
}

export async function issueTokens(s: Services, user: AuthUser, req: FastifyRequest, familyId?: string, db: Exec = s.db): Promise<IssuedTokens & { refreshId: string }> {
  const refreshToken = randomToken(48);
  const expiresAt = new Date(Date.now() + s.cfg.REFRESH_TOKEN_TTL_DAYS * 86400_000);
  const [row] = await db
    .insert(refreshTokens)
    .values({ userId: user.id, tokenHash: sha256(refreshToken), familyId: familyId ?? crypto.randomUUID(), expiresAt, userAgent: req.headers['user-agent']?.slice(0, 300) ?? null, ip: req.ip })
    .returning({ id: refreshTokens.id });
  return { accessToken: await signAccessToken(s.cfg, user), accessTokenExpiresIn: s.cfg.ACCESS_TOKEN_TTL_SECONDS, refreshToken, refreshTokenExpiresAt: expiresAt, refreshId: row!.id };
}

/** Rotate a refresh token. Reuse of an already-rotated token revokes the whole family (theft detection). */
export async function rotateRefreshToken(s: Services, presented: string, req: FastifyRequest) {
  const out = await s.db.transaction(async (tx) => {
    const [row] = await tx.select().from(refreshTokens).where(eq(refreshTokens.tokenHash, sha256(presented))).for('update');
    if (!row) throw unauthorized('Session not found. Please sign in again.');
    if (row.revokedAt) {
      // Committed (not thrown inside the transaction) so the family revocation sticks.
      await tx.update(refreshTokens).set({ revokedAt: new Date() }).where(and(eq(refreshTokens.familyId, row.familyId), isNull(refreshTokens.revokedAt)));
      return { reused: true as const };
    }
    if (row.expiresAt <= new Date()) throw unauthorized('Session expired. Please sign in again.');
    const [u] = await tx.select().from(users).where(eq(users.id, row.userId));
    if (!u || u.deletedAt) throw unauthorized('Account unavailable');
    const authUser: AuthUser = { id: u.id, email: u.email, emailVerified: !!u.emailVerifiedAt };
    const issued = await issueTokens(s, authUser, req, row.familyId, tx);
    await tx.update(refreshTokens).set({ revokedAt: new Date(), replacedById: issued.refreshId }).where(eq(refreshTokens.id, row.id));
    return { reused: false as const, user: u, tokens: issued };
  });
  if (out.reused) throw unauthorized('Session was already used. Please sign in again.');
  return { user: out.user, tokens: out.tokens };
}

export async function revokeRefreshToken(s: Services, presented: string) {
  await s.db.update(refreshTokens).set({ revokedAt: new Date() }).where(and(eq(refreshTokens.tokenHash, sha256(presented)), isNull(refreshTokens.revokedAt)));
}

export function setRefreshCookie(s: Services, reply: FastifyReply, token: string, expires: Date) {
  reply.setCookie(REFRESH_COOKIE, token, {
    httpOnly: true,
    secure: s.cfg.COOKIE_SECURE || s.cfg.NODE_ENV === 'production',
    sameSite: 'lax',
    path: '/v1/auth',
    domain: s.cfg.COOKIE_DOMAIN,
    expires,
  });
}

export function clearRefreshCookie(s: Services, reply: FastifyReply) {
  reply.clearCookie(REFRESH_COOKIE, { path: '/v1/auth', domain: s.cfg.COOKIE_DOMAIN });
}

/** Mobile clients send `X-BH-Client: mobile` to receive the refresh token in the response body. */
export const wantsBodyToken = (req: FastifyRequest) => String(req.headers['x-bh-client'] ?? '').toLowerCase() === 'mobile';

export function serializeUser(u: typeof users.$inferSelect) {
  return { id: u.id, email: u.email, name: u.name, locale: u.locale, timeZone: u.timeZone, emailVerified: !!u.emailVerifiedAt, createdAt: u.createdAt.toISOString(), deletionRequestedAt: u.deletionRequestedAt?.toISOString() ?? null };
}
