// Browser bridge to the deterministic engine. The engine is plain CommonJS
// (../engine/*) — Vite pre-bundles it so the SAME scoring / search / hotspot
// code the Node CLI uses runs in the PWA. Data + prompts + config are inlined
// at build time (?raw / ?json) so the engine works with zero signal; live data
// arrives via PouchDB (see db.js) and overrides the seed on first sync.

// Default imports + runtime destructure: the engine is CommonJS; Vite's
// optimizer (via the @engine alias) pre-bundles it to ESM with both default
// and named exports. Same code, same runtime as the Node CLI.
import csvMod from '@engine/csv.js';
import searchMod from '@engine/search.js';
import hotspotMod from '@engine/hotspot.js';
import geoMod from '@engine/geo.js';
import promptMod from '@engine/prompt.js';

const { parseCSV } = csvMod;
const { search, preFilter } = searchMod;
const { hotspotSweep } = hotspotMod;
const geo = geoMod;
const { buildPrompt, buildHotspotPrompt } = promptMod;
// Build-time inlines (kept fresh with the repo; overridden by PouchDB at runtime).
import recordsCsv from '../../../claude-impact-labs-data/claude-impact-lab-mumbai-2026/data/Synthetic_Missing_Persons_2500.csv?raw';
import zonesCsv from '../../../claude-impact-labs-data/claude-impact-lab-mumbai-2026/data/Zone_Boundaries.csv?raw';
import chokepointsCsv from '../../../claude-impact-labs-data/claude-impact-lab-mumbai-2026/data/Chokepoints_Parking.csv?raw';
import policeCsv from '../../../claude-impact-labs-data/claude-impact-lab-mumbai-2026/data/Police_Stations.csv?raw';
import specialAreasCsv from '../../../claude-impact-labs-data/claude-impact-lab-mumbai-2026/data/Special_Areas.csv?raw';
import locationCoordsCsv from '../../../claude-impact-labs-data/claude-impact-lab-mumbai-2026/data/Location_Coordinates.csv?raw';
import areaBoundariesGeojson from '../../../claude-impact-labs-data/claude-impact-lab-mumbai-2026/data/Area_Boundaries.geojson?raw';
import configScoring from '../../../config-scoring.json';
import promptsMd from '../../../prompts.md?raw';

export const seedData = {
  records: parseCSV(recordsCsv),
  zones: parseCSV(zonesCsv),
  chokepoints: parseCSV(chokepointsCsv),
  policeStations: parseCSV(policeCsv),
  specialAreas: parseCSV(specialAreasCsv),
  locationCoords: parseCSV(locationCoordsCsv),
  areaBoundaries: JSON.parse(areaBoundariesGeojson),
};

export const config = configScoring;
export const promptsText = promptsMd;

/** Build the geo options the engine expects, from whichever dataset is active
 *  (seed, or PouchDB-loaded). Memoised per dataset identity. */
export function buildGeoOpts(data) {
  const areaIndex = geo.buildAreaIndex(data.specialAreas, data.zones, data.locationCoords);
  const vocab = [...new Set(data.records.map((r) => r.last_seen_location).filter(Boolean))];
  return {
    areaIndex,
    locationAdjacency: geo.buildLocationAdjacency(vocab, areaIndex),
    chokepoints: data.chokepoints,
    policeStations: data.policeStations,
  };
}

export function runSearch(query, data, opts = {}) {
  const geoOpts = buildGeoOpts(data);
  return search(query, data.records, config, {
    mode: (opts.mode || 'A').toUpperCase(),
    semantic: opts.semantic || 'pending',
    now: opts.now,
    ...geoOpts,
  });
}

export function runHotspot(data, opts = {}) {
  return hotspotSweep(data.records, data.zones, data.chokepoints, data.policeStations, config, {
    now: opts.now,
    specialAreas: data.specialAreas,
    locationCoords: data.locationCoords,
  });
}

export function runResolve(text, data) {
  const areaIndex = geo.buildAreaIndex(data.specialAreas, data.zones, data.locationCoords);
  return geo.resolveLocation(text, areaIndex);
}

/** Assemble the Phase-n prompt for the LLM proxy. The proxy (server) runs the
 *  LlmBackend; the browser never sees the API key. */
export function buildPromptForClaude(query, data, opts = {}) {
  const geoOpts = buildGeoOpts(data);
  const candidates = preFilter(query, data.records, config, geoOpts);
  return buildPrompt(candidates, config, { phase: opts.phase || 2, md: promptsMd });
}

export function buildHotspotPromptForClaude(data, opts = {}) {
  const openCases = data.records.filter((r) =>
    ['pending', 'unresolved'].includes(String(r.status || '').toLowerCase()),
  );
  return buildHotspotPrompt(openCases, data.zones, data.chokepoints, runHotspot(data, opts).hotspots, config, {
    phase: opts.phase || 2,
    md: promptsMd,
  });
}

export { geo };
