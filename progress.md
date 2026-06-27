# KumbhRakshak / Setu — Progress

> Offline-first cross-center missing-person matcher for Nashik Kumbh Mela 2027.
> Status as of 27 Jun 2026. Built on the Claude Impact Lab Mumbai 2026 dataset
> (2,500 synthetic records, 1,280 CCTV, 32 zone polygons + 21 ghat/transit areas,
> 14 police stations, 85 risk-tagged chokepoints).

Legend: ✅ done · 🟡 partial / wired but not complete · ⬜ not started

---

## 1. Data package — ✅ done

| Item | Status | Notes |
|---|---|---|
| CSV ↔ KML duplicate audit | ✅ | CCTV/Police/Chokepoints verified; 2,808 stray CCTV KML points removed |
| CSV as single source of truth | ✅ | KML dropped after extraction |
| `Area_Boundaries.geojson` (53 polygons) | ✅ | 32 zones + 21 ghat/transit sub-areas, extracted from CCTV KML |
| `Special_Areas.csv` | ✅ | ghat / transit_hub / landmark subtypes + centroids |
| `Zone_Boundaries.csv` enriched | ✅ | `area_type`, polygon-derived centroids, `boundary_point_count` |
| `Chokepoints_Parking.csv` enriched | ✅ | `risk_level`, `status`, `source_url`, `note` from KML |
| `enrich_from_kml.py` re-run script | ✅ | idempotent extractor if source KML is re-added |
| README documents all fields | ✅ | |

## 2. Engine (`engine/`) — deterministic offline core

| Item | Status | Notes |
|---|---|---|
| RFC-4180 CSV parser (`csv.js`) | ✅ | handles quoted commas / escaped quotes / CRLF |
| Config-driven scoring (`scoring.js`) | ✅ | all weights/bands/adjacency from `config-scoring.json`; honest per-field breakdown; name exact/phonetic, age band+adjacent, gender, state, location, time, semantic pending/heuristic/online |
| Pre-filter → ≤40 candidates (`search.js`) | ✅ | gender+age gate, progressive state/location tightening, cheap pre-score tiebreak |
| Mode A/B search + ranking | ✅ | topN, banding, minReturnScore; `--mode B` (IDENTIFY) labeled mode |
| Duplicate + re-report warnings | ✅ | dup scan widened to the **candidate pool** (was top-3); re-report on OPEN matches; **`dupReports` trafficking-sensitive trigger** via union-find grouping |
| Location adjacency (`geo.js`) | ✅ | haversine + fuzzy landmark→centroid + curated location coords; adjacent-zone credit wired into scoring |
| Police escalation flags | ✅ | child + unresolved + health/disability; **nearest police station named** in every escalation message (Phase 3) |
| Chokepoint awareness (Phase 3) | ✅ | each returned match annotated with nearest high-risk chokepoint + risk_level + distance |
| Landmark resolution at intake | ✅ | `--resolve "<text>"` → resolved area + nearest zone (offline) |
| **Mode C hotspot sweep (`hotspot.js`)** | ✅ | open cases clustered near Traffic choke-points; risk-priority tie-break; nearest police station + trend; `--hotspot` CLI + `formatHotspot` + `buildHotspotPrompt` |
| Curated `Location_Coordinates.csv` | ✅ | 20 `last_seen_location` terms → real coords; 277/277 open cases resolve in Mode C |
| Prompt builder (`prompt.js`) | ✅ | Mode A/B candidate+config injection; `buildHotspotPrompt()` for Mode C payload |
| Mode A/B output template (`format.js`) | ✅ | exact Phase-2 format; IDENTIFY/SEARCH label; chokepoint-awareness line; escalation lines |
| CLI (`cli.js`) | ✅ | `--name --gender --age/--band --state --district --loc --time --now --desc --semantic --mode --resolve --prompt --json --hotspot` |
| Accuracy harness (`validate.js`) | ✅ | planted-twin, deterministic LCG; **91.7% top-3 recall, 80.3% #1, 83.3% HIGH**, pre-filter cap respected, runs in ~1s |
| `package.json` run scripts | ✅ | `npm run validate` / `demo` / `prompt` / `hotspot` |

