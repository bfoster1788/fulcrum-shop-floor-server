// Fulcrum Public REST API seam.
//
// Nothing here talks to Fulcrum directly from the phone. Every call goes to OUR server
// (BASE below), which holds the Public API token and forwards to Fulcrum. A Public API
// token must never ship inside this app — anything on a phone can be read off it.
//
// Endpoint mapping confirmed against the OpenAPI schema on developers.fulcrumpro.com:
//   person clock in/out ....... POST /api/time-clock-timers/clock-in | /clock-out
//   start a step timer ........ POST /api/job-tracking-timers/start
//                               body: { userId?, jobId, itemToMakeId, operationId, type }
//                               type enum: setup | run | clockIn | break | labor | machine
//   stop a step timer ......... POST /api/job-tracking-timers/stop
//                               body: { userId?, timerId }
//   find running timers ....... POST /api/job-tracking-timers        (search)
//   post partial quantity ..... POST /api/jobs/{jobId}/items-to-make/{itemToMakeId}
//                                    /operations/{operationId}/add-quantity-completed
//   complete an operation ..... POST .../operations/{operationId}/complete
//
// TWO THINGS FULCRUM DOES NOT STORE, so our server has to:
//
// 1. EQUIPMENT. The start body has no equipmentId — a timer is scoped to the operation,
//    not to a machine instance. Fulcrum will never know that this run is on D3. The
//    scheduledEquipmentName is NOT a fallback: checked across real routings it is blank
//    on every CNC machining step, and populated only on fixed-station steps that have
//    one obvious location ("1.Programming Office", "Laser", "Shipping Station") whose
//    free text does not match the equipment master's ids anyway. So CNC steps require
//    an explicit machine tap every time, and the pick is stored in our own side table
//    keyed by timerId. That
//    table is load-bearing: the run board, the machine label on every card, and the
//    utilization dashboard all read from it, and a second device that talked only to
//    Fulcrum would not know which spindle anything is on.
//
// 2. PAUSE REASONS. The stop body is { userId?, timerId } — no reason field, and
//    Fulcrum's reason codes live only on person-level Break entries. So:
//      - machine/material/inspection reasons -> our database (equipment downtime;
//        posting these as a person-level Break would be false data, because the
//        operator keeps working another machine while this one sits)
//      - "Break / end of shift" -> a real Fulcrum break timer, because that one
//        genuinely is the person stopping
//    Downtime analytics therefore comes out of our database, not Fulcrum.

// Our server, not Fulcrum's host. It holds the Public API token; the phone never does.
// ?api= overrides for local testing against a dev server, and ?mock=1 forces the mock
// backend back on without an edit — useful for demoing with no signal.
const QS = new URLSearchParams(location.search);
const BASE = QS.get('api') || 'https://fulcrum-shop-floor-production.up.railway.app/api';
const MOCK = QS.get('mock') === '1';

// Reads are GET with query params, writes are POST with a JSON body — matching the live
// server's routes. mockPath keeps the offline mock addressable by its own path, so the
// two can diverge without the mock needing to mimic REST shapes.
async function req(method, path, payload, mockPath) {
  if (MOCK) return mock(mockPath || path, payload || {});
  let url = BASE + path;
  const init = { method, mode: 'cors', headers: {} };
  if (method === 'GET') {
    const q = new URLSearchParams();
    Object.keys(payload || {}).forEach((k) => {
      if (payload[k] !== undefined && payload[k] !== null && payload[k] !== '') q.set(k, payload[k]);
    });
    if ([...q.keys()].length) url += '?' + q.toString();
  } else {
    init.headers['Content-Type'] = 'application/json';
    init.body = JSON.stringify(payload || {});
  }
  const res = await fetch(url, init);
  if (!res.ok) throw Object.assign(new Error('api ' + res.status), { status: res.status });
  return res.status === 204 ? null : res.json();
}

const get = (path, params, mockPath) => req('GET', path, params, mockPath);
const post = (path, body, mockPath) => req('POST', path, body, mockPath);

const REPLAY_TO_MOCK = {
  '/timers/start': '/job-tracking-timers/start',
  '/timers/stop': '/job-tracking-timers/stop',
  '/timers/break/start': '/job-tracking-timers/stop',
  '/timers/break/end': '/paused-runs/resolve',
};

// ---- response normalizing ----------------------------------------------
// The live server returns a bare array of operators with Fulcrum's own field names
// (fulcrumUserId / firstName / lastName), while every view in this app reads
// { items: [{ userId, name, role, shift }] }. Normalizing HERE keeps that difference at
// the seam instead of spreading two shapes through the UI.
const asItems = (r) => (Array.isArray(r) ? { items: r } : (r && Array.isArray(r.items) ? r : { items: [] }));

function normOperator(o) {
  if (!o) return o;
  const first = o.firstName || '';
  const last = o.lastName || '';
  const full = o.name || (first && last ? first.charAt(0) + '. ' + last : (first || last));
  return {
    ...o,
    userId: o.userId || o.fulcrumUserId || o.id,
    name: full || 'Unknown',
    role: o.role || 'Operator',
    shift: o.shift || '',
    badgeId: o.badgeId || o.rfidBadgeId || '',
  };
}

function normOperators(r) {
  return { items: asItems(r).items.map(normOperator) };
}

