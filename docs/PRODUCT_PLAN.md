# BranchHarbor product plan: from demo to the real product

Agreed with the founder on 15 Oct 2026. This document is the source of truth for the build that turns the demo into the production product.

## Decisions

1. **One industry per business account.** The industry is chosen at sign-up and fixes the screens, words, reports, website modules and mobile app. A group that runs two industries has two business accounts under one login, with an account switcher.
2. **Hospitality is in the MVP.** It covers hotels, guesthouses, serviced apartments and hostels, with an optional restaurant outlet add-on that reuses the Foods engine.
3. **The real product has no sample data.** A separate demo site (for example `demo.branchharbor.com`) runs the same code against a seeded demo account for prospects and investors.
4. **Franchise law:** BranchHarbor maintains a configurable rules table for each jurisdiction (disclosure, registration, waiting and cooling-off periods). It is presented as a compliance aid and is to be reviewed by franchise counsel before launch.
5. **Hosting:**

   | Service | Provider |
   |---|---|
   | Marketing site, dashboard, customer sites | Vercel |
   | Database | Neon (Postgres) |
   | API and workers | Fly.io or Render |

6. **Access is built from building blocks, not fixed job titles** (see below).

## Access model

Real teams don't match org charts. At a typical franchisor:
- one person may do franchise sales and training
- instructors may handle course leads
- the operations manager may run finance, websites and the CRM

So:

- **Workspaces → modules → actions.**
  - The workspaces are Network (HQ), Operations, Sales, Marketing, Finance, Legal & compliance, Training, Community.
  - Each workspace has modules, such as Marketing → website builder, email, automations, social, ads, network campaigns, brand assets.
  - Each module has actions: view, edit, publish or approve, and export.
