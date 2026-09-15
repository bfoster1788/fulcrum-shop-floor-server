# Reports API — what the OLE and OEE views need

> **Status, 2026-09-15.** `/api/reports/labor` and `/api/reports/equipment` are implemented and
> the Reports page, the Machining, Production and People board views all read them live.
> Two open items:
>
> 1. **UTC vs Pacific bucketing.** It matters. The shop runs roughly 05:00–15:00 Pacific, which
>    is 12:00–22:00 UTC in summer, so a single UTC day currently holds one Pacific day's work and
>    nothing crosses midnight — today's numbers are right. It breaks on overtime and lights-out:
>    anything booked after 17:00 Pacific (00:00 UTC) lands on the next day's report, which will
>    show a machine that ran all night as idle on the night it ran and over-utilized the morning
>    after. Bucket on `America/Los_Angeles` local day instead, and keep `date` meaning the local
>    day. Until then the views state the caveat.
> 2. **Attribution for non-CNC stations.** Routing steps carry free text or blanks for several
>    stations (audit below). The client now treats any station code outside the known list as
>    unmeasurable rather than scoring it.
>
> Known equipment codes, from the 2026-09-15 audit: DB1 deburr, S1 shipping, PK packaging,
> U1 cleaning, PAS passivation, QC1/QL quality, CMM1/CMM2 CMM inspection, P1 programming
> (CNC and CMM share it), SC1 bandsaw, L1 laser. Seen wrong in live routings: Deburr, Shipping,
> CNC Programming and Laser Engraving alternate between the real code and free text
> ("Post- Machining Work Bench", "Programming Office"); Cleaning scheduled against Assembly
> Station 1 instead of U1; CMM Inspection as "9.Keyence XM"; Bandsaw often blank; PK never used.
> Brian's team holds the fix checklist.

Two read-only routes. Neither exists yet. `GET /api/dashboard/machines` cannot be reused:
it measures only timers that are running at this instant (`Date.now() - startedUtc`), so
it has no answer for "what happened during today's shift". These routes need **completed**
time entries.

Definitions below were confirmed by Brian on 2026-09-14. The client computes the factors
from raw seconds and counts — the server should return the raw values, not percentages, so
the arithmetic stays visible in one place and a missing input can be reported honestly
rather than silently defaulted to 1.0.

## GET /api/schedule/queues

What "On deck" (`plan.html`) needs to be always-on. It currently does this join in the
browser: one `/api/jobs/:id/routing` call per open job, about 50 requests, four at a time,
behind a LOAD THE SCHEDULE button. That is deliberate — a wall display refreshing every
minute would otherwise be 50 requests a minute, each fanning out to one
`items-to-make/list` plus one `operations/list` upstream. One server route replaces all of
it and can be cached.

```json
{
  "generatedUtc": "2026-09-14T19:20:00Z",
  "jobCount": 50,
  "operations": [
    {
      "jobId": "69fa471f0b15243f7bdc11af",
      "systemJobNumber": 1896,
      "jobName": "KARM (002.5)",
      "customerName": "Karman Space & Defense",
      "itemName": "10000700-C01",
      "quantityRemaining": 12,
      "jobScheduledEndUtc": "2026-09-20T16:00:00Z",

      "itemToMakeId": "...",
      "operationId": "e43bb413-b43c-453d-be5f-19640023cddf",
      "operationName": "5. Machining",
      "order": 5,
      "status": "Ready",
      "scheduledEquipmentId": "...",
      "scheduledEquipmentName": "DMU 50",
      "scheduledStartUtc": "2026-09-15T13:00:00Z",
      "scheduledEndUtc": "2026-09-15T19:00:00Z",
      "isOutsideProcessing": false,
      "isMachineTimeOnly": true,
      "estimatedMachineTimeInSeconds": 21600,
      "estimatedSetupTimeInSeconds": 3600,
      "associatedPurchaseOrderIds": []
    }
  ]
}
```

Rules:

- **Scope:** operations on the open job set (`inProgress` + `scheduled`, same as
  `GET /api/jobs`) whose `status` is not complete. Completed operations are not "on deck".
- **Flat, not nested.** The client groups by `scheduledEquipmentName` (machine view) and by
  operation name (area view, since operations carry no work-center field). A flat list keeps
  both groupings possible without re-shaping.
- **Job fields are denormalised onto each operation** — number, name, customer, quantity
  remaining, job scheduled end. Otherwise the client needs a second read to label a row.
- **Cache it.** Routing changes on the scale of hours, not seconds. A process-level cache
  with a 60-120s TTL, or a `?refresh=1` bypass, is enough; the fan-out cost is what matters,
  not freshness to the second.
- **Partial failure must not empty the response.** One job whose routing read fails should be
  omitted with a warning (same best-effort approach as `enrichJob`), and the count of
  omissions returned as `skippedJobCount` so the view can say the list is incomplete rather
  than implying an empty queue.
