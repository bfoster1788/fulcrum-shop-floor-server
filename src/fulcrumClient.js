// Thin wrapper around Fulcrum's Public REST API (developers.fulcrumpro.com), not the MCP server --
// the Public API is what this backend runs on, authenticated as ONE static company-wide Bearer token.
// Per-operator identity is only ever a userId parameter passed alongside that token; Fulcrum itself
// never verifies an individual operator, which is exactly why sign-in in this whole system is our own
// badge table, not anything Fulcrum-side.
//
// Endpoints below were confirmed directly against Fulcrum's OpenAPI schema during the design phase.
// Anything marked TODO/VERIFY was inferred from the schema's naming/shape but not yet exercised against
// a live token (Brian hadn't generated one yet as of this build) -- confirm against a real response
// before relying on it in production, and adjust field names here if they differ.

// CONFIRMED 2026-09-10/11, two-part fix:
// (1) The Public API lives on Fulcrum's shared API host, NOT the tenant's own web-app subdomain --
//     speedmetal.fulcrumpro.com is the browser UI host and doesn't serve this API at all. That wrong
//     host is what caused the first round of live 405/404s.
// (2) Impulse's Fulcrum site is ITAR-compliant, which per Fulcrum's own "ITAR Usage" docs means
//     tokens are issued against api.fulcrumpro.US, not api.fulcrumpro.COM -- the .com host answers
//     401 (access denied) for ITAR-issued tokens even when the token itself is valid and unexpired.
//     That's what caused the second round of 401s after the host was first "fixed" to the .com host.
// The bearer token alone scopes every call to Brian's tenant -- no subdomain/header needed for that.
const BASE_URL = process.env.FULCRUM_API_BASE_URL || 'https://api.fulcrumpro.us/api';
const TOKEN = process.env.FULCRUM_API_TOKEN || '';

class FulcrumApiError extends Error {
  constructor(message, status, body) {
    super(message);
    this.name = 'FulcrumApiError';
    this.status = status;
    this.body = body;
  }
}

