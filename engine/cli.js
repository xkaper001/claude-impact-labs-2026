#!/usr/bin/env node
'use strict';
/**
 * KumbhRakshak SEARCH CLI — runs the full offline pipeline end-to-end.
 *
 *   node engine/cli.js --gender Male --age 72 --state Bihar \
 *        --loc "Ramkund Ghat" --desc "elderly man, white kurta, rudraksha mala"
 *
 * Flags:
 *   --name <s>      missing person's name (optional)
 *   --gender <s>    Male | Female
 *   --age <n>       approximate age  (or --band 61-70)
 *   --band <s>      explicit age band; repeatable / comma-separated
 *   --state <s>     state of origin
 *   --district <s>
 *   --loc <s>       last-seen location (see dataset vocabulary)
 *   --time <s>      report time "YYYY-MM-DD HH:MM" (for time scoring)
 *   --desc <s>      free-text physical description (mixed Hindi-English ok)
 *   --semantic <m>  pending (default) | heuristic   (heuristic = offline demo)
 *   --prompt [n]    instead of running the engine, print the Phase-n LLM prompt
 *                   with candidates+config injected (n defaults to 1)
 *   --json          print the raw result object as JSON
 */

const data = require('./data');
const fs = require('fs');
const path = require('path');
const { search } = require('./search');
const { formatResult, formatHotspot } = require('./format');
const { buildPrompt, buildHotspotPrompt } = require('./prompt');
const { preFilter } = require('./search');
const { hotspotSweep } = require('./hotspot');
const geo = require('./geo');

const PROMPTS_MD = path.resolve(__dirname, '..', 'prompts.md');
function readPrompts() { return fs.readFileSync(PROMPTS_MD, 'utf8'); }

function parseArgs(argv) {
  const a = { bands: [] };
  for (let i = 2; i < argv.length; i++) {
    const k = argv[i];
    const next = () => argv[++i];
    switch (k) {
      case '--name': a.name = next(); break;
      case '--gender': a.gender = next(); break;
      case '--age': a.ageApprox = Number(next()); break;
      case '--band': a.bands.push(...next().split(',')); break;
      case '--state': a.state = next(); break;
      case '--district': a.district = next(); break;
      case '--loc': a.lastSeenLocation = next(); break;
      case '--time': a.reportedAt = next(); break;
      case '--now': a.now = next(); break;
      case '--desc': a.description = next(); break;
      case '--semantic': a.semantic = next(); break;
      case '--mode': a.mode = next(); break;
      case '--resolve': a.resolve = next(); break;
      case '--json': a.json = true; break;
      case '--hotspot': a.hotspot = true; break;
      case '--prompt': a.prompt = /^\d+$/.test(argv[i + 1] || '') ? Number(next()) : 1; break;
      default: console.error(`Unknown flag: ${k}`); process.exit(1);
    }
  }
  return a;
}

function buildGeoOpts(records) {
  const specialAreas = data.loadSpecialAreas();
  const zones = data.loadZones();
  const locationCoords = data.loadLocationCoords();
  const areaIndex = geo.buildAreaIndex(specialAreas, zones, locationCoords);
  const vocab = [...new Set(records.map((r) => r.last_seen_location).filter(Boolean))];
  return {
    areaIndex,
    locationAdjacency: geo.buildLocationAdjacency(vocab, areaIndex),
    chokepoints: data.loadChokepoints(),
    policeStations: data.loadPoliceStations(),
  };
}

function runResolve(a) {
  const areaIndex = geo.buildAreaIndex(data.loadSpecialAreas(), data.loadZones(), data.loadLocationCoords());
  const hit = geo.resolveLocation(a.resolve, areaIndex);
  if (!hit) {
    console.log(`Could not resolve "${a.resolve}" to a known area/zone.`);
    return;
  }
  const zones = data.loadZones().map((z) => ({ name: z.zone_name, centroid_lat: Number(z.centroid_lat), centroid_lng: Number(z.centroid_lng) }));
  let nearest = null;
  for (const z of zones) {
    const d = geo.haversine([hit.lng, hit.lat], [z.centroid_lng, z.centroid_lat]);
    if (!nearest || d < nearest.dist) nearest = { name: z.name, dist: Math.round(d) };
  }
  console.log(`Resolving "${a.resolve}" → ${hit.name} (${hit.source})`);
  if (nearest) console.log(`Nearest zone: ${nearest.name} (${nearest.dist}m)`);
}

function runHotspot(a, config, records) {
  const zones = data.loadZones();
  const chokepoints = data.loadChokepoints();
  const police = data.loadPoliceStations();
  const opts = {
    now: a.now,
    specialAreas: data.loadSpecialAreas(),
    locationCoords: data.loadLocationCoords(),
  };
  const result = hotspotSweep(records, zones, chokepoints, police, config, opts);
  if (a.json) {
    console.log(JSON.stringify(result, null, 2));
    return;
  }
  if (a.prompt) {
    const openCases = records.filter((r) => ['pending', 'unresolved'].includes(String(r.status || '').toLowerCase()));
    process.stdout.write(buildHotspotPrompt(openCases, zones, chokepoints, result.hotspots, config, { phase: a.prompt, md: readPrompts() }));
    process.stdout.write('\n');
    return;
  }
  const timestamp = a.now || new Date().toISOString().replace('T', ' ').slice(0, 16);
  console.log(formatHotspot(result, config, { timestamp }));
}

function main() {
  const a = parseArgs(process.argv);
  const config = data.loadConfig();
  const records = data.loadRecords();

  if (a.resolve) {
    runResolve(a);
    return;
  }

  if (a.hotspot) {
    runHotspot(a, config, records);
    return;
  }

  const query = {
    name: a.name,
    gender: a.gender,
    ageApprox: a.ageApprox,
    ageBands: a.bands.length ? a.bands : undefined,
    state: a.state,
    district: a.district,
    lastSeenLocation: a.lastSeenLocation,
    reportedAt: a.reportedAt,
    description: a.description,
  };

  const geoOpts = buildGeoOpts(records);
  const opts = {
    mode: (a.mode || 'A').toUpperCase(),
    semantic: a.semantic || 'pending',
    now: a.now || a.reportedAt,
    ...geoOpts,
  };

  if (a.prompt) {
    const candidates = preFilter(query, records, config, opts);
    process.stdout.write(buildPrompt(candidates, config, { phase: a.prompt, mode: opts.mode, md: readPrompts() }));
    process.stdout.write('\n');
    return;
  }

  const result = search(query, records, config, opts);
  if (a.json) {
    console.log(JSON.stringify(result, null, 2));
    return;
  }
  const timestamp = (a.now || new Date().toISOString().replace('T', ' ').slice(0, 16));
  console.log(formatResult(result, config, { timestamp }));
}

main();