## 3. Prompts (`prompts.md`) — ✅ done

| Item | Status | Notes |
|---|---|---|
| Phase 1 matcher brain | ✅ | config-injected, no hardcoded numbers; engine implements every rule end-to-end |
| Phase 2 Mode A/B/C + format + dedup | ✅ | Mode B `--mode B` (IDENTIFY) labeled mode; Mode C engine + risk tie-break; dup scan widened to candidate pool; re-report flags |
| Phase 3 guardrails / escalation / language / offline | ✅ | chokepoint-awareness annotation on matches; nearest police station in escalation; `dupReports` trafficking trigger; `--resolve` landmark intake; language synonym awareness offline; NEVER block enforced (mobile projected out) |
| NEVER block | ✅ | no Aadhaar/PAN, no repeating mobile, no auto-reunion |

## 4. Plan + design

| Item | Status | Notes |
|---|---|---|
| `PLAN.html` | ✅ | references GeoJSON polygons, risk-colored chokepoints, `riskPriority` tie-break |
| `config-scoring.json` | ✅ | added `cluster.riskPriority` |
| Kumbh-specific `DESIGN.md` | ⬜ | root `DESIGN.md` is the Airbnb reference; no Setu UI token doc yet |

---

## Gaps & deviations found in this review

Ordered by impact on the rubric (deployability / real-world fit / UX / system design / responsible data).

### A. Mode C (HOTSPOT / ICCC) — now implemented ✅
Was the biggest spec-vs-code gap. **Built this pass:** `engine/hotspot.js` (`hotspotSweep()`), `--hotspot`
CLI flag, `formatHotspot()` (exact Phase-2 Mode C template), `buildHotspotPrompt()` (Mode C payload for
Claude), and curated `Location_Coordinates.csv` so all 20 `last_seen_location` terms resolve to real
coords. Verified: 277/277 open cases geo-resolved; top-5 hotspots ranked by case count then
`riskPriority` (very high > high > medium); nearest police station + recent-case trend per hotspot.
Example: Zone Area 31 — 14 open cases 167m from Mumbai Naka (high), nearest help Mumbai naka PS (194m).

### B. Enriched geography was loaded but unused — now fixed ✅
Before this pass: `data.js` loaded zones/chokepoints/police but `search.js` never used them; location
scoring was exact-string only and `opts.locationAdjacency` was never populated (dead code). **Fixed:**
added `geo.js`, loaders for `Area_Boundaries.geojson` / `Special_Areas.csv` / CCTV, and wired
location-adjacency into `search()` + `validate.js`. Vague nearby landmarks now earn location credit.

### C. Landmark resolution (Phase 3) — now implemented ✅
`prompts.md` says resolve "near the big Nandi statue" → zone using Special_Areas / Area_Boundaries.
**Built:** `geo.resolveLocation()` + curated `Location_Coordinates.csv` back both location-adjacency
scoring and a CLI intake path `--resolve "<text>"` that prints the resolved area + nearest zone offline.
Example: `--resolve "near Ramkund"` → `Ramkund Ghat (curated)`, nearest zone Zone Area 30 (1708m).

### D. Police escalation — fully wired ✅
`escalationFlags()` is now called by `search()` and rendered by `format.js`. Child + unresolved +
health/disability flags all surface, and **every escalation message names the nearest police station**
with its distance (Phase 3 requirement). The **`dupReports` trafficking-sensitive trigger** is wired via
union-find grouping of the candidate pool (verified: 5 same-person records across centers → sensitive
warning, "do not discuss with the family").

