# Setu — सेतु

**A bridge between every lost-and-found center at the Kumbh Mela.**

Built for the Claude Impact Lab, Mumbai 2026 · Problem: missing persons at the Nashik–Trimbakeshwar
Simhastha Kumbh Mela 2027 (80M+ pilgrims).

---

## The problem we fix

At Kumbh scale, thousands are separated from their families every day — mostly **elderly, rural,
multilingual pilgrims, many with no phone**. The current system relies on manual lost-and-found
centers (*Kho-Ya-Paya kendras*) with **no cross-search between them**: a person found and registered
at Center A is invisible to a family searching at Center B.

**Setu closes that gap.** It is one shared, searchable registry across all centers, with a tolerant
matcher that works on incomplete data, in 11+ languages, and **fully offline**.

### Three truths that shape the design

1. **The missing person usually cannot help themselves.** The largest group is the 61–70 age band;
   records say *"cannot remember name," "hard of hearing," "keeps asking for Ramkund."* They won't
   pull out a phone — many never owned one. A pilgrim-facing app helps almost no one who is actually lost.
2. **The family searching is panicked, often non-literate, speaks another language.** They go
   counter-to-counter on foot describing a person in their own tongue.
3. **The infrastructure that exists is human, not digital.** So Setu runs on the **volunteer at the
   desk**, not the pilgrim's device — and survives with no signal.

---

## What we're building

An **operator-mediated** tool: a trained volunteer uses it while face-to-face with a distressed
family or a found person. Three surfaces, one core.

| Surface | What it does |
|---|---|
| **① Volunteer Console** | Tablet/laptop PWA at every kendra. Two buttons: *I lost someone / I found someone.* Voice-first intake in the family's language, auto-transcribed and translated. |
| **② Match Engine** | Scores every new record against the opposite pool (lost ↔ found) across **all** centers. Tolerant of blank names, phonetic spelling, 11+ languages. Returns a ranked shortlist with plain-language reasons. |
| **③ Ops Map (ICCC)** | Leaflet map over the 32 zones — open cases, CCTV coverage, chokepoints, nearest police. Where cases cluster near a traffic chokepoint = crowd danger forming. The government control-room integration pitch. |

**The machine never auto-reunites.** It ranks; a trained volunteer verifies and decides. Safer, and
the right privacy posture.

### Reunion flow

```
Family reports (voice, any language)
   → Volunteer console (structured record)
      → Match engine (scores all "found" across centers)
         → Shortlist + reasons (shown to both desks)
            → Human confirms → reunion / route to police
```

---

## Decisions — locked

| Decision | Choice |
|---|---|
| **Storage + sync** | **CouchDB + PouchDB** — real multi-master replication. The 2-tab "two centers" demo is the DB's native mode. |
| **AI backend** | **Claude now**, behind a swappable `LlmBackend` interface. **Local LLM later** drops into the same interface for fully on-box, no-internet operation. |
| **Scoring config** | **Fully configurable** — every weight, threshold, cluster and escalation rule lives in one `config:scoring` doc in CouchDB, replicated to every console. No hard-coded numbers. |
| **Offline behavior** | **Rules engine** scores offline from config; Claude adds semantic + translation when online. Search never blocks. |
| **Languages** | **English · Hindi · Marathi** (UI strings + Claude translation). |
| **Demo** | **Live on stage** — 3 scenarios; 90-second recorded backup if wifi fails. |

---

## Architecture

```
Console PWA (React + PouchDB)  ↔  CouchDB (kendra box, multi-master sync)
                                      ↓
                            Rules engine (JS · config-driven · offline)
                                      ↓
                            LlmBackend (Claude now · local LLM later)
```

- **PouchDB / CouchDB** give offline-first replication for free. Pull the network cable → consoles
  keep working → that *is* the offline proof. Nothing in the cloud = PII never leaves the box.
- **Config-driven rules engine** does deterministic scoring on-device, always available. Reads the
  same `config:scoring` doc that the LLM prompt reads, so offline and online never drift.
- **LlmBackend** is a swappable interface. Claude does the language-heavy lifting now
  (transcribe → translate → structure → semantic description match → explain a match). Swap
  `"backend": "claude"` → `"local"` in the config and nothing else changes.

### Why this stack wins
Boring = deployable. No GPU, no model training (the data is for testing the pipeline, not training).
Runs on one kendra laptop. Maps onto the kendras and volunteers that already exist — no new hardware
for pilgrims.

---

## System design — offline & messy by default

- **Offline-first:** every console is a PWA backed by PouchDB; it works with zero signal. PouchDB ↔
  CouchDB replicate continuously with revision-based conflict handling — no hand-rolled sync layer.
  Total-blackout fallback: printed QR "case cards" a runner carries between kendras.
