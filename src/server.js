import 'dotenv/config';
import express from 'express';
import cors from 'cors';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { fulcrum, FulcrumApiError } from './fulcrumClient.js';
import * as mock from './mockData.js';
import * as store from './store.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const MOCK_MODE = (process.env.MOCK_MODE ?? 'true') !== 'false';
const PORT = process.env.PORT || 3000;
const ALLOWED_ORIGINS = (process.env.ALLOWED_ORIGINS || '*').split(',').map(s => s.trim());

const app = express();
app.use(express.json());
app.use(cors({ origin: ALLOWED_ORIGINS.includes('*') ? true : ALLOWED_ORIGINS }));

// ---- Static PWA -----------------------------------------------------------------------------
// Serves the actual shop-floor app (index.html, board.html, api.js, icons, manifest, service
// worker) from this same Railway service, at the same domain/port as the API -- so
// shopfloor.impulseprecision.com/ shows the real app instead of raw JSON, and the app's own
// same-origin API calls (api.js defaults to this server's absolute URL already) keep working
// with no separate hosting/CORS setup needed. This is the exported build from the Claude Design
// canvas (received from Brian 2026-09-11), copied verbatim into public/ -- not hand-written here.
app.use(express.static(path.join(__dirname, '..', 'public')));

// In-memory mock run state (only used when MOCK_MODE=true) so start/pause/complete round-trip
// sensibly across requests without needing a real Fulcrum account.
const mockTimers = new Map(); // timerId -> { userId, jobId, itemToMakeId, operationId, type, startedUtc, stoppedUtc }
let mockTimerSeq = 1;

// Cheap in-memory cache for item/customer name lookups used to enrich jobs -- see the big
// comment in fulcrumClient.js. Names change rarely enough that a process-lifetime cache with no
// eviction is fine at this scale; revisit if this ever needs to run for weeks without a restart.
const itemNameCache = new Map();     // itemId -> name
const customerNameCache = new Map(); // customerId -> name

async function enrichJob(job) {
  let itemName = null, customerName = null;
  try {
    if (job.parentItemId) {
      if (!itemNameCache.has(job.parentItemId)) {
        const item = await fulcrum.getItem(job.parentItemId);
        itemNameCache.set(job.parentItemId, item?.name || item?.itemNumber || null);
      }
      itemName = itemNameCache.get(job.parentItemId);
    }
    if (job.salesOrderId) {
      const so = await fulcrum.getSalesOrder(job.salesOrderId);
      const customerId = so?.customerId;
      if (customerId) {
        if (!customerNameCache.has(customerId)) {
          const customer = await fulcrum.getCustomer(customerId);
          customerNameCache.set(customerId, customer?.name || null);
        }
        customerName = customerNameCache.get(customerId);
      }
    }
  } catch (err) {
    // Enrichment is best-effort -- a job with an unresolvable item/customer name still shows up
    // in search by number/name, just without those extra fields. Don't fail the whole request.
    console.warn(`Job enrichment failed for job ${job.id}:`, err.message);
  }
  return { ...job, systemJobNumber: job.number, jobName: job.name, itemName, customerName };
}

// ---- Admin auth gate -----------------------------------------------------------------------------
// Protects the operator-registration endpoint (mapping a badge id to a Fulcrum userId). Everything
// else in the API is either read-only shop-floor data or scoped to whichever userId the caller
// already asserts (the PWA has no login-session concept -- badge/name lookup IS the login), so this
// is the one place worth an explicit gate: without it, anyone who can reach this server over the
// open internet could register a badge id of their choosing against any Fulcrum userId and sign in
// as that operator. A single shared admin token is deliberately simple -- there's one admin
// (Brian) doing this rarely (onboarding an operator's badge), not a multi-admin permissions system.
const ADMIN_TOKEN = process.env.ADMIN_TOKEN || '';

