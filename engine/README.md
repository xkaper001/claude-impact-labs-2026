# KumbhRakshak — offline matching pipeline

The deterministic rules engine that powers cross-center missing-person search at
Nashik Kumbh Mela 2027. Zero dependencies, pure JavaScript — the same code runs
in Node (this CLI) and in the browser under PouchDB, exactly as the design
intends. It reads `../config-scoring.json` and `../prompts.md` as the single
sources of truth, so changing a weight in CouchDB changes behaviour everywhere
with no code or prompt edit.

## The pipeline

```
2,500 records ──▶ preFilter() ──▶ ≤40 candidates ──▶ scoreCandidate() ──▶ rank ──▶ topN
   (CSV)          gender+age+         (cheap, O(n))     deterministic fields    band     +warnings
                  state/location                        (config-driven)
                                          │
                                          └──▶ buildPrompt() ──▶ Claude (online)
                                               injects candidates+config         fills the ONE field
                                               into the Phase-N prompt           the engine can't do:
                                                                                 semantic `description`
                                                                                 + operator explanation
```

The engine does the **scaling** (2,500 → ≤40) and every **deterministic** field
offline. Claude, when reachable, only fills the semantic `description` points and
writes the human-facing prose. Offline, those points are tagged `semantic
pending` and the rest still scores — the two never drift because they read the
same config doc.

## Files

| File | Role |
|---|---|
| `csv.js` | RFC-4180 parser (handles commas inside quoted `physical_description`) |
| `data.js` | Loads config + the 5 CSVs (Node side; swap for PouchDB in browser) |
| `scoring.js` | `scoreCandidate()` — all weights/bands/adjacency from config; per-field honest breakdown |
| `search.js` | `preFilter()`, `search()`, duplicate + re-report + escalation flags |
| `prompt.js` | Injects candidates + config into the Phase-1/2/3 prompt from `prompts.md` |
| `format.js` | Renders the exact Mode A/B output template |
| `cli.js` | Run a search from the terminal |
| `validate.js` | Accuracy harness (planted-twin methodology) |

## Usage

```bash
# Live search (offline default: description = "semantic pending")
node engine/cli.js --gender Male --age 72 --state Bihar \
     --loc "Ramkund Ghat" --desc "elderly man, white kurta, rudraksha mala"

# Offline demo with provisional semantic scoring (keyword overlap)
node engine/cli.js ... --semantic heuristic

# Raw result object
node engine/cli.js ... --json

# Emit the LLM prompt (candidates+config injected) for Phase 1/2/3 instead
node engine/cli.js ... --prompt 1

# Accuracy harness
node engine/validate.js
```

Flags: `--name --gender --age|--band --state --district --loc --time --desc
--semantic --prompt --json`. Location vocabulary matches the dataset
(`Ramkund Ghat`, `Takli Sangam`, `Kushavart Kund`, …).

## Scoring (all values from `config-scoring.json`)

| Field | Weight | Rule |
|---|---|---|
| age | 25 | full on same band; half (floor) on adjacent band per `adjacency.ageBands`; else 0 |
| gender | 20 | full on equal known genders; 0/unassessed if either Unknown |
| state | 20 | full on equal |
| description | 20 | semantic — `pending` offline / Claude online / `heuristic` demo |
| location | 10 | full on same (or curated-adjacent) location |
| time | 5 | full when both within `timeWindowHours` (6h) |
| nameExact / namePhonetic | 10 / 5 | exact normalised match / Soundex match; blank name never penalised |

Total capped at `scoreCap` (100), banded HIGH ≥75 · MEDIUM ≥50 · LOW ≥30, never
returned below `minReturnScore` (30), at most `topN` (3) matches.

**Honesty rule:** a field that can't be assessed (unknown on query or record) is
**excluded** — 0 points, `assessed:false`, with a note — never guessed, never
penalised. Every match shows its per-field breakdown and its honest conflicts.

## Accuracy — and honest data caveats

The harness was rebuilt after inspecting the data. Three properties of the
**synthetic** dataset matter (all verified in `validate.js`'s header):

1. **`is_duplicate_report` has no recoverable twin** — only 2/202 flagged rows
   have an actual same-person record at another center. The flag is a random
   ~8% label, so dedup recall **cannot** be measured against it.
2. **`physical_description` is decorative noise** — ~35% of descriptions
   contradict the row's own gender (a `Male` row described "Woman in green
   saree"). Semantic matching is real on production data but meaningless here;
   that's why `pending` (description excluded) is the offline-safe default.
3. **Low cardinality** (20 states, 20 locations, 7 age bands) means coarse
   fields collide constantly — they pre-filter, they don't identify.

So the harness proves the product claim with a **controllable ground truth**:
plant a known same-person record at a *different* center under realistic
degradation (name dropped 30%, age shifted to an adjacent band 25%, location/
time jittered), then check the engine reunites it.

```
Twin reunited in top-3 : 92.7%   <-- cross-center recall
Twin ranked #1         : 83.3%   (mean rank 1.12)
  ...at HIGH band      : 83.0%
Pre-filter cap         : ≤40 candidates, full run < 0.5s
```

…using **family-known fields only** (no name guarantee, no usable description),
fully offline. Name + Claude's semantic layer sharpen this further on real data.

## What's deterministic vs. what needs Claude

- **Deterministic (offline, this engine):** pre-filter, age/gender/state/
  location/time/name scoring, banding, duplicate/re-report/escalation flags,
  output format. Same input → same ranking.
- **Claude (online):** transcribe/translate the operator's spoken query into the
  structured query, score the semantic `description`, and write the explanation.
  Wire-up point is `buildPrompt()` → send to `claude-opus-4-8` (per
  `config.llm.model`) → read back `description` points and prose.
```
