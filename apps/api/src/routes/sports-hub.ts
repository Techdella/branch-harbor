import type { FastifyPluginAsyncZod } from 'fastify-type-provider-zod';
import { sportsAdminRoutes } from './sports-admin.ts';
import { sportsPortalRoutes } from './sports-portal.ts';
import { sportsScheduleRoutes } from './sports-schedule.ts';

/** Sports full product (setup wizard, fees/instalments, guardians, schedule, selection, reports, AI). */
export const sportsHubRoutes: FastifyPluginAsyncZod = async (app) => {
  await app.register(sportsAdminRoutes);
  await app.register(sportsScheduleRoutes);
  await app.register(sportsPortalRoutes);
};