function requireAdmin(req, res, next) {
  if (!ADMIN_TOKEN) {
    // Fail CLOSED, not open: an unset token must never mean "admin routes are unprotected." This
    // only bites if someone deploys without setting ADMIN_TOKEN in .env -- the error message says
    // exactly what to do.
    return res.status(503).json({
      error: 'ADMIN_TOKEN is not configured on this server. Set it in .env before registering operators.',
    });
  }
  const provided = req.get('X-Admin-Token');
  if (!provided || provided !== ADMIN_TOKEN) {
    return res.status(401).json({ error: 'Missing or invalid X-Admin-Token header.' });
  }
  next();
}

function handleError(res, err) {
  if (err instanceof FulcrumApiError) {
    return res.status(err.status >= 400 && err.status < 600 ? err.status : 502).json({
      error: err.message, fulcrum: err.body,
    });
  }
  console.error(err);
  return res.status(500).json({ error: err.message || 'Internal error' });
}

app.get('/api/health', (req, res) => {
  res.json({ ok: true, mockMode: MOCK_MODE });
});

// ---- Auth / operators ------------------------------------------------------------------------
// No password anywhere. Sign-in is badge-scan (NFC serial) primary, name-search secondary, both
// resolved against our own operator table -- never against Fulcrum, which has no way to verify
// an individual operator at all (see fulcrumClient.js header comment).

app.get('/api/operators', async (req, res) => {
  try {
    const operators = await store.getOperators();
    res.json(operators.map(({ badgeId, badgeIdPending, ...rest }) => rest)); // don't leak badge ids in the name-search list
  } catch (err) { handleError(res, err); }
});

app.post('/api/badge/lookup', async (req, res) => {
  try {
    const { badgeId } = req.body;
    if (!badgeId) return res.status(400).json({ error: 'badgeId is required' });
    const operator = await store.findOperatorByBadge(badgeId);
    if (!operator) return res.status(404).json({ error: 'Badge not registered', badgeId });
    res.json(operator);
  } catch (err) { handleError(res, err); }
});

// Admin-gated: registers or re-maps a badge id to a Fulcrum userId. Requires the X-Admin-Token
// header to match ADMIN_TOKEN (see requireAdmin above). This is the one write endpoint that isn't
// scoped to an existing operator's own userId, so it's the one that needed a real gate before this
// server is reachable from outside the shop network.
app.post('/api/operators', requireAdmin, async (req, res) => {
  try {
    const { badgeId, fulcrumUserId, firstName, lastName, role } = req.body;
    if (!badgeId || !fulcrumUserId) {
      return res.status(400).json({ error: 'badgeId and fulcrumUserId are required' });
    }
    const operator = await store.upsertOperator({
      badgeId, badgeIdPending: false, fulcrumUserId, firstName, lastName, role,
    });
    res.json(operator);
  } catch (err) { handleError(res, err); }
});

// Admin-gated: removes a registered badge id (e.g. one that turned out not to work, like a
// non-NFC-readable prox fob number). Same requireAdmin gate as registration above, for the same
// reason -- this is a write endpoint touching another operator's login mapping.
app.delete('/api/operators/:badgeId', requireAdmin, async (req, res) => {
  try {
    const removed = await store.removeOperatorByBadge(req.params.badgeId);
    if (!removed) return res.status(404).json({ error: 'No operator registered with that badgeId' });
    res.json({ ok: true, removedBadgeId: req.params.badgeId });
  } catch (err) { handleError(res, err); }
});

// ---- Jobs -------------------------------------------------------------------------------------

