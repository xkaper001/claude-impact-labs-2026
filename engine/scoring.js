'use strict';
/**
 * KumbhRakshak config-driven scoring engine.
 *
 * Every number comes from the injected `config:scoring` doc — there are NO
 * hardcoded weights/bands/thresholds here. This is the same rules engine the
 * spec says runs offline; when Claude is reachable it fills the one field the
 * engine cannot do deterministically (semantic `description`).
 *
 * scoreCandidate(query, candidate, config, opts) -> {
 *   score, band, capped, breakdown: { <field>: {points, max, assessed, note} },
 *   semanticPending: bool
 * }
 *
 * Honesty rule (from the prompt): a field we cannot assess is EXCLUDED
 * (points 0, assessed:false, with a note) — never guessed, never penalised.
 */

const AGE_BANDS = ['0-12', '13-17', '18-40', '41-60', '61-70', '71-80', '80+'];

// ---------------------------------------------------------------------------
// Normalisation helpers
// ---------------------------------------------------------------------------

function norm(s) {
  return String(s == null ? '' : s).trim().toLowerCase();
}
function isBlank(s) {
  return s == null || String(s).trim() === '';
}
function normName(s) {
  return norm(s).replace(/[^a-z\s]/g, '').replace(/\s+/g, ' ').trim();
}

/** Soundex — phonetic key for name matching. Imperfect on transliterated
 *  Indian names, so a phonetic hit is treated as the weaker `namePhonetic`
 *  weight, never as a confirmed match. */
function soundex(name) {
  const s = normName(name).replace(/\s/g, '');
  if (!s) return '';
  const codes = { b: 1, f: 1, p: 1, v: 1, c: 2, g: 2, j: 2, k: 2, q: 2, s: 2, x: 2, z: 2, d: 3, t: 3, l: 4, m: 5, n: 5, r: 6 };
  const first = s[0];
  let out = first.toUpperCase();
  let prev = codes[first] || 0;
  for (let i = 1; i < s.length && out.length < 4; i++) {
    const code = codes[s[i]] || 0;
    if (code !== 0 && code !== prev) out += code;
    if (s[i] !== 'h' && s[i] !== 'w') prev = code;
  }
  return (out + '000').slice(0, 4);
}

// ---------------------------------------------------------------------------
// Age bands
// ---------------------------------------------------------------------------

/** Map an approximate numeric age to the band(s) it could fall in.
 *  "60-something" / 60 is intentionally ambiguous → both 41-60 and 61-70. */
function ageToBands(age) {
  if (age == null || isNaN(age)) return [];
  const a = Number(age);
  const bands = [];
  if (a <= 12) bands.push('0-12');
  if (a >= 13 && a <= 17) bands.push('13-17');
  if (a >= 18 && a <= 40) bands.push('18-40');
  if (a >= 41 && a <= 60) bands.push('41-60');
  if (a >= 61 && a <= 70) bands.push('61-70');
  if (a >= 71 && a <= 80) bands.push('71-80');
  if (a >= 80) bands.push('80+');
  // Edge ages straddle two bands ("about 60", "around 80").
  if (a === 60) bands.push('61-70');
  if (a === 40) bands.push('41-60');
  if (a === 70) bands.push('71-80');
  return [...new Set(bands)];
}

function buildAgeAdjacency(config) {
  const adj = {};
  const pairs = (config.adjacency && config.adjacency.ageBands) || [];
  for (const [a, b] of pairs) {
    (adj[a] = adj[a] || new Set()).add(b);
    (adj[b] = adj[b] || new Set()).add(a);
  }
  return adj;
}

// ---------------------------------------------------------------------------
// Semantic description — Hindi/English aware keyword overlap (OFFLINE only)
// ---------------------------------------------------------------------------
//
// The spec: offline, the rules engine tags description points "semantic
// pending"; Claude fills them when online. We support three modes:
//   'pending'   (default, spec-faithful) -> 0 points, semanticPending:true
//   'heuristic' (offline demo)           -> deterministic keyword overlap,
//                                            flagged "provisional (offline)"
//   value: <n>  (online)                 -> caller passes Claude's semantic
//                                            points; engine just slots them in