### E. Mode B (IDENTIFY) — now implemented ✅
`--mode B` selects IDENTIFY mode; output is labeled `IDENTIFY RESULT` and the query is framed as a found
person → search the reports pool. Per the prompt's "same scoring config," weights are unchanged; the
found-person emphasis (state/clothing/age) is Claude's job online. The dataset is a single pool (no
separate found-vs-missing tables), so Mode B is a labeled symmetric mode — documented, not a separate
weight set.

### F. Duplicate detection scope — widened ✅
`findDuplicatePairs` now runs across the **candidate pool** (not just top-3), surfacing pairs involving
returned matches first (capped at 5). Same union-find grouping powers the Phase 3 trafficking trigger.

### G. `childAgeMax` config drift — minor 🟡
`escalationFlags` detects children via the `age_band` string `'0-12'`, not via `config.escalation.childAgeMax`
(12). Works today because bands are authoritative, but the config value is effectively unused for that
check — a drift risk if bands change. The new code now also honors `childAgeMax` for the `13-17` edge.

### H. No automated tests beyond `validate.js` 🟡
`validate.js` is the only harness. A few unit tests for `scoring.js` edge cases (blank name, adjacent age,
semantic pending) and `csv.js` quoting would protect regressions. Low priority for a hackathon.

### I. Stray `DESIGN.md` ⬜
Root `DESIGN.md` + `airbnb/DESIGN.md` are the Airbnb design-system reference, unrelated to Setu. Not a
code defect, but a Kumbh-specific UI token doc would help the frontend build referenced in `PLAN.html`.

---

## How the engine was improved this pass

1. **`engine/geo.js`** — haversine, fuzzy landmark→centroid, location-adjacency builder, curated-coords support.
2. **`engine/data.js`** — loaders for `Area_Boundaries.geojson`, `Special_Areas.csv`, `CCTV_Locations.csv`, `Location_Coordinates.csv`.
3. **`engine/search.js`** — location adjacency wired into scoring; `escalationFlags` now called and returned; added health/disability trigger; `childAgeMax` honored for 13-17 edge.
4. **`engine/hotspot.js`** — Mode C `hotspotSweep()`: clusters open cases near Traffic choke-points, risk-priority tie-break, nearest police station + trend.
5. **`engine/format.js`** — escalation flags rendered; `formatHotspot()` for the Mode C template.
6. **`engine/prompt.js`** — `buildHotspotPrompt()` for the Mode C payload.
7. **`engine/cli.js`** — `--now` + `--hotspot` flags; builds + injects location adjacency.
8. **`engine/validate.js`** — harness now uses location adjacency + curated coords (recall reflects the real pipeline).
9. **`data/Location_Coordinates.csv`** — curated coords for all 20 `last_seen_location` terms.
10. **`package.json`** — `npm run validate` / `demo` / `prompt` / `hotspot`.

Verified: `node engine/validate.js` → 91.7% top-3 / 80.3% #1 / 83.3% HIGH;
`node engine/cli.js --hotspot --now "2027-08-12 18:00"` → 277 open cases resolved, 5 ranked hotspots;
CLI search, `--prompt`, `--json`, `--hotspot --prompt` all run clean.

---

## Phase 2 / 3 completion (this pass)

Closed every remaining spec-vs-code gap from the audit:

1. **Mode B (IDENTIFY)** — `--mode B` flag → `IDENTIFY RESULT` label, found-person framing, same scoring
   config per the prompt (dataset is a single pool, so Mode B is a labeled symmetric mode).
2. **Duplicate scan widened** — `findDuplicatePairs` now runs on the candidate pool, not just top-3;
   pairs involving returned matches surface first (capped at 5).
3. **`dupReports` trafficking trigger** — `groupSamePerson()` union-finds the candidate pool; any group
   ≥ `config.escalation.dupReports` emits a sensitive warning (verified: 5 cross-center same-person
   records → "do not discuss with the family").
4. **Nearest police station in Mode A/B escalation** — every child/unresolved/health flag now names the
   nearest station + distance (e.g. "nearest: Panchavati Police station (646m)").
