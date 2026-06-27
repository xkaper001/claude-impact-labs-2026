'use strict';
/**
 * Search orchestration for KumbhRakshak.
 *
 *   preFilter()  — narrow 2,500 records to <=40 candidates BEFORE scoring,
 *                  so the spike test stays fast and (when online) Claude only
 *                  ever sees a small candidate set.
 *   search()     — Mode A/B: pre-filter -> score -> band -> rank -> topN,
 *                  with duplicate + re-report warnings.
 *
 * All thresholds come from the config doc. Deterministic: same input -> same
 * ranking (records are pre-sorted by case_id before slicing on ties).
 */

const S = require('./scoring');
const geo = require('./geo');

const OPEN_STATUSES = new Set(['pending', 'unresolved']);

// ---------------------------------------------------------------------------
// Geo helpers for Phase 3 (chokepoint awareness + nearest police station)
// ---------------------------------------------------------------------------

/** Resolve a record's last_seen_location to a coordinate via the area index. */
function recordCoord(record, areaIndex) {
  if (!areaIndex) return null;
  const hit = geo.resolveLocation(record.last_seen_location, areaIndex);
  return hit ? { lat: hit.lat, lng: hit.lng } : null;
}

/** Nearest chokepoint to a record within `radiusM`, any category.
 *  Returns { name, riskLevel, distanceM } or null. */
function nearestChokepoint(record, chokepoints, areaIndex, radiusM) {
  const rc = recordCoord(record, areaIndex);
  if (!rc || !chokepoints || !chokepoints.length) return null;
  let best = null;
  for (const c of chokepoints) {
    const lat = Number(c.latitude);
    const lng = Number(c.longitude);
    if (!isFinite(lat) || !isFinite(lng)) continue;
    const d = geo.haversine([rc.lng, rc.lat], [lng, lat]);
    if (d <= radiusM && (!best || d < best.distanceM)) {
      best = { name: c.location_name, riskLevel: S.norm(c.risk_level), distanceM: Math.round(d) };
    }
  }
  return best;
}

/** Nearest police station to a record. Returns { name, distanceM } or null. */
function nearestStation(record, policeStations, areaIndex) {
  const rc = recordCoord(record, areaIndex);
  if (!rc || !policeStations || !policeStations.length) return null;
  let best = null;
  for (const p of policeStations) {
    const lat = Number(p.latitude);
    const lng = Number(p.longitude);
    if (!isFinite(lat) || !isFinite(lng)) continue;
    const d = geo.haversine([rc.lng, rc.lat], [lng, lat]);
    if (!best || d < best.distanceM) best = { name: p.station_name, distanceM: Math.round(d) };
  }
  return best;
}

// ---------------------------------------------------------------------------
// Pre-filter
// ---------------------------------------------------------------------------

/**
 * Cheap, deterministic narrowing before the expensive scoring pass.
 * Strategy: hard-gate on gender + age compatibility (always true of a real
 * match), then progressively tighten with state/location only if still over
 * the cap. Falls back gracefully so we never return zero candidates that a
 * looser filter would have caught.
 */
function preFilter(query, records, config, opts = {}) {
  const max = opts.maxCandidates || 40;
  const ageAdj = S.buildAgeAdjacency(config);

  let queryBands = [];
  if (Array.isArray(query.ageBands) && query.ageBands.length) queryBands = query.ageBands.slice();
  else if (query.ageBand) queryBands = [query.ageBand];
  else if (query.ageApprox != null) queryBands = S.ageToBands(query.ageApprox);
  const expandedBands = new Set(queryBands);
  for (const qb of queryBands) if (ageAdj[qb]) for (const adj of ageAdj[qb]) expandedBands.add(adj);

  const qG = S.norm(query.gender);
  const qS = S.norm(query.state);
  const qL = S.norm(query.lastSeenLocation);

  const genderOk = (r) => !qG || qG === 'unknown' || S.norm(r.gender) === qG || S.norm(r.gender) === 'unknown';
  const ageOk = (r) => expandedBands.size === 0 || expandedBands.has(r.age_band);

  // Base gate: gender + age.
  let pool = records.filter((r) => genderOk(r) && ageOk(r));

  // Tighten with state if that keeps a usable pool.
  if (pool.length > max && qS) {
    const byState = pool.filter((r) => S.norm(r.state) === qS);
    if (byState.length >= Math.min(max, 5)) pool = byState;
  }
  // Tighten with location if still over cap.
  if (pool.length > max && qL) {
    const byLoc = pool.filter((r) => S.norm(r.last_seen_location) === qL);
    if (byLoc.length >= Math.min(max, 5)) pool = byLoc;
  }

  // Still over cap → keep the strongest by a cheap pre-score (no semantic).
  if (pool.length > max) {
    pool = pool
      .map((r) => ({ r, p: S.scoreCandidate(query, r, config, { semantic: 'pending' }).score }))
      .sort((a, b) => b.p - a.p || String(a.r.case_id).localeCompare(String(b.r.case_id)))
      .slice(0, max)
      .map((x) => x.r);
  }
  return pool;
}

