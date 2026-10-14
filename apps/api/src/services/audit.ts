import type { FastifyRequest } from 'fastify';
import type { Exec } from '../db/client.ts';
import { auditEvents } from '../db/schema/index.ts';

export interface AuditInput {
  organizationId: string | null;
  actorUserId: string | null;
  actorType?: 'user' | 'system' | 'webhook' | 'ai';
  action: string;
  scopeKind?: string | null;
  scopeId?: string | null;
  targetType?: string | null;
  targetId?: string | null;
  metadata?: Record<string, unknown>;
  ip?: string | null;
}

/** Records who did what, in which scope, to which record. Call inside the same transaction as the change. */
export async function audit(db: Exec, e: AuditInput) {
  await db.insert(auditEvents).values({
    organizationId: e.organizationId,
    actorUserId: e.actorUserId,
    actorType: e.actorType ?? (e.actorUserId ? 'user' : 'system'),
    action: e.action,
    scopeKind: e.scopeKind ?? null,
    scopeId: e.scopeId ?? null,
    targetType: e.targetType ?? null,
    targetId: e.targetId ?? null,
    metadata: e.metadata ?? {},
    ip: e.ip ?? null,
  });
}

export const actor = (req: FastifyRequest) => ({ actorUserId: req.user?.id ?? null, ip: req.ip });
