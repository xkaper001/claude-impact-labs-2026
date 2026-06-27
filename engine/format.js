'use strict';
/** Render a search result in the exact Mode A/B output template (prompts.md
 *  Phase 2). The deterministic engine can produce this offline; when Claude is
 *  online it rewrites the "Why it matches" prose, but the structure is fixed
 *  so the output stays parseable under a snan-day spike. */

function fmtBreakdown(b) {
  // Only show assessed fields, in the template's order.
  const order = ['age', 'gender', 'state', 'description', 'location', 'time', 'name'];
  const labels = { age: 'Age', gender: 'Gender', state: 'State', description: 'Description', location: 'Location', time: 'Time', name: 'Name' };
  const parts = [];
  for (const k of order) {
    const f = b[k];
    if (f && f.assessed) parts.push(`${labels[k]} +${f.points}`);
  }
  return parts.join(' | ');
}

function whyMatches(m) {
  const b = m.breakdown;
  const why = [];
  for (const k of ['name', 'age', 'gender', 'state', 'location', 'description', 'time']) {
    const f = b[k];
    if (f && f.assessed && f.points > 0) why.push(f.note);
  }
  return why;
}

function conflicts(m) {
  const b = m.breakdown;
  const out = [];
  for (const k of Object.keys(b)) {
    const f = b[k];
    if (f.assessed && f.points === 0) out.push(f.note);
    else if (!f.assessed) out.push(`${k}: ${f.note}`);
  }
  return out;
}

function formatResult(result, config, opts = {}) {
  const ts = opts.timestamp || '';
  const lines = [];
  lines.push('---');
  lines.push(`SEARCH RESULT — ${ts}`);
  lines.push(`Query: ${describeQuery(result.query)}`);
  lines.push(`Records searched: ${result.recordsSearched} (pre-filtered to ${result.candidatesConsidered} candidates)`);
  if (result.semanticMode === 'pending') {
    lines.push('Note: description points = "semantic pending" (Claude offline); deterministic fields only.');
  } else if (result.semanticMode === 'heuristic') {
    lines.push('Note: description points are provisional (offline keyword heuristic).');
  }
  lines.push('');

  if (result.matches.length === 0) {
    lines.push('NO MATCH FOUND');
    lines.push(`⟶ NEXT ACTION: widen the age band or check a specific center; ` +
      `re-run with fewer constraints (no name / broader location).`);
    lines.push('---');
    return lines.join('\n');
  }

  result.matches.forEach((m, i) => {
    const r = m.record;
    lines.push(`MATCH ${i + 1} — ${m.band} (${m.score}/${config.scoreCap})`);
    lines.push(`Case: ${r.case_id} · Registered at: ${r.reporting_center} · Status: ${r.status}`);
    lines.push(`Score breakdown: ${fmtBreakdown(m.breakdown)} = ${m.score}`);
    lines.push('Why it matches:');
    for (const w of whyMatches(m)) lines.push(`  • ${w}`);
    const c = conflicts(m);
    lines.push(`Possible conflict: ${c.length ? c.join('; ') : 'none material'}`);
    lines.push(`⟶ NEXT ACTION: call ${r.reporting_center}, ask for case ${r.case_id}; ` +
      `verify ${verifyFields(m)} before telling the family. (possible match — volunteer confirms)`);
    lines.push('');
  });

  for (const w of result.warnings) lines.push(w.message);
  lines.push('---');
  return lines.join('\n');
}

function verifyFields(m) {
  // Suggest verifying the fields we could NOT assess or that conflict.
  const b = m.breakdown;
  const weak = [];
  for (const k of ['name', 'description', 'location']) {
    if (b[k] && (!b[k].assessed || b[k].points === 0)) weak.push(k);
  }
  return weak.length ? weak.join(' + ') : 'photo / a distinguishing detail';
}

function describeQuery(q) {
  const bits = [];
  if (q.name) bits.push(q.name);
  if (q.gender) bits.push(q.gender);
  if (q.ageBand) bits.push(`age ${q.ageBand}`);
  else if (q.ageBands) bits.push(`age ${q.ageBands.join('/')}`);
  else if (q.ageApprox != null) bits.push(`~${q.ageApprox}y`);
  if (q.state) bits.push(`from ${q.state}`);
  if (q.lastSeenLocation) bits.push(`last seen ${q.lastSeenLocation}`);
  if (q.description) bits.push(`"${q.description}"`);
  return bits.join(', ') || '(no constraints given)';
}

module.exports = { formatResult, describeQuery };
