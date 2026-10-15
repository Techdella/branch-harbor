/**
 * Ads platform adapters (Meta Ads, Google Ads, LinkedIn Ads). Scaffolding only: OAuth consent URLs are built when
 * the platform app is configured, but campaign creation and results import are not automated yet — results are
 * entered by hand (product plan: "Ads platform API integrations beyond campaign tracking" is later).
 *
 * To enable: META_APP_ID/META_APP_SECRET (ads_management, ads_read), GOOGLE_OAUTH_CLIENT_ID/SECRET plus
 * GOOGLE_ADS_DEVELOPER_TOKEN (adwords scope), LINKEDIN_CLIENT_ID/SECRET (r_ads, r_ads_reporting). `fetchInsights`
 * then pulls daily spend / impressions / clicks / leads per campaign into ad_campaign_results with source = platform.
 */
import type { AdPlatform } from '@bh/shared';
import type { Config } from '../config.ts';

export const adsCallbackUrl = (cfg: Config, platform: AdPlatform) => `${cfg.PUBLIC_API_URL.replace(/\/$/, '')}/v1/oauth/ads/${platform}/callback`;

export function adsOauthUrl(cfg: Config, platform: AdPlatform, state: string): string | null {
  if (platform === 'meta' && cfg.META_APP_ID && cfg.META_APP_SECRET) {
    return `https://www.facebook.com/v21.0/dialog/oauth?${new URLSearchParams({ client_id: cfg.META_APP_ID, redirect_uri: adsCallbackUrl(cfg, 'meta'), state, scope: 'ads_management,ads_read,business_management' })}`;
  }
  if (platform === 'google' && cfg.GOOGLE_OAUTH_CLIENT_ID && cfg.GOOGLE_ADS_DEVELOPER_TOKEN) {
    return `https://accounts.google.com/o/oauth2/v2/auth?${new URLSearchParams({ client_id: cfg.GOOGLE_OAUTH_CLIENT_ID, redirect_uri: adsCallbackUrl(cfg, 'google'), state, response_type: 'code', access_type: 'offline', prompt: 'consent', scope: 'https://www.googleapis.com/auth/adwords' })}`;
  }
  if (platform === 'linkedin' && cfg.LINKEDIN_CLIENT_ID) {
    return `https://www.linkedin.com/oauth/v2/authorization?${new URLSearchParams({ response_type: 'code', client_id: cfg.LINKEDIN_CLIENT_ID, redirect_uri: adsCallbackUrl(cfg, 'linkedin'), state, scope: 'r_ads r_ads_reporting' })}`;
  }
  return null;
}

export type AdsSyncResult = { mode: 'sandbox'; imported: 0; reason: string };

/** Results import. Always sandbox for now: nothing is fetched and nothing is invented. */
export async function fetchInsights(_cfg: Config, platform: AdPlatform): Promise<AdsSyncResult> {
  return { mode: 'sandbox', imported: 0, reason: `${platform} results import is not enabled. Enter spend and results by hand.` };
}
