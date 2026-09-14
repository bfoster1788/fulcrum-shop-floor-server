// Tiny JSON-file-backed store for the data Fulcrum's API has no place for:
//   - operators: badge id -> Fulcrum userId mapping (admin-populated, no real Fulcrum creds involved)
//   - equipmentAssignments: timerId -> equipmentId (Fulcrum's timer-start has no equipment field at all,
//     so machine attribution for concurrent multi-machine runs has to live here)
//   - pauseReasons: timerId -> { reason, note, pausedAtUtc } for machine/material pauses that aren't a
//     real Fulcrum break (Fulcrum's stop endpoint has no reason field either)
//   - idempotencyKeys: client-supplied key -> { response, createdUtc }, so a phone retrying a partially-
//     applied quantity/completion post after a dropped connection can't double-count. Flagged as a firm
//     requirement by the design canvas once the offline replay queue was built.
//
// This is intentionally not a database. Shop-floor scale here is dozens of employees and a handful of
// concurrent machine runs -- a single JSON file with atomic writes is plenty, and it means zero
// infrastructure to stand up before this can run. If/when that stops being true, swap this module for
// a real store; nothing above it needs to change since callers only see the functions below.

import { readFile, writeFile, rename } from 'node:fs/promises';
import { existsSync, mkdirSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DATA_DIR = path.join(__dirname, '..', 'data');
const DATA_FILE = path.join(DATA_DIR, 'store.json');

const EMPTY_STATE = {
  // Real NFC tag roster from Brian 2026-09-11 (replaces the earlier placeholder badge 0029392,
  // an HID 125kHz prox fob that turned out not NFC-readable and was removed). badgeId here is
  // the tag's serial with colons stripped and uppercased, matching exactly what index.html
  // computes from a live scan (see `(e.serialNumber || '').replace(/:/g, '').toUpperCase()` in
  // public/index.html) -- so these register on first tap with no separate onboarding step.
  // fulcrumUserId for each was resolved by name against the live Fulcrum user list (search-users)
  // on 2026-09-11, not guessed.
  operators: [
    { badgeId: '04428117C92A81', badgeIdPending: false, fulcrumUserId: '6a2836095c1346467db87fb9', firstName: 'Brian', lastName: 'Foster', role: 'Administrator' },
    { badgeId: '0463F517C92A81', badgeIdPending: false, fulcrumUserId: '6a831be04665f6cc7595d209', firstName: 'Xiao', lastName: 'Chan', role: 'Production Supervisor' },
    { badgeId: '0438CA17C92A81', badgeIdPending: false, fulcrumUserId: '6a831b9632053cb68ce6c34c', firstName: 'Dan', lastName: 'Mero', role: 'Production Supervisor' },
    { badgeId: '041A7617C92A81', badgeIdPending: false, fulcrumUserId: '6a55441207121116ef248b25', firstName: 'Lucas', lastName: 'Gonzalez', role: 'Quality Manager' },
    { badgeId: '04C7CE17C92A81', badgeIdPending: false, fulcrumUserId: '65e66a75f02972e2dac674f2', firstName: 'Tyler', lastName: 'Puska', role: 'Administrator' },
    { badgeId: '04489217C92A81', badgeIdPending: false, fulcrumUserId: '6aa0566a4c0d9cf0ab528849', firstName: 'Griffin', lastName: 'Foster', role: 'Production Operator' },

    // Remaining active Fulcrum users pulled via search-users on 2026-09-14, per Brian's request to
    // get everyone into the roster even before their fob is in hand. badgeId is a placeholder
    // (never matches a real NFC scan) and badgeIdPending stays true until an admin calls
    // POST /api/operators with that person's real badge id -- upsertOperator matches on
    // fulcrumUserId, so registering a real badge later just overwrites the placeholder in place.
    // They already show up in the name-search sign-in list today (GET /api/operators returns
    // everyone regardless of badgeIdPending); only the quick-tap badge flow is unavailable until
    // then. Two accounts were deliberately left out as not individual people: "Quality Dept"
    // (690e228b867f5de5d665c046, a shared department login) and "Shop Floor iPad"
    // (67ad28af4c3c9488fd2a302f, a shared device login) -- flag to Brian if either should be
    // added as a real badge-scannable identity after all.
    { badgeId: 'PENDING-68b8629d3043618cb24da941', badgeIdPending: true, fulcrumUserId: '68b8629d3043618cb24da941', firstName: 'Chris', lastName: 'Bowers', role: 'Production Operator' },
    { badgeId: 'PENDING-67f3fb8a6d2bc3746df9e284', badgeIdPending: true, fulcrumUserId: '67f3fb8a6d2bc3746df9e284', firstName: 'Emily', lastName: 'Eaton', role: 'Quality Manager' },
    { badgeId: 'PENDING-65e241a25c7b303e5d8807f8', badgeIdPending: true, fulcrumUserId: '65e241a25c7b303e5d8807f8', firstName: 'Nate', lastName: 'Eckert', role: 'Administrator' },
    { badgeId: 'PENDING-65e66cfcf02972e2dac67501', badgeIdPending: true, fulcrumUserId: '65e66cfcf02972e2dac67501', firstName: 'Renee', lastName: 'Eckert', role: 'Administrator' },
    { badgeId: 'PENDING-690e2335ae0cc0c81c9c4f61', badgeIdPending: true, fulcrumUserId: '690e2335ae0cc0c81c9c4f61', firstName: 'Ivan', lastName: 'Gurgurov', role: 'Quality Lab' },
    { badgeId: 'PENDING-65e66cbcf02972e2dac674fe', badgeIdPending: true, fulcrumUserId: '65e66cbcf02972e2dac674fe', firstName: 'Seth', lastName: 'McCallum', role: 'Production Operator' },
    { badgeId: 'PENDING-695eebbe73459f1f7567ad9c', badgeIdPending: true, fulcrumUserId: '695eebbe73459f1f7567ad9c', firstName: 'Mark', lastName: 'Stockhover', role: 'Quality Supervisor' },
    { badgeId: 'PENDING-6aa055b78d71a9fab9dcdbc5', badgeIdPending: true, fulcrumUserId: '6aa055b78d71a9fab9dcdbc5', firstName: 'Austin', lastName: 'Workes', role: 'Production Operator' },
  ],
  equipmentAssignments: {}, // timerId -> equipmentId
  pauseReasons: {},         // timerId -> { reason, note, pausedAtUtc }
  idempotencyKeys: {}       // key -> { response, createdUtc }
};

let cache = null;

async function load() {
  if (cache) return cache;
  if (!existsSync(DATA_DIR)) mkdirSync(DATA_DIR, { recursive: true });
  if (!existsSync(DATA_FILE)) {
    cache = structuredClone(EMPTY_STATE);
    await persist();
    return cache;
  }
  const raw = await readFile(DATA_FILE, 'utf8');
  cache = JSON.parse(raw);
  // Safety net for Brian's real roster if this deploy lands on a volume that already has an
  // older store.json (so a bare EMPTY_STATE default wouldn't apply): merge in any seed operator
  // whose badgeId isn't already present, without touching or duplicating anything already there.
  const existingBadges = new Set((cache.operators || []).map(o => o.badgeId));
  let seeded = false;
  for (const op of EMPTY_STATE.operators) {
    if (!existingBadges.has(op.badgeId)) {
      cache.operators = cache.operators || [];
      cache.operators.push(op);
      seeded = true;
    }
  }
  if (seeded) await persist();
  return cache;
}

async function persist() {
  // Write to a temp file then rename, so a crash mid-write never corrupts store.json.
  const tmp = `${DATA_FILE}.tmp`;
  await writeFile(tmp, JSON.stringify(cache, null, 2), 'utf8');
  await rename(tmp, DATA_FILE);
}

export async function getOperators() {
  const state = await load();
  return state.operators;
}

export async function findOperatorByBadge(badgeId) {
  const state = await load();
  return state.operators.find(o => o.badgeId === badgeId && !o.badgeIdPending) || null;
}

export async function upsertOperator(operator) {
  const state = await load();
  const i = state.operators.findIndex(o => o.fulcrumUserId === operator.fulcrumUserId);
  if (i >= 0) state.operators[i] = { ...state.operators[i], ...operator };
  else state.operators.push(operator);
  await persist();
  return operator;
}

export async function removeOperatorByBadge(badgeId) {
  const state = await load();
  const before = state.operators.length;
  state.operators = state.operators.filter(o => o.badgeId !== badgeId);
  await persist();
  return before !== state.operators.length; // true if something was actually removed
}

export async function setEquipmentForTimer(timerId, equipmentId) {
  const state = await load();
  state.equipmentAssignments[timerId] = equipmentId;
  await persist();
}

export async function getEquipmentForTimer(timerId) {
  const state = await load();
  return state.equipmentAssignments[timerId] || null;
}

export async function getAllEquipmentAssignments() {
  const state = await load();
  return state.equipmentAssignments;
}

export async function clearEquipmentForTimer(timerId) {
  const state = await load();
  delete state.equipmentAssignments[timerId];
  await persist();
}

export async function setPauseReason(timerId, reason, note) {
  const state = await load();
  state.pauseReasons[timerId] = { reason, note: note || null, pausedAtUtc: new Date().toISOString() };
  await persist();
}

export async function getPauseReason(timerId) {
  const state = await load();
  return state.pauseReasons[timerId] || null;
}

export async function clearPauseReason(timerId) {
  const state = await load();
  delete state.pauseReasons[timerId];
  await persist();
}

// Idempotency: call before doing the real work. If it returns a stored response, replay that and
// skip the write. Otherwise do the write, then call storeIdempotentResponse with the result.
export async function getIdempotentResponse(key) {
  if (!key) return null;
  const state = await load();
  const entry = state.idempotencyKeys[key];
  return entry ? entry.response : null;
}

export async function storeIdempotentResponse(key, response) {
  if (!key) return;
  const state = await load();
  state.idempotencyKeys[key] = { response, createdUtc: new Date().toISOString() };
  // Cheap unbounded-growth guard: keep at most the 5000 most recent keys.
  const keys = Object.keys(state.idempotencyKeys);
  if (keys.length > 5000) {
    const sorted = keys.sort((a, b) =>
      new Date(state.idempotencyKeys[a].createdUtc) - new Date(state.idempotencyKeys[b].createdUtc));
    for (const k of sorted.slice(0, keys.length - 5000)) delete state.idempotencyKeys[k];
  }
  await persist();
}
