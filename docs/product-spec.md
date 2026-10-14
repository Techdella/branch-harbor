# BranchHarbor — Product, UI/UX, Website and Brand Specification

Version: 1.0 | Date: 11 October 2026 | Status: Design brief and proposed build specification

Audience: Product designer, UX designer, developer and pilot-business stakeholders.

This document specifies the intended product, not capabilities already implemented. Initial market: United States and Canada. Domain: branchharbor.com, reported available by the founder; purchase and trademark clearance are not established by this document. Pricing, vendors and release dates remain decisions to validate.

## 1. Product purpose

BranchHarbor helps independent businesses, multi-location operators and franchise networks manage their websites, local customer activity and industry workflows through one coordinated platform. Headquarters receives oversight and brand controls; locations receive autonomy within explicitly defined permissions.

Core promise: **One home for every location.**

Supporting message: **Manage your brand together. Run each location with confidence.**

The product addresses disconnected websites, inconsistent local content, difficult campaign reporting, unreliable integrations and unclear ownership across business locations. It must not assume a WordPress plugin can automatically replace every booking, payment or operational system.

### Delivery models

| Model | Customer experience | Responsibility |
|---|---|---|
| Hosted | Launch a BranchHarbor website and dashboard; optionally connect a domain | BranchHarbor hosts its service and published experience |
| WordPress connector | Keep an existing website; add supported BranchHarbor blocks, forms and connections | Customer retains WordPress hosting; BranchHarbor operates its connected service |
| Existing-system connection | Connect supported booking, commerce or other software | The integration defines authoritative data and allowed actions |

The hosted and WordPress options share business records and permissions. They do not require identical page editors. Every module must name whether it replaces a workflow, embeds an existing workflow or only reports on it.

## 2. Vertical portfolio and release boundaries

| Vertical | Primary customer | Main workflow | First vertical release | Subsequent scope |
|---|---|---|---|---|
| Studios | Yoga, Pilates, dance, barre, cycling and boutique fitness | Enquiry → trial → class → membership | Websites, schedules, lead routing and selected booking connection | Native bookings, packs, memberships, cover requests and online classes |
| Sports | Academies, clubs, training programmes and camps | Registration → group assignment → attendance | Programme registration, rosters, scheduling and announcements | Instalments, fixtures, selection and expanded guardian portal |
| Wellness | Spas, massage, wellness centres and appointment services | Service selection → practitioner → appointment | Service pages, availability, booking and reminders | Packages, resource scheduling and advanced retention |
| Commerce | Retail groups and franchise stores | Product discovery → order → fulfilment | Shared catalogue, local availability and WooCommerce connection | Native storefront ordering, inventory transfers and returns |
| Foods | Restaurants, cafés, bakeries, meal preparation and food franchises | Location → menu → order → pickup | Master menus, local overrides, pickup ordering and kitchen view | Delivery, catering, recurring meals, POS and ingredient inventory |

Design all five verticals now. Build the shared foundation once and release one complete vertical first. Suggested first pilot: Studios; Foods follows. Sequencing may change if a committed pilot customer supports another choice. Navigation must never expose unusable placeholders as working features.

## 3. Brand system

### Personality and voice

Calm, capable, welcoming and organised. Write for business owners, not developers. Use short labels such as Locations, Orders, Classes and Connections. Explain consequences before broad changes. Avoid promises of guaranteed revenue, legal compliance or perfect attribution.

Brand narrative: individual branches remain distinct while drawing support from a shared home. The identity should suit both a Canadian yoga studio and a US restaurant group.

### Logo direction

Design a BranchHarbor wordmark with a compact symbol suggesting several branches joining a sheltered centre. Explore a branching H or three paths meeting within an open enclosure. Keep it readable at favicon size. Avoid detailed trees, literal ships, medical crosses and restaurant-specific imagery. The identity is an umbrella brand, not an industry logo.

Required assets: horizontal lockup, stacked lockup, symbol, one-colour version, reversed version, favicon and minimum-size/clear-space guidance. Verify small-size legibility and originality before finalising.

### Proposed design tokens