// ---------------------------------------------------------------------------
// Search (Mode A / B)
// ---------------------------------------------------------------------------

function search(query, records, config, opts = {}) {
  const mode = (opts.mode || 'A').toUpperCase(); // 'A' | 'B'
  const candidates = preFilter(query, records, config, opts);

  const scored = candidates
    .map((r) => ({ record: r, ...S.scoreCandidate(query, r, config, opts) }))
    .sort((a, b) => b.score - a.score || String(a.record.case_id).localeCompare(String(b.record.case_id)));

  const minScore = config.returnRules.minReturnScore;
  const topN = config.returnRules.topN;
  const matches = scored.filter((m) => m.score >= minScore).slice(0, topN);

  // Phase 3 — chokepoint awareness: annotate each returned match with the
  // nearest high-risk separation point near its last_seen, if any.
  const awarenessRadius = (config.cluster && config.cluster.radiusMeters) || 300;
  const areaIndex = opts.areaIndex || null;
  for (const m of matches) {
    const cp = nearestChokepoint(m.record, opts.chokepoints, areaIndex, awarenessRadius);
    if (cp) m.chokepoint = cp;
  }

  const warnings = [];
  // Phase 2 — duplicate detection across the candidate pool (not just top-N),
  // surfacing pairs that involve a returned match first, capped at 5.
  const matchIds = new Set(matches.map((m) => m.record.case_id));
  const poolPairs = findDuplicatePairs(candidates, config);
  poolPairs.sort((a, b) => {
    const ai = (matchIds.has(a.pair[0]) || matchIds.has(a.pair[1])) ? 0 : 1;
    const bi = (matchIds.has(b.pair[0]) || matchIds.has(b.pair[1])) ? 0 : 1;
    return ai - bi;
  });
  for (const dup of poolPairs.slice(0, 5)) {
    warnings.push({
      type: 'duplicate',
      caseIds: dup.pair,
      message: `⚠️ Possible duplicate — ${dup.pair[0]} and ${dup.pair[1]} appear to be the same person. ` +
        `Check with both centers before proceeding.`,
    });
  }

  // Phase 3 — trafficking-sensitive trigger: >= dupReports candidates that are
  // all the same person, across centers. Noted sensitively, never a conclusion.
  const dupThreshold = (config.escalation && config.escalation.dupReports) || 3;
  for (const group of groupSamePerson(candidates, config)) {
    if (group.length < dupThreshold) continue;
    const ids = group.map((r) => r.case_id);
    warnings.push({
      type: 'trafficking',
      caseIds: ids,
      message: `⚠️ SENSITIVE — ${ids.length} reports (${ids.slice(0, 4).join(', ')}${ids.length > 4 ? '…' : ''}) ` +
        `appear to describe the same person across centers. Note sensitively — possible trafficking concern. ` +
        `Escalate to a senior volunteer / police, do not discuss with the family.`,
    });
  }

  // Re-report: does the query itself match an OPEN case already on file?
  for (const m of matches) {
    if (OPEN_STATUSES.has(S.norm(m.record.status)) && m.band !== 'BELOW' && m.score >= config.bands.medium) {
      const hrs = hoursAgo(m.record.reported_at, opts.now);
      warnings.push({
        type: 're-report',
        caseId: m.record.case_id,
        message: `⚠️ POSSIBLE RE-REPORT: Case ${m.record.case_id} filed ${hrs == null ? '?' : hrs + 'h'} ago at ` +
          `${m.record.reporting_center} may be the same person. Confirm with family before registering a new case.`,
      });
    }
  }

  // Police escalation flags (config.escalation) — surfaced per match, with the
  // nearest police station named (Phase 3).
  const escalations = [];
  for (const m of matches) {
    const flags = escalationFlags(m.record, config, opts);
    if (flags.length) escalations.push({ caseId: m.record.case_id, flags });
  }

  return {
    mode,
    query,
    recordsSearched: records.length,
    candidatesConsidered: candidates.length,
    semanticMode: opts.semantic == null ? 'pending' : opts.semantic,
    matches,
    warnings,
    escalations,
  };
}

// ---------------------------------------------------------------------------
// Duplicate detection (validated against is_duplicate_report ground truth)
// ---------------------------------------------------------------------------

/** Two records likely describe the same person when their identity fields
 *  lock AND they were filed at DIFFERENT centers. Used for in-result warnings.
 *
 *  Tightened deliberately: with this dataset's low field cardinality (20
 *  states, 20 locations, 7 age bands) coarse fields alone collide constantly,
 *  so we require the strong discriminators too — an exact/phonetic name match,
 *  OR same location with shared description features. Never a confirmation:
 *  the warning only asks a human to verify with both centers. */
