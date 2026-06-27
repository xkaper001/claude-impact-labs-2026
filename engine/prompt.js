'use strict';
/**
 * Builds the LLM prompt by injecting the PRE-FILTERED candidates and the
 * config doc into the phased system prompt authored in prompts.md.
 *
 * This is the seam between the deterministic engine and Claude: the engine
 * does the scaling (2,500 -> <=40) and the deterministic fields; the prompt
 * hands that small set to Claude to fill the semantic `description` points
 * and write the operator-facing explanation. One source of truth for the
 * prompt text (prompts.md) and the numbers (config-scoring.json).
 *
 * fs-free: the prompts.md text is passed in via opts.md by the caller
 * (Node CLI reads it from disk; the browser inlines it at build time via
 * ?raw). So this same module runs unchanged in Node and in the browser.
 */

// Fields the prompt declares it will receive (project to avoid leaking the
// reporter_mobile into prompt text — the NEVER block forbids repeating it).
const CANDIDATE_FIELDS = [
  'case_id', 'reported_at', 'missing_person_name', 'gender', 'age_band', 'state',
  'district', 'language', 'last_seen_location', 'reporting_center',
  'physical_description', 'status', 'is_duplicate_report', 'remarks',
];

/** Extract the ```text fenced blocks from prompts.md, in order. */
function extractPhaseBlocks(md) {
  const blocks = [];
  const re = /```text\r?\n([\s\S]*?)```/g;
  let m;
  while ((m = re.exec(md)) !== null) blocks.push(m[1].trimEnd());
  return blocks;
}

/** Assemble the full prompt text for a phase (1, 2, or 3). Phases are
 *  cumulative: phase N = phase 1 .. N concatenated, with the
 *  "[ALL OF PHASE ...]" marker lines stripped. `md` is the prompts.md text. */
function assemblePhase(phase = 1, md) {
  if (!md) throw new Error('assemblePhase: prompts.md text is required (pass opts.md)');
  const blocks = extractPhaseBlocks(md);
  if (!blocks.length) throw new Error('No ```text prompt blocks found in prompts.md');
  const n = Math.min(phase, blocks.length);
  const parts = [];
  for (let i = 0; i < n; i++) {
    let text = blocks[i];
    // Drop the cumulative marker line(s) like "[ALL OF PHASE 1, then add:]".
    text = text.replace(/^\s*\[ALL OF PHASE[^\]]*\]\s*\n/i, '');
    parts.push(text);
  }
  return parts.join('\n\n');
}

function projectCandidates(records) {
  return records.map((r) => {
    const o = {};
    for (const f of CANDIDATE_FIELDS) o[f] = r[f] !== undefined ? r[f] : '';
    return o;
  });
}

/**
 * @param candidates pre-filtered records (<=40)
 * @param config     config:scoring doc
 * @param opts       { phase: 1|2|3 }
 * @returns the full prompt string with placeholders filled.
 */
function buildPrompt(candidates, config, opts = {}) {
  const phase = opts.phase || 1;
  let prompt = assemblePhase(phase, opts.md);
  const candJSON = JSON.stringify(projectCandidates(candidates), null, 2);
  const configJSON = JSON.stringify(config, null, 2);
  prompt = prompt
    .replace('{{CANDIDATES_JSON}}', candJSON)
    .replace('{{CONFIG_JSON}}', configJSON);
  return prompt;
}

/** Build a Mode C (HOTSPOT) prompt: the phased prompt text + a deterministic
 *  payload of open cases, zones, and risk-tagged chokepoints. The engine has
 *  already computed the hotspots; Claude's job online is to write the ICCC
 *  action prose, not to recompute clusters. */
function buildHotspotPrompt(openCases, zones, chokepoints, hotspots, config, opts = {}) {
  const phase = opts.phase || 2;
  const prompt = assemblePhase(phase, opts.md);
  const configJSON = JSON.stringify(config, null, 2);
  const payload = JSON.stringify({
    mode: 'C',
    openCases: projectCandidates(openCases),
    zones: zones.map((z) => ({
      zone_name: z.zone_name,
      centroid_lat: Number(z.centroid_lat),
      centroid_lng: Number(z.centroid_lng),
    })),
    chokepoints: chokepoints.map((c) => ({
      location_name: c.location_name,
      category: c.category,
      risk_level: c.risk_level,
      latitude: Number(c.latitude),
      longitude: Number(c.longitude),
    })),
    engineHotspots: hotspots,
  }, null, 2);
  const header =
    'MODE C HOTSPOT — ICCC control room. The deterministic engine has already ' +
    'clustered open cases near Traffic choke-points (see engineHotspots below). ' +
    'Use those as authoritative; write the ICCC action prose per the output ' +
    'format, tie-break by risk_level, and never invent coordinates.\n\n';
  return (
    prompt
      .replace('{{CONFIG_JSON}}', configJSON)
      .replace('{{CANDIDATES_JSON}}', '[] // Mode C: see MODE C payload below') +
    '\n\n--- MODE C PAYLOAD ---\n' + header + payload + '\n'
  );
}

module.exports = {
  buildPrompt,
  buildHotspotPrompt,
  assemblePhase,
  extractPhaseBlocks,
  projectCandidates,
  CANDIDATE_FIELDS,
};