| Token | Value | Use |
|---|---|---|
| Harbor navy | #142D3B | Wordmark, primary text, app navigation |
| Deep teal | #087F82 | Main actions and selection |
| Warm canvas | #F7F8F5 | Marketing and application backgrounds |
| Surface | #FFFFFF | Cards, forms and drawers |
| Secondary text | #52636D | Supporting copy |
| Border | #DCE4E5 | Dividers and field outlines |
| Studios accent | #7460A8 | Vertical identification |
| Sports accent | #2867AA | Vertical identification |
| Wellness accent | #56836C | Vertical identification |
| Commerce accent | #A66C26 | Vertical identification |
| Foods accent | #B9543D | Vertical identification |

Vertical accents are decorative identifiers, not status colours. Validate contrast per actual foreground/background pair before using them for text. Use explicit text and icons for success, warning and error.

Typography: Manrope for headings and Inter for interface/body text, subject to design validation and licence review. Self-host required font assets. Fallback: system sans-serif. Suggested scale: 48–64px desktop hero, 32–40px mobile hero, 28–36px page heading, 20–24px section heading, 14–16px interface text. Use tabular numerals for money and reports.

Spacing: 4px base scale; 8, 12, 16, 24, 32 and 48px intervals. Controls around 44px high, generous mobile targets, 8px control radius and 12px card radius. Restrained shadows. Motion should explain state changes; respect reduced-motion preferences.

Photography: real business environments, diverse owners, local staff and customers. Show studios, sports venues, wellness services, shops and kitchens without relying on stereotyped stock poses. Marketing screenshots must be accurate or explicitly labelled conceptual previews.

### Product naming

Use BranchHarbor Studios, BranchHarbor Sports, BranchHarbor Wellness, BranchHarbor Commerce and BranchHarbor Foods. Keep one wordmark; distinguish products through an accent, descriptor and industry imagery. AI is called **BranchHarbor AI** until a separate name is selected; do not assume it is startbuddi's Chip.

## 4. Public website

### Information architecture

| Route | Purpose | Primary action |
|---|---|---|
| / | Explain the platform and help visitors choose a path | Explore your industry |
| /industries/studios | Studio problems, workflows and product preview | Request a studio demo |
| /industries/sports | Programmes, teams and registration | Request a sports demo |
| /industries/wellness | Services, appointments and packages | Request a wellness demo |
| /industries/commerce | Catalogue and multi-location retail | Request a commerce demo |
| /industries/foods | Menus, local control and ordering | Request a food-business demo |
| /solutions/franchises | Headquarters/location coordination | Discuss your network |
| /solutions/independent-businesses | Simpler single-location experience | Explore setup |
| /wordpress | Connector, prerequisites and support boundaries | View supported connections |
| /integrations | Searchable compatibility catalogue | Inspect an integration |
| /pricing | Hosted, connector and network plan structure | Choose plan or request quote |
| /demo | Guided product preview and demo enquiry | Submit enquiry |
| /resources and /docs | Guides and product documentation | Read relevant guide |
| /support | Help and contact options | Find help |
| /about | Team, purpose and company details | Contact team |
| /privacy, /terms, /security | Actual policies and operating practices | Read information |

App authentication and account administration belong on an application surface, proposed app.branchharbor.com. Marketing routes are proposed, not deployed URLs.

### Homepage sections, in order

1. Header: logo; Industries; For franchises; WordPress & integrations; Pricing; Sign in; Request a demo. Collapse into an accessible mobile menu.
2. Hero: **One home for every location.** Supporting copy: “Connect your websites, customer activity and industry workflows. Give headquarters visibility and local teams the control they need.” Primary CTA: Explore your industry. Secondary CTA: See how it works.
3. Product visual: headquarters overview with a selected-location drawer. Show realistic content and label sample data.
4. Industry selector: five cards with one customer description and one primary workflow each.
5. Headquarters and locations: paired panels explaining shared controls and local autonomy.
6. Three-step explanation: choose industry; connect or launch; coordinate locations.
7. Core capability section: Websites, Customers, Marketing, Payments, AI and Connections. Identify launch availability.
8. Hosted versus WordPress: two clear choices without technical jargon.
9. Integration section: show supported integrations only; planned integrations receive an explicit status label.
10. Evidence: genuine pilot results or customer quotations when available. Before then, demonstrate workflows; do not invent customers, logos or performance claims.
11. Pricing preview and FAQs: explain per-location billing, existing software, local control and onboarding.
12. Closing CTA and footer: industry links, documentation, company information and policies.

### Industry page template

Industry-specific headline → customer problem → interactive/sample workflow → headquarters/local permissions → first-release capabilities → connected systems → optional later capabilities → pricing path → FAQs → demo CTA.