- **Role templates are starting points, not an org chart.** They are grouped by team, and every business can rename them, combine them or ignore them:

  | Team | Templates |
  |---|---|
  | Leadership | Owner, HQ admin |
  | Franchise development | Development lead, Development rep (franchise pipeline, territories, disclosure and agreements; no customer sales) |
  | Sales | Sales lead, Sales rep (leads, deals, customers, memberships and packages, course leads) |
  | Marketing | Marketing lead (a CMO maps here), Brand manager, Digital marketer, Content & social |
  | Operations | Operations lead, Field consultant / business coach (a portfolio of locations; supports and audits, no owner finances) |
  | Finance | Finance lead, Accountant (read and export only) |
  | Legal & compliance | Legal lead |
  | Training | Training lead, Trainer |
  | Franchise partners | Master franchisee (near-HQ view of a territory), Area developer (own units plus the pipeline of their development area), Area representative (supports units they don't own), Multi-unit operator (owner-group admin) |
  | Locations | Franchise owner, Location manager, Staff (own schedule and front-line work only) |
  | Other | Auditor (read-only plus audits) |

  New custom roles start empty (least privilege). A team with no VP Franchise, a marketing-only team or a team where people wear several hats all work: rename a template to your job title, give one person several roles (access is the union), or use the combined roles a small team gets ("Marketing & sales", "Operations & finance", "Franchise development & training"). The first templates' role keys were migrated to the nearest template, keeping what the old template gave as per-person grants.
- **Team shape.** At onboarding an HQ account picks "Full team", "Small team (people cover several areas)", "Just me for now" or "Custom"; each pre-creates suggested roles. It can be changed later in Team & access; nothing is locked.
- **Custom access per person.** The owner (or anyone with Team & access) can tick exactly which modules each person gets, and for which scope: the whole network, a brand, a territory (a sub-network such as a country run by a master franchisee, holding locations and franchise pipeline entries), a region, a portfolio (any named set of locations, e.g. a field consultant's), an owner group or a location. A person also has a free-text job title, separate from their roles.
- **Grant ceiling.** Nobody can grant a capability or a scope they don't hold themselves; the owner holds everything.
- **Effective-access preview.** Before saving, Team & access shows exactly which workspaces, modules, actions and locations the person will get, the sensitive data it includes and what stays hidden. A person's ticked access can be saved as a new role.
- **Ownership vs support.** Finance, legal files and customer personal data are sensitive classes. Seeing a location never implies them: revenue, invoices, agreements and customer exports need the module that carries the class, granted by an ownership template or explicitly. Support templates (field consultant, area representative, auditor) never include them. A person-level "never show" deny removes a class from every role they hold; it is the only kind of deny.
- **Coverage.** Team & access lists uncovered areas ("Nobody handles royalties yet") with "Assign to…". Approvals and notifications whose responsible role is empty go to the owner.
- **Franchise owners get the full dashboard for their own locations**, and nothing that belongs to other franchisees or to HQ's private areas: franchise agreements of others, network finances, legal files.
- **Screen-level access.** Where a module mixes front-line and management screens, the management screens are their own capabilities (studios: schedule builder, rooms, pricing/packs/offers; and the matching screens of the other industries; reports are their own modules). Staff get the front-line screens only; location managers and above get all of them. The API refuses changes on a management screen's records without its capability.
- **Territory-scoped legal.** Disclosure and Franchise agreements can be granted on a territory (never by default): a master franchisee then sends disclosure, manages agreements and edits the jurisdiction rules and registrations of their territory's country, for their territory's prospects, owner groups and locations. HQ keeps full visibility.
- **No padlocks.** Anything a person can't access is not shown at all, and the API refuses it, module by module (each Operations screen checks its own module). Sensitive fields (finance, legal, customer personal data) are filtered server-side.
- **Workspace switcher.** People with more than one workspace get one. A person with one workspace sees just that.

## Workspaces in one app

There is a single app. Each workspace has its own home and navigation so nobody is overwhelmed. Marketing and sales are workspaces inside the app, not separate suites.

## New-location and franchise development flow

1. Enquiry and qualification.
2. Disclosure document with signed receipt; the waiting period is enforced.
3. Agreement e-signature and fees.
4. Onboarding checklist with owners, due dates, reminders and cadence.
5. Location created from the brand template.
6. Pre-opening checks.
7. HQ go-live approval.
8. Open.

Renewals and expiries are tracked from then on, and "coming soon" marketing campaigns are tied to the pipeline.

## Marketing workspace

- **Website builder:**
  - section-based drag and drop
  - a theme library with 8–12 themes per industry plus general themes; switching theme keeps the content
  - HQ locks per section, version history, phone preview
- **Email builder** with blocks that render correctly in email clients.
- **Visual automation builder:** trigger → conditions → actions.
- **Messaging and social:**
  - unified inbox (email, SMS, WhatsApp, Instagram, Messenger)
  - social scheduling with HQ-owned accounts
  - network ad campaigns (HQ runs ads for all locations, including coming-soon campaigns)
- **Other:** forms and landing pages, brand asset library, local marketing approvals with budgets.

## Kitchen display

A web page that runs on any tablet, TV stick or PC. A device is paired with a code, then:
- runs full screen
- gets orders in real time
- buffers orders when offline
- supports USB bump bars

Optional extras:
- network kitchen printers (Epson, Star)
- POS kitchen screens through the existing POS connection

No special hardware API is required.

## Later (not MVP)

- Airbnb, Booking.com and Expedia through a channel manager.
- Ads platform API integrations beyond campaign tracking.

## Build order

1. Production mode, the access model and workspaces, industry lock, multi-account login, and the demo/production split.
2. In parallel:
   - Hospitality
   - franchise development and the new-location flow with jurisdiction rules
3. Marketing workspace (builder and themes, email, automations, inbox, social, network campaigns).
4. Community, Training academy, help desk, Finance (royalties, marketing fund, payouts), Legal workspace.
5. Staging and production deployment on Vercel, Neon and Fly/Render; end-to-end tests per role and industry; the demo site.
