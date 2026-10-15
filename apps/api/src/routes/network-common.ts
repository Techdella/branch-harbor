import { z } from 'zod';

/** Shared request schemas for the network workspaces (community, resources, training, help desk). */
export const audienceSchema = z.object({
  regionIds: z.array(z.uuid()).max(200).optional(),
  ownerGroupIds: z.array(z.uuid()).max(500).optional(),
  locationIds: z.array(z.uuid()).max(2000).optional(),
  roles: z.array(z.string().min(1).max(40)).max(20).optional(),
  hqOnly: z.boolean().optional(),
  userIds: z.array(z.uuid()).max(500).optional(),
});

export const attachmentSchema = z.object({
  name: z.string().trim().min(1).max(200),
  url: z.url().max(2000),
  mimeType: z.string().max(120).nullable().optional(),
  sizeBytes: z.number().int().min(0).max(1_000_000_000).nullable().optional(),
});
export const attachmentsSchema = z.array(attachmentSchema).max(10).default([]);

export const httpUrl = z.url({ protocol: /^https?$/ }).max(2000);