Suggested headlines:

- Studios: “Keep every studio connected, from first enquiry to the next class.”
- Sports: “Bring programmes, teams and venues into one organised home.”
- Wellness: “Make service booking simpler for clients and local teams.”
- Commerce: “Coordinate your catalogue. Let every store serve its customers.”
- Foods: “One brand menu. Local control. Clear ordering.”

### Conversion flow

Visitor chooses industry → selects single business or network → views a relevant workflow → requests demo or joins a pilot. Form fields: name, work email, business, industry, location count, existing website, primary difficulty. Phone and existing systems are optional. Confirmation explains the next step without inventing a response deadline.

Self-service signup appears only when that vertical supports it. Keep unsupported verticals on demo/pilot enquiry. No dead Start now buttons.

## 5. Roles, ownership and business hierarchy

Hierarchy: organisation → optional regions → locations. Franchise-owner entities may operate several locations. Users receive scoped roles and may have more than one assignment. Customers may participate at multiple locations, but cross-location sharing requires an explicit business policy and permitted purpose.

| Role | Default scope | Main permissions |
|---|---|---|
| Organisation owner | Organisation | Billing, ownership, administrators and governance |
| Headquarters admin | Assigned network | Templates, locations, policies and authorised reports |
| Regional manager | Assigned regions | Location oversight and approvals within scope |
| Franchise owner | Owned/assigned locations | Local operations, permitted payments and staff |
| Location manager | Assigned locations | Daily management and local publishing privileges |
| Staff/instructor/coach | Assigned work | Relevant schedules, attendance or orders |
| Marketing contributor | Assigned locations/campaigns | Draft content; publish only if authorised |
| Finance user | Assigned financial scope | Payments, reconciliation and permitted refunds |
| Customer/guardian | Own records | Bookings, orders, registrations and preferences |

All permissions are enforced server-side. Headquarters access to customer details is not automatic merely because it can see network reports. Removing a location assignment must revoke access immediately. Support access must be authorised, time-limited and logged.

## 6. Application navigation and layout

Desktop: left navigation around 240px; top bar with scope selector, search, notifications and profile; content width suited to tables and calendars. Tablet: collapsible navigation. Mobile: concise navigation, full-screen detail panels and sticky primary actions where appropriate.

Scope selector is always visible: **All authorised locations**, a region, an owner group or a location. Show the active scope on reports, AI requests and bulk actions. Single-location customers skip network concepts unless they add a location.

| Common navigation | Purpose |
|---|---|
| Overview | Relevant metrics, upcoming work and connection alerts |
| Locations | Directory and location administration |
| Industry operations | Vertical-specific daily workflow |
| Customers/Participants/Members | Appropriate relationship records |
| Websites | Pages, templates, approvals and domains |
| Marketing | Campaigns, assets, forms and lead routing |
| Payments | Transactions, connected accounts and reconciliation |
| Team | Roles and staff assignments |
| Community & resources | Announcements, documents and support discussions |
| Reports | Network/location performance with data freshness |
| Connections | Supported integrations and sync health |
| Settings | Business policies, preferences and subscription |

AI opens in a persistent side panel on desktop and a full-screen panel on mobile. Record details use drawers with a shareable full-page option. Closing a drawer or using Back restores filters, scroll position and selected date. Global search respects permissions and groups results by record type.

Overview metric cards show definition, time range and data source. Missing data is “Unavailable” or “Not connected,” never a fabricated zero. Revenue reports distinguish currencies and refunds; no combined USD/CAD total without a defined conversion method.

## 7. Onboarding and domain UX

### Business setup

1. Create account and verify email.
2. Choose industry and independent business versus network.
3. Enter business details, timezone and default currency.
4. Add first location; optionally import more with row-level validation.
5. Select hosted site or existing WordPress site.
6. Add industry data: services/classes/programmes/products/menu.
7. Connect required booking, commerce or payment system; identify its source-of-truth role.
8. Invite staff with explicit location permissions.
9. Preview the customer experience, complete a test transaction/workflow and publish.

Save progress at each step. Provide a checklist rather than blocking all navigation. Allow Skip for optional steps. A payment-dependent workflow cannot become purchasable until the relevant account is enabled. Show blockers with a direct repair action.

### Location wizard

Fields: name, internal code, owner group, address, timezone, currency, contact information, hours, template and permitted overrides. Headquarters chooses inherited settings. Preview which settings are shared and which are local before saving. Adding a location does not automatically publish a website or make it visible to customers.