// Canonical feature tokens with Hindi/Marathi/English synonyms collapsed.
const FEATURE_SYNONYMS = {
  elderly: ['elderly', 'old', 'aged', 'bujurg', 'buzurg', 'bujurg', 'senior'],
  child: ['child', 'kid', 'bachcha', 'bachchi', 'baccha', 'boy', 'girl', 'young'],
  saffron: ['saffron', 'orange', 'bhagwa', 'kesari'],
  white: ['white', 'safed'],
  green: ['green', 'hara'],
  red: ['red', 'lal'],
  blue: ['blue', 'neela'],
  yellow: ['yellow', 'peela'],
  kurta: ['kurta'],
  saree: ['saree', 'sari', 'silk'],
  dhoti: ['dhoti'],
  dupatta: ['dupatta'],
  shirt: ['shirt', 'tshirt'],
  schooldress: ['school', 'uniform', 'schoolbag', 'bag'],
  rudraksha: ['rudraksha', 'mala', 'beads'],
  tilak: ['tilak', 'tika', 'teeka'],
  bindi: ['bindi'],
  bald: ['bald', 'baldhead'],
  greyhair: ['grey', 'gray', 'greyhair', 'whitehair'],
  hearingaid: ['hearing', 'hearingaid', 'deaf'],
  widow: ['widow', 'widowmarks'],
  pigtails: ['pigtails', 'braids', 'plaits'],
  glasses: ['glasses', 'spectacles', 'chashma'],
  thin: ['thin', 'slim', 'lean', 'dubla'],
  heavy: ['heavy', 'fat', 'stout', 'mota'],
};

function featureSet(text) {
  const t = norm(text).replace(/[^a-z\s]/g, ' ');
  const tokens = new Set(t.split(/\s+/).filter(Boolean));
  const features = new Set();
  for (const [feat, syns] of Object.entries(FEATURE_SYNONYMS)) {
    if (syns.some((s) => tokens.has(s))) features.add(feat);
  }
  return features;
}

/** Provisional offline description score (deterministic). Jaccard overlap of
 *  feature sets, scaled to the description weight. Clearly flagged. */
function heuristicDescription(queryDesc, candDesc, maxPts) {
  const q = featureSet(queryDesc);
  const c = featureSet(candDesc);
  if (q.size === 0 || c.size === 0) return { points: 0, overlap: 0, shared: [] };
  let inter = 0;
  const shared = [];
  for (const f of q) if (c.has(f)) { inter++; shared.push(f); }
  const union = new Set([...q, ...c]).size;
  const overlap = inter / union;
  return { points: Math.min(maxPts, Math.round(maxPts * overlap)), overlap, shared };
}

// ---------------------------------------------------------------------------
// Scoring
// ---------------------------------------------------------------------------

function field(points, max, assessed, note) {
  return { points: assessed ? points : 0, max, assessed, note: note || '' };
}

/**
 * @param query     structured query (operator's description of the person)
 * @param candidate one found-persons record
 * @param config    the config:scoring doc
 * @param opts      { semantic: 'pending'|'heuristic'|number, locationAdjacency }
 */