// The server forwards Fulcrum's own job shape: id / number / name, with jobName and
// customerName alongside. The UI was written against jobId / operations, so the mapping
// happens once here rather than in every view.
//
// ROUTING IS NOT IN THIS PAYLOAD. workOrders comes down empty and there is no
// /jobs/:id/operations route on our server yet, so operations is [] on live reads and
// the app has to say so rather than render a blank step. Nothing can be STARTED against
// a live job until the server exposes the routing.
function normJob(j) {
  if (!j || typeof j !== 'object') return j;
  if (j.operations && j.jobId) return j;
  const ops = [];
  (j.workOrders || []).forEach((wo) => {
    (wo.operations || []).forEach((o) => {
      ops.push({
        operationId: o.id || o.operationId,
        operationName: o.name || o.operationName || '',
        workCenterName: o.workCenterName || (o.workCenter && o.workCenter.name) || '',
        itemToMakeId: wo.itemToMakeId || wo.id,
        sequence: o.sequence,
        scheduledEquipmentName: o.scheduledEquipmentName || null,
        quantityCompleted: o.quantityCompleted || 0,
      });
    });
  });
  const made = Number(j.quantityCompleted || 0);
  const qty = Number(j.quantityToMake != null ? j.quantityToMake : j.quantity || 0);
  return {
    ...j,
    jobId: j.id || j.jobId,
    systemJobNumber: j.systemJobNumber != null ? j.systemJobNumber : j.number,
    jobName: j.jobName || j.name || '',
    customerName: j.customerName || '',
    itemNumber: j.itemNumber || j.itemName || '',
    quantity: qty,
    quantityRemaining: j.quantityRemaining != null ? j.quantityRemaining : Math.max(0, qty - made),
    operations: ops,
    currentOperationIndex: 0,
    routingUnavailable: ops.length === 0,
  };
}

// The dashboard read returns percentages against the shift, not hour buckets, and no
// operator roll-up — the board was written against the richer mock. Mapping happens
// here so the board stays a view.
//
// isCnc comes back false for every machine on the live read, so the split between
// spindles and support stations is derived from the equipment description instead.
// Real equipment codes at Impulse, from Brian's audit. Routing steps for non-CNC stations
// frequently carry free text instead ("Post- Machining Work Bench", "Programming Office",
// "9.Keyence XM") or nothing at all, and Cleaning has been seen scheduled against Assembly
// Station 1 rather than U1. So a station code that is not on this list is not an attribution
// we can report time against — the views mute it rather than charging the hours somewhere.
const STATION_CODES = ['DB1','S1','PK','U1','PAS','QC1','QL','CMM1','CMM2','P1','SC1','L1'];
export const isKnownStation = (code) =>
  STATION_CODES.indexOf(String(code || '').trim().toUpperCase()) > -1;

const CNC_RE = /\bcnc\b|mill|lathe|machining/i;

function normFloor(d, equipment) {
  const shift = Number(d.shiftLengthHours || 0);
  const byId = {};
  (equipment || []).forEach((e) => { byId[e.id] = e; });

  const machines = (d.machines || []).map((m) => {
    const eq = byId[m.equipmentId] || {};
    const util = m.utilizationPctShift != null ? m.utilizationPctShift : 0;
    const spindle = m.spindleUtilizationPctShift != null ? m.spindleUtilizationPctShift : null;
    const cut = ((spindle != null ? spindle : util) / 100) * shift;
    const runs = (m.activeRuns || []).map((r) => ({
      timerId: r.timerId || r.id,
      jobId: r.jobNumber != null ? r.jobNumber : (r.jobId || ''),
      jobName: r.jobName || r.jobDescription || '',
      operationName: r.operationName || '',
      operatorName: r.operatorName || r.userName || '',
      startedOnUtc: r.startedOnUtc || r.startedUtc || null,
      isPaused: !!r.isPaused,
      pauseReason: r.pauseReason || '',
      unattended: !!r.unattended,
      quantity: r.quantity != null ? r.quantity : null,
      quantityCompleted: r.quantityCompleted != null ? r.quantityCompleted : null,
    }));
    const state = m.status === 'running' ? 'running'
      : m.status === 'down' || m.status === 'paused' ? 'down'
      : 'idle';
    const isCnc = m.isCnc || CNC_RE.test(m.description || '');
    return {
      equipmentId: m.name || m.equipmentId,
      name: m.name,
      model: (m.description || '').split(',')[0] || '',
      description: m.description || '',
      isCnc,
      // The dashboard read leaves workCenterName off most rows; the equipment read is the
      // fallback, and the description is what is left when neither carries it.
      workCenterName: m.workCenterName || eq.workCenterName || '',
      // CNC rows are attributed by the machine itself and are trustworthy. Everything else
      // is only as good as the routing step's equipment assignment.
      attributionOk: isCnc || isKnownStation(m.name || m.equipmentId),
      lightsOut: !!(eq.canRunUnattended),
      state,
      run: runs[0] || null,
      runs,
      cuttingHours: cut,
      setupHours: Math.max(0, ((util - (spindle != null ? spindle : util)) / 100) * shift),
      downHours: 0,
      shiftHours: shift,
      utilizationPctShift: util,
      spindleUtilizationPctShift: spindle,
    };
  });

  // Staffing counts every open run, on a spindle or at a bench — the support stations are
  // where deburr, passivation, packaging and shipping time lands, and a board that only
  // counted CNC runs showed those operators as not working.
  const ops = {};
  machines.forEach((m) => m.runs.forEach((r) => {
    const key = r.operatorName || 'Unassigned';
    // running/paused are COUNTS on the board, not flags. role and shift are not in the
    // dashboard payload, so they read from the run rather than being invented.
    ops[key] = ops[key] || { name: key, runs: [], running: 0, paused: 0, role: 'on floor', shift: 'current' };
    ops[key].runs.push({ ...r, equipmentId: m.equipmentId, isCnc: m.isCnc });
    if (r.isPaused) ops[key].paused++; else ops[key].running++;
  }));

  return {
    asOfUtc: d.asOfUtc || d.generatedUtc || new Date().toISOString(),
    isScheduledWorkday: d.isScheduledWorkday !== false,
    shiftHours: shift,
    machines: machines.filter((m) => m.isCnc),
    support: machines.filter((m) => !m.isCnc),
    operators: Object.keys(ops).map((k) => ops[k]),
    shopWideUtilizationPct: d.shopWideUtilizationPct,
    shopWideSpindleUtilizationPct: d.shopWideSpindleUtilizationPct,
  };
}