### Website address

Choices: Use included address; Connect my domain; Buy a domain (later).

Included address example: https://sites.branchharbor.com/your-business/your-location, subject to final routing design. Never imply that an example customer domain is owned or deployed.

Domain connection flow: enter hostname → verify ownership → provide exact DNS instructions → run verification → issue/validate certificate → preview → set primary address. Statuses: awaiting DNS, verifying, certificate pending, ready, failed. Keep the existing address working during setup. Connecting an existing business should preserve email records and include a route/redirect migration plan.

Domain purchase later: search → availability check → registration and renewal price → registrant details → consent and payment → provisioning. Register for the customer, expose renewal status and transfer options; do not bundle indefinite domain ownership into a monthly plan.

## 8. Shared website and brand-governance UX

Template editor separates Locked brand content, Editable local content and Approval required. Each field displays its origin. Local overrides can be reset to headquarters defaults. Group publishing uses a review table listing locations, changed pages, excluded overrides and warnings.

Page flow: draft → preview → submit if required → approve/reject with comment → schedule/publish → monitor. Update statuses independently per location; a partial failure must not be presented as full success.

Deleting a page shows inbound links, booking/order dependencies and redirect choices. Default to archive with recovery. Publishing shared changes needs a version snapshot and rollback mechanism. Do not claim a local page deletion inherently breaks all WordPress Multisite sites; investigate actual routing and shared configuration.

Page builder scope: templates and editable sections first; full arbitrary drag-and-drop editing later. SEO settings include page title, description, canonical ownership and sitemap ownership. Existing SEO plugins remain authoritative where selected.

## 9. Studios — full product and UX

Purpose: connect studio websites, enquiries, classes and member relationships. Users: franchise headquarters, owners, managers, instructors and members. Support recurring schedules, local calendars and instructor substitution.

| Screen | Main content and actions |
|---|---|
| Studio overview | Enquiries, upcoming classes, occupancy where available, membership activity and sync alerts |
| Classes | Week/day calendar and list; location/instructor filters; cancel or edit one occurrence versus a series |
| Class detail | Capacity, instructor, attendees, waitlist, booking source and communication history |
| Members | Searchable records, packs, membership state, attendance and consent |
| Instructor cover | Open requests, availability, acceptance and manager approval |
| Offers | Introductory offers, campaign pages and eligibility rules |
| Online classes | Registration, access and content library permissions |

Customer flow: choose location → browse classes → select occurrence → see price/eligible credit → sign in or supply details → book/pay → receive confirmation → manage cancellation. A full class offers waitlist rather than a misleading booking action. Hold capacity during checkout for a defined period; handle expiration and payment success after expiry with an explicit recovery process.

Manager flow: create class type → instructor and room → recurrence, timezone and capacity → price/credit rules → preview → publish. Series edits explain which occurrences and existing bookings will change. Notify affected customers through supported, consent-appropriate channels.

Cover flow: instructor requests cover → eligible staff receive notice → substitute accepts → authorised manager confirms if required → schedule and customer-facing instructor update together. Preserve the request history.

AI: draft class descriptions, prepare local promotions, summarise attendance changes and propose follow-up audiences. Do not infer causes from occupancy alone. First-release native booking features must stay hidden if the connected booking provider remains authoritative.

Key edge cases: duplicate booking, expired pack, cross-location membership restrictions, instructor absence, daylight-saving changes, failed recurring payment and provider outage. Acceptance: schedule changes remain scoped, booking data carries the location, and unauthorised users cannot view another studio's member details.

## 10. Sports — full product and UX

Purpose: manage programmes, teams and training across venues. Users: directors, administrators, coaches, participants and guardians. Season and programme structures remain distinct from individual sessions.

| Screen | Main content and actions |
|---|---|
| Programme overview | Enrolment, capacity, outstanding administrative work and upcoming sessions |
| Programmes | Season/camp catalogue, age groups, venue, fees and registration period |
| Registrations | Submitted, awaiting review, accepted, waitlisted and withdrawn |
| Teams/groups | Rosters, coach assignments and transfers |
| Schedule | Training, fixtures and venue conflict indicators |
| Attendance | Fast check-in and absence recording |
| Guardian portal | Authorised participants, schedules, balances and messages |