function scoreCandidate(query, candidate, config, opts = {}) {
  const w = config.weights;
  const semantic = opts.semantic == null ? 'pending' : opts.semantic;
  const locAdj = opts.locationAdjacency || {};
  const ageAdj = buildAgeAdjacency(config);
  const b = {};
  let semanticPending = false;

  // --- Gender ---
  const qG = norm(query.gender), cG = norm(candidate.gender);
  if (!qG || !cG || qG === 'unknown' || cG === 'unknown') {
    b.gender = field(0, w.gender, false, 'gender unknown on query or record');
  } else {
    b.gender = field(qG === cG ? w.gender : 0, w.gender, true,
      qG === cG ? `both ${candidate.gender}` : `query ${query.gender} vs record ${candidate.gender}`);
  }

  // --- Age ---
  let queryBands = [];
  if (Array.isArray(query.ageBands) && query.ageBands.length) queryBands = query.ageBands.slice();
  else if (query.ageBand) queryBands = [query.ageBand];
  else if (query.ageApprox != null) queryBands = ageToBands(query.ageApprox);
  const cBand = candidate.age_band;
  if (!queryBands.length || !cBand) {
    b.age = field(0, w.age, false, 'age unknown on query or record');
  } else if (queryBands.includes(cBand)) {
    b.age = field(w.age, w.age, true, `same band ${cBand}`);
  } else if (queryBands.some((qb) => ageAdj[qb] && ageAdj[qb].has(cBand))) {
    b.age = field(Math.floor(w.age / 2), w.age, true, `adjacent band (query ${queryBands.join('/')} ~ record ${cBand})`);
  } else {
    b.age = field(0, w.age, true, `bands disjoint (query ${queryBands.join('/')} vs record ${cBand})`);
  }

  // --- State ---
  const qS = norm(query.state), cS = norm(candidate.state);
  if (!qS || !cS) {
    b.state = field(0, w.state, false, 'state unknown on query or record');
  } else {
    b.state = field(qS === cS ? w.state : 0, w.state, true,
      qS === cS ? `both ${candidate.state}` : `query ${query.state} vs record ${candidate.state}`);
  }

  // --- Location (same or adjacent zone) ---
  const qL = norm(query.lastSeenLocation), cL = norm(candidate.last_seen_location);
  if (!qL || !cL) {
    b.location = field(0, w.location, false, 'location unknown on query or record');
  } else if (qL === cL) {
    b.location = field(w.location, w.location, true, `same location ${candidate.last_seen_location}`);
  } else if ((locAdj[qL] && locAdj[qL].includes(cL)) || (locAdj[cL] && locAdj[cL].includes(qL))) {
    b.location = field(w.location, w.location, true, `adjacent zone (${query.lastSeenLocation} ~ ${candidate.last_seen_location})`);
  } else {
    b.location = field(0, w.location, true, `different location (query ${query.lastSeenLocation} vs record ${candidate.last_seen_location})`);
  }

  // --- Time (both within timeWindowHours) ---
  const qT = parseTime(query.reportedAt), cT = parseTime(candidate.reported_at);
  if (qT == null || cT == null) {
    b.time = field(0, w.time, false, 'report time unknown on query or record');
  } else {
    const diffH = Math.abs(qT - cT) / 36e5;
    b.time = field(diffH <= config.timeWindowHours ? w.time : 0, w.time, true,
      diffH <= config.timeWindowHours ? `within ${diffH.toFixed(1)}h` : `${diffH.toFixed(1)}h apart (> ${config.timeWindowHours}h)`);
  }

  // --- Name (exact / phonetic; blank never penalised) ---
  const qN = query.name, cN = candidate.missing_person_name;
  if (isBlank(qN) || isBlank(cN)) {
    b.name = field(0, Math.max(w.nameExact, w.namePhonetic), false,
      isBlank(cN) ? 'record has no name (not penalised)' : 'no name on query');
  } else if (normName(qN) === normName(cN)) {
    b.name = field(w.nameExact, w.nameExact, true, `exact name match "${cN}"`);
  } else if (soundex(qN) === soundex(cN)) {
    b.name = field(w.namePhonetic, w.nameExact, true, `phonetic match (${qN} ~ ${cN})`);
  } else {
    b.name = field(0, w.nameExact, true, `names differ (${qN} vs ${cN})`);
  }

  // --- Description (semantic) ---
  if (isBlank(candidate.physical_description) || isBlank(query.description)) {
    b.description = field(0, w.description, false, 'description blank on query or record');
  } else if (semantic === 'pending') {
    b.description = field(0, w.description, false, 'semantic pending — Claude offline');
    semanticPending = true;
  } else if (typeof semantic === 'number') {
    b.description = field(Math.min(w.description, semantic), w.description, true, 'semantic score from Claude');
  } else { // 'heuristic'
    const h = heuristicDescription(query.description, candidate.physical_description, w.description);
    b.description = field(h.points, w.description, true,
      h.shared.length ? `provisional (offline): shared ${h.shared.join(', ')}` : 'provisional (offline): no shared features');
  }

  // --- Total, cap, band ---
  let raw = 0;
  for (const k of Object.keys(b)) raw += b[k].points;
  const capped = raw > config.scoreCap;
  const score = Math.min(raw, config.scoreCap);

  return { score, raw, capped, band: bandOf(score, config), breakdown: b, semanticPending };
}

function bandOf(score, config) {
  const { high, medium, low } = config.bands;
  if (score >= high) return 'HIGH';
  if (score >= medium) return 'MEDIUM';
  if (score >= low) return 'LOW';
  return 'BELOW';
}

/** Parse "YYYY-MM-DD HH:MM" (dataset format) or ISO into epoch ms. */
function parseTime(s) {
  if (isBlank(s)) return null;
  let str = String(s).trim();
  if (/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}/.test(str)) str = str.replace(' ', 'T');
  const t = Date.parse(str);
  return isNaN(t) ? null : t;
}

module.exports = {
  AGE_BANDS,
  scoreCandidate,
  bandOf,
  ageToBands,
  soundex,
  featureSet,
  parseTime,
  buildAgeAdjacency,
  norm,
  normName,
  isBlank,
};
