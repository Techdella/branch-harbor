# Hospitality — full product and UX

Status: specification for the seventh vertical (`hospitality` in `@bh/shared` `INDUSTRY_META`, release **available**). In MVP
per PRODUCT_PLAN decision 2. Written in the spirit of product-spec §9–13; the shared rules of §5 (roles), §14 (payments),
§15 (AI), §17 (data) and §18 (states) apply.

Purpose: run hotels, guesthouses/B&Bs, serviced apartments and hostels — single properties and groups — from one place:
inventory and rates, direct bookings with deposits, the front desk (arrivals, room assignment, folio, departures),
housekeeping and maintenance, guest messaging, an optional restaurant outlet and per-currency performance reports.
BranchHarbor is the property's own booking engine and PMS-lite. It is not an OTA, and it never claims a channel
manager sync is live unless it is.

| Screen | Main content and actions |
|---|---|
| Hospitality overview (Pulse) | Tonight's occupancy per property, arrivals/departures/in-house counts, rooms to clean, ADR and RevPAR per currency |
| Room grid | Rooms × nights calendar per property; reservation bars by status; unassigned reservations; out-of-order blocks; assign/move a reservation to a room |
| Reservations | List with filters (arrivals, in-house, departures, status, dates); detail with stay, guests, rate, policy, deposit, folio, registration, messages, timeline |
| Folio | Charges (room nights, taxes, extras, outlet charges, fees), payments and refunds, balance; post charge/payment; check-out requires a zero balance |
| Rates & availability | Rate plans (BAR, non-refundable, packages incl. breakfast), base/season/weekday prices per room type in the property currency, daily overrides, min/max stay, closed / closed to arrival / closed to departure |
| Room types & rooms | Room types (beds, occupancy, size, amenities, photos, dorm flag); rooms/units; dorm beds |
| Policies & taxes | Deposit and cancellation/no-show policies; taxes configured by the business (percent, per night, per person per night, per stay; max nights; exemptions by age) |
| Housekeeping board | Daily task board by status (to do, in progress, done, inspected), room status (clean, dirty, inspected, out of order), assign to staff; maintenance issues |
| Outlet | Optional restaurant/bar per property that reuses the Foods engine (menu, orders, kitchen display) with charge-to-room |
| Reports | Occupancy, ADR, RevPAR per property **per currency** (never combined), pickup, cancellations |
| Channels | Channel manager adapters (SiteMinder, Cloudbeds, Channex) in **sandbox**: preview the availability/rate payload, record a sandbox export; nothing is sent |

**Properties and inventory.** A property is a location (currency, time zone, address, locale). Property settings:
check-in and check-out times, hold minutes, require-inspected-before-check-in, registration fields, message timing,
outlet on/off. A **room type** has a name, kind (`room` | `apartment` | `dorm`), beds (type + count), base and max
occupancy, size, amenities, photos and an online-bookable flag. Rooms/units belong to a room type; a dorm room has
**beds**, and a dorm room type sells beds rather than rooms. Sellable inventory per room type and night =
units (rooms, or beds for dorms) minus units out of order that night. Inventory is a row per room type and night with
`sold ≤ total` enforced by a database CHECK; every booking, hold, modification, cancellation and no-show changes the
counter inside the same transaction, so concurrent bookings can never oversell (the second update fails the check and
rolls back). Room assignment is a row per room (or bed) and night with a unique constraint, so a room cannot be given to
two stays on the same night.

**Rates.** A rate plan belongs to a property and is priced in the property currency (minor units). Kinds: `bar` (best
available, flexible), `non_refundable` (may be derived from another plan with a percentage adjustment), `package` (e.g.
bed & breakfast, with inclusions). Price for one night = daily override → season price (weekday price if set) → base
price (weekday price if set), plus extra-guest fees above base occupancy, adjusted for derived plans. Restrictions:
min/max stay (plan, season and daily, evaluated on the arrival night; the strictest applies), closed (any night),
closed to arrival (arrival night) and closed to departure (departure date). A room type without a price for a night is
not sellable on that plan — prices are never invented.

**Taxes.** Configured only by the business: name, kind (`percent` of room revenue, `per_night`, `per_person_per_night`,
`per_stay`), amount or rate, inclusive or added, maximum nights, and an exemption under an age. Shown as separate lines in
quotes and on the folio. Where none are configured, none are charged and the quote says so.