Customer flow: select programme and venue → review age/eligibility criteria → identify participant and guardian relationship → complete necessary forms → choose payment option → receive enrolment or review-pending confirmation. Do not treat successful payment as team selection when approval is required.

Administrator flow: create season/programme → assign venues and coaches → eligibility and capacity → fees → registration forms → publish → review registrations → assign groups → announce schedules. Refund/withdrawal policy must be shown before checkout.

Coach flow: open assigned session → view authorised roster → record attendance → issue relevant update. Guardians see only participants they are authorised to represent; invitations and relationship disputes require a verification workflow.

AI: draft programme descriptions, summarise enrolment and suggest scheduling conflict resolutions. No automatic selection of children based on inferred ability or sensitive characteristics.

Key edge cases: guardian permissions, age boundary dates, cancelled sessions, venue clashes, programme transfers, duplicate participant records and unpaid instalments. Acceptance: coach access is scoped; capacity and approval rules survive payment retries; calendar updates reach affected groups without sending network-wide notices.

## 11. Wellness — full product and UX

Purpose: simplify service selection, practitioner scheduling and repeat appointments. Initial scope is administrative; medical diagnosis, clinical records and treatment recommendations are outside this release.

| Screen | Main content and actions |
|---|---|
| Appointment overview | Today, upcoming bookings, cancellations and utilisation |
| Services | Duration, price, buffers, eligible practitioners and required resources |
| Calendar | Practitioner/room views and conflict-aware rescheduling |
| Clients | Appointment history, packages, preferences and scoped administrative notes |
| Practitioners | Availability, location assignments and service eligibility |
| Packages | Included sessions, remaining balance and expiry |
| Forms | Necessary administrative questions and consent version |

Customer flow: choose location → service → practitioner or any available → slot → review deposit/cancellation terms → enter details → pay if required → confirmation. Show timezone and location clearly. Ask only information necessary for the workflow.

Manager flow: configure services → assign practitioners and rooms → set availability, buffers and package rules → publish. A reservation must secure both practitioner and required resource; two calendars cannot independently promise the same room.

Reschedule flow: select new slot → show price/policy effects → confirm → release old reservation only after replacement is secured. Failed replacement preserves the existing appointment.

AI: service copy, approved-policy reply drafts and appointment reporting. Exclude sensitive form responses from general AI context by default. No health claims invented from marketing prompts.

Key edge cases: practitioner absence, conflicting rooms, deposit refunds, package expiry, overlapping location schedules and confidential notes. Acceptance: time buffers are enforced and staff visibility matches actual duties.

## 12. Commerce — full product and UX

Purpose: coordinate shared catalogues and local storefront operations. Customers retain their business identity; this is not an open marketplace of unrelated sellers.

| Screen | Main content and actions |
|---|---|
| Commerce overview | Orders, stock warnings, revenue by currency and sync health |
| Catalogue | Master products, variants, images and publish status |
| Local assortment | Stock, permitted prices, availability and override origin |
| Orders | Payment/fulfilment states, location, source and customer |
| Inventory | Adjustments, reasons, reorder alerts and later transfers |
| Returns | Requested, reviewed, authorised, received and resolved |
| Storefront | Collections, product finder, fulfilment settings and preview |

Shopper flow: choose store/location where required → browse/search → select variant and fulfilment method → cart → checkout → payment processing → confirmed order → status/return request. Display stock for the fulfilment location. Inventory reservation and payment expiry require coordinated release rules.

Headquarters flow: create master product → set editable fields and eligible locations → publish preview → distribute → inspect sync results. Local changes never silently overwrite master identifiers or global product content.

Local flow: adjust availability/stock with reason → fulfil orders → process authorised returns. Record inventory history, not only a mutable stock number. A physical stock adjustment differs from a sale or reservation.

AI: draft product copy from supplied specifications, suggest merchandising and explain stock trends with cited records. It must not invent compatibility, safety specifications or product availability.

Key edge cases: backorders, variant mismatch, concurrent sales, external checkout, partial refunds, inventory drift and cross-location collection. Acceptance: authoritative order system is explicit, retrying sync creates no duplicate orders, and monetary reports do not mix currencies without disclosure.

## 13. Foods — full product and UX

Purpose: distribute brand menus while supporting location-level ordering and kitchen execution. Suitable for restaurants, cafés, bakeries, takeaway and meal-prep groups.

