import type { FastifyPluginAsyncZod } from 'fastify-type-provider-zod';
import { publicRoutes } from './public.ts';
import { authRoutes } from './auth.ts';
import { meRoutes } from './me.ts';
import { orgRoutes } from './orgs.ts';
import { locationRoutes } from './locations.ts';
import { memberRoutes } from './members.ts';
import { websiteRoutes } from './websites.ts';
import { domainRoutes } from './domains.ts';
import { connectionRoutes } from './connections.ts';
import { paymentRoutes, webhookRoutes } from './payments.ts';
import { reportRoutes } from './reports.ts';
import { crmRoutes } from './crm.ts';
import { studioRoutes } from './studios.ts';
import { sportsRoutes } from './sports.ts';
import { wellnessRoutes } from './wellness.ts';
import { commerceRoutes } from './commerce.ts';
import { foodRoutes } from './foods.ts';
import { aiRoutes } from './ai.ts';
import { mobileRoutes } from './mobile.ts';
import { approvalRoutes } from './approvals.ts';
import { shiftRoutes } from './shifts.ts';
import { offerRoutes } from './offers.ts';
import { intakeFormRoutes } from './intakeForms.ts';
import { pickupSettingsRoutes } from './pickupSettings.ts';

/** All /v1 routes. Public and webhook routes are unauthenticated; everything else requires a bearer token. */
export const registerRoutes: FastifyPluginAsyncZod = async (app) => {
  // Access model: organisation routes are refused (403 module_not_available) for members without the module.
  app.addHook('preHandler', (await import('../services/module-guard.ts')).moduleGuard);
  // No free plan: without a paid trial or plan, organisation data is read-only (BILLING_ENFORCE, default on in production).
  app.addHook('preHandler', (await import('../services/billing-gate.ts')).billingGate);
  await app.register(publicRoutes);
  await app.register(authRoutes);
  await app.register(webhookRoutes);
  await app.register((await import('./partner-webhooks.ts')).partnerWebhookRoutes);
  await app.register(studioRoutes);
  await app.register(foodRoutes);
  await app.register(wellnessRoutes);
  await app.register(sportsRoutes);
  await app.register(meRoutes);
  await app.register(orgRoutes);
  await app.register(locationRoutes);
  await app.register(memberRoutes);
  await app.register((await import('./access.ts')).accessCatalogueRoutes);
  await app.register((await import('./access.ts')).accessRoutes);
  await app.register((await import('./platform.ts')).platformRoutes);
  await app.register((await import('./platform.ts')).demoRoutes);
  await app.register(websiteRoutes);
  await app.register(domainRoutes);
  await app.register(connectionRoutes);
  await app.register((await import('./partner-integrations.ts')).partnerIntegrationRoutes);
  await app.register(paymentRoutes);
  await app.register(reportRoutes);
  await app.register(crmRoutes);
  await app.register(commerceRoutes);
  await app.register(aiRoutes);
  await app.register(mobileRoutes);
  await app.register(approvalRoutes);
  await app.register(shiftRoutes);
  await app.register(offerRoutes);
  await app.register(intakeFormRoutes);
  await app.register(pickupSettingsRoutes);
  await app.register((await import('./sites.ts')).siteRoutes);
  await app.register((await import('./sports-hub.ts')).sportsHubRoutes);
  await app.register((await import('./realty.ts')).realtyRoutes);
  await app.register((await import('./hospitality.ts')).hospitalityRoutes);
  await app.register((await import('./wellness-ext.ts')).wellnessExtRoutes);
  await app.register((await import('./studios-full.ts')).studioFullRoutes);
  await app.register((await import('./commerce-ext.ts')).commerceExtRoutes);
  await app.register((await import('./foods-ext.ts')).foodsExtRoutes);
  await app.register((await import('./payments-customer.ts')).paymentCustomerRoutes);
  await app.register((await import('./franchise.ts')).franchiseRoutes);
  await app.register((await import('./franchise-public.ts')).franchisePublicRoutes);
  // Network workspaces: Community (with the resource library), Training academy, Help desk.
  await app.register((await import('./community.ts')).communityRoutes);
  await app.register((await import('./resources.ts')).resourceRoutes);
  await app.register((await import('./training.ts')).trainingRoutes);
  await app.register((await import('./helpdesk.ts')).helpdeskRoutes);
  // Marketing & sales communications: inbox webhooks (raw bodies), inbox, sales pipeline, social, ad campaigns.
  await app.register((await import('./comms-webhooks.ts')).commsWebhookRoutes);
  await app.register((await import('./inbox.ts')).inboxRoutes);
  await app.register((await import('./sales-pipeline.ts')).salesPipelineRoutes);
  await app.register((await import('./social.ts')).socialRoutes);
  await app.register((await import('./ad-campaigns.ts')).adCampaignRoutes);
  // Marketing workspace (website builder, email, automations, forms, brand assets).
  await app.register((await import('./marketing-sites.ts')).marketingSiteRoutes);
  await app.register((await import('./marketing.ts')).marketingRoutes);
  await app.register((await import('./marketing-public.ts')).marketingPublicRoutes);
  await app.register((await import('./finance.ts')).financeRoutes);
  // Marketing → Reviews (requests, hosted review page, Google Business Profile, replies, dashboard).
  await app.register((await import('./reviews.ts')).reviewRoutes);
  // BranchHarbor plan billing (paid trial, checkout with billing-country lock, who pays per location) and data export.
  await app.register((await import('./billing.ts')).billingRoutes);
  // Field audits, compliance documents, the league table, and signed links to their private files.
  await app.register((await import('./audits.ts')).privateFileRoutes);
  await app.register((await import('./audits.ts')).auditRoutes);
  await app.register((await import('./compliance.ts')).complianceRoutes);
  await app.register((await import('./league-table.ts')).leagueTableRoutes);
  // Network data platform: POS / booking sales connectors (+ public OAuth callback), import wizard, bulk launch, benchmarks.
  await app.register((await import('./sales-connectors.ts')).salesConnectorPublicRoutes);
  await app.register((await import('./sales-connectors.ts')).salesConnectorRoutes);
  await app.register((await import('./imports.ts')).importRoutes);
  await app.register((await import('./launches.ts')).launchRoutes);
  await app.register((await import('./benchmarks.ts')).benchmarkRoutes);
  // Suppliers (catalogue, purchase orders, receiving, rebates, off-contract spend) and the supplier's magic-link pages.
  await app.register((await import('./supply.ts')).supplyRoutes);
  await app.register((await import('./supply.ts')).supplyPublicRoutes);
  // Audits phase 2 (recurring schedules, trends, visit planner, retraining) and self-checks.
  await app.register((await import('./audit-programmes.ts')).auditProgrammeRoutes);
  // Local marketing: listings, co-op fund, call tracking (with Twilio voice webhooks and DNI), settings, review reply
  // templates and the local social content calendar.
  await app.register((await import('./listings.ts')).listingRoutes);
  await app.register((await import('./coop.ts')).coopRoutes);
  await app.register((await import('./call-tracking.ts')).callTrackingWebhookRoutes);
  await app.register((await import('./call-tracking.ts')).callTrackingRoutes);
  await app.register((await import('./local-marketing.ts')).localMarketingRoutes);
  // Franchise development: territory map (+ public map), surveys, validation calls (+ public scheduling page),
  // agreement lifecycle and master franchise.
  await app.register((await import('./territories.ts')).territoryRoutes);
  await app.register((await import('./territories.ts')).territoryPublicRoutes);
  await app.register((await import('./surveys.ts')).surveyRoutes);
  await app.register((await import('./validation.ts')).validationRoutes);
  await app.register((await import('./validation.ts')).validationPublicRoutes);
  await app.register((await import('./lifecycle.ts')).lifecycleRoutes);
  await app.register((await import('./master.ts')).masterRoutes);
};