**Deposits and cancellation.** A rate plan has a deposit rule (`none`, `first_night`, `percent`, `full`) and a
cancellation policy: free until N hours before arrival (property check-in time, property time zone); a late-cancellation
fee and a no-show fee (`first_night`, `percent`, `full`, `fixed`); or non-refundable. The policy is snapshotted on the
reservation at booking. Cancelling refunds the deposit minus the fee through the existing payments service; a fee above
the deposit is left on the folio as an outstanding charge (no off-session charge in this release).

**Customer flow.** Brand site → property → dates and guests → available room types with rate choices (total incl.
taxes, deposit, cancellation terms, inclusions) → guest details (name, email, phone, arrival time, requests, consent to
pre-arrival messages) → **hold** (inventory secured, timed) → deposit payment with the card form → confirmation with a
manage link. Manage booking: view, add registration details when the property asks for them, change dates (new nights
are secured before old ones are released; on failure the original booking stays), cancel with the fee shown first.
Rates with no deposit confirm immediately.

**Front desk flow.** Arrivals list → open reservation → capture registration details where legally needed (the business
configures the fields; nothing else is accepted) → assign a clean (or inspected) room → check in → room nights and taxes
post to the folio → extras, outlet charges, payments → check out at zero balance → the room becomes dirty and a departure
clean is created. No-show after the arrival date: fee per policy, inventory released. Group bookings: one reservation
with several rooms and a group name; inventory for all rooms is secured all-or-nothing.

**Housekeeping and maintenance.** Room status transitions: `dirty → clean` (cleaned), `clean → inspected`,
`clean|inspected → dirty`, any → `out_of_order` (reason and until date; reduces inventory and is refused if it would
oversell), `out_of_order → dirty` (back in service). Daily board: departure cleans, stayovers, inspections and
maintenance tasks with `todo → in_progress → done` and assignment to staff. Staff use the mobile app to see their tasks and
mark them done.

**Guest messaging.** Pre-arrival (N days before) and check-in information (on arrival day) through the existing email/SMS
adapters, sent only with the guest's consent (recorded with purpose and version) and logged once per reservation and kind.

**Restaurant outlet add-on.** A property can enable an F&B outlet that uses the Foods engine on the same location
(menus, local prices, orders, kitchen display). Outlet staff can charge an order to an in-house reservation's room: the
order is created on the room's tab and a folio line is posted in the same transaction; rejecting or cancelling the
order reverses the folio line.

**Permissions.** Front desk and housekeeping staff (`operations.read/write` at the property) see reservations, the grid,
folios and tasks for their property; guest contact and registration details need `customers.read`; rates, policies and
taxes need `locations.write`; refunds need `payments.refund`; reports need `reports.read`. HQ sees aggregates per property.

**Reports.** Occupancy = room nights sold ÷ room nights available (out-of-order excluded); ADR = room revenue ÷ room
nights sold; RevPAR = room revenue ÷ room nights available. Per property and per currency, never summed across
currencies. Pickup: room nights and revenue booked per booking date for a stay window. Cancellations: count, room nights
lost and fees retained.

**Channel managers (later phase).** Adapter interface (`buildAvailabilityPayload`, `buildRatesPayload`,
`parseReservation`) with SiteMinder-, Cloudbeds- and Channex-style implementations in **sandbox** only; the UI states that
nothing is sent. Airbnb, Booking.com and Expedia arrive later through a channel manager.

**AI.** Room-type and policy copy drafts from supplied facts only; no invented amenities, ratings or tax amounts.

Key edge cases: last room booked twice at once (one succeeds, the other gets `sold_out`), modification to full dates
(original kept), payment after the hold expired (confirmed only if inventory can be re-secured, else the reconciliation
queue), out-of-order on a sold-out night (refused), check-in before the room is clean (refused unless the property allows
it), outlet charge to a guest who checked out (refused), cancellation fee above the deposit (outstanding folio charge),
mixed-currency groups (reports split per currency). Acceptance: no overbooking under concurrency, modifications secure new
inventory before releasing old, folio balance is exact, reports never combine currencies.