// ROUTING comes from its own read: GET /jobs/:jobId/routing returns one entry per
// item-to-make, each holding the operation list. Operations carry no work center, so
// whether a step needs a spindle picked is derived from the operation's own estimates:
// machine-time-only, or non-zero machine time. Deliberately NOT the name — operation
// names are shop-defined free text and "Outside Machining Services" is a vendor step,
// not a spindle. Outside processing is never machine work.

function normRouting(list) {
  const groups = Array.isArray(list) ? list : (list && list.items) || [];
  const ops = [];
  groups.forEach((g) => {
    (g.operations || [])
      .slice()
      .sort((a, b) => (a.order || 0) - (b.order || 0))
      .forEach((o) => {
        const machineWork = !o.isOutsideProcessing && (
          !!o.isMachineTimeOnly || Number(o.estimatedMachineTimeInSeconds || 0) > 0
        );
        ops.push({
          operationId: o.id,
          systemOperationId: o.systemOperationId || null,
          itemToMakeId: g.itemToMakeId || g.id,
          operationName: o.name || '',
          // Free text, and it repeats within a routing — never keyed on.
          sequence: o.order,
          status: o.status || '',
          isComplete: o.status === 'complete',
          isMachineWork: machineWork,
          isOutsideProcessing: !!o.isOutsideProcessing,
          workCenterName: machineWork ? 'CNC Machining' : '',
          scheduledEquipmentId: o.scheduledEquipmentId || null,
          scheduledEquipmentName: o.scheduledEquipmentName || null,
          instructions: o.instructions || '',
        });
      });
  });
  const firstOpen = ops.findIndex((o) => !o.isComplete);
  return { operations: ops, currentOperationIndex: firstOpen < 0 ? Math.max(0, ops.length - 1) : firstOpen };
}

