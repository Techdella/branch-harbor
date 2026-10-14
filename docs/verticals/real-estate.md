# Real Estate — full product and UX

Status: specification for the sixth vertical (`realty` in `@bh/shared` `INDUSTRY_META`, release **next**). Written in the
spirit of product-spec §9–13; the shared rules of §5 (roles), §14 (payments), §15 (AI), §17 (data) and §18 (states) apply.

Purpose: give brokerage networks, franchise offices and independent agencies one home for listings, enquiries, viewings and
offers, with headquarters governing advertising standards and each office running its own pipeline. Users: network HQ,
office managers/franchise owners, licensed agents, buyers/tenants and vendors/landlords. BranchHarbor is not a property
portal, an MLS/IDX feed or a transaction/escrow system; it never claims a portal integration is live unless it is.

| Screen | Main content and actions |
|---|---|
| Realty overview (Pulse) | Active listings, new enquiries, viewings this week, offers in negotiation, enquiry → viewing → offer funnel |
| Listings board | Columns per status (draft → coming soon → active → under offer → sold/let, withdrawn); office/agent filters; awaiting-HQ-approval badge |
| Listing editor | Facts (sale/rent, type, price + currency, beds/baths, area with unit, features), photos, floor plans, virtual tour link, business-supplied disclosures, agents (listing + co-listing), vendor/landlord contact, portal opt-in, AI description draft, submit/approve |
| Enquiries | Inbox with source (website, portal, phone, walk-in), routing result (listing agent / round-robin / office pool), status, assign |
| Viewings | Calendar/list per agent in the office time zone; requested → confirmed → completed/no-show/cancelled; feedback; open houses |
| Offers | Per listing; amount + currency, conditions, status timeline (submitted → countered → accepted/rejected/withdrawn); only authorised users |
| Agents | Office agents, licence number, availability, accepts-leads flag, workload |
| Reports | Active listings, days on market, funnel, sold/let volume **per currency** (never combined) |
| Syndication | Feed adapters per portal (sandbox), per-listing opt-in, validation issues, last sandbox export |

**Offices and governance.** An office is a location. Each office has a governance tier (from the prototypes): `managed`
and `standard` offices need HQ approval (permission `website.approve`, never the requester) before a listing is published
or before marketing changes to a published listing go live; `flexible` offices publish directly. Office settings: area unit
(`sqft` | `sqm`, defaulted from the country), lead routing mode, viewing length/buffer, and disclosure texts supplied by the
business (brokerage licence line, energy certificate, permit number, etc.). BranchHarbor never writes legal text.

**Listing lifecycle.** `draft → coming_soon → active → under_offer → sold` (sale) or `let` (rent); `withdrawn` from any open
state; `under_offer → active` when a deal falls through; `withdrawn → draft` to relist. Customer-visible: coming soon,
active and under offer. Days on market count from the first time a listing became active. Prices are stored in minor units
in the office currency; area is stored canonically in m² and shown in the office unit (1 ft² = 0.09290304 m²).
Addresses are formatted per country; an agent can hide the exact street address publicly.

**Customer flow.** Brand site → property search (sale/rent, type, price range in a chosen currency, beds, baths, minimum
area in m² or ft², city/office) → listing page (gallery, floor plans, tour link, features, disclosures, agents, open houses,
map placeholder) → **book a viewing** (slots from the listing agents' availability; the agent confirms) or **make an
enquiry** → confirmation with a manage link. Buyers can **save a search** and opt into email alerts with explicit consent
(consent record with purpose/version; unsubscribe link in every alert). Office pages list agents.

**Agent flow.** New enquiry arrives → routed to the listing agent (or co-listing agent), else round-robin among active
agents who accept leads, else the office pool → agent contacts → books/confirms viewing → logs feedback (interest level,
rating, notes) → records offers → negotiation (counter, accept, reject, withdraw; each step in the audit trail) → accepted
offer moves the listing to under offer → sold/let.

**Permissions.** Agents (role `staff` + agent profile linked to the user) see their own listings, their assigned
enquiries plus the office pool, their viewings, and offers on listings they list or co-list (or offers they submitted).
Office managers/franchise owners (`customers.read` at the office) see everything in their office. HQ admins see network
reports and listings but not client personal data or offer details by default. Vendor/landlord contact details are limited
to the listing agents and office managers.

**Fair housing and privacy.** No search filter, saved-search criterion, audience rule or AI action may use protected
characteristics (race, colour, religion, national origin, sex, gender identity, sexual orientation, familial status,
disability, age, marital status, source of income …). The AI tools accept only property and engagement criteria and refuse
anything else; listing copy is checked for steering phrases. Personal data is minimised: enquiries keep name, email,
phone and message only; HQ reports are aggregates.

**AI.** Drafts listing descriptions from the supplied facts only (no invented features, views, schools or neighbourhood
claims), summarises viewing feedback, and proposes follow-ups. Everything is a proposal; an authorised user applies it
through the normal editor (and approval) path.

**Portal syndication.** Adapter interface (`buildFeed`, `validate`) with Zillow-style XML, Realtor.ca-style JSON,
Rightmove-style JSON and Idealista-style XML implementations, all **sandbox**: the feed can be previewed and a sandbox
export recorded, but nothing is sent and the UI says so. Listings are exported only when opted in per portal.

Key edge cases: double-booked agent (server rejects overlapping viewings per agent), offer accepted while another is
accepted (only one accepted offer per listing), listing withdrawn with pending viewings (viewings cancelled with notice),
approval rejected (stays draft with comment), currency mismatch in price filters (other-currency listings excluded, never
converted), consent withdrawn (no alerts). Acceptance: offers are never visible to unauthorised agents, viewing conflicts
are rejected per agent, sold volume is reported per currency, and AI refuses protected-characteristic targeting.
