import { z } from 'zod';
import { apiError } from '@bh/shared';

export const uuid = z.uuid();
export const orgParams = z.object({ orgId: z.uuid() });
export const idParams = z.object({ orgId: z.uuid(), id: z.uuid() });
export const secured = [{ bearerAuth: [] }];
export const errorResponses = { 400: apiError, 401: apiError, 403: apiError, 404: apiError, 409: apiError };
export const iso = (d: Date | null | undefined) => (d ? d.toISOString() : null);
export const pageQuery = z.object({ limit: z.coerce.number().int().min(1).max(200).default(50), cursor: z.string().optional() });
export const isoDateTime = z.iso.datetime({ offset: true });