async function request(method, urlPath, body) {
  if (!TOKEN) {
    throw new Error(
      'FULCRUM_API_TOKEN is not set. Generate a Public API token in Fulcrum ' +
      '(Settings -> API / Integrations) and put it in .env, or leave MOCK_MODE=true.'
    );
  }
  const res = await fetch(`${BASE_URL}${urlPath}`, {
    method,
    headers: {
      'Authorization': `Bearer ${TOKEN}`,
      'Content-Type': 'application/json',
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  const parsed = text ? JSON.parse(text) : null;
  if (!res.ok) {
    throw new FulcrumApiError(`Fulcrum API ${method} ${urlPath} -> ${res.status}`, res.status, parsed);
  }
  return parsed;
}

export const fulcrum = {
  // ---- Jobs / search --------------------------------------------------------------------------
  // CONFIRMED against Fulcrum's live OpenAPI schema (developers.fulcrumpro.com/api-schema) on
  // 2026-09-08: job search is POST /jobs/list with a filter body -- there is NO free-text or
  // customer/item-name search parameter. Only exact filters: jobIds, numbers (job numbers),
  // jobNames (exact names), status/statuses, salesOrderId, createdBefore/AfterUtc,
  // modifiedBefore/AfterUtc. Plus Skip/Take query params (Take max 5000).
  //
  // Bigger finding: the raw job object itself (GET /jobs/{jobId} and list results) has NO
  // customerName or itemName field at all -- just parentItemId and salesOrderId. The MCP tool
  // used during design (search-jobs / get-job-details) does its own enrichment joins that the
  // raw Public API this server runs on does NOT do for free. That's why listJobsEnriched below
  // exists: it fetches the base job list, then resolves item + customer names via the item and
  // sales-order endpoints (also confirmed to exist: GET /items/{itemId}, GET /sales-orders/{id}).
  // This means "search by customer/job/part" has to happen server-side (or client-side) over a
  // working set of jobs, not as a single Fulcrum filter call -- confirms the design canvas's own
  // flagged rough edge ("search loads all open jobs and filters client-side, won't hold at
  // scale"). Worth discussing a real fix (Fulcrum webhook + our own indexed cache) once this is
  // live and search performance actually matters.
  listJobs: ({ statuses, take = 200, skip = 0 } = {}) =>
    request('POST', `/jobs/list?Skip=${skip}&Take=${take}`, statuses ? { statuses } : {}),
  getJob: (jobId) => request('GET', `/jobs/${jobId}`),
  getJobsByNumbers: (numbers) => request('POST', '/jobs/list', { numbers }),

  // ---- Items / customers (for enrichment -- see note above) --------------------------------------
  getItem: (itemId) => request('GET', `/items/${itemId}`),
  getSalesOrder: (salesOrderId) => request('GET', `/sales-orders/${salesOrderId}`),
  // TODO/VERIFY: /customers/{id} path pattern assumed by analogy with /items/{id} and
  // /sales-orders/{id} (both confirmed) -- not individually confirmed against the schema.
  getCustomer: (customerId) => request('GET', `/customers/${customerId}`),

  // ---- Users ------------------------------------------------------------------------------------
  getUser: (userId) => request('GET', `/users/${userId}`),

  // ---- Job tracking timers (the real start/stop endpoints, confirmed against the schema) --------
  startTimer: ({ userId, jobId, itemToMakeId, operationId, type }) =>
    request('POST', '/job-tracking-timers/start', { userId, jobId, itemToMakeId, operationId, type }),

  stopTimer: ({ userId, timerId }) =>
    request('POST', '/job-tracking-timers/stop', { userId, timerId }),

  // CONFIRMED 2026-09-11 against the live schema: same /list-suffix search pattern as jobs and
  // equipment above -- the bare /job-tracking-timers path 404s.
  searchTimers: (body) => request('POST', '/job-tracking-timers/list', body),

  // ---- Quantity / completion ----------------------------------------------------------------------
  addQuantityCompleted: (jobId, itemToMakeId, operationId, quantity) =>
    request(
      'POST',
      `/jobs/${jobId}/items-to-make/${itemToMakeId}/operations/${operationId}/add-quantity-completed`,
      { quantity }
    ),

  completeOperation: (jobId, itemToMakeId, operationId) =>
    request(
      'POST',
      `/jobs/${jobId}/items-to-make/${itemToMakeId}/operations/${operationId}/complete`,
      {}
    ),

  // ---- Time clock (real Fulcrum breaks / clock-in-out, distinct from job tracking timers) --------
  clockIn: (userId) => request('POST', '/time-clock-timers/clock-in', { userId }),
  clockOut: (userId) => request('POST', '/time-clock-timers/clock-out', { userId }),

  // ---- Equipment ----------------------------------------------------------------------------------
  // CONFIRMED: POST /equipment/list (same list-with-filter-body pattern as jobs). Empty body
  // returns everything; take is a query param same as jobs.
  searchEquipment: (take = 200) => request('POST', `/equipment/list?Take=${take}`, {}),

  // ---- Routing (items-to-make + operations) -------------------------------------------------------
  // CONFIRMED live 2026-09-11 via a direct probe against the real API (the docs page gave
  // inconsistent GET/POST answers twice in a row, so this was verified empirically instead):
  //   POST /jobs/{jobId}/items-to-make/list -> 200, returns a bare array of
  //     { id (this IS itemToMakeId), itemId, quantityToMake, status, quantityMade, depth, ... }
  //   GET  (no body) on that same path 404s; GET on the .../list path 400s asking for a body --
  //   this really is a POST-with-empty-body list endpoint, same family as /jobs/list,
  //   /equipment/list, /job-tracking-timers/list elsewhere in this file.
  // This is what closes the "no routing read" gap: the client can search and open a job, but has
  // nothing to start a timer against without itemToMakeId + operationId, neither of which exist on
  // the raw job object.
  getItemsToMake: (jobId) => request('POST', `/jobs/${jobId}/items-to-make/list`, {}),
  // TODO/VERIFY: operations-list path guessed by analogy with the items-to-make fix above (same
  // POST .../list pattern) -- not yet individually confirmed live. server.js's debug probe route
  // checks this before it's relied on for real.
  getOperationsForItemToMake: (jobId, itemToMakeId) =>
    request('POST', `/jobs/${jobId}/items-to-make/${itemToMakeId}/operations/list`, {}),
};

export { FulcrumApiError };