- **Messy / incomplete data:** ~15% of records have no name, ~20% no mobile — the matcher
  **down-weights, never blocks**. Free-text descriptions are normalized into structured tags at
  intake. Language is a signal, not a barrier (store original + English, match across both).
- **Duplicate-aware:** ~8% of records are the same person across centers; Setu detects and flags
  them rather than double-counting.
- **Holds under load:** pre-filter in PouchDB (zone + gender + age) to ≤40 candidates before the LLM
  → search returns in < 3s even under a 4–5× snan-day spike.

---

## Confidence scoring

Built from the `config:scoring` doc (see `config-scoring.json`). Default weights:

| Component | Points |
|---|---|
| Age band (exact or adjacent) | +25 |
| Gender | +20 |
| State of origin | +20 |
| Physical description (semantic overlap) | up to +20 |
| Last seen same/adjacent zone | +10 |
| Time window (within 6h) | +5 |
| Name (exact +10 / phonetic +5) | +10 |

Total is capped at 100. **HIGH ≥ 75 · MEDIUM ≥ 50 · LOW ≥ 30 · below 30 = not returned.** Every
score is shown with a per-field breakdown so the volunteer understands why. All values are tunable
live in CouchDB without a redeploy.

---

## Privacy by design

- **Minimal collection** — only what helps reunite. No Aadhaar, PAN, voter ID, caste, or permanent
  biometric store.
- **Found-person photos are ephemeral** — used for the match window, auto-purged on reunion or after
  the mela. Never published to a public wall.
- **No public search** — only authenticated volunteers query; families get results through a person,
  removing the trafficking/scam risk of an open lost-children database.
- **Human in the loop on every reunion** — the model proposes, a volunteer + ID check confirms before
  handover. Never an automated custody decision.
- **Audit & scope** — every record logs who created/accessed it; data scoped to the event, deleted
  after. Synthetic-only in the demo; zero real PII.

---

## Data

Provided synthetic dataset (`claude-impact-labs-data/claude-impact-lab-mumbai-2026/data/`). All missing-person records are fake. Geography is real (Kumbhathon Innovation Foundation).

| File | Rows | Use |
|---|---|---|
| `Synthetic_Missing_Persons_2500.csv` | 2,500 | the registry — messy, realistic reports |
| `Area_Boundaries.geojson` | 53 polygons | 32 zone polygons + 21 ghat/transit sub-areas — map overlays & landmark→zone resolution |
| `Zone_Boundaries.csv` | 32 | zone centroids + polygon-derived metadata for spatial scoring |
| `Special_Areas.csv` | 21 | ghats / kunds / transit hubs — resolve "near Ramkund" to a zone |
| `Location_Coordinates.csv` | 20 | curated coords for every `last_seen_location` term |
| `Chokepoints_Parking.csv` | 85 | 26 traffic chokepoints + transfer nodes + parking; **risk_level** (very high/high/medium), status, source, note |
| `CCTV_Locations.csv` | 1,280 | coverage map across 32 zones |
| `Police_Stations.csv` | 14 | routing / escalation |

---

## Repo

| File | What |
|---|---|
| `PLAN.html` | Interactive pitch & build plan (open in a browser) |
| `progress.md` | Build status — what's done ✅, partial 🟡, planned ⬜ |
| `config-scoring.json` | The CouchDB `config:scoring` doc — all tunable AI behavior |
| `prompts.md` | All system prompts, phased and config-driven (P1 → P2 → P3) |
| `engine/` | The deterministic core — runs today (see below) |
| `web/` | PWA console — React+Vite, PouchDB↔CouchDB, Leaflet ops map, LlmBackend proxy (`web/DESIGN.md`) |
| `README.md` | This file |

### Built today — the deterministic core (`engine/`)

Zero-dependency JS rules engine + Claude prompt builder. Same code runs in Node (CLI) and in the browser under PouchDB. **Validated**, not slideware:

```bash
npm run validate   # planted-twin accuracy harness
npm run demo       # Mode A/B cross-center search
npm run hotspot    # Mode C ICCC hotspot sweep
npm run prompt     # emit the Claude prompt with candidates+config injected
```

- **Mode A/B matcher** — config-driven scoring, honest per-field breakdown, pre-filter to ≤40 candidates. Mode B (`--mode B`) is the IDENTIFY variant. Planted-twin harness: **91.7% cross-center recall (top-3), 80.3% #1, 83.3% at HIGH band** — fully offline, family-known fields only.
- **Mode C hotspot** — clusters open cases near Traffic choke-points; ranks by case count then `risk_level` (very high > high > medium); names the nearest police station. 277/277 open cases geo-resolve to a real zone.
- **Phase 3 guardrails** — chokepoint-awareness annotation on every match, nearest-police-station in escalation messages, `dupReports` trafficking-sensitive trigger (union-find over the candidate pool), and offline landmark resolution (`--resolve "near Ramkund"` → zone).
- **Landmark resolution** — `geo.js` + curated coords resolve every `last_seen_location` to a real point and feed adjacent-zone scoring.

