# Deploying BranchHarbor

Each piece runs on a different host:

| What | Where | Address (example) |
|---|---|---|
| Marketing website (`apps/web`) | Vercel | `branchharbor.com` |
| Business dashboard (`apps/app`) | Vercel | `app.branchharbor.com` |
| Customer websites (`apps/sites`) | Vercel | `sites.branchharbor.com` + customers' own domains |
| API and background jobs (`apps/api`) | Fly.io **or** Render | `api.branchharbor.com` |
| Database | Neon (Postgres 16) | — |
| Mobile app (`apps/mobile`) | Expo EAS → App Store / Google Play | — |

There are three environments. Each has its own database branch and its own API app:

| Environment | Purpose | Data |
|---|---|---|
| **Staging** | Every push to the main branch deploys here for testing | Test data |
| **Production** | Real customers | Starts empty (`pnpm db:seed` creates no businesses) |
| **Demo** | For prospects and investors | Seeded with `pnpm db:seed:demo`; shows a "Demo environment" ribbon |

## 1. Neon (database)

1. Create a project named `branchharbor`. Pick the region closest to most customers; use one project per data region later (US, EU, APAC).
2. Create branches `production`, `staging` and `demo`.
3. For each branch, copy the **pooled** connection string (it ends in `-pooler`, with `?sslmode=require`). This becomes the API's `DATABASE_URL` for that environment.
4. Migrations run automatically when the API starts. To run them by hand: `DATABASE_URL=... pnpm db:migrate`.
5. For the demo branch only, run `DATABASE_URL=... pnpm db:seed:demo` once.

## 2. API on Fly.io (option A)

```bash
brew install flyctl          # or see fly.io/docs
fly auth login
fly launch --no-deploy --copy-config --name branchharbor-api   # uses fly.toml in the repo root
fly secrets set \
  DATABASE_URL="postgres://...-pooler.../neondb?sslmode=require" \
  JWT_SECRET="$(openssl rand -hex 32)" \
  ENCRYPTION_KEY="$(openssl rand -hex 32)" \
  PUBLIC_API_URL="https://api.branchharbor.com" \
  WEB_URL="https://branchharbor.com" \
  APP_URL="https://app.branchharbor.com" \
  SITES_BASE_URL="https://sites.branchharbor.com" \
  CORS_ORIGINS="https://branchharbor.com,https://app.branchharbor.com,https://sites.branchharbor.com" \
  COOKIE_DOMAIN=".branchharbor.com" COOKIE_SECURE=true
fly deploy
fly certs add api.branchharbor.com   # then add the DNS record Fly shows you
```

Repeat with `--name branchharbor-api-staging` and `branchharbor-api-demo`, each with its own secrets. The demo app also needs `DEMO_MODE=true`.

## 2. API on Render (option B)

In Render, choose **New → Blueprint** and pick this repository. It reads `render.yaml`. Fill in the values marked as required (the same ones as the Fly secrets above), then add the custom domain `api.branchharbor.com`.

**Never reuse `ENCRYPTION_KEY` between environments, and never change it after launch.** It encrypts saved partner credentials.

## 3. Vercel (three projects)

Create three Vercel projects from the same GitHub repository. Vercel detects the pnpm workspace by itself.

| Project | Root directory | Domain | Environment variables |
|---|---|---|---|
| `branchharbor-web` | `apps/web` | `branchharbor.com` | `NEXT_PUBLIC_API_URL`, `NEXT_PUBLIC_APP_URL`, `NEXT_PUBLIC_SITE_URL`, `NEXT_PUBLIC_TURNSTILE_SITE_KEY` |
| `branchharbor-app` | `apps/app` | `app.branchharbor.com` | `NEXT_PUBLIC_API_URL` (+ `NEXT_PUBLIC_DEMO_MODE=true` on the demo project only) |
| `branchharbor-sites` | `apps/sites` | `sites.branchharbor.com` | `NEXT_PUBLIC_API_URL`, `API_URL`, `SITES_BASE_URL`, `SITES_TRUSTED_PROXY_HOPS=1` |

- Use Vercel's **Preview** environment for staging, pointing at the staging API.
- For the demo, add a second app project with the demo variables on `demo.branchharbor.com`.
- **Customers' own domains:** customers point their domain at BranchHarbor. Cloudflare for SaaS (configured in the API with `CLOUDFLARE_API_TOKEN`, `CLOUDFLARE_ZONE_ID` and `DOMAINS_CNAME_TARGET`) issues the certificate and forwards the traffic to the sites project.

## 4. Payments, email and other services

Each service is optional, and the API runs in a logged test mode without it. When you're ready, add the keys to the API secrets. The full list and setup steps are in `docs/API_INTEGRATIONS.md`. For a first pilot:
- **Stripe:**
  - `STRIPE_SECRET_KEY`, `STRIPE_PUBLISHABLE_KEY`
  - webhook endpoints `https://api.branchharbor.com/v1/webhooks/stripe` and `.../v1/webhooks/stripe/connect`, with their two secrets
- **Email:** Postmark or Resend (`EMAIL_PROVIDER`, plus its token, `EMAIL_FROM`).
- **AI assistant:** Anthropic (`ANTHROPIC_API_KEY`).
- **Error tracking and analytics:** Sentry (`SENTRY_DSN`) and PostHog.

## 5. Mobile app

```bash
cd apps/mobile
npx eas login
npx eas build:configure
EXPO_PUBLIC_API_URL=https://api.branchharbor.com npx eas build --profile production --platform all
npx eas submit --platform ios && npx eas submit --platform android
```

Store listings need an Apple Developer account ($99/year) and a Google Play developer account ($25 once).

## 6. Checking a deployment

After each deploy:
1. `curl https://api.branchharbor.com/health` should list each integration as live or sandbox.
2. The browser tests in `tools/ui-audit` (`pnpm --filter @bh/ui-audit smoke`) can be pointed at the deployed addresses with the `BASE_*` variables in that README.
3. The GitHub workflow `.github/workflows/ui-cross-browser.yml` runs the same tests in Chrome, Firefox and Safari's engine on every push.

## Not yet verified

The container image (`deploy/api.Dockerfile`) has not been built in the development environment, because no Docker daemon is available there. Its install and start-up steps were checked separately. The first build will happen on Fly or Render.