export const api = {
  health: () => get('/health', null, '/health'),

  // IDENTITY IS OURS, NOT FULCRUM'S.
  // The Public API has no login endpoint — its only Auth operation describes the token
  // making the request. So the whole integration authenticates as ONE static company
  // Bearer token held by our server, and an individual operator is only ever a userId
  // passed alongside it. Fulcrum never verifies an operator's identity, which is why
  // there is no password anywhere in this app: our server keeps a small operator table
  // (Fulcrum userId + RFID badge id, populated once by an admin) and that is the whole
  // of sign-in. Treat a badge id as an identifier, not a secret.
  lookupBadge: (badgeId) => post('/badge/lookup', { badgeId }, '/operators/by-badge').then(normOperator),
  operators: () => get('/operators', null, '/operators').then(normOperators),

  // The equipment master, authoritative server-side. The UI still reads its local
  // constant; this is here so that swap is a one-line change when we make it.
  equipment: () => get('/equipment', null, '/equipment').then(asItems),

  // NO ROUTE YET for the person-level clock. Fulcrum has /api/time-clock-timers/clock-in
  // and /clock-out, but our server does not expose them, so these resolve without a
  // call rather than throwing on every sign-in. Sign-in still works; the person clock
  // simply is not punched.
  clockIn: () => Promise.resolve(null),
  clockOut: () => Promise.resolve(null),

  // Fulcrum starts a REAL running timer here — the phone is not the clock of record.
  // equipmentId is NOT part of Fulcrum's body; our server strips it off and records it
  // against the returned timerId in its own table.
  startTimer: ({ userId, jobId, itemToMakeId, operationId, type, equipmentId }) =>
    post('/timers/start', { userId, jobId, itemToMakeId, operationId, type, equipmentId },
      '/job-tracking-timers/start'),

  stopTimer: ({ userId, timerId }) => post('/timers/stop', { userId, timerId }, '/job-tracking-timers/stop'),

  // Pause is a Fulcrum BREAK on the same timer, not a stop — so the timer survives and
  // resuming does not fragment the step into several entries. reason and kind ride along
  // for our own downtime table; Fulcrum's break has no reason field of its own.
  pauseTimer: ({ userId, timerId, reason, kind, heldSeconds }) =>
    post('/timers/break/start', { userId, timerId, reason, kind, heldSeconds }, '/job-tracking-timers/stop'),

  resumeTimer: ({ userId, timerId }) =>
    post('/timers/break/end', { userId, timerId }, '/paused-runs/resolve'),

  // NO ROUTE YET for reading one operator's open timers. Fails soft so the app still
  // loads: the phone shows its own last-known runs instead of an error screen.
  activeTimers: (userId) =>
    get('/timers/active', { userId }, '/job-tracking-timers').then(asItems, () => ({ items: [] })),

  // Paused runs live in this phone's own storage now that pause is a Fulcrum break —
  // there is no server route, so a reinstalled phone cannot recover them.
  // ---- Reports (today) ------------------------------------------------------------
  // Neither of these exists on the server yet — the dashboard only ever looks at timers
  // that are running RIGHT NOW, so nothing can answer "what happened today". Both calls
  // resolve to a null payload rather than throwing, and the report views say plainly
  // that the read is missing. REPORTS-API.md is the spec for implementing them.
  // Schedule: operations across the open job set, grouped by where they run. Fulcrum puts
  // scheduledEquipmentName / scheduledStartUtc on the OPERATION, so a queue per machine or
  // per bench is a real read rather than an invention — but it needs the routing for every
  // open job, which is one request per job. The client join below is honest but heavy; a
  // server-side /api/schedule/queues would replace it with one call (see REPORTS-API.md).
  routingFor: (jobId) => api.routing(jobId).then((r) => r.operations, () => []),

  laborReport: (date) => get('/reports/labor', { date }, '/reports/labor').then((r) => r, () => null),

  // Material backlog and on-time history: neither Fulcrum's purchase-order/receipt endpoints nor
  // any shipment read is wired into this server yet (fulcrumClient.js has jobs, items, sales
  // orders, customers, equipment, timers and routing — nothing for POs, material allocation or
  // shipments). Both resolve null so the view can say precisely what is missing.
  materialsBacklog: () => get('/materials/backlog', null, '/materials/backlog').then((r) => r, () => null),
  onTimeReport: () => get('/reports/on-time', null, '/reports/on-time').then((r) => r, () => null),
  equipmentReport: (date) => get('/reports/equipment', { date }, '/reports/equipment').then((r) => r, () => null),

  pausedRuns: () => Promise.resolve({ items: [] }),

  // userId and equipmentId are ours, not Fulcrum's — the same extra fields already sent on
  // /timers/start. Without them the server's productionEvents log cannot attribute the pieces
  // to an operator or a station, so goodQty and scrapQty read 0 on both report routes.
  addQuantity: ({ jobId, itemToMakeId, operationId, quantity, scrapQuantity, userId, equipmentId }) =>
    post(`/jobs/${jobId}/items-to-make/${itemToMakeId}/operations/${operationId}/add-quantity-completed`,
      { quantity, scrapQuantity, userId, equipmentId }),

  completeOperation: ({ jobId, itemToMakeId, operationId, quantity, scrapQuantity, userId, equipmentId }) =>
    post(`/jobs/${jobId}/items-to-make/${itemToMakeId}/operations/${operationId}/complete`,
      { quantity, scrapQuantity, userId, equipmentId }),

  // Substring search over open jobs, server-side. Fulcrum has no free-text job search
  // upstream, so the server does the matching.
  searchJobs: (query) => get('/jobs', { search: query }, '/jobs/search')
    .then((r) => ({ items: asItems(r).items.map(normJob) })),

  // A scanned traveler encodes the system job number, so resolving one is an exact
  // lookup rather than a text search.
  jobByNumber: (systemJobNumber) =>
    get('/jobs/by-number/' + encodeURIComponent(systemJobNumber), null, '/jobs/by-number').then(normJob),

  job: (jobId) => get('/jobs/' + encodeURIComponent(jobId), null, '/jobs/by-number').then(normJob),

  routing: (jobId) => get('/jobs/' + encodeURIComponent(jobId) + '/routing', null, '/jobs/by-number')
    .then(normRouting),

  // A job is only startable with its routing attached, and the routing is a second read
  // — so search stays one call and the routing is fetched when a job is opened.
  jobWithRouting: (jobId) => Promise.all([
    api.job(jobId),
    api.routing(jobId).then((r) => r, () => null),
  ]).then(([job, routing]) => (routing && routing.operations.length
    ? { ...job, ...routing, routingUnavailable: false }
    : job)),

  // Whole-floor view for a supervisor: every machine, who is on it, and time buckets
  // for the shift. Deliberately NOT scoped to one operator, unlike every call above.
  floorStatus: () => (MOCK
    ? get('/dashboard/machines', null, '/floor/status')
    : Promise.all([
        get('/dashboard/machines'),
        get('/equipment').then(asItems, () => ({ items: [] })),
      ]).then(([d, eq]) => normFloor(d, eq.items))),

  // Replays a queued write verbatim after a signal comes back. The outbox stores the
  // path and body of each call rather than a label, so a held entry can actually be
  // posted instead of merely counted. Every queued write is a POST.
  // Queued paths are the live REST paths. Under ?mock=1 they map back to the mock's own
  // path names so the offline queue stays testable without a server.
  replay: (path, body) => post(path, body, REPLAY_TO_MOCK[path] || path),
};

// ---- mock backend: real shapes, no network. Replaces itself when MOCK = false. ----

// Our server's operator table — the only place a badge maps to a Fulcrum user.
// Row 1 is Brian Foster's real Fulcrum userId. Its badgeId is a PLACEHOLDER: 0029392 is
// his 125 kHz HID prox fob, which a phone cannot read (NFC is 13.56 MHz — a frequency
// mismatch, not a software one). Operators will carry a separate NTAG213 NFC fob on the
// same keyring, and this row gets re-mapped to that fob's serial once it arrives. The
// NFC fob is independent of door access; it only carries a serial we map to a userId.
// Badge ids are stored verbatim as the reader reports them — an NFC serial arrives as
// hex while a prox number is decimal, so the lookup normalizes rather than assuming.
const OPERATORS = [
  { userId: '6a2836095c1346467db87fb9', name: 'B. Foster', role: 'Administrator', badgeId: '0029392', badgeIdPending: true, shift: 'day', email: 'brian@impulseprecision.com' },
  { userId: 'usr-4471', name: 'M. Ortega', role: 'Machinist', badgeId: '04A2C71B', shift: '2nd' },
  { userId: 'usr-4402', name: 'R. Feld', role: 'Machinist', badgeId: '04B93D02', shift: '2nd' },
  { userId: 'usr-4510', name: 'T. Nakamura', role: 'Machinist', badgeId: '04C11E88', shift: '2nd' },
  { userId: 'usr-4388', name: 'D. Voss', role: 'Machinist', badgeId: '04D7A934', shift: '3rd' },
  { userId: 'usr-4356', name: 'J. Alvarez', role: 'Deburr', badgeId: '04E20C57', shift: '2nd' },
  { userId: 'usr-4291', name: 'K. Wheeler', role: 'Quality', badgeId: '04F58B10', shift: '2nd' },
];