5. **Chokepoint-awareness annotation** — each returned match is annotated with the nearest high-risk
   chokepoint + `risk_level` + distance (e.g. "last seen near Chokepoint 'Panchavati / Ramkund access
   zone' (very high separation zone, 2m)").
6. **Landmark resolution at intake** — `--resolve "<text>"` prints the resolved area + nearest zone
   offline (e.g. "near Ramkund" → Ramkund Ghat, Zone Area 30).

Verified end-to-end: `validate.js` still 91.7% / 80.3% / 83.3% in ~1s; all new flags run clean; no
linter errors. Phase 1, 2, and 3 are now fully implemented in the deterministic engine.

---

## Recommended next builds (priority order)

1. **Unit tests** for `scoring.js` / `csv.js` / `hotspot.js` / `search.js` edge cases (blank name,
   adjacent age, semantic pending, dup grouping, chokepoint radius).
2. ~~**Setu UI `DESIGN.md`**~~ — ✅ done (`web/DESIGN.md`).
3. ~~**Frontend map**~~ — ✅ done (`web/src/components/OpsMap.jsx`): GeoJSON polygons, risk-colored
   chokepoints, hotspot heat-circles from `engine/hotspot.js`.
4. ~~**PWA console + CouchDB sync**~~ — ✅ scaffolded (`web/`): React+Vite PWA, PouchDB↔CouchDB
   replication, LlmBackend proxy, voice intake. See `web/DESIGN.md`.

---

## 5. Frontend & integrations (`web/`) — ✅ scaffolded this pass

| Item | Status | Notes |
|---|---|---|
| React + Vite PWA | ✅ | manifest + service worker (Workbox); build verified, OSM tiles cached |
| Engine wired into browser | ✅ | `engine/*` imported as-is (CJS via `build.commonjsOptions.include`); same JS as Node CLI |
| PouchDB store | ✅ | `kind=case\|config\|audit`; seeds 2,500 records on first run |
| PouchDB ↔ CouchDB sync | ✅ | `db.sync(remote,{live,retry})` multi-master; `VITE_COUCHDB_URL` |
| `LlmBackend` (`engine/llm.js`) | ✅ | `ClaudeBackend` + `LocalBackend` stub; config-driven; swappable per `config.llm.backend` |
| LLM server proxy | ✅ | `web/server/index.js` `/api/llm` (key stays server-side) + `/api/health` |
| Offline degradation | ✅ | LLM unreachable → `{pending:true}` → "semantic pending"; search never blocks |
| Leaflet ops map | ✅ | `Area_Boundaries.geojson` polygons, risk-colored chokepoints, police, open-case dots, hotspot heat-circles |
| Voice intake (STT) | ✅ | Whisper.cpp box (`/api/stt`) + Web Speech + typed fallback; contract in `web/DESIGN.md §5` |
| i18n EN/HI/MR | ✅ | `lib/i18n.js`; family-facing phrasing via Claude at explain-time |
| Two-button intake (Lost/Found) | ✅ | `components/Intake.jsx` + `Home.jsx` |
| Match results + explain | ✅ | `components/MatchResults.jsx`; "Explain with Claude" calls `/api/llm` |
| `web/DESIGN.md` | ✅ | sync, LLM, map, STT contracts + run instructions |
| Code-split map chunk | ⬜ | bundle ~253 KB gzip; acceptable, polish later |
| Point-in-polygon last-seen | ⬜ | currently nearest-centroid via `geo.resolveLocation` |
| Photo capture + purge / auth gate / audit UI | ⬜ | privacy surfaces, not yet built |
| Local-LLM adapter | ⬜ | swap `llm.backend` → `local`; `LocalBackend` stub in place |

### Other AI services (planned, via `config.llm.useFor`)
`transcribe · translate · structure · semanticDescription · explain · duplicateDetection` — all routed
through the same `LlmBackend`. STT is Whisper.cpp on the kendra box (offline) + Web Speech (online).
No separate STT/MT vendor; Claude does the language-heavy lifting now, local LLM later.