// Fulcrum's job-list endpoint has no free-text/customer/item search -- only exact filters (see
// fulcrumClient.js). So: pull the open working set (inProgress + scheduled, which is what
// operators actually need to find) and filter substring-match server-side. Confirmed real
// limitation, not a shortcut -- matches the design canvas's own flagged rough edge. Fine at
// Impulse's current job volume; revisit (indexed cache, or ask Fulcrum about a search endpoint)
// if this ever gets slow.
app.get('/api/jobs', async (req, res) => {
  try {
    const q = (req.query.search || '').toLowerCase();
    if (MOCK_MODE) {
      const results = mock.jobs.filter(j =>
        !q || j.jobName.toLowerCase().includes(q) || j.customerName.toLowerCase().includes(q) ||
        j.itemName.toLowerCase().includes(q) || String(j.systemJobNumber).includes(q));
      return res.json(results);
    }
    // TODO/VERIFY: whether /jobs/list wraps results as { items: [...] } (common Fulcrum list
    // shape elsewhere) or returns a bare array -- guarded both ways until confirmed live.
    const raw = await fulcrum.listJobs({ statuses: ['inProgress', 'scheduled'], take: 500 });
    const jobs = await Promise.all((raw?.items ?? raw ?? []).map(enrichJob));
    const results = !q ? jobs : jobs.filter(j =>
      (j.jobName || '').toLowerCase().includes(q) ||
      (j.customerName || '').toLowerCase().includes(q) ||
      (j.itemName || '').toLowerCase().includes(q) ||
      String(j.systemJobNumber).includes(q));
    res.json(results);
  } catch (err) { handleError(res, err); }
});

app.get('/api/jobs/by-number/:number', async (req, res) => {
  try {
    const number = req.params.number.replace(/^0+/, ''); // strip leading zeros, per the design canvas's lookup
    if (MOCK_MODE) {
      const job = mock.jobs.find(j => String(j.systemJobNumber) === number);
      if (!job) return res.status(404).json({ error: 'No job with that number' });
      return res.json(job);
    }
    const raw = await fulcrum.getJobsByNumbers([Number(number)]);
    const job = (raw?.items ?? raw ?? [])[0];
    if (!job) return res.status(404).json({ error: 'No job with that number' });
    res.json(await enrichJob(job));
  } catch (err) { handleError(res, err); }
});

app.get('/api/jobs/:jobId', async (req, res) => {
  try {
    if (MOCK_MODE) {
      const job = mock.jobs.find(j => j.id === req.params.jobId);
      if (!job) return res.status(404).json({ error: 'Job not found' });
      return res.json(job);
    }
    res.json(await enrichJob(await fulcrum.getJob(req.params.jobId)));
  } catch (err) { handleError(res, err); }
});

// ---- Routing (items-to-make + operations) -------------------------------------------------------
// Closes the "no routing read" gap flagged during pilot testing 2026-09-11: the client can search
// and open a job, but has nothing to start a timer against -- /api/timers/start requires
// itemToMakeId + operationId, and neither exists on the raw job object (confirmed live -- see
// enrichJob/GET /api/jobs/:jobId above). This walks Fulcrum's routing tree
// (POST /jobs/{jobId}/items-to-make/list, then POST .../items-to-make/{id}/operations/list per
// item -- both CONFIRMED live 2026-09-11 via a direct probe, see fulcrumClient.js) and returns one
// flat structure the client can render as a step picker.
function asList(x) {
  if (Array.isArray(x)) return x;
  if (x && typeof x === 'object') {
    for (const v of Object.values(x)) if (Array.isArray(v)) return v;
  }
  return [];
}

app.get('/api/jobs/:jobId/routing', async (req, res) => {
  try {
    const { jobId } = req.params;
    if (MOCK_MODE) {
      return res.json([{
        itemToMakeId: `${jobId}-item-1`,
        itemName: 'Mock Item',
        operations: [
          { id: `${jobId}-op-1`, name: '1. Setup', status: 'Ready', order: 0 },
          { id: `${jobId}-op-2`, name: '2. Machining', status: 'Pending', order: 1 },
        ],
      }]);
    }
    const itemsRaw = await fulcrum.getItemsToMake(jobId);
    const items = asList(itemsRaw);
    const withOps = await Promise.all(items.map(async (item) => {
      const itemToMakeId = item.id ?? item.itemToMakeId;
      try {
        const opsRaw = await fulcrum.getOperationsForItemToMake(jobId, itemToMakeId);
        return { ...item, itemToMakeId, operations: asList(opsRaw) };
      } catch (err) {
        // One item's operations failing to load shouldn't blank the whole routing screen --
        // same best-effort philosophy as enrichJob above.
        console.warn(`Operations fetch failed for job ${jobId} item ${itemToMakeId}:`, err.message);
        return { ...item, itemToMakeId, operations: [] };
      }
    }));
    res.json(withOps);
  } catch (err) { handleError(res, err); }
});

