// PouchDB store + CouchDB replication. Each console is a PWA backed by PouchDB
// in the browser; when a CouchDB URL is configured (kendra box), it replicates
// both directions — multi-master, revision-based, conflict handling built in.
// No hand-rolled sync layer. See DESIGN.md §Sync.
//
// We import `pouchdb-browser` (the self-contained browser build) rather than
// `pouchdb`, which pulls Node's `events`/`leveldown` and breaks under Vite's
// browser externalization ("Class extends value is not a constructor").
//
// Doc design (one DB, typed by `kind` / `_id`):
//   kind: "case"     — a missing/found person record (engine row shape + _id)
//   kind: "ref"      — static geo reference, one doc per dataset:
//                        ref:zones / ref:chokepoints / ref:policeStations /
//                        ref:specialAreas / ref:locationCoords → { rows: [...] }
//                        ref:areaBoundaries                     → { geojson: {...} }
//   kind: "config"   — config:scoring (scoring weights), config:prompts ({text}),
//                        config:voiceAgent (Deepgram intake prompt + submit_case schema)
//   kind: "audit"    — append-only audit events (create/match/escalate/purge)
//
// The PWA ships with NO bundled data. CouchDB is populated externally (ops/admin)
// and the console stays empty until replication delivers the docs — see loadAll.

import PouchDB from 'pouchdb-browser';

const COUCH_URL = import.meta.env.VITE_COUCHDB_URL || ''; // e.g. http://admin:admin@localhost:5984
const CENTER = import.meta.env.VITE_CENTER_ID || 'kendra-A';

const db = new PouchDB('setu-cases');
let remote = null;
let syncHandle = null;

export function getDb() {
  return db;
}

export function centerId() {
  return CENTER;
}

/** Start live bidirectional replication to CouchDB if a URL is configured.
 *  `onChange` (optional) fires on every replication change/pause so the UI can
 *  reload the dataset as docs arrive. Returns the sync handle. */
export function startSync(onChange) {
  if (!COUCH_URL || syncHandle) return null;
  remote = new PouchDB(`${COUCH_URL}/setu-cases`);
  syncHandle = db.sync(remote, { live: true, retry: true });
  if (onChange) syncHandle.on('change', onChange).on('paused', onChange);
  return syncHandle;
}

export function syncState() {
  return { configured: !!COUCH_URL, remote: !!remote };
}

const REF_DOCS = {
  'ref:zones': 'zones',
  'ref:chokepoints': 'chokepoints',
  'ref:policeStations': 'policeStations',
  'ref:specialAreas': 'specialAreas',
  'ref:locationCoords': 'locationCoords',
};

/** The empty dataset shape — what the engine sees before any sync arrives. */
export function emptyData() {
  return {
    records: [],
    zones: [],
    chokepoints: [],
    policeStations: [],
    specialAreas: [],
    locationCoords: [],
    areaBoundaries: null,
    config: null,
    promptsText: '',
    voiceAgent: null,
  };
}

/** Load the full dataset (records + geo reference + config + prompts) from
 *  PouchDB in one pass. Pieces stay empty/null until replication populates
 *  them. The engine reads `config` / `promptsText` off this object. */
export async function loadAll() {
  const res = await db.allDocs({ include_docs: true });
  const out = emptyData();
  for (const { doc } of res.rows) {
    if (!doc) continue;
    if (doc.kind === 'case') {
      const { _id, _rev, kind, center, createdAt, ...row } = doc;
      out.records.push(row);
    } else if (REF_DOCS[doc._id]) {
      out[REF_DOCS[doc._id]] = doc.rows || [];
    } else if (doc._id === 'ref:areaBoundaries') {
      out.areaBoundaries = doc.geojson || null;
    } else if (doc._id === 'config:scoring') {
      const { _id, _rev, kind, ...cfg } = doc;
      out.config = cfg;
    } else if (doc._id === 'config:prompts') {
      out.promptsText = doc.text || '';
    } else if (doc._id === 'config:voiceAgent') {
      const { _id, _rev, kind, ...va } = doc;
      out.voiceAgent = va;
    }
  }
  return out;
}

/** Persist a new case (Lost or Found intake). Returns the saved doc. */
export async function saveCase(record) {
  const doc = {
    _id: `case:${record.case_id || `loc-${Date.now()}`}`,
    kind: 'case',
    center: CENTER,
    createdAt: Date.now(),
    status: 'pending',
    ...record,
  };
  await db.put(doc);
  await audit({ type: 'create', caseId: doc._id });
  return doc;
}

export async function audit(event) {
  await db.put({
    _id: `audit:${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
    kind: 'audit',
    at: Date.now(),
    center: CENTER,
    ...event,
  });
}