- Optional `?equipmentName=` / `?operationName=` filters are not needed — the payload for 50
  jobs is small and the client already holds it for both groupings.

With this in place, `plan.html` drops the LOAD THE SCHEDULE button and the progress
counter, and polls this route on the same 60s cadence as the floor board.

## GET /api/materials/backlog and GET /api/reports/on-time

The project-management view needs these two and nothing in `fulcrumClient.js` reaches them
yet — it has jobs, items, sales orders, customers, equipment, timers and routing, but no
purchase-order, material-allocation, receipt or shipment call. Both routes should return
`null`-able fields rather than zeros, same principle as the reports above.

### The purchase order carries the date that matters

Confirmed with Brian 2026-09-14: **purchase-order lines have an expected date, and that is
what material and OSP status should be judged against** — not the routing's
`scheduledEndUtc`. The live data makes the case: all 22 open outside-processing steps in the
current job set have `scheduledEndUtc: null`, so the routing cannot answer "is this late" at
all, while each step does carry `associatedPurchaseOrderIds`. The routing date is a
production plan; the PO expected date is the vendor's commitment. Where both exist, the PO
date decides lateness and the routing date is only what the schedule assumed.

So this one route is the source for inbound dates, covering **both** raw material and
outside-processing services — the same query against purchase orders, separated by a flag:

```json
{
  "generatedUtc": "2026-09-14T20:10:00Z",
  "lines": [
    {
      "purchaseOrderId": "...",
      "purchaseOrderNumber": "PO-4417",
      "lineId": "...",
      "vendorName": "Precision Coating Inc",
      "isOutsideProcessing": true,

      "expectedDate": "2026-09-10T00:00:00Z",
      "promisedDate": "2026-09-08T00:00:00Z",
      "orderedQuantity": 12,
      "receivedQuantity": 0,
      "receivedDate": null,

      "jobId": "...",
      "systemJobNumber": 1947,
      "jobName": "MSCI (069.0) WO 26-1947",
      "customerName": "Machine Sciences Corporation",
      "operationId": "...",
      "operationName": "7. Chem Film"
    }
  ],
  "missing": [
    {
      "jobId": "...",
      "systemJobNumber": 1951,
      "jobName": "...",
      "itemName": "...",
      "requiredQuantity": 40,
      "reason": "no purchase order line"
    }
  ]
}
```

Rules:

- **`expectedDate` is what makes a line judgeable.** Past its expected date with
  `receivedQuantity < orderedQuantity` is late. A missing `expectedDate` must come back
  `null`, and the view reports it as unmeasurable rather than on time — that distinction is
  the whole reason this section exists.
- Return `promisedDate` alongside `expectedDate` if Fulcrum distinguishes them (original
  commitment vs current expectation). On-time inbound is measured against the original
  promise; the backlog list shows what to expect now. If only one exists, return it as
  `expectedDate` and leave `promisedDate` null.
- **`isOutsideProcessing` separates services from material**, so one route feeds both the
  material-backlog block and the outside-processing block. Join to the routing operation via
  `associatedPurchaseOrderIds` so the OSP block can still name the step.
- `missing` answers a different question from late: open jobs whose material has no PO line
  at all. Keep it a separate array with a `reason` string.
- Fulcrum's purchase-order endpoints are not in `fulcrumClient.js` yet. Expect the same
  `POST /{resource}/list` + `Skip`/`Take` pattern as `/jobs/list`, `/equipment/list` and
  `/job-tracking-timers/list` — verify the path and the received-quantity field names against
  the live schema before relying on them, the way the routing endpoints were verified.

### Implementation path — the Fulcrum endpoints that back both routes

Checked against Fulcrum's public API docs and changelog 2026-09-15. The data exists; this
server simply does not call it yet. Paths follow the same `POST /{resource}/list` family that
`/jobs/list`, `/equipment/list` and `/job-tracking-timers/list` already use, so treat the exact
paths as TODO/VERIFY and probe them the way the routing endpoints were probed.

What the docs confirm is available:

- **Purchase orders**, with part line items carrying `promiseDate` and `receiveByDate` — these
  are the `promisedDate` / `expectedDate` this spec asks for. POs also carry
  `vendorOrderNumber`, so the vendor name is reachable without a second guess.
- **Receipts** — Receipt List and Receipt Get, filterable, carrying invoice and external
  reference. Receipt date against the line's `promiseDate` is inbound on-time.
- **Shipments** — Shipment Get returns the scheduled ship-by date and, once shipped, the actual
  shipped date. That pair is outbound on-time, and it removes the completed-job problem noted
  below: on-time outbound can be measured from shipments directly rather than from a job query
  that only returns open work.
- **Reporting-view list endpoints** — Fulcrum exposes pre-joined report rows (a shipping
  reporting view with shipped/unshipped columns among them). If the shipping view covers the
  ship-by vs shipped-date pair, use it instead of hand-joining shipments to sales-order lines.

Order of work:

