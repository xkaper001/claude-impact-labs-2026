// Browser bridge to the deterministic engine. The engine is plain CommonJS
// (../engine/*) — Vite pre-bundles it so the SAME scoring / search / hotspot
// code the Node CLI uses runs in the PWA. The PWA ships with ZERO bundled data:
// records, geo reference, scoring config and prompts ALL arrive via PouchDB
// replication from CouchDB (see db.js loadAll). The engine functions read the
// active config + prompts off the runtime `data` object, not module globals.

// Default imports + runtime destructure: the engine is CommonJS; Vite's
// optimizer (via the @engine alias) pre-bundles it to ESM with both default
// and named exports. Same code, same runtime as the Node CLI.
import searchMod from '@engine/search.js';
import hotspotMod from '@engine/hotspot.js';
import geoMod from '@engine/geo.js';
import promptMod from '@engine/prompt.js';
import scoringMod from '@engine/scoring.js';

const { search, preFilter } = searchMod;
const { hotspotSweep } = hotspotMod;
const geo = geoMod;
const { buildPrompt, buildHotspotPrompt } = promptMod;
const { scoreCandidate } = scoringMod;

// Geo options are derived purely from the dataset (areaIndex + the O(vocab²)
// haversine adjacency), so they're stable for a given `data` object. Cache by
// data identity in a WeakMap — rebuilding on every search/keystroke was the
// bug the old "Memoised per dataset identity" comment described but never did.
const _geoCache = new WeakMap();

/** Build (and cache) the geo options the engine expects, from whichever dataset
 *  is active (seed, or PouchDB-loaded). Memoised per dataset identity. */
export function buildGeoOpts(data) {
  const cached = _geoCache.get(data);
  if (cached) return cached;
  const areaIndex = geo.buildAreaIndex(data.specialAreas, data.zones, data.locationCoords);
  const vocab = [...new Set(data.records.map((r) => r.last_seen_location).filter(Boolean))];
  const opts = {
    areaIndex,
    locationAdjacency: geo.buildLocationAdjacency(vocab, areaIndex),
    chokepoints: data.chokepoints,
    policeStations: data.policeStations,
  };
  _geoCache.set(data, opts);
  return opts;
}

export function runSearch(query, data, opts = {}) {
  const geoOpts = buildGeoOpts(data);
  return search(query, data.records, data.config, {
    mode: (opts.mode || 'A').toUpperCase(),
    // Offline default is 'heuristic': the deterministic Jaccard description
    // overlap (engine/scoring.js) contributes the 20-pt description weight
    // instead of leaving it at 0. Online paths (voice agent, semantic re-rank)
    // pass a numeric Claude score to upgrade it. Pass semantic:'pending'
    // explicitly to suppress description scoring entirely.
    semantic: opts.semantic || 'heuristic',
    now: opts.now,
    ...geoOpts,
  });
}

/** The real last-seen-location vocabulary, drawn from the active dataset
 *  (record locations ∪ curated landmark coords) instead of a hardcoded list.
 *  Sorted, de-duplicated; safe before sync (returns []). */
export function locationVocab(data) {
  const set = new Set();
  for (const r of data.records || []) if (r.last_seen_location) set.add(r.last_seen_location);
  for (const c of data.locationCoords || []) if (c.location_name) set.add(c.location_name);
  return [...set].sort((a, b) => a.localeCompare(b));
}

/** Map a Deepgram `submit_case` function-call payload to the engine query shape.
 *  age_band (enum) feeds query.ageBands (engine/scoring.js supports it directly);
 *  age_approx is the numeric fallback. Blank strings become undefined so the
 *  engine's honesty rules treat them as unassessed, never as mismatches. */
export function submitCaseToQuery(args = {}, opts = {}) {
  const blank = (v) => (v == null || String(v).trim() === '' ? undefined : v);
  const ageBand = blank(args.age_band);
  return {
    name: blank(args.missing_person_name),
    gender: blank(args.gender),
    ageBands: ageBand ? [ageBand] : undefined,
    ageApprox: args.age_approx ? Number(args.age_approx) : undefined,
    state: blank(args.state),
    lastSeenLocation: blank(args.last_seen_location),
    description: blank(args.physical_description),
    reportedAt: opts.now || new Date().toISOString().slice(0, 16).replace('T', ' '),
  };
}

