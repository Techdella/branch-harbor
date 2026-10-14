import { SignJWT, jwtVerify } from 'jose';
import type { FastifyReply, FastifyRequest } from 'fastify';
import type { Config } from '../config.ts';
import { unauthorized } from '../lib/errors.ts';

export interface AuthUser {
  id: string;
  email: string;
  emailVerified: boolean;
}

declare module 'fastify' {
  interface FastifyRequest {
    user: AuthUser | null;
    /** Per-request cache of role assignments keyed by organisation id. */
    assignmentCache: Map<string, import('../domain/scope.ts').Assignment[]>;
  }
}

const secretKey = (cfg: Config) => new TextEncoder().encode(cfg.JWT_SECRET);

export async function signAccessToken(cfg: Config, user: AuthUser): Promise<string> {
  return new SignJWT({ email: user.email, ev: user.emailVerified })
    .setProtectedHeader({ alg: 'HS256' })
    .setSubject(user.id)
    .setIssuer(cfg.JWT_ISSUER)
    .setAudience('bh-api')
    .setIssuedAt()
    .setExpirationTime(`${cfg.ACCESS_TOKEN_TTL_SECONDS}s`)
    .sign(secretKey(cfg));
}

export async function verifyAccessToken(cfg: Config, token: string): Promise<AuthUser | null> {
  try {
    const { payload } = await jwtVerify(token, secretKey(cfg), { issuer: cfg.JWT_ISSUER, audience: 'bh-api' });
    if (!payload.sub) return null;
    return { id: payload.sub, email: String(payload.email ?? ''), emailVerified: payload.ev === true };
  } catch {
    return null;
  }
}

/** Parses a bearer token if present; never rejects. Routes that need a user use `authenticate`. */
export function optionalAuth(cfg: Config) {
  return async (req: FastifyRequest) => {
    req.user = null;
    req.assignmentCache = new Map();
    const header = req.headers.authorization;
    if (header?.startsWith('Bearer ')) req.user = await verifyAccessToken(cfg, header.slice(7));
  };
}

/** preHandler: requires a valid access token. Roles are NOT in the token — they are loaded from the DB per request, so revocation is immediate. */
export async function authenticate(req: FastifyRequest, _reply: FastifyReply) {
  if (!req.user) throw unauthorized();
}

export function requireUser(req: FastifyRequest): AuthUser {
  if (!req.user) throw unauthorized();
  return req.user;
}