| Screen | Main content and actions |
|---|---|
| Food overview | Current orders, pickup capacity, sold-out items and connection alerts |
| Master menu | Categories, items, descriptions, images and business-supplied dietary details |
| Location menu | Prices, permitted modifiers, availability and inherited fields |
| Orders | New, accepted, preparing, ready, collected, cancelled and rejected |
| Kitchen view | Large order cards, item modifiers, promised time and status action |
| Pickup settings | Opening hours, cutoffs, preparation buffers and slot capacity |
| Preorders/catering | Cooking dates, deadlines, packages, quotes and production summaries |

Customer flow: choose location → choose available pickup date/time → browse local menu → configure modifiers → cart → contact details and order notes → review totals → pay → receive acceptance/confirmation state → collect. Clearly distinguish an order awaiting restaurant acceptance from an accepted order.

Headquarters flow: create menu items and required modifiers → supply dietary details → choose permitted local changes → preview affected locations → publish → inspect successes/failures. Allergen and dietary information comes from the business; AI cannot infer it as fact.

Restaurant flow: set hours and capacity → mark items sold out → accept/reject incoming orders → prepare → ready → collected. Rejection triggers the appropriate void/refund workflow and customer notice. Status buttons require acknowledgement from the server; optimistic UI cannot silently lose orders.

Kitchen UX: high legibility, time sorting, clear overdue markers and accessible audible alerts that can be disabled. On a lost connection, show last refresh time and stop presenting stale data as current. No unnecessary customer information on shared kitchen screens.

Preorder flow: customer selects cooking date before items → sees cutoff and collection options → pays → business gets a production summary. Catering enquiries are reviewed before acceptance when price or capacity is not fixed.

AI: menu copy, campaign drafts and production/order summaries. Do not let it independently change ingredients, dietary labels, prices or order acceptance.

Key edge cases: closing time during checkout, sold-out modifier, slot exhaustion, delayed preparation, paid order never received and duplicate payment events. Acceptance: slot/menu checks occur server-side before confirmation, and payment/order mismatches appear in a recovery queue.

## 14. Payments and financial UX

Separate BranchHarbor subscription billing from business customer payments. Stripe Connect is a proposed hosted-platform option; platform eligibility, connected-country coverage, fees and liability configuration require confirmation before adoption. Independently owned franchise locations may need separate merchant accounts; company-owned locations may share an account with reporting allocations.

Existing WordPress stores retain supported gateways and checkout by default. Never insert a second checkout flow automatically. Other providers can be added through adapters after geography and use-case validation; “supports all gateways” is not a product claim.

| Screen | Requirements |
|---|---|
| Payment setup | Account owner, provider authorisation, enabled capabilities and location mapping |
| Transactions | Location, external reference, amount/currency, order/booking, payment state and refund state |
| Payment detail | Timeline, source events, receipt, supported refund action and audit history |
| Reconciliation | Paid without fulfilled record, unpaid but confirmed record and amount mismatch |
| Subscription billing | BranchHarbor plan, authorised location count, invoices and payment method |

Payment states: created, pending/action required, processing, succeeded, failed and cancelled. Refund states are separate: requested, pending, partial, complete and failed. Settlement/payout status is not the same as payment success.

Use hosted/tokenised payment collection; do not store raw card details. Signed provider events confirm outcomes. Process retries idempotently and reconcile missing events. Approval screens display business/location, exact amount and currency before refund execution. Headquarters royalties and automatic splits are later, separately approved workflows.

Display item subtotal, applicable configured tax, service charges, discount and total before confirmation. Tax configuration requires business-specific validation; do not invent a universal US/Canada tax rate or imply automatic compliance.

## 15. BranchHarbor AI

AI is an assistant attached to the current organisation, location and permissions. It can draft, summarise and propose structured actions; authorised application services execute approved changes.

Panel elements: active scope, conversation, source references, proposed-action cards, preview, approval controls, usage indicator and status. Users can change scope explicitly. A location user cannot expand to headquarters data by asking the model.

Action flow: request → gather authorised data → explain assumptions/missing data → draft plan → preview affected records → obtain required approval → execute through validated tools → show per-record result → link to audit/rollback where supported.

| Action class | Default behaviour |
|---|---|
| Read authorised data | Respond with source and freshness |
| Draft copy/report | Save draft or display for review |
| Publish/send/change price | Preview and explicit approval with affected scope |
| Refund/delete/change permissions | Elevated authorisation and separate confirmation |
| Network-wide update | Location list, exclusions and partial-failure handling |

