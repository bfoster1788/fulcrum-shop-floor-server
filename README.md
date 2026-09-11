# Fulcrum Shop Floor — backend server

Backend proxy for the Fulcrum Shop Floor PWA. Holds the one Fulcrum Public API bearer token
server-side, exposes a small REST API matching the PWA's `api.js` seam, and keeps the local
side-data Fulcrum's API has no place for: operator badge mapping, machine attribution per timer,
idempotency keys, and local pause reasons.

## Status

Built in mock mode (`MOCK_MODE=true`) and runnable end-to-end right now with **no Fulcrum
account or token** — every route returns realistic fake data shaped like the real API. This is
so the server can be reviewed and wired up to the PWA design immediately. Switching to real data
needs exactly one thing from Brian: a Fulcrum Public API token (Settings → API / Integrations in
Fulcrum), dropped into `.env` as `FULCRUM_API_TOKEN`, with `MOCK_MODE=false`.

## Run it

```
npm install
cp .env.example .env
npm start
```

Health check: `GET http://localhost:3000/api/health`

## Admin auth (registering operator badges)

`POST /api/operators` — the endpoint that maps a badge id to a Fulcrum userId — is gated behind
an `X-Admin-Token` header that must match `ADMIN_TOKEN` in `.env`. This is the one write endpoint
in the whole API that isn't scoped to an operator's own identity (everything else either reads
shop-floor data or acts as whichever userId the caller already asserts via badge/name sign-in),
so it's the one that needed a real gate before this server is reachable from outside the shop
network -- otherwise anyone who could reach the server could register their own badge id against
any Fulcrum userId and sign in as that person.

Generate a token once (`openssl rand -hex 32` or similar), put it in `.env` as `ADMIN_TOKEN`, and
send it as `X-Admin-Token` from whatever's doing badge registration (a small admin screen, or curl
for now). **If `ADMIN_TOKEN` isn't set, the server refuses all registration requests outright**
(fails closed) rather than silently running unprotected. Brian's own badge is already registered
in `data/store.json` with his real NFC serial (`04:42:81:17:C9:2A:81`, confirmed working via a
free NFC reader app once he switched to genuine NTAG-chip fobs — his first batch turned out to be
mislabeled/incompatible chips despite listing 13.56MHz).

Every other endpoint (jobs, equipment, timers, dashboard) is intentionally ungated for now, since
they either return non-sensitive shop-floor operational data or act only as the userId the request
itself provides. Worth revisiting once this is live on the open internet if that assumption stops
holding.

## Before going live on real Fulcrum data

**Note on testing:** the token Brian generated (`FULCRUM_API_TOKEN`, real value now in `.env`)
could not be tested live from the Claude sandbox this server was built in -- that environment's
network egress is allowlisted and `speedmetal.fulcrumpro.com` isn't on it (confirmed: a direct
`fetch` to it there returns a 403 "Host not in allowlist", not a Fulcrum error). The code itself
should be correct, but **run this from a machine with normal internet access** (your own laptop,
or wherever it ends up hosted) to actually validate it against live data for the first time --
don't be surprised if `MOCK_MODE=false` hasn't been exercised against a real response yet.

Job search and equipment listing are now confirmed directly against Fulcrum's live OpenAPI
schema (not inferred): `POST /jobs/list` and `POST /equipment/list`, both filter-body-plus-Skip/
Take-query-params. Two real findings from that pass, not TODOs:

1. **Fulcrum's job search has no free-text or customer/item search at all** — only exact filters
   (job ids, job numbers, exact job names, status, sales order id, created/modified date range).
   So `GET /api/jobs?search=...` in this server pulls the open working set (inProgress +
   scheduled jobs) and filters by substring server-side. That's a real architectural constraint,
   not a shortcut — it just won't hold up if the open job count gets very large. Worth revisiting
   (an indexed local cache kept in sync via polling `modifiedAfterUtc`, or asking Fulcrum support
   whether a real search endpoint exists) once this matters in practice.
2. **The raw job object has no customer or item name on it** — just `parentItemId` and
   `salesOrderId`. The MCP tool used during design did its own enrichment joins that the raw
   Public API doesn't do for you. `enrichJob()` in `server.js` now does this itself (one call to
   `GET /items/{id}` and one to `GET /sales-orders/{id}` → `GET /customers/{id}`, cached
   in-process), but it's unverified against a live token — confirm response field names
   (`name`, `customerId`, etc.) match once real credentials exist, and fix `enrichJob` if not.

Remaining `TODO/VERIFY` in `src/fulcrumClient.js`:

- `getCustomer`'s path (`/customers/{id}`) is assumed by analogy with the two confirmed
  patterns, not individually checked against the schema.
- Whether `/jobs/list` and `/equipment/list` responses are a bare array or wrapped as
  `{ items: [...] }` — code defensively handles either, but should be confirmed and simplified.

## Utilization definition (confirmed by Brian, 2026-09-09)

`GET /api/dashboard/machines` returns two separate numbers per machine:

- **`utilizationPctShift`** (all equipment) — any active job-tracking time (setup included, per
  Brian) divided by 7 scheduled hours/weekday. Fixed 7-hour denominator, not "hours elapsed
  today" — a machine can exceed 100% if it legitimately runs past that (lights-out overnight or
  weekend CNC work), and that's intentional: it shows as bonus output beyond standard staffed
  capacity, which is exactly what matters when judging capital equipment payback.
- **`spindleUtilizationPctShift`** (CNC machines only, `null` elsewhere) — narrower and
  deliberately excludes setup: only timer type `'run'` counts. This is the number Brian actually
  wants for gauging ROI on the 5-axis mills specifically — "biggest bang for buck on capital
  equipment."
- `isScheduledWorkday` on the response flags whether today is a weekday, for display purposes
  (e.g. graying out or annotating the numbers on a weekend) — the calculation itself still runs
  every day so unattended weekend output isn't hidden.

Still open, not yet defined:

1. **"Down" machine status.** The dashboard currently only distinguishes running/idle — there's no
   real signal yet for a machine being down for maintenance vs. simply idle. Fulcrum's equipment
   `status` field (seen values so far: `"Good"`) may or may not carry this; needs a real down/repair
   workflow decision from Brian.

## Deployment

Not deployed anywhere yet. Hosting requires creating an account and likely a payment method,
which needs Brian's explicit go-ahead and involvement (not something to do unilaterally). Options
to raise with him when this is ready: a small always-on box (Railway, Render, Fly.io — cheap,
minutes to deploy) vs. self-hosting on shop infrastructure if there's already a machine that stays
on. The server itself has no dependency on any particular host — it's a plain Node/Express app
with a JSON file for local state.

## Data model

See `src/store.js` for the full shape. In short: `data/store.json` (gitignored) holds the
operator badge table (seeded with Brian's own mapping, flagged `badgeIdPending: true` until his
real NFC keychain fob replaces the placeholder HID prox number), the equipment-assignment table
(`timerId -> equipmentId`, since Fulcrum's timer-start endpoint has no equipment field at all —
this is how concurrent multi-machine runs get attributed to the right machine), local pause
reasons, and idempotency keys.
