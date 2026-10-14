import type { FastifyPluginAsyncZod } from 'fastify-type-provider-zod';
import { foodMenuAdminRoutes } from './foods-menu-admin.ts';
import { foodOpsRoutes } from './foods-ops.ts';
import { foodPlanRoutes } from './foods-plans.ts';
import { foodPublicRoutes } from './foods-public.ts';

/**
 * Foods — full product routes (delivery, dine-in, preorders & catering, meal plans, KDS stations,
 * delivery handoff, ingredient inventory, reports, AI drafts). First-release foods routes stay in foods.ts.
 */
export const foodsExtRoutes: FastifyPluginAsyncZod = async (app) => {
  await app.register(foodPublicRoutes);
  await app.register(foodMenuAdminRoutes);
  await app.register(foodOpsRoutes);
  await app.register(foodPlanRoutes);
};