// ---- Equipment ----------------------------------------------------------------------------------

app.get('/api/equipment', async (req, res) => {
  try {
    if (MOCK_MODE) return res.json(mock.equipment);
    const raw = await fulcrum.searchEquipment();
    res.json(raw?.items ?? raw ?? []);
  } catch (err) { handleError(res, err); }
});

// ---- Timers: start / pause(stop) / resume -----------------------------------------------------
// Machine attribution lives entirely in our own side table (store.setEquipmentForTimer) because
// Fulcrum's start endpoint has no equipment field. "Pause" is not a Fulcrum concept -- it's a real
// stop of the Fulcrum timer, with our own pauseReasons table recording why, and "resume" is a new
// start against the same job/item/operation. This mirrors exactly what the design canvas's PWA
// already assumes on the client side.

app.post('/api/timers/start', async (req, res) => {
  try {
    const { userId, jobId, itemToMakeId, operationId, type, equipmentId } = req.body;
    for (const [k, v] of Object.entries({ userId, jobId, itemToMakeId, operationId, type })) {
      if (!v) return res.status(400).json({ error: `${k} is required` });
    }

    let timer;
    if (MOCK_MODE) {
      const id = `mock-timer-${mockTimerSeq++}`;
      timer = { id, userId, jobId, itemToMakeId, operationId, type, startedUtc: new Date().toISOString(), stoppedUtc: null };
      mockTimers.set(id, timer);
    } else {
      timer = await fulcrum.startTimer({ userId, jobId, itemToMakeId, operationId, type });
    }

    if (equipmentId) await store.setEquipmentForTimer(timer.id, equipmentId);
    res.json(timer);
  } catch (err) { handleError(res, err); }
});

// Recovers in-progress timers for an operator after a force-quit/reload -- flagged during pilot
// testing 2026-09-11 as "the biggest functional hole": without this, a phone that lost its local
// state had no way to find out it still had a running timer in Fulcrum. Filters server-side to the
// requesting userId since Fulcrum's search has no per-user scoping built in.
app.get('/api/timers/active', async (req, res) => {
  try {
    const { userId } = req.query;
    if (!userId) return res.status(400).json({ error: 'userId is required' });

    if (MOCK_MODE) {
      const active = [...mockTimers.values()].filter(t => !t.stoppedUtc && t.userId === userId);
      return res.json(active);
    }
    const raw = await fulcrum.searchTimers({ userId, stoppedOnUtc: null });
    const active = asList(raw).filter(t => t.userId === userId);
    res.json(active);
  } catch (err) { handleError(res, err); }
});

app.post('/api/timers/stop', async (req, res) => {
  try {
    const { userId, timerId, reason, note } = req.body;
    if (!userId || !timerId) return res.status(400).json({ error: 'userId and timerId are required' });

    let result;
    if (MOCK_MODE) {
      const timer = mockTimers.get(timerId);
      if (!timer) return res.status(404).json({ error: 'Timer not found' });
      timer.stoppedUtc = new Date().toISOString();
      result = timer;
    } else {
      result = await fulcrum.stopTimer({ userId, timerId });
    }

    // A "pause" (machine/material reason) is recorded locally; a real break should go through
    // /api/timers/break instead, which also clocks a real Fulcrum break -- see below.
    if (reason) await store.setPauseReason(timerId, reason, note);
    res.json(result);
  } catch (err) { handleError(res, err); }
});

// Real end-of-shift / break: stops the job timer (above) AND clocks a genuine Fulcrum break,
// distinct from the local-only machine/material pause reasons.
app.post('/api/timers/break/start', async (req, res) => {
  try {
    const { userId } = req.body;
    if (!userId) return res.status(400).json({ error: 'userId is required' });
    if (MOCK_MODE) return res.json({ ok: true, mock: true });
    res.json(await fulcrum.clockOut(userId));
  } catch (err) { handleError(res, err); }
});