Treat webpages, messages and imported content as untrusted data, not instructions. Access control, tenant boundaries and tool validation live outside the prompt. Limit secrets and personal data in model context; redact financial credentials. Do not train models on customer data by default. Model-provider retention and contractual terms must be verified before stating privacy guarantees.

Reports separate observations from hypotheses. Marketing attribution is limited to observed, supported data. If a booking provider is disconnected, say what cannot be measured. AI outage must not block manual bookings, order management or publishing.

## 16. WordPress connector and compatibility

Coexistence means functioning alongside a plugin; integration means supported data exchange. Publish a named compatibility matrix with tested versions, available actions, prerequisites and known limitations. No universal plugin compatibility claim.

| Category | Design requirement |
|---|---|
| WooCommerce | Supported product/order APIs, HPOS handling and declared checkout compatibility |
| Page builders | Blocks/shortcodes/embeds that work without replacing the site's editor |
| Booking systems | Selected adapters with documented API rights and source-of-truth rules |
| SEO | Explicit ownership of metadata, canonical URLs and sitemaps |
| Forms | Field mapping, submission routing and duplicate prevention |
| Memberships | One owner for access rules and membership state |
| Cache/security | Exclude required dynamic/authenticated paths; test event delivery |
| Multilingual | Validate language mapping and translated records |
| Multisite | Network authorisation plus explicit per-site/location connections |

Connection UX: detect relevant systems with disclosure → select supported adapter → authorise least-privilege access → map site/location → choose data direction → test → show status. Do not automatically disable another plugin, overwrite content or copy all customer records.

Status labels: Tested; Limited support; Requires setup; Planned; Unsupported. Live connection states: connected, initial sync, degraded, disconnected and authorisation expired. Display last successful sync, affected records and recovery action. Background work must not slow every page request.

Use WordPress APIs, scoped credentials and documented public extension points. External authorised connections should not require the user's primary password. Avoid duplicate copies of WordPress-supplied libraries and third-party assets unrelated to the documented service.

Directory distribution: GPL-compatible free connector; separate premium extensions outside WordPress.org where appropriate; documented substantive hosted service; consent for external data processing; restrained upgrades; optional public credits off by default. No ads injected into customer websites or dashboards as BranchHarbor's revenue mechanism.

## 17. Data and synchronisation requirements

Core entities: Organisation, Region, OwnerGroup, Location, User, RoleAssignment, Customer, GuardianRelationship, Website, PageVersion, Template, Campaign, Lead, Connection, ExternalMapping, PaymentReference, Approval and AuditEvent.

Industry entities: ClassOccurrence, Pack, Membership, CoverRequest; Programme, Season, Team, Registration, Attendance; Service, Practitioner, Resource, Appointment; Product, Variant, StockMovement, Order, Return; Menu, Modifier, PickupSlot and FoodOrder.

Each entity defines ownership scope and an authoritative writer. Connections retain stable external IDs, event IDs and mapping state. Integration screen must expose whether data is imported, exported or bidirectional, plus conflict resolution. Customer deduplication requires review where identities are ambiguous.

Policies: no cross-organisation access; local versus group ownership explicit; retries idempotent; deletion tombstones propagated where applicable; UTC storage with local-time presentation; recurrence respects location timezone; monetary amounts retain currency; audit events record actor and affected scope. Analytics cannot assume imported history is complete.

## 18. Interaction states, accessibility and responsive requirements

Design every major screen for loading, empty, partial data, error, permission denied, stale connection, pending approval and completed action. Skeletons preserve layout. Empty states explain the next useful action. Form errors appear next to fields and in an accessible summary; entered data remains intact after failure.

Tables provide search, filters, pagination and saved views where useful. Mobile uses labelled cards or deliberate horizontal scrolling. Bulk actions display selected count and scope; selection across filtered pages is explicit. Calendar alternatives include an accessible list.

Target WCAG 2.2 AA: keyboard navigation, visible focus, semantic headings, accessible dialogs, sufficient contrast, labelled inputs, reduced motion and screen-reader announcements. Do not rely on colour alone. Test at roughly 360px mobile, 768px tablet and 1440px desktop; support zoom and long content.

Changes with financial or network effects require a consequence preview. Recoverable local edits should not trigger excessive confirmation dialogs. Provide undo where feasible. Notifications distinguish information, required action and integration failure.