What's **planned** (see `progress.md`): code-split the map chunk, point-in-polygon last-seen, photo capture + purge, auth gate, and the local-LLM adapter. The PWA console, CouchDB sync, Leaflet ops map, and LlmBackend are **scaffolded in `web/`** (build-verified).

---

## Running the demo

**A. Run the engine now (zero setup, no network):**
```bash
npm run validate                                      # accuracy harness
npm run demo                                          # Mode A/B search
npm run hotspot                                       # Mode C ICCC sweep
node engine/cli.js --mode B ...                       # Mode B IDENTIFY
node engine/cli.js --resolve "near Ramkund"           # offline landmark → zone
node engine/cli.js --hotspot --now "2027-08-12 18:00" # → top danger zones
```
The engine is the validated core — scoring, dedup/re-report flags, escalation, and Mode C all run offline from `config-scoring.json`.

**B. Full sync demo (Phase-2 frontend build — now scaffolded in `web/`):**
```bash
cd web && cp .env.example .env     # set ANTHROPIC_API_KEY, WHISPER_BOX_URL, COUCHDB_URL
npm install && npm start           # Vite (5173) + API proxy (8787)
# CouchDB for the 2-center sync:
docker run -d -p 5984:5984 -e COUCHDB_USER=admin -e COUCHDB_PASSWORD=admin couchdb:3
```
The console is a React+Vite **PWA**: PouchDB in the browser ↔ CouchDB multi-master
replication, the **same `engine/`** scoring/hotspot code running in-browser, a
Leaflet/OpenStreetMap ops map (`Area_Boundaries.geojson` polygons, risk-colored
chokepoints, hotspot heat-circles), and voice intake (Whisper.cpp box offline +
Web Speech online + typed fallback). The `LlmBackend` (`engine/llm.js`,
Claude now / local later) is called via a server proxy so the API key never
reaches the browser; offline, the rules engine still scores and the UI shows
"semantic pending". Full design + contracts: **`web/DESIGN.md`**.

1. Start the sync hub (local, offline-capable):
```bash
docker run -d -p 5984:5984 -e COUCHDB_USER=admin -e COUCHDB_PASSWORD=admin couchdb:3
```
2. Seed the config + data into CouchDB (load `config-scoring.json` as a doc; import the CSVs).
3. Run the console (two named databases — `center1`, `center2` — both replicating to
   `http://localhost:5984`) so the demo shows the real cross-center gap closing, not two tabs sharing
   one store.
4. Demo offline: pull the network cable → consoles keep scoring (rules engine) → re-enable → records
   converge across both centers. That is the offline + sync proof.

### Three demo scenarios

1. **Cross-center reunion (headline).** Family at Ramkund describes a *bujurg* in a white kurta, no
   name, no phone. Setu surfaces the unknown male logged at Adgaon, 4km away — 91% HIGH. *"Two
   centers that would never have connected today."*
2. **Offline + dedup.** Network OFF, log a found child at Center 1. Family already reported the same
   child at Center 7. Re-enable → sync → Setu flags the duplicate/re-report and auto-escalates (child
   < 12, > 2h) with the nearest police station. *"Messy, offline, duplicated — handled."*
3. **Hotspot sweep (ICCC).** Run spike load → Setu returns top danger zones, ranked by case count
   then chokepoint risk: *"🔺 Zone Area 31 — 14 open cases, 167m from Mumbai Naka (high) → nearest
   help Mumbai naka PS (194m)."* *"Same data predicts the crush — plugs into the government control
   room."*

Order on stage: **1 (emotional hook) → 2 (technical credibility) → 3 (scale / government vision).**

---

## Judging criteria → how Setu wins

| Criterion | How |
|---|---|
| **Deployability** | CouchDB + PouchDB PWA + Claude. Runs on one kendra box; consoles sync peer-to-peer. No new pilgrim hardware. LLM swaps Claude→local for fully offline ops. |
| **Real-world fit** | Targets the exact named failure — no cross-center search. Designed around the actual missing person (elderly, phoneless), not an idealized app user. |
| **UX** | Operator-mediated, so phoneless / non-literate elders are served by a human. Voice-in, multilingual, big-type, two-button, icon-led. |
| **System design** | Offline-first multi-master sync + QR fallback. Config-driven scoring (no drift). Tolerant of 15% no-name / 20% no-mobile; dedups the 8%. Holds < 3s under 5× spike. |
| **Responsible data** | Minimal collection, no public wall, ephemeral photos, human-confirmed reunions, full audit, synthetic-only demo. Privacy baked into the architecture. |

---

*Claude Impact Lab, Mumbai 2026 · RIIDL, Somaiya Vidyavihar University. In partnership with the
Kumbhathon Innovation Foundation and the Government of Maharashtra. All missing-person data is
synthetic.*
