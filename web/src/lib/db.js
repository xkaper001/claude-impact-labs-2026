// PouchDB store + CouchDB replication. Each console is a PWA backed by PouchDB
// in the browser; when a CouchDB URL is configured (kendra box), it replicates
// both directions — multi-master, revision-based, conflict handling built in.
// No hand-rolled sync layer. See DESIGN.md §Sync.
//
// We import `pouchdb-browser` (the self-contained browser build) rather than
// `pouchdb`, which pulls Node's `events`/`leveldown` and breaks under Vite's
// browser externalization ("Class extends value is not a constructor").
//
// Doc design (one DB, typed by `kind`):
//   kind: "case"     — a missing/found person record (engine row shape + _id)
//   kind: "config"   — the config:scoring doc (single doc, id "config:scoring")
//   kind: "audit"    — append-only audit events (create/match/escalate/purge)
//
// On first run we seed from the bundled dataset (engine.js seedData) so the
// console is fully functional offline before any replication happens.

import PouchDB from 'pouchdb-browser';
import { seedData, config } from './engine.js';

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

/** Seed the local DB from the bundled dataset if it is empty. Idempotent. */
export async function seedIfEmpty() {
  const info = await db.info();
  if (info.doc_count > 0) return false;
  const docs = seedData.records.map((r, i) => ({
    _id: `case:${r.case_id || `seed-${i}`}`,
    kind: 'case',
    center: CENTER,
    createdAt: Date.now(),
    ...r,
  }));
  docs.push({ _id: 'config:scoring', kind: 'config', ...config });
  await db.bulkDocs(docs);
  return true;
}

/** Start live bidirectional replication to CouchDB if a URL is configured.
 *  Returns a handle with .on('change'/.../ error) for UI status. */
export function startSync() {
  if (!COUCH_URL || syncHandle) return null;
  remote = new PouchDB(`${COUCH_URL}/setu-cases`);
  syncHandle = db.sync(remote, { live: true, retry: true });
  return syncHandle;
}

export function syncState() {
  return { configured: !!COUCH_URL, remote: !!remote };
}

/** Load all cases into the engine's row shape (strip PouchDB internals). */
export async function loadCases() {
  const res = await db.allDocs({ include_docs: true });
  return res.rows
    .filter((r) => r.doc && r.doc.kind === 'case')
    .map((r) => {
      const { _id, _rev, kind, center, createdAt, ...row } = r.doc;
      return row;
    });
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

/** Load the active config:scoring doc, falling back to the bundled config. */
export async function loadConfig() {
  try {
    const doc = await db.get('config:scoring');
    const { _id, _rev, kind, ...cfg } = doc;
    return cfg;
  } catch {
    return config;
  }
}
