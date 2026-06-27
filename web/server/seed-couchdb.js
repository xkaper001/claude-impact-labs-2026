// One-shot CouchDB seeder (admin tool). The PWA ships with NO bundled data —
// it reads everything from CouchDB (see web/src/lib/db.js loadAll). This script
// loads the repo CSV/GeoJSON/config/prompts into the doc shapes the app expects.
//
// Idempotent: if the DB already holds config:scoring it exits without touching
// anything. Pass --force to overwrite existing docs (re-fetches _rev first).
//
//   node --env-file=.env server/seed-couchdb.js          # seed if empty
//   node --env-file=.env server/seed-couchdb.js --force   # overwrite
//
// Target comes from COUCHDB_URL in .env (server-side credential). DB: setu-cases.

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { parseCSV } = require('../../engine/csv.js'); // CommonJS, shared with the engine

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..', '..');
const DATA = path.join(ROOT, 'claude-impact-labs-data', 'claude-impact-lab-mumbai-2026', 'data');

const RAW = (process.env.COUCHDB_URL || '').replace(/\/$/, '');
const CENTER = process.env.VITE_CENTER_ID || 'kendra-A';
const FORCE = process.argv.includes('--force');

if (!RAW) {
  console.error('COUCHDB_URL not set. Add it to web/.env (e.g. http://admin:pass@host:5984).');
  process.exit(1);
}

// Node's fetch rejects credentials embedded in the URL, so split them out into a
// Basic auth header and keep a clean base URL.
const parsed = new URL(RAW);
const AUTH = (parsed.username || parsed.password)
  ? 'Basic ' + Buffer.from(`${decodeURIComponent(parsed.username)}:${decodeURIComponent(parsed.password)}`).toString('base64')
  : null;
parsed.username = '';
parsed.password = '';
const COUCH = parsed.toString().replace(/\/$/, '');

const readCsv = (f) => parseCSV(fs.readFileSync(path.join(DATA, f), 'utf8'));
const readJson = (p) => JSON.parse(fs.readFileSync(p, 'utf8'));
const readText = (p) => fs.readFileSync(p, 'utf8');

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

function buildDocs() {
  const records = readCsv('Synthetic_Missing_Persons_2500.csv');
  const now = Date.now();
  const docs = records.map((r, i) => ({
    _id: `case:${r.case_id || `seed-${i}`}`,
    kind: 'case',
    center: CENTER,
    createdAt: now,
    ...r,
  }));

  docs.push({ _id: 'ref:zones', kind: 'ref', rows: readCsv('Zone_Boundaries.csv') });
  docs.push({ _id: 'ref:chokepoints', kind: 'ref', rows: readCsv('Chokepoints_Parking.csv') });
  docs.push({ _id: 'ref:policeStations', kind: 'ref', rows: readCsv('Police_Stations.csv') });
  docs.push({ _id: 'ref:specialAreas', kind: 'ref', rows: readCsv('Special_Areas.csv') });
  docs.push({ _id: 'ref:locationCoords', kind: 'ref', rows: readCsv('Location_Coordinates.csv') });
  docs.push({
    _id: 'ref:areaBoundaries',
    kind: 'ref',
    geojson: readJson(path.join(DATA, 'Area_Boundaries.geojson')),
  });

  docs.push({ _id: 'config:scoring', kind: 'config', ...readJson(path.join(ROOT, 'config-scoring.json')) });
  docs.push({ _id: 'config:prompts', kind: 'config', text: readText(path.join(ROOT, 'prompts.md')) });
  docs.push({ _id: 'config:voiceAgent', kind: 'config', ...readJson(path.join(ROOT, 'voice-agent.json')) });

  return docs;
}

async function main() {
  // Ensure the DB exists (PUT is a no-op 412 if already there).
  const created = await couch('PUT', '/setu-cases');
  if (created.status === 201) console.log('created database setu-cases');
  else if (created.status === 412) { /* already exists */ }
  else if (created.status === 401) { console.error('auth failed — check COUCHDB_URL credentials'); process.exit(1); }
  else console.log(`PUT /setu-cases → ${created.status}`);

  // Idempotent guard: config:prompts is the new-schema sentinel. If it's there
  // the DB is fully seeded — bail unless --force. (config:scoring alone is NOT
  // enough: the old app seeded that without ref docs / prompts.)
  const existing = await couch('GET', '/setu-cases/config:prompts');
  if (existing.status === 200 && !FORCE) {
    console.log('already fully seeded (config:prompts present). Use --force to overwrite. Nothing to do.');
    return;
  }

  let docs = buildDocs();

  // Upsert: attach the current _rev to any doc that already exists (e.g. cases
  // from an older partial seed), else _bulk_docs rejects them with 409 conflict.
  const all = await couch('GET', '/setu-cases/_all_docs');
  const revById = new Map((all.json?.rows || []).map((row) => [row.id, row.value.rev]));
  docs = docs.map((d) => (revById.has(d._id) ? { ...d, _rev: revById.get(d._id) } : d));

  const res = await couch('POST', '/setu-cases/_bulk_docs', { docs });
  if (res.status !== 201) {
    console.error(`bulk insert failed → ${res.status}: ${res.text.slice(0, 300)}`);
    process.exit(1);
  }
  const errors = (res.json || []).filter((r) => r.error);
  console.log(`seeded ${docs.length} docs (${docs.length - errors.length} ok, ${errors.length} errors)`);
  if (errors.length) console.log('first errors:', errors.slice(0, 3));
}

main().catch((e) => { console.error(e); process.exit(1); });
