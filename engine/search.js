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

const OPEN_STATUSES = new Set(['pending', 'unresolved']);

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
  const candidates = preFilter(query, records, config, opts);

  const scored = candidates
    .map((r) => ({ record: r, ...S.scoreCandidate(query, r, config, opts) }))
    .sort((a, b) => b.score - a.score || String(a.record.case_id).localeCompare(String(b.record.case_id)));

  const minScore = config.returnRules.minReturnScore;
  const topN = config.returnRules.topN;
  const matches = scored.filter((m) => m.score >= minScore).slice(0, topN);

  const warnings = [];
  // Duplicate detection among the returned matches.
  for (const dup of findDuplicatePairs(matches.map((m) => m.record), config)) {
    warnings.push({
      type: 'duplicate',
      caseIds: dup.pair,
      message: `⚠️ Possible duplicate — ${dup.pair[0]} and ${dup.pair[1]} appear to be the same person. ` +
        `Check with both centers before proceeding.`,
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

  return {
    query,
    recordsSearched: records.length,
    candidatesConsidered: candidates.length,
    semanticMode: opts.semantic == null ? 'pending' : opts.semantic,
    matches,
    warnings,
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

// ---------------------------------------------------------------------------
// Escalation flags (config.escalation) — Phase 3
// ---------------------------------------------------------------------------

function escalationFlags(record, config, now) {
  const esc = config.escalation;
  const flags = [];
  const hrs = hoursAgo(record.reported_at, now);
  const isChild = ['0-12'].includes(record.age_band) ||
    (record.age_band === '0-12');

  if (isChild && hrs != null && hrs > esc.childHours) {
    flags.push({ type: 'child', message: `Child (${record.age_band}) separated ${hrs}h (> ${esc.childHours}h) — escalate to police.` });
  }
  if (OPEN_STATUSES.has(S.norm(record.status)) && hrs != null && hrs > esc.unresolvedHours) {
    flags.push({ type: 'unresolved', message: `Case open ${hrs}h (> ${esc.unresolvedHours}h) — escalate.` });
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
  escalationFlags,
  hoursAgo,
  OPEN_STATUSES,
};