const EQUIPMENT = [
  { id: 'D1', model: 'DMG Mori DMU 50 · 5-axis', wc: 'CNC Machining', lightsOut: true },
  { id: 'D2', model: 'DMG Mori DMU 75 w/ PH150 · 5-axis', wc: 'CNC Machining', lightsOut: true },
  { id: 'D3', model: 'DMG Mori DMC 75 w/ RPS · 5-axis', wc: 'CNC Machining', lightsOut: true },
  { id: 'H1', model: 'Hermle C650 w/ flexHeavy · 5-axis', wc: 'CNC Machining', lightsOut: true },
  { id: 'M1', model: 'Mikron UCP 600 Vario · 5-axis pallet', wc: 'CNC Machining', lightsOut: true },
  { id: 'M2', model: 'Mikron HPM 450U · 5-axis pallet', wc: 'CNC Machining', lightsOut: true },
  { id: 'M3', model: 'Mikron HPM 450U · 5-axis pallet', wc: 'CNC Machining', lightsOut: true },
  { id: 'M4', model: 'Mikron HPM 450U · 5-axis pallet', wc: 'CNC Machining', lightsOut: true },
  { id: 'O1', model: 'Okuma M560V · 3-axis + 4th', wc: 'CNC Machining', lightsOut: false },
  // The rest of the equipment master. The operator app's machine picker filters to
  // CNC Machining, so these are here for the floor board's cross-process view: step-level
  // work centers carry time against the router step, not a spindle.
  { id: 'SC1', model: 'Bandsaw', wc: 'Saw Cutting', lightsOut: false },
  { id: 'DB1', model: 'Deburr bench', wc: 'Deburr', lightsOut: false },
  { id: 'L1', model: 'CloudRay laser marker', wc: 'Laser Engraving', lightsOut: false },
  { id: 'CMM1', model: 'Altera S bridge CMM', wc: 'CMM Inspection', lightsOut: false },
  { id: 'CMM2', model: 'Keyence XM mobile CMM', wc: 'CMM Inspection', lightsOut: false },
  { id: 'QC1', model: 'QA/QC', wc: 'QA/QC', lightsOut: false },
  { id: 'QL', model: 'QA/QC', wc: 'QA/QC', lightsOut: false },
  { id: 'A1', model: 'Assembly', wc: 'Assembly', lightsOut: false },
  { id: 'U1', model: 'Ultrasonic cleaning', wc: 'Cleaning', lightsOut: false },
  { id: '3D', model: '3D Printing Center', wc: '3D Printing Center', lightsOut: true },
  { id: 'P1', model: 'Programming', wc: 'Programming', lightsOut: false },
  { id: 'PK', model: 'Packaging', wc: 'Packaging', lightsOut: false },
  { id: 'PAS', model: 'Post-Process In-House OSP', wc: 'Post-Process In-House OSP', lightsOut: false },
  { id: 'S1', model: 'Shipping & Receiving', wc: 'Shipping & Receiving', lightsOut: false },
];

