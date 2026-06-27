// One-shot migration: backfill `report_type: 'lost'` on existing case docs in
// CouchDB. The seed dataset is all family-filed missing reports, so every
// pre-existing case is a 'lost' report. New intakes set report_type from the
// button (lost/found); this brings legacy docs in line so cross-type matching
// (engine/search.js byReportType) activates on the real data.
//
// Idempotent: only touches case docs that don't already have a report_type.
// Re-running is a no-op.
//
//   node --env-file=.env server/migrate-report-type.js
//
// Target comes from COUCHDB_URL in .env (server-side credential). DB: setu-cases.

import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const RAW = (process.env.COUCHDB_URL || '').replace(/\/$/, '');
if (!RAW) {
  console.error('COUCHDB_URL not set. Add it to web/.env (e.g. http://admin:pass@host:5984).');
  process.exit(1);
}

// Node's fetch rejects credentials embedded in the URL, so split them into a
// Basic auth header and keep a clean base URL (same trick as seed-couchdb.js).
const parsed = new URL(RAW);
const AUTH = (parsed.username || parsed.password)
  ? 'Basic ' + Buffer.from(`${decodeURIComponent(parsed.username)}:${decodeURIComponent(parsed.password)}`).toString('base64')
  : null;
parsed.username = '';
parsed.password = '';
const COUCH = parsed.toString().replace(/\/$/, '');

async function couch(method, urlPath, body) {
  const headers = {};
  if (AUTH) headers.Authorization = AUTH;
  if (body) headers['Content-Type'] = 'application/json';
  const res = await fetch(`${COUCH}${urlPath}`, {
    method,
    headers,
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  let json = null;
  try { json = text ? JSON.parse(text) : null; } catch { /* non-JSON */ }
  return { status: res.status, json, text };
}

async function main() {
  // Confirm the DB exists.
  const head = await couch('GET', '/setu-cases');
  if (head.status === 404) { console.error('database setu-cases not found — run the seeder first.'); process.exit(1); }
  if (head.status === 401) { console.error('auth failed — check COUCHDB_URL credentials'); process.exit(1); }

  const all = await couch('GET', '/setu-cases/_all_docs?include_docs=true');
  if (all.status !== 200) { console.error(`GET _all_docs → ${all.status}: ${all.text.slice(0, 200)}`); process.exit(1); }

  const rows = (all.json && all.json.rows) || [];
  const toUpdate = [];
  let cases = 0;
  let alreadyTyped = 0;
  for (const row of rows) {
    const doc = row && row.doc;
    if (!doc || !doc._id || !doc._id.startsWith('case:')) continue;
    cases++;
    if (doc.report_type != null && String(doc.report_type).trim() !== '') { alreadyTyped++; continue; }
    toUpdate.push({ ...doc, report_type: 'lost' });
  }

  if (!toUpdate.length) {
    console.log(`No migration needed. ${cases} case docs, ${alreadyTyped} already have report_type.`);
    return;
  }

  const res = await couch('POST', '/setu-cases/_bulk_docs', { docs: toUpdate });
  if (res.status !== 201) {
    console.error(`bulk update failed → ${res.status}: ${res.text.slice(0, 300)}`);
    process.exit(1);
  }
  const errors = (res.json || []).filter((r) => r.error);
  console.log(`Backfilled report_type='lost' on ${toUpdate.length} case doc(s) (${toUpdate.length - errors.length} ok, ${errors.length} errors).`);
  console.log(`Total cases: ${cases} · already typed: ${alreadyTyped} · updated: ${toUpdate.length}`);
  if (errors.length) console.log('first errors:', errors.slice(0, 3));
}

main().catch((e) => { console.error(e); process.exit(1); });