app.post('/api/timers/break/end', async (req, res) => {
  try {
    const { userId } = req.body;
    if (!userId) return res.status(400).json({ error: 'userId is required' });
    if (MOCK_MODE) return res.json({ ok: true, mock: true });
    res.json(await fulcrum.clockIn(userId));
  } catch (err) { handleError(res, err); }
});

// ---- Quantity / completion (idempotent) ---------------------------------------------------------
// A client-supplied Idempotency-Key header is required. The offline replay queue in the PWA can
// legitimately fire the same completion twice (partial success, then a retry) -- this is what
// stops that from double-counting quantity or double-completing an operation.

app.post('/api/jobs/:jobId/items-to-make/:itemToMakeId/operations/:operationId/add-quantity-completed', async (req, res) => {
  try {
    const idempotencyKey = req.get('Idempotency-Key');
    if (!idempotencyKey) return res.status(400).json({ error: 'Idempotency-Key header is required' });

    const cached = await store.getIdempotentResponse(idempotencyKey);
    if (cached) return res.json(cached);

    const { jobId, itemToMakeId, operationId } = req.params;
    const { quantity } = req.body;
    if (quantity == null) return res.status(400).json({ error: 'quantity is required' });

    const result = MOCK_MODE
      ? { ok: true, mock: true, jobId, itemToMakeId, operationId, quantity }
      : await fulcrum.addQuantityCompleted(jobId, itemToMakeId, operationId, quantity);

    await store.storeIdempotentResponse(idempotencyKey, result);
    res.json(result);
  } catch (err) { handleError(res, err); }
});

app.post('/api/jobs/:jobId/items-to-make/:itemToMakeId/operations/:operationId/complete', async (req, res) => {
  try {
    const idempotencyKey = req.get('Idempotency-Key');
    if (!idempotencyKey) return res.status(400).json({ error: 'Idempotency-Key header is required' });

    const cached = await store.getIdempotentResponse(idempotencyKey);
    if (cached) return res.json(cached);

    const { jobId, itemToMakeId, operationId } = req.params;
    const result = MOCK_MODE
      ? { ok: true, mock: true, jobId, itemToMakeId, operationId }
      : await fulcrum.completeOperation(jobId, itemToMakeId, operationId);

    await store.storeIdempotentResponse(idempotencyKey, result);
    res.json(result);
  } catch (err) { handleError(res, err); }
});

// ---- Supervisor dashboard -----------------------------------------------------------------------
// One rollup endpoint: every piece of equipment, whatever's running on it right now (if anything),
// and utilization numbers. Definition CONFIRMED by Brian on 2026-09-09 (not a placeholder):
//
//   - Denominator: 7 scheduled hours per weekday (Mon-Fri). This is a fixed capacity baseline,
//     not "hours elapsed today" -- a machine that's still running gets credit up to 7 hours, and
//     if something legitimately runs past that (lights-out overnight/weekend CNC work) it shows
//     as utilization ABOVE 100%, which is the informative behavior here: it's bonus output beyond
//     standard staffed capacity, exactly the kind of thing Brian's trying to see when judging
//     capital equipment payback.
//   - Setup time counts as productive for the general "equipment utilization" number.
//   - CNC machines ALSO get a separate "spindle utilization" number: cutting/run time ONLY
//     (timer type 'run'), setup excluded. This is deliberately a second, narrower metric --
//     Brian wants to see actual chip-making time on the CNCs specifically, separate from general
//     equipment utilization, to gauge ROI on the 5-axis mills. Only computed for equipment whose
//     workCenterName is "CNC Machining"; null for everything else (spindle isn't a meaningful
//     concept for a deburr bench or a CMM).

const SHIFT_LENGTH_HOURS = 7; // confirmed: 7 scheduled hours/weekday, see comment above

function isWeekday(date = new Date()) {
  const day = date.getDay(); // 0 = Sunday, 6 = Saturday
  return day !== 0 && day !== 6;
}