1. Add to `fulcrumClient.js`: `listPurchaseOrders`, `getPurchaseOrder`, `listReceipts`,
   `listShipments`. Same `request('POST', '/x/list?Take=…', {})` shape as the rest.
2. Add a debug probe route in `server.js` (the pattern already used for the operations list) and
   hit each one against the live ITAR token before wiring any view to it. Record the real field
   names — this spec's names are the client contract, not Fulcrum's.
3. Build `/api/materials/backlog` from purchase orders + receipts, mapping Fulcrum's fields onto
   the shape above and joining to jobs via the routing's `associatedPurchaseOrderIds`. Ship it —
   it unblocks two KPI cards, section 1 and the correct date for section 2.
4. Build `/api/reports/on-time` from receipts (inbound) and shipments (outbound), over a stated
   window, returning `null` for any factor with no data behind it.

Steps 1 and 2 are an hour of work and answer the open question (do the fields exist, and what are
they called). Everything after that is shaping data this server already has access to.

`/api/reports/on-time`: completed history, not open work — inbound (received date vs promised
date per PO line) and outbound (ship or completion date vs scheduled end per job), each as
`{ onTime, total }` over a stated window, plus the per-customer breakdown for outbound. Note
the current job read only returns `inProgress` and `scheduled`, so outbound on-time needs a
completed-job query that does not exist today.

## GET /api/reports/labor?date=YYYY-MM-DD

```json
{
  "date": "2026-09-14",
  "generatedUtc": "2026-09-14T19:40:00Z",
  "shiftSeconds": 25200,
  "operators": [
    {
      "userId": "6a2836095c1346467db87fb9",
      "name": "B. Foster",
      "role": "Administrator",
      "runSeconds": 14400,
      "setupSeconds": 3600,
      "standardSeconds": 16200,
      "goodQty": 41,
      "scrapQty": 2,
      "jobs": 3
    }
  ]
}
```

- `shiftSeconds` — scheduled shift length, **regardless of clock in/out** (Brian's choice).
  7 hours = 25200.
- `runSeconds` / `setupSeconds` — completed time entries for that user on `date`, split by
  timer type (`run` vs setup). Exclude breaks.
- `standardSeconds` — routing estimated machine time for the operations that user completed
  on `date` (`estimatedMachineTimeInSeconds` × quantity completed). Omit or `null` when the
  routing has no estimate; the view then says "no routing standard" instead of scoring.
- `goodQty` / `scrapQty` — pieces that user posted on `date`. See scrap capture below.

OLE = (run + setup) / shiftSeconds × standardSeconds / runSeconds × good / (good + scrap).

## GET /api/reports/equipment?date=YYYY-MM-DD

```json
{
  "date": "2026-09-14",
  "generatedUtc": "2026-09-14T19:40:00Z",
  "calendarSeconds": 86400,
  "machines": [
    {
      "equipmentId": "...",
      "name": "D1",
      "description": "DMG Mori DMU 50, 5-axis",
      "isCnc": true,
      "runSeconds": 33000,
      "setupSeconds": 5400,
      "standardSeconds": 31000,
      "goodQty": 88,
      "scrapQty": 1
    }
  ]
}
```

- `calendarSeconds` — **calendar** hours, not staffed hours (Brian's choice: capital
  utilization). Full day = 86400; for today-in-progress, seconds elapsed since local
  midnight is acceptable as long as it is stated.
- Machine attribution comes from our own `timerId -> equipmentId` table
  (`store.getAllEquipmentAssignments()`), same as the dashboard route — Fulcrum's timers
  carry no equipment.
- `isCnc` — `workCenterName === 'CNC Machining'`, as elsewhere.

OEE = (run + setup) / calendarSeconds × standardSeconds / runSeconds × good / (good + scrap).

Note these numbers will read **lower** than the floor board's utilization, which divides by
7 staffed hours. That is intended and the view says so.

## Scrap capture (already shipped on the client)

Quality had no source anywhere, so the operator app now captures it. The complete sheet has
a scrap stepper, and both quantity routes receive `scrapQuantity`:

- `POST /jobs/:jobId/items-to-make/:itemToMakeId/operations/:operationId/complete`
  → `{ quantity, scrapQuantity }` (Fulcrum already accepts this)
- `POST /jobs/:jobId/items-to-make/:itemToMakeId/operations/:operationId/add-quantity-completed`
  → `{ quantity, scrapQuantity }` — **server change needed.** Fulcrum's add-quantity call has
  no scrap field, so store `scrapQuantity` in our own side table keyed by
  `jobId/itemToMakeId/operationId` plus `userId` and timestamp, the same way pause reasons
  and equipment assignment already live locally. Without this, partial posts lose their scrap
  count and the quality factor is only correct on the post that closes a step.

## Missing inputs

Return `null` (or omit) rather than zero for anything unknown. The views render a per-factor
reason — "no routing standard", "no good/scrap count", "no time booked" — and suppress the
combined score. A fabricated 100% quality factor would make OEE look 20 points better than
reality, which is worse than an empty column.