const JOBS = [
  {
    jobId: '1896', systemJobNumber: '1896', jobName: 'CAST (009.0)', itemToMakeId: 'itm-1896-1',
    itemNumber: '10000700-C01', revision: 'A', customerName: 'Castelion',
    quantity: 10, quantityRemaining: 6, dueDate: 'Sep 9', priority: 'HOT',
    operations: [
      { operationId: 'op-1', operationName: '1. Engineering Review', workCenterName: 'Engineering' },
      { operationId: 'op-2', operationName: '1. Programming', workCenterName: 'Programming', scheduledEquipmentName: '1.Programming Office' },
      { operationId: 'op-3', operationName: '2. Setup', workCenterName: 'CNC Machining' },
      { operationId: 'op-4', operationName: '3. Machining', workCenterName: 'CNC Machining' },
      { operationId: 'op-5', operationName: '4. Deburr', workCenterName: 'Deburr', scheduledEquipmentName: '6.Post-Machining Work Bench' },
      { operationId: 'op-6', operationName: '5. Inspection', workCenterName: 'QA/QC' },
      { operationId: 'op-7', operationName: 'Laser Engraving', workCenterName: 'Laser Engraving', scheduledEquipmentName: 'Laser' },
      { operationId: 'op-8', operationName: 'Anodize', workCenterName: 'Outside processing' },
      { operationId: 'op-9', operationName: 'Chem Film', workCenterName: 'Outside processing' },
      { operationId: 'op-10', operationName: 'BAG & TAG', workCenterName: 'Packaging' },
      { operationId: 'op-11', operationName: '5. Inspection', workCenterName: 'QA/QC' },
      { operationId: 'op-12', operationName: '6. Shipping', workCenterName: 'Shipping & Receiving', scheduledEquipmentName: 'Shipping Station' },
    ],
    currentOperationIndex: 3,
  },
  {
    jobId: '1893', systemJobNumber: '1893', jobName: 'MSCI (023.2) WO 26-0615', itemToMakeId: 'itm-1893-1',
    itemNumber: 'M04-07387-A06.0', revision: 'A06.0', customerName: 'Machine Sciences Corporation',
    quantity: 55, quantityRemaining: 55, dueDate: 'Sep 11', priority: 'STD',
    operations: [
      { operationId: 'op-1', operationName: '2. Setup', workCenterName: 'CNC Machining' },
      { operationId: 'op-2', operationName: '3. Machining', workCenterName: 'CNC Machining' },
      { operationId: 'op-3', operationName: '4. Deburr', workCenterName: 'Deburr', scheduledEquipmentName: '6.Post-Machining Work Bench' },
      { operationId: 'op-4', operationName: '5. Inspection', workCenterName: 'QA/QC' },
      { operationId: 'op-5', operationName: '6. Shipping', workCenterName: 'Shipping & Receiving', scheduledEquipmentName: 'Shipping Station' },
    ],
    currentOperationIndex: 1,
  },
  {
    jobId: '1888', systemJobNumber: '1888', jobName: 'SPX (019.13)', itemToMakeId: 'itm-1888-1',
    itemNumber: '02081847-008-A', revision: 'A', customerName: 'SpaceX',
    quantity: 50, quantityRemaining: 44, dueDate: 'Sep 12', priority: 'STD',
    operations: [
      { operationId: 'op-1', operationName: '2. Setup', workCenterName: 'CNC Machining' },
      { operationId: 'op-2', operationName: '3. Machining', workCenterName: 'CNC Machining' },
      { operationId: 'op-3', operationName: '4. Deburr', workCenterName: 'Deburr', scheduledEquipmentName: '6.Post-Machining Work Bench' },
      { operationId: 'op-4', operationName: 'BAG & TAG', workCenterName: 'Packaging' },
      { operationId: 'op-5', operationName: '6. Shipping', workCenterName: 'Shipping & Receiving', scheduledEquipmentName: 'Shipping Station' },
    ],
    currentOperationIndex: 2,
  },
  {
    jobId: '1901', systemJobNumber: '1901', jobName: 'DELT (030) 125806-502', itemToMakeId: 'itm-1901-1',
    itemNumber: '125806-502', revision: 'A', customerName: 'Delta Air Lines',
    quantity: 1, quantityRemaining: 1, dueDate: 'Sep 15', priority: 'HOT',
    operations: [
      { operationId: 'op-1', operationName: '1. Programming', workCenterName: 'Programming', scheduledEquipmentName: '1.Programming Office' },
      { operationId: 'op-2', operationName: '2. Setup', workCenterName: 'CNC Machining' },
      { operationId: 'op-3', operationName: '3. Machining', workCenterName: 'CNC Machining' },
      { operationId: 'op-4', operationName: '5. Inspection', workCenterName: 'CMM Inspection' },
      { operationId: 'op-5', operationName: '6. Shipping', workCenterName: 'Shipping & Receiving', scheduledEquipmentName: 'Shipping Station' },
    ],
    currentOperationIndex: 1,
  },
  {
    jobId: '1904', systemJobNumber: '1904', jobName: 'DELT (031) 125806-503', itemToMakeId: 'itm-1904-1',
    itemNumber: '125806-503', revision: 'A', customerName: 'Delta Air Lines',
    quantity: 1, quantityRemaining: 1, dueDate: 'Sep 15', priority: 'HOT',
    operations: [
      { operationId: 'op-1', operationName: '1. Programming', workCenterName: 'Programming', scheduledEquipmentName: '1.Programming Office' },
      { operationId: 'op-2', operationName: '3. Machining', workCenterName: 'CNC Machining' },
      { operationId: 'op-3', operationName: 'Laser Engraving', workCenterName: 'Laser Engraving', scheduledEquipmentName: 'Laser' },
      { operationId: 'op-4', operationName: '5. Inspection', workCenterName: 'CMM Inspection' },
      { operationId: 'op-5', operationName: 'Anodize', workCenterName: 'Outside processing' },
    ],
    currentOperationIndex: 1,
  },
];

let seededTimers = [
  { timeEntryId: 't-1', userId: 'usr-4471', entryType: 'machine', operatorName: 'M. Ortega', jobId: '1896', systemJobNumber: '1896', jobName: 'CAST (009.0)', operationName: '3. Machining', operationId: 'op-4', itemToMakeId: 'itm-1896-1', equipmentId: 'D3', startedOnUtc: new Date(Date.now() - 4360e3).toISOString(), stoppedOnUtc: null, laborHours: null, wasEdited: false, isPaused: false },
  { timeEntryId: 't-2', userId: 'usr-4471', entryType: 'run', operatorName: 'M. Ortega', jobId: '1893', systemJobNumber: '1893', jobName: 'MSCI (023.2) WO 26-0615', operationName: '3. Machining', operationId: 'op-2', itemToMakeId: 'itm-1893-1', equipmentId: 'M1', startedOnUtc: new Date(Date.now() - 1565e3).toISOString(), stoppedOnUtc: null, laborHours: null, wasEdited: false, isPaused: false },
  { timeEntryId: 't-3', userId: 'usr-4471', entryType: 'labor', operatorName: 'M. Ortega', jobId: '1888', systemJobNumber: '1888', jobName: 'SPX (019.13)', operationName: '4. Deburr', operationId: 'op-3', itemToMakeId: 'itm-1888-1', equipmentId: null, startedOnUtc: new Date(Date.now() - 1200e3).toISOString(), stoppedOnUtc: new Date(Date.now() - 687e3).toISOString(), laborHours: 513 / 3600, wasEdited: false, isPaused: true, pauseReason: 'Tool change', pauseKind: 'downtime' },
];

