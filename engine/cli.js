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
const { search } = require('./search');
const { formatResult } = require('./format');
const { buildPrompt } = require('./prompt');
const { preFilter } = require('./search');

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
      case '--desc': a.description = next(); break;
      case '--semantic': a.semantic = next(); break;
      case '--json': a.json = true; break;
      case '--prompt': a.prompt = /^\d+$/.test(argv[i + 1] || '') ? Number(next()) : 1; break;
      default: console.error(`Unknown flag: ${k}`); process.exit(1);
    }
  }
  return a;
}

function main() {
  const a = parseArgs(process.argv);
  const config = data.loadConfig();
  const records = data.loadRecords();

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

  const opts = { semantic: a.semantic || 'pending', now: a.reportedAt };

  if (a.prompt) {
    const candidates = preFilter(query, records, config, opts);
    process.stdout.write(buildPrompt(candidates, config, { phase: a.prompt }));
    process.stdout.write('\n');
    return;
  }

  const result = search(query, records, config, opts);
  if (a.json) {
    console.log(JSON.stringify(result, null, 2));
    return;
  }
  const timestamp = new Date().toISOString().replace('T', ' ').slice(0, 16);
  console.log(formatResult(result, config, { timestamp }));
}

main();
