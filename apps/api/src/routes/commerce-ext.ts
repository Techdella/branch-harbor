import type { FastifyPluginAsyncZod } from 'fastify-type-provider-zod';
import { expireReservations } from '../services/commerce-orders.ts';
import { commerceCatalogueRoutes } from './commerce-catalogue.ts';
import { commerceOperationsRoutes } from './commerce-operations.ts';
import { commerceStorefrontRoutes, commerceWebhookRoutes } from './commerce-storefront.ts';

/**
 * Commerce — full product: master catalogue & distribution, local assortment, native storefront ordering,
 * fulfilment, inventory (transfers, counts, purchasing), returns, gift cards / store credit, reports and AI.
 */
export const commerceExtRoutes: FastifyPluginAsyncZod = async (app) => {
  await app.register(commerceWebhookRoutes);
  await app.register(commerceStorefrontRoutes);
  await app.register(commerceCatalogueRoutes);
  await app.register(commerceOperationsRoutes);

  // Reservation sweep: unpaid checkouts release their stock (and payment intents) when the window ends.
  if (app.ctx.cfg.NODE_ENV !== 'test') {
    const timer = setInterval(() => void expireReservations(app.ctx).catch((err) => app.log.warn({ err }, 'commerce reservation sweep failed')), 60_000);
    timer.unref();
    app.addHook('onClose', async () => clearInterval(timer));
  }
};