async function mock(path, body) {
  await new Promise((r) => setTimeout(r, 140));

  if (path === '/jobs/search') {
    const q = (body.query || '').toLowerCase();
    return {
      items: JOBS.filter((j) => {
        const hay = [j.jobId, j.jobName, j.itemNumber, j.customerName]
          .concat(j.operations.map((o) => o.operationName + ' ' + o.workCenterName)).join(' ').toLowerCase();
        return hay.indexOf(q) > -1;
      }),
    };
  }
  if (path === '/floor/status') return floorStatus();
  if (path === '/jobs/by-number') {
    const n = String(body.systemJobNumber || '').trim().replace(/^0+/, '');
    const hit = JOBS.filter((j) => String(j.systemJobNumber) === n || String(j.jobId) === n)[0];
    if (!hit) throw Object.assign(new Error('no such job'), { status: 404 });
    return hit;
  }
  // Both reads are scoped to one operator, as the real server will be.
  const mine = (t) => !body.userId || t.userId === body.userId;
  if (path === '/job-tracking-timers') return { items: seededTimers.filter((t) => mine(t) && !t.stoppedOnUtc && !t.isPaused) };

  if (path === '/paused-runs') return { items: seededTimers.filter((t) => mine(t) && t.isPaused) };
  if (path === '/paused-runs/resolve') {
    seededTimers = seededTimers.map((t) => t.timeEntryId === body.timerId
      ? { ...t, isPaused: false, pauseReason: '', pauseKind: '' } : t);
    return { ok: true };
  }

  if (path === '/reports/labor') {
    return {
      date: new Date().toISOString().slice(0, 10),
      generatedUtc: new Date().toISOString(),
      shiftSeconds: 25200,
      operators: [
        { userId: 'usr-4471', name: 'M. Ortega', role: 'Machinist', runSeconds: 15900, setupSeconds: 3400, standardSeconds: 17600, goodQty: 41, scrapQty: 2, jobs: 3 },
        { userId: 'usr-4472', name: 'D. Whitfield', role: 'Machinist', runSeconds: 13200, setupSeconds: 5100, standardSeconds: 12400, goodQty: 28, scrapQty: 0, jobs: 2 },
        { userId: 'usr-4473', name: 'R. Salcedo', role: 'Deburr', runSeconds: 17400, setupSeconds: 0, standardSeconds: null, goodQty: 96, scrapQty: 3, jobs: 4 },
        { userId: 'usr-4474', name: 'T. Nakamura', role: 'Quality', runSeconds: 9800, setupSeconds: 1200, standardSeconds: 9000, goodQty: 0, scrapQty: 0, jobs: 2 },
      ],
    };
  }
  if (path === '/reports/equipment') {
    const day = 86400;
    const mk = (equipmentId, name, description, isCnc, run, setup, std, good, scrap) =>
      ({ equipmentId, name, description, isCnc, runSeconds: run, setupSeconds: setup, standardSeconds: std, goodQty: good, scrapQty: scrap });
    return {
      date: new Date().toISOString().slice(0, 10),
      generatedUtc: new Date().toISOString(),
      calendarSeconds: day,
      machines: [
        mk('M1', 'M1', 'DMG Mori DMU 50, 5-axis', true, 33000, 5400, 31000, 88, 1),
        mk('M2', 'M2', 'Haas VF-2SS, 3-axis', true, 26400, 7200, 22000, 54, 4),
        mk('M3', 'M3', 'Mazak QTN 250, turning', true, 41000, 3600, 39500, 120, 2),
        mk('L2', 'L2', 'Okuma Genos L250, turning', true, 12000, 2400, 11200, 33, 0),
        mk('DB1', 'DB1', 'Deburr bench', false, 16800, 0, null, 96, 3),
        mk('U1', 'U1', 'Ultrasonic cleaning', false, 7200, 0, null, 74, 0),
        mk('CMM1', 'CMM1', 'Zeiss Contura CMM', false, 10800, 1800, 9600, 61, 2),
        mk('S1', 'S1', 'Shipping', false, 5400, 0, null, 0, 0),
      ],
    };
  }
  if (path === '/job-tracking-timers/start') {
    const job = JOBS.filter((j) => j.jobId === body.jobId)[0];
    const op = job.operations.filter((o) => o.operationId === body.operationId)[0];
    const who = OPERATORS.filter((o) => o.userId === body.userId)[0] || OPERATORS[0];
    const t = {
      timeEntryId: 't-' + Date.now(), userId: who.userId, entryType: body.type, operatorName: who.name,
      jobId: job.jobId, jobName: job.jobName, operationName: op.operationName,
      operationId: op.operationId, itemToMakeId: job.itemToMakeId,
      // Our field, not Fulcrum's — see the note at the top of this file.
      equipmentId: body.equipmentId || null,
      startedOnUtc: new Date().toISOString(), stoppedOnUtc: null, laborHours: null, wasEdited: false, isPaused: false,
    };
    seededTimers = seededTimers.concat([t]);
    return t;
  }
  if (path === '/job-tracking-timers/stop') {
    // A reason on the stop means our server also files this as a paused run, and it
    // trusts the client's accumulated total rather than recomputing from its own start.
    seededTimers = seededTimers.map((t) => {
      if (t.timeEntryId !== body.timerId) return t;
      const segment = (Date.now() - new Date(t.startedOnUtc)) / 1000;
      const total = Number.isFinite(body.heldSeconds) ? body.heldSeconds : segment;
      return {
        ...t,
        stoppedOnUtc: new Date().toISOString(),
        laborHours: total / 3600,
        isPaused: !!body.reason,
        pauseReason: body.reason || '',
        pauseKind: body.kind || '',
        heldSeconds: body.reason ? total : undefined,
      };
    });
    return { ok: true };
  }
  if (path.indexOf('add-quantity-completed') > -1 || path.indexOf('/complete') > -1) {
    const jobId = path.split('/')[2];
    const job = JOBS.filter((j) => j.jobId === jobId)[0];
    if (job) {
      if (path.indexOf('/complete') > -1) {
        job.quantityRemaining = job.quantity;
        job.currentOperationIndex = Math.min(job.currentOperationIndex + 1, job.operations.length);
      } else {
        job.quantityRemaining = Math.max(0, job.quantityRemaining - (body.quantity || 0));
      }
    }
    return { ok: true };
  }
  if (path === '/operators') return { items: OPERATORS };
  if (path === '/operators/by-badge') {
    // Match the id as printed, and also as a decimal/hex pair, so a reader that reports
    // 0029392 and one that reports the same card in hex both resolve to one operator.
    const raw = String(body.badgeId || '').trim().replace(/^0+/, '').toUpperCase();
    const alt = /^[0-9]+$/.test(raw) ? Number(raw).toString(16).toUpperCase() : String(parseInt(raw, 16) || '');
    const norm = (v) => String(v || '').trim().replace(/^0+/, '').toUpperCase();
    const hit = OPERATORS.filter((o) => norm(o.badgeId) === raw || norm(o.badgeId) === alt)[0];
    if (!hit) throw Object.assign(new Error('unknown badge'), { status: 404 });
    return hit;
  }
  if (path.indexOf('clock-') > -1) return { ok: true, at: new Date().toISOString() };
  throw new Error('unmapped mock path ' + path);
}