function looksLikeSamePerson(a, b, config) {
  if (a.case_id === b.case_id) return false;
  if (S.norm(a.reporting_center) === S.norm(b.reporting_center)) return false; // not "across centers"
  if (S.norm(a.gender) !== S.norm(b.gender)) return false;
  if (S.norm(a.state) !== S.norm(b.state)) return false;

  const ageAdj = S.buildAgeAdjacency(config);
  const sameOrAdjAge = a.age_band === b.age_band ||
    (ageAdj[a.age_band] && ageAdj[a.age_band].has(b.age_band));
  if (!sameOrAdjAge) return false;

  // Strong discriminator 1: name (exact or phonetic), when both present.
  const bothNamed = !S.isBlank(a.missing_person_name) && !S.isBlank(b.missing_person_name);
  const nameMatch = bothNamed &&
    (S.normName(a.missing_person_name) === S.normName(b.missing_person_name) ||
      S.soundex(a.missing_person_name) === S.soundex(b.missing_person_name));

  // Strong discriminator 2: same place + shared description features.
  const sameLoc = S.norm(a.last_seen_location) === S.norm(b.last_seen_location);
  const fa = S.featureSet(a.physical_description);
  const fb = S.featureSet(b.physical_description);
  let shared = 0;
  for (const f of fa) if (fb.has(f)) shared++;

  return nameMatch || (sameLoc && shared >= 2);
}

function findDuplicatePairs(records, config) {
  const pairs = [];
  for (let i = 0; i < records.length; i++) {
    for (let j = i + 1; j < records.length; j++) {
      if (looksLikeSamePerson(records[i], records[j], config)) {
        pairs.push({ pair: [records[i].case_id, records[j].case_id] });
      }
    }
  }
  return pairs;
}

/** Union-find grouping of records that look like the same person, across
 *  centers. Returns groups (arrays of records) of size > 1. Used for the
 *  Phase 3 dupReports trafficking-sensitive trigger. */
function groupSamePerson(records, config) {
  const parent = records.map((_, i) => i);
  const find = (i) => { while (parent[i] !== i) { parent[i] = parent[parent[i]]; i = parent[i]; } return i; };
  const union = (a, b) => { parent[find(a)] = find(b); };
  for (let i = 0; i < records.length; i++) {
    for (let j = i + 1; j < records.length; j++) {
      if (looksLikeSamePerson(records[i], records[j], config)) union(i, j);
    }
  }
  const groups = {};
  for (let i = 0; i < records.length; i++) {
    const r = find(i);
    (groups[r] = groups[r] || []).push(records[i]);
  }
  return Object.values(groups).filter((g) => g.length > 1);
}

// ---------------------------------------------------------------------------
// Escalation flags (config.escalation) — Phase 3
// ---------------------------------------------------------------------------

function escalationFlags(record, config, opts = {}) {
  const esc = config.escalation;
  const flags = [];
  const hrs = hoursAgo(record.reported_at, opts.now);
  const isChild = record.age_band === '0-12' ||
    (record.age_band === '13-17' && esc.childAgeMax != null && 13 <= Number(esc.childAgeMax));

  // Phase 3 — name the nearest police station when geography is available.
  const station = nearestStation(record, opts.policeStations, opts.areaIndex);
  const stationSuffix = station ? ` — nearest: ${station.name} (${station.distanceM}m)` : '';

  if (isChild && hrs != null && hrs > esc.childHours) {
    flags.push({ type: 'child', message: `Child (${record.age_band}) separated ${hrs}h (> ${esc.childHours}h) — escalate to police${stationSuffix}.` });
  }
  if (OPEN_STATUSES.has(S.norm(record.status)) && hrs != null && hrs > esc.unresolvedHours) {
    flags.push({ type: 'unresolved', message: `Case open ${hrs}h (> ${esc.unresolvedHours}h) — escalate${stationSuffix}.` });
  }
  // Disability / health condition surfaced in free-text remarks or description.
  const haystack = S.norm(record.remarks + ' ' + record.physical_description);
  if (haystack && /\b(deaf|hearing|blind|wheelchair|disabil|handicap|mental|epilep|autis|specially.?abled|divyang)\b/.test(haystack)) {
    flags.push({ type: 'health', message: `Stated health condition / disability noted — flag for priority handling${stationSuffix}.` });
  }
  return flags;
}

function hoursAgo(reportedAt, now) {
  const t = S.parseTime(reportedAt);
  if (t == null) return null;
  const ref = now != null ? (typeof now === 'number' ? now : S.parseTime(now)) : null;
  if (ref == null) return null;
  return Math.round((ref - t) / 36e5);
}

module.exports = {
  preFilter,
  search,
  looksLikeSamePerson,
  findDuplicatePairs,
  groupSamePerson,
  escalationFlags,
  nearestChokepoint,
  nearestStation,
  hoursAgo,
  OPEN_STATUSES,
};
