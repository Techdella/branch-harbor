import type { FastifyPluginAsyncZod } from 'fastify-type-provider-zod';
import { studioAdminRoutes } from './studios-admin.ts';
import { studioCustomerRoutes } from './studios-customer.ts';

/** Studios full product: schedule builder, series edits, rooms, packs/memberships, policies, members, online, reports, AI, customer portal. */
export const studioFullRoutes: FastifyPluginAsyncZod = async (app) => {
  await app.register(studioCustomerRoutes);
  await app.register(studioAdminRoutes);
};