export const equipment = EQUIPMENT;
export const isMock = MOCK;

// ---- floor rollup -------------------------------------------------------
// Time buckets per machine for the current shift. In the real server these come from
// summing time entries by entryType (setup / run / machine) plus our own downtime
// table; here they are seeded so the dashboard has something honest-shaped to show.
//
// Two utilization numbers, per Brian, both over the same 7-scheduled-hour weekday:
//   utilizationPctShift        (cutting + setup) / 7  — general equipment utilization
//   spindleUtilizationPctShift  cutting / 7           — CNC only, capital-equipment ROI
// Neither is clamped: lights-out overnight and weekend running legitimately exceeds
// 100% of a scheduled weekday. Field names match the real server's.

const SHIFT_HOURS = 7;

const SEEDED_BUCKETS = {
  D1: { cutting: 5.6, setup: 0.7, down: 0.0 },
  D2: { cutting: 5.1, setup: 1.1, down: 0.3 },
  D3: { cutting: 4.7, setup: 1.7, down: 0.0 },
  H1: { cutting: 6.7, setup: 0.5, down: 0.0 },
  M1: { cutting: 4.2, setup: 1.0, down: 0.0 },
  M2: { cutting: 3.1, setup: 0.6, down: 1.8 },
  M3: { cutting: 6.5, setup: 0.6, down: 0.0 },
  M4: { cutting: 0.9, setup: 0.3, down: 0.0 },
  O1: { cutting: 0.0, setup: 0.0, down: 0.0 },
};

const pct = (hours) => Math.round((hours / SHIFT_HOURS) * 1000) / 10;

function floorStatus() {
  const open = seededTimers.filter((t) => !t.stoppedOnUtc || t.isPaused);

  const machines = EQUIPMENT.filter((m) => m.wc === 'CNC Machining').map((m) => {
    const t = open.filter((x) => x.equipmentId === m.id)[0] || null;
    const job = t ? JOBS.filter((j) => j.jobId === t.jobId)[0] : null;
    const b = SEEDED_BUCKETS[m.id] || { cutting: 0, setup: 0, down: 0 };
    return {
      equipmentId: m.id, model: m.model, workCenterName: m.wc, lightsOut: m.lightsOut,
      state: t ? (t.isPaused ? 'down' : 'running') : 'idle',
      run: t ? {
        timeEntryId: t.timeEntryId, jobId: t.jobId, jobName: t.jobName,
        operationName: t.operationName, operatorName: t.operatorName, entryType: t.entryType,
        startedOnUtc: t.startedOnUtc, heldSeconds: t.heldSeconds || null,
        pauseReason: t.pauseReason || '', unattended: t.entryType === 'machine',
        quantity: job ? job.quantity : null,
        quantityRemaining: job ? job.quantityRemaining : null,
      } : null,
      cuttingHours: b.cutting, setupHours: b.setup, downHours: b.down,
      shiftHours: SHIFT_HOURS,
      utilizationPctShift: pct(b.cutting + b.setup),
      spindleUtilizationPctShift: pct(b.cutting),
    };
  });

  const support = EQUIPMENT.filter((m) => m.wc !== 'CNC Machining').map((m) => {
    const t = open.filter((x) => !x.equipmentId && x.operationName && JOBS.filter((j) =>
      j.jobId === x.jobId && j.operations.filter((o) =>
        o.operationName === x.operationName && o.workCenterName === m.wc).length).length)[0] || null;
    return {
      equipmentId: m.id, workCenterName: m.wc,
      state: t ? (t.isPaused ? 'down' : 'running') : 'idle',
      run: t ? { jobId: t.jobId, jobName: t.jobName, operationName: t.operationName, operatorName: t.operatorName } : null,
    };
  });

  const operators = OPERATORS.filter((o) => o.role !== 'Administrator').map((o) => {
    const theirs = open.filter((t) => t.operatorName === o.name);
    return {
      userId: o.userId, name: o.name, role: o.role, shift: o.shift,
      running: theirs.filter((t) => !t.isPaused).length,
      paused: theirs.filter((t) => t.isPaused).length,
      runs: theirs.map((t) => ({
        jobId: t.jobId, operationName: t.operationName,
        equipmentId: t.equipmentId, isPaused: t.isPaused, pauseReason: t.pauseReason || '',
      })),
    };
  });

  return { shiftHours: SHIFT_HOURS, asOf: new Date().toISOString(), machines, support, operators };
}
