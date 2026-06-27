# Setu — Frontend & Integration Design

This documents the **PWA console** (`web/`) and how it ties the deterministic
`engine/` to PouchDB/CouchDB, the LLM backend, the Leaflet/OpenStreetMap ops
map, and offline speech-to-text. The deterministic brain is shared verbatim
between the Node CLI and the browser — one brain, two runtimes.

## 1. Architecture

```
React + Vite PWA  (service worker caches the whole bundle + OSM tiles)
  ├─ PouchDB (browser) ──live replicate──▶ CouchDB (kendra box, docker)
  │      docs: kind=case | kind=config | kind=audit
  ├─ engine/  (imported as-is: scoring/search/hotspot/geo/csv/prompt)
  ├─ LlmBackend  (engine/llm.js) ── called by server proxy, never the browser
  │      └─ ClaudeBackend (claude-opus-4-8)  +  LocalBackend (stub)
  ├─ Voice intake — Whisper.cpp box (offline) / Web Speech (online) / typed
  └─ Leaflet + OSM
        ├─ Area_Boundaries.geojson polygons (32 zones + 21 special areas)
        ├─ chokepoints sized/colored by risk_level
        ├─ police stations, open-case markers (geo-resolved)
        └─ hotspot heat-circles fed by engine/hotspot.js
```

## 2. Sync — PouchDB ↔ CouchDB (multi-master, offline-first)

- Each console is a PWA backed by **PouchDB** in the browser. Works fully with
  zero signal.
- When `VITE_COUCHDB_URL` is set, `db.startSync()` runs `db.sync(remote,
  {live:true, retry:true})` — bidirectional, revision-based, conflict handling
  built in. **No hand-rolled sync layer.**
- The 2-tab "two centers" demo is CouchDB's native multi-master mode: point two
  consoles at two PouchDB instances replicating to the same CouchDB, or to two
  CouchDB instances replicating peer-to-peer.
- Doc model (single DB, typed by `kind`):
  - `case:<id>` — a missing/found record (engine row shape + `center` + `createdAt`)
  - `config:scoring` — the single scoring-config doc (replicated to every console)
  - `audit:<ts>-<rand>` — append-only audit events (create / match / explain / escalate)
- **Seed:** on first run `seedIfEmpty()` loads the bundled 2,500-record dataset
  (+ zones, chokepoints, police, special areas, location coords, GeoJSON) into
  PouchDB so the console is fully functional before any replication.

## 3. LLM backend — Claude now, local later, swappable

- `engine/llm.js` defines the `LlmBackend` contract with two adapters:
  `ClaudeBackend` (calls Anthropic; needs `ANTHROPIC_API_KEY`) and
  `LocalBackend` (stub for a future on-box LLM — drop in a localhost fetch).
- The **browser never holds the API key.** It assembles the prompt with
  `engine/prompt.js` (via `lib/engine.js buildPromptForClaude`) and POSTs it to
  `/api/llm`; the Express proxy (`web/server/index.js`) runs `complete()` with
  the config doc and key.
- `config-scoring.json` drives it: `llm.backend`, `llm.model`,
  `llm.useFor = [transcribe, translate, structure, semanticDescription,
  explain, duplicateDetection]`, `llm.languages = [en, hi, mr]`.
- **Offline degradation:** if the proxy is unreachable, `complete()` returns
  `{pending:true}`; the UI shows "semantic pending" and the deterministic
  engine still returns a ranked result. **Search never blocks on the LLM.**
- One source of truth: the same `config:scoring` doc feeds the rules engine
  (offline) and the prompt (online) — no drift.

## 4. Ops map — Leaflet + OpenStreetMap (`components/OpsMap.jsx`)

- Base: OSM raster tiles (cached via Workbox `runtimeCaching` so the map still
  pans at zero signal).
- **Zone + special-area polygons** rendered from `Area_Boundaries.geojson`
  (53 shapes): zones in blue, ghats/transit hubs in amber.
- **Chokepoints** sized + colored by `risk_level` (very high = red 11px → low =
  grey 4px); click popup shows category + risk.
- **Police stations** as markers.
- **Open-case dots** geo-resolved via `engine/geo.resolveLocation` +
  `Location_Coordinates.csv` (handles vague "last seen near Ramkund").
- **Hotspot heat-circles** driven by `engine/hotspot.js` output
  (`hotspots[]`): radius scales with case count, color by chokepoint risk,
  popup shows case count + nearest chokepoint. The map↔engine contract is the
  `runHotspot()` return shape.

## 5. STT — offline-first voice intake

Three paths, auto-chosen, always degrading to typed input (the cut-order
fallback from `prompts.md`):

1. **Whisper.cpp box (kendra LAN) — production offline path.** A small
   Whisper.cpp server runs on the kendra box on the local network. The console
   records a Blob (`lib/voice.js recordAudio`) and POSTs it to `/api/stt`; the
   proxy forwards to `${WHISPER_BOX_URL}/inference`. Works offline because the
   box is on LAN. **Box contract:**
   - `POST /inference` multipart `audio` (webm/wav) + optional `language`
   - Response: `{ "text": "<transcript>" }`
   - Model: `whisper.cpp` small/base multilingual; runs CPU on the box.
2. **Web Speech API — online convenience fallback.** Browser-native on
   Chrome/Edge (`lib/voice.js webSpeechListen`); used only when the box is
   unreachable and signal is up. Not relied upon offline.
3. **Typed input** — always available.

After transcription, Claude (online) translates + structures the free text into
the record fields (`config.llm.useFor` = transcribe → translate → structure).
Offline, the operator types and the engine scores as-is.

## 6. Languages

UI strings: EN / HI / MR (`lib/i18n.js`). Family-facing phrasing is generated
by Claude in the family's language at explain-time (`config.llm.languages`).

## 7. Running

```bash
cd web
cp .env.example .env            # set ANTHROPIC_API_KEY, WHISPER_BOX_URL, COUCHDB_URL
npm install
npm start                       # vite (5173) + API proxy (8787), concurrently
# production:
npm run build && npm run server # serve dist/ + proxy behind one origin
```

CouchDB for the sync demo:

```bash
docker run -d -p 5984:5984 -e COUCHDB_USER=admin -e COUCHDB_PASSWORD=admin couchdb:3
# then set VITE_COUCHDB_URL=http://admin:admin@localhost:5984 in web/.env
```

## 8. Status & next steps

- ✅ Scaffold: Vite + React PWA, service worker, manifest, EN/HI/MR.
- ✅ Engine wired into the browser (build verified; same JS as Node CLI).
- ✅ PouchDB store + CouchDB replication + seed + audit.
- ✅ LlmBackend (Claude + Local stub) + server proxy + offline degradation.
- ✅ Leaflet ops map: polygons, risk-colored chokepoints, hotspot heat-circles.
- ✅ Voice intake (Whisper box + Web Speech + typed) + STT contract.
- ⬜ Code-split the map chunk (bundle is ~253 KB gzip; acceptable, polish later).
- ⬜ Point-in-polygon for vague last-seen (currently nearest-centroid).
- ⬜ Photo capture + ephemeral purge, auth gate, audit-log UI.
- ⬜ Local-LLM adapter (swap `llm.backend` → `local`).
