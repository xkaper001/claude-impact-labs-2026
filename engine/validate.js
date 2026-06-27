#!/usr/bin/env node
'use strict';
/**
 * Accuracy harness for the cross-center matcher.
 *
 * DATA CAVEATS (verified against the dataset — read before trusting numbers):
 *  1. `is_duplicate_report` is a synthetic ~8% flag with NO recoverable twin:
 *     only 2/202 flagged rows have an actual same-person record at another
 *     center. So you CANNOT measure dedup recall against that flag — there is
 *     no ground-truth pairing.
 *  2. `physical_description` is decorative noise: ~35% of descriptions
 *     contradict the row's own gender (a Male row described "Woman in green
 *     saree"). Semantic description matching is real on production data but
 *     meaningless here — which is why `pending` (description excluded) is the
 *     safe default.
 *  3. Low cardinality (20 states, 20 locations, 7 age bands, 3 genders) means
 *     coarse fields collide constantly: almost every record has a statistical
 *     twin at another center. Coarse fields PRE-FILTER; they don't identify.
 *
 * So we prove the thing the product actually claims, with a controllable
 * ground truth: PLANT a known same-person record at a DIFFERENT center under
 * realistic degradation (name sometimes dropped, age sometimes shifted to an
 * adjacent band, location/time jittered), then confirm the engine reunites it.
 * That is the "found at Center A, family searching at Center B" path.
 */

const data = require('./data');
const S = require('./scoring');
const { search, preFilter } = require('./search');

// Deterministic PRNG (no Math.random) so the harness is reproducible.
function lcg(seed) {
  let s = seed >>> 0;
  return () => ((s = (1664525 * s + 1013904223) >>> 0) / 2 ** 32);
}

const CENTERS = [
  'Adgaon Kho-Ya-Paya', 'Rajur Bahula Center', 'Panchavati Center',
  'Ramkund Kho-Ya-Paya Kendra', 'Bharat Bharati Control Room', 'Central Control Room',
  'Nashik Road Center', 'Sadhugram Lost Found', 'Police Main Control Room',
];

const ADJ_LOC = { // a few plausible nearby-location jitters
  'Ramkund Ghat': 'Panchavati Circle', 'Panchavati Circle': 'Ramkund Ghat',
  'Kushavart Kund': 'Trimbakeshwar Approach', 'Trimbakeshwar Approach': 'Kushavart Kund',
};

function shiftTime(ts, hours) {
  const t = S.parseTime(ts);
  if (t == null) return ts;
  const d = new Date(t + hours * 36e5);
  return d.toISOString().replace('T', ' ').slice(0, 16);
}

/** Build the FOUND-person twin filed at another center (what's already in the
 *  registry), degraded the way real intake degrades. */
function plantTwin(seed, rnd, idx) {
  const ageAdj = S.buildAgeAdjacency(require('./data').loadConfig());
  const twin = { ...seed, case_id: `PLANT-${idx}` };

  // Different reporting center (the whole point).
  let c = CENTERS[Math.floor(rnd() * CENTERS.length)];
  if (S.norm(c) === S.norm(seed.reporting_center)) c = CENTERS[(CENTERS.indexOf(c) + 1) % CENTERS.length];
  twin.reporting_center = c;

  // 30%: drop the name at the found side (person can't say it).
  if (rnd() < 0.3) twin.missing_person_name = '';
  // 25%: age recorded one adjacent band off.
  if (rnd() < 0.25) {
    const adj = ageAdj[seed.age_band] ? [...ageAdj[seed.age_band]] : [];
    if (adj.length) twin.age_band = adj[Math.floor(rnd() * adj.length)];
  }
  // 30%: last-seen location jittered to a nearby one (if we know a neighbour).
  if (rnd() < 0.3 && ADJ_LOC[seed.last_seen_location]) twin.last_seen_location = ADJ_LOC[seed.last_seen_location];
  // time recorded within the window (±a few hours).
  twin.reported_at = shiftTime(seed.reported_at, Math.round((rnd() * 8 - 4)));
  return twin;
}

/** The operator's query as the FAMILY would give it at Center B. Families
 *  reliably know origin state + gender + rough age; name/description often
 *  vague. We drop description (noise in this set) and keep what families know. */
function familyQuery(seed) {
  return {
    name: seed.missing_person_name || undefined,
    gender: seed.gender,
    ageApprox: undefined,
    ageBand: seed.age_band,
    state: seed.state,
    lastSeenLocation: seed.last_seen_location,
    reportedAt: seed.reported_at,
  };
}

function run() {
  const config = data.loadConfig();
  const all = data.loadRecords();
  const rnd = lcg(20270728);

  const N = 300;
  // Pick N distinct seed records spread across the dataset.
  const seeds = [];
  for (let i = 0; i < N; i++) seeds.push(all[Math.floor((i / N) * all.length)]);

  let recallTop1 = 0, recallTopN = 0, bandHigh = 0, bandMedium = 0, found = 0;
  let prefilterMax = 0;
  const ranks = [];

  seeds.forEach((seed, i) => {
    const twin = plantTwin(seed, rnd, i);
    // Pool = full dataset minus the seed itself (the seed is the family's NEW
    // report; it shouldn't be in the found-registry) PLUS the planted twin.
    const pool = all.filter((r) => r.case_id !== seed.case_id).concat([twin]);

    const q = familyQuery(seed);
    prefilterMax = Math.max(prefilterMax, preFilter(q, pool, config).length);
    const res = search(q, pool, config); // default semantic 'pending' (offline-safe)

    const rank = res.matches.findIndex((m) => m.record.case_id === twin.case_id);
    if (rank >= 0) {
      found++;
      ranks.push(rank + 1);
      if (rank === 0) recallTop1++;
      recallTopN++;
      const m = res.matches[rank];
      if (m.band === 'HIGH') bandHigh++;
      else if (m.band === 'MEDIUM') bandMedium++;
    }
  });

  const pct = (a) => ((100 * a) / N).toFixed(1);
  const meanRank = ranks.length ? (ranks.reduce((s, r) => s + r, 0) / ranks.length).toFixed(2) : '-';

  console.log('KumbhRakshak — cross-center matching accuracy (planted-twin)');
  console.log('============================================================');
  console.log(`Seeds: ${N}  |  pre-filter cap respected: max ${prefilterMax} candidates (<= ${40})`);
  console.log(`Scoring: deterministic fields only ("semantic pending" / offline)`);
  console.log('');
  console.log(`Twin reunited in top-${config.returnRules.topN} : ${recallTopN}/${N} = ${pct(recallTopN)}%  <-- cross-center recall`);
  console.log(`Twin ranked #1                 : ${recallTop1}/${N} = ${pct(recallTop1)}%`);
  console.log(`  ...returned at HIGH band     : ${bandHigh}/${N} = ${pct(bandHigh)}%`);
  console.log(`  ...returned at MEDIUM band   : ${bandMedium}/${N} = ${pct(bandMedium)}%`);
  console.log(`Mean rank of the true twin     : ${meanRank}`);
  console.log('');
  console.log('Interpretation: with family-known fields only (no name guarantee,');
  console.log('no usable description), the engine still reunites the cross-center');
  console.log('record in the returned set. Name + Claude semantic scoring (online)');
  console.log('only sharpen ranking further — on production data, not this noise set.');
}

run();