## 19. Designer handoff and screen inventory

Deliver a token-based design system; components with variants; annotated desktop/mobile screens; five vertical customer journeys; headquarters/local permission states; realistic fixtures; interaction prototypes; and implementation notes. Build a reusable shell and industry-specific components rather than five disconnected UI systems.

Minimum prototype scenarios:

1. Marketing visitor chooses industry and requests a demo.
2. Hosted customer completes setup, previews a site and connects a domain.
3. WordPress customer authorises a supported connection and resolves a mapping error.
4. Headquarters publishes a shared change; one location fails and is retried.
5. Local manager edits an allowed field and requests approval for a protected change.
6. Studio customer books or joins a waitlist; manager handles instructor cover.
7. Guardian registers a participant; coach checks attendance.
8. Wellness customer books and reschedules without losing the original slot on failure.
9. Commerce order synchronises and a partial refund is recorded.
10. Food customer orders pickup; restaurant accepts and kitchen updates status.
11. AI drafts a multi-location campaign and an authorised user reviews scope.
12. Payment succeeds but local fulfilment record fails; reconciliation recovers it.

### Review checklist

- Can a business owner explain the product without technical vocabulary?
- Is the active location visible before every consequential action?
- Can users distinguish inherited values from local overrides?
- Can every customer-facing workflow recover from a failed payment or connection?
- Are planned features labelled honestly on marketing and application screens?
- Does back navigation preserve context?
- Are private records inaccessible to another organisation and unauthorised location?
- Can staff complete core work when AI is unavailable?
- Are confirmation, approval and error states designed, not left to developers?

## 20. Implementation gates and outstanding decisions

Gate 1: review product scope and interview pilot businesses. Gate 2: approve core design and tenancy model. Gate 3: build foundation plus first complete vertical. Gate 4: test payments, permissions, synchronisation and customer journeys in staging. Gate 5: launch a controlled pilot and measure actual usage. Gate 6: expand integrations and release the next vertical.

Open decisions: first committed pilot; legal operating entity/payment eligibility; payment provider and liability model; pricing and support limits; initial booking adapters; hosted-site routing; registrar partner; AI provider/data terms; customer data-sharing policies; recurring-payment entitlements; migration scope; retention/backups; support response commitments.

Potential startbuddi reuse requires a code, licensing and security review. Do not assume existing APIs, multi-workspace behaviour or Chip context can be copied unchanged. Keep BranchHarbor's customer experience and authorisation boundaries explicit.

Pilot measures: setup completion, time to publish, local task completion, connection reliability, booking/order completion, payment-record mismatch rate, approval turnaround, support workload and paying retention. Campaign revenue metrics apply only when supported data exists; define attribution windows and deduplication before reporting.

## 21. Source references and interpretation

The product and brand choices above are proposed requirements, not statements that third-party providers support every workflow. Re-check provider documentation and commercial eligibility at implementation time.

- [WordPress detailed plugin guidelines](https://developer.wordpress.org/plugins/wordpress-org/detailed-plugin-guidelines/) — free directory distribution, serviceware, consent, advertising and credits.
- [WordPress Multisite creation](https://developer.wordpress.org/advanced-administration/multisite/create-network/) — shared installation structure; not evidence that a local deletion should break all sites.
- [WordPress Application Passwords](https://developer.wordpress.org/advanced-administration/security/application-passwords/) — scoped external authentication design reference.
- [Stripe Connect overview](https://docs.stripe.com/connect/how-connect-works) — platform and connected-account availability.
- [Stripe direct charges](https://support.stripe.com/questions/what-should-i-know-about-using-direct-charges) — payments on connected accounts.
- [Stripe Connect disputes](https://docs.stripe.com/connect/disputes) — responsibility varies with configuration.
- [WooCommerce HPOS](https://developer.woocommerce.com/docs/features/orders/high-performance-order-storage/) — order-storage compatibility.
- [WooCommerce Checkout Blocks integration](https://developer.woocommerce.com/2023/11/06/faq-extending-cart-and-checkout-blocks/) — separate checkout compatibility requirements.
- [WooCommerce extension development](https://developer.woocommerce.com/docs/extensions/getting-started-extensions/) — use documented public extension APIs.
- [Cloudflare customer domains](https://developers.cloudflare.com/use-cases/saas/custom-domains/) — example infrastructure option; not a selected provider.

End of specification.