app.get('/api/dashboard/machines', async (req, res) => {
  try {
    // CONFIRMED 2026-09-11 live: Fulcrum's /equipment/list and /job-tracking-timers/list both
    // return a bare array, not an {items:[...]} / {timers:[...]} wrapper -- same shape as
    // /jobs/list (see the raw?.items ?? raw ?? [] guard on GET /api/jobs above). The dashboard
    // route was written assuming a wrapper and silently got an empty array back (no error, just
    // zero machines) once the upstream host/auth were fixed and these calls started succeeding.
    const equipmentRaw = MOCK_MODE ? mock.equipment : await fulcrum.searchEquipment();
    const equipmentList = MOCK_MODE ? equipmentRaw : (equipmentRaw?.items ?? equipmentRaw ?? []);
    const assignments = await store.getAllEquipmentAssignments(); // timerId -> equipmentId
    const byEquipment = {};
    for (const [timerId, equipmentId] of Object.entries(assignments)) {
      (byEquipment[equipmentId] ||= []).push(timerId);
    }

    const runningTimersRaw = MOCK_MODE
      ? [...mockTimers.values()].filter(t => !t.stoppedUtc)
      : await fulcrum.searchTimers({ stoppedOnUtc: null });
    // The query already asks Fulcrum for stoppedOnUtc: null (i.e. only still-running timers), so
    // no extra client-side filtering here -- just unwrap whichever shape comes back (asList,
    // defined above the routing routes) rather than guessing one field name and crashing on a
    // live 200 with a different shape.
    const runningTimers = MOCK_MODE ? runningTimersRaw : asList(runningTimersRaw);

    const shiftDenominatorMs = SHIFT_LENGTH_HOURS * 60 * 60 * 1000;
    const onWeekday = isWeekday();

    const machines = equipmentList.map(eq => {
      const timerIds = byEquipment[eq.id] || [];
      const active = runningTimers.filter(t => timerIds.includes(t.id));
      const isCnc = eq.workCenterName === 'CNC Machining';

      // All active time counts toward general utilization (setup included, per Brian).
      const allMs = active.reduce((sum, t) => sum + (Date.now() - new Date(t.startedUtc).getTime()), 0);
      // Only 'run' type counts toward CNC spindle utilization (setup excluded).
      const spindleMs = active
        .filter(t => t.type === 'run')
        .reduce((sum, t) => sum + (Date.now() - new Date(t.startedUtc).getTime()), 0);

      // Weekend running still shows real numbers (informative, per the comment above) rather
      // than being zeroed out -- onWeekday only affects whether shop-wide rollups below treat
      // today as a scheduled workday.
      return {
        equipmentId: eq.id,
        name: eq.name,
        description: eq.description,
        workCenterName: eq.workCenterName,
        isCnc,
        status: active.length > 0 ? 'running' : 'idle', // TODO: "down" needs a real signal -- see README
        activeRuns: active.map(t => ({
          timerId: t.id, userId: t.userId, jobId: t.jobId,
          itemToMakeId: t.itemToMakeId, operationId: t.operationId,
          startedUtc: t.startedUtc, type: t.type,
        })),
        utilizationPctShift: Math.round((allMs / shiftDenominatorMs) * 100),
        spindleUtilizationPctShift: isCnc ? Math.round((spindleMs / shiftDenominatorMs) * 100) : null,
      };
    });

    const avg = (list) => list.length ? Math.round(list.reduce((s, v) => s + v, 0) / list.length) : 0;
    const cncMachines = machines.filter(m => m.isCnc);

    res.json({
      isScheduledWorkday: onWeekday,
      shiftLengthHours: SHIFT_LENGTH_HOURS,
      machines,
      shopWideUtilizationPct: avg(machines.map(m => m.utilizationPctShift)),
      shopWideSpindleUtilizationPct: avg(cncMachines.map(m => m.spindleUtilizationPctShift)),
    });
  } catch (err) { handleError(res, err); }
});

app.listen(PORT, () => {
  console.log(`Fulcrum Shop Floor server listening on :${PORT} (MOCK_MODE=${MOCK_MODE})`);
});