export function runHotspot(data, opts = {}) {
  return hotspotSweep(data.records, data.zones, data.chokepoints, data.policeStations, data.config, {
    now: opts.now,
    specialAreas: data.specialAreas,
    locationCoords: data.locationCoords,
  });
}

export function runResolve(text, data) {
  const areaIndex = geo.buildAreaIndex(data.specialAreas, data.zones, data.locationCoords);
  return geo.resolveLocation(text, areaIndex);
}

/** Assemble the Phase-n prompt for the LLM proxy. The proxy (server) runs the
 *  LlmBackend; the browser never sees the API key. */
export function buildPromptForClaude(query, data, opts = {}) {
  const geoOpts = buildGeoOpts(data);
  const candidates = preFilter(query, data.records, data.config, geoOpts);
  return buildPrompt(candidates, data.config, { phase: opts.phase || 2, md: data.promptsText });
}

export function buildHotspotPromptForClaude(data, opts = {}) {
  const openCases = data.records.filter((r) =>
    ['pending', 'unresolved'].includes(String(r.status || '').toLowerCase()),
  );
  return buildHotspotPrompt(openCases, data.zones, data.chokepoints, runHotspot(data, opts).hotspots, data.config, {
    phase: opts.phase || 2,
    md: data.promptsText,
  });
}

/** Build a tight prompt asking Claude for a per-candidate semantic description
 *  score (0..weights.description). This is the "make AI real" path: Claude's
 *  numbers feed back into the deterministic score via rerankWithSemantic, so the
 *  20-pt description weight actually affects ranking (offline it's the heuristic
 *  Jaccard fallback). Returns STRICT JSON keyed by case_id. */
export function buildSemanticPrompt(query, matches, config) {
  const max = (config.weights && config.weights.description) || 20;
  const cands = matches.map((m) => {
    const r = m.record || m;
    return { case_id: r.case_id, description: r.physical_description || '' };
  });
  return [
    'You score how well each candidate\'s physical description SEMANTICALLY matches the query description.',
    'Match meaning, not exact words: "elderly man, white kurta" ~ "old person in saffron clothing" share build/age; colour differs.',
    'Account for Hindi/Marathi terms (bujurg=elderly, bachcha=child, kurta, sari, rudraksha).',
    `Give each candidate an integer 0..${max} (0 = nothing in common, ${max} = strong semantic overlap).`,
    '',
    `QUERY DESCRIPTION: ${JSON.stringify(query.description || '')}`,
    '',
    'CANDIDATES:',
    JSON.stringify(cands, null, 2),
    '',
    `Respond with ONLY a JSON object mapping case_id to score, e.g. {"M0001": 14, "M0002": 0}. No prose.`,
  ].join('\n');
}

/** Parse the model's JSON reply (tolerates code fences / surrounding prose) into
 *  a { case_id: number } map. Returns {} on any failure — caller keeps heuristic. */
export function parseSemanticScores(text) {
  if (!text) return {};
  try {
    const m = text.match(/\{[\s\S]*\}/);
    if (!m) return {};
    const obj = JSON.parse(m[0]);
    const out = {};
    for (const [k, v] of Object.entries(obj)) {
      const n = Number(v);
      if (!Number.isNaN(n)) out[k] = n;
    }
    return out;
  } catch {
    return {};
  }
}

/** Re-score the current matches using Claude's per-candidate semantic numbers
 *  (falling back to the offline heuristic for any candidate Claude didn't score),
 *  then re-sort. Preserves each match's warnings / escalation / chokepoint info;
 *  only score, band and breakdown change. */
export function rerankWithSemantic(query, data, matches, semanticByCaseId = {}) {
  const { locationAdjacency } = buildGeoOpts(data);
  const rescored = matches.map((m) => {
    const r = m.record || m;
    const sem = semanticByCaseId[r.case_id];
    const s = scoreCandidate(query, r, data.config, {
      semantic: typeof sem === 'number' ? sem : 'heuristic',
      locationAdjacency,
    });
    return { ...m, score: s.score, band: s.band, breakdown: s.breakdown, semanticPending: s.semanticPending };
  });
  rescored.sort((a, b) =>
    (b.score - a.score) ||
    String((a.record || a).case_id || '').localeCompare(String((b.record || b).case_id || '')),
  );
  return rescored;
}

export { geo };
