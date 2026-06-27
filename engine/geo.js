'use strict';
/**
 * Geography helpers: haversine distance, fuzzy landmark → centroid
 * resolution, and location-adjacency built from Special_Areas + zone
 * centroids. Lets the scoring engine give location credit when the
 * family's "last seen" and the record's differ but are physically near
 * (e.g. "Ramkund Ghat" vs "Panchavati Circle"), instead of only on
 * exact string equality.
 *
 * Pure JS so the same code runs in Node and in the browser (PouchDB).
 */

const RADIUS_M = 6371000; // Earth radius in metres

/** Great-circle distance in metres between two [lng, lat] points. */
function haversine(a, b) {
  const toRad = (d) => (d * Math.PI) / 180;
  const [lng1, lat1] = a;
  const [lng2, lat2] = b;
  const dLat = toRad(lat2 - lat1);
  const dLng = toRad(lng2 - lng1);
  const s1 = Math.sin(dLat / 2);
  const s2 = Math.sin(dLng / 2);
  const h = s1 * s1 + Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * s2 * s2;
  return 2 * RADIUS_M * Math.asin(Math.sqrt(h));
}

function norm(s) {
  return String(s == null ? '' : s).trim().toLowerCase();
}

/** Coarse token set for fuzzy name matching. */
function tokens(s) {
  return new Set(
    norm(s)
      .replace(/[^a-z0-9\s]/g, ' ')
      .split(/\s+/)
      .filter((t) => t.length > 2 || ['kund', 'ghat'].includes(t)),
  );
}

/** Resolve a free-text location to the closest known area centroid.
 *  Returns { name, lat, lng, source, score } or null. Matches on
 *  substring + token overlap; falls back to nearest by distance only
 *  when a token match exists. Never invents coordinates. */
function resolveLocation(rawName, areas) {
  const q = norm(rawName);
  if (!q) return null;
  const qt = tokens(q);

  let best = null;
  for (const area of areas) {
    const aName = norm(area.name);
    if (!aName) continue;
    const at = tokens(aName);
    // Exact / substring match wins outright.
    if (q === aName || aName.includes(q) || q.includes(aName)) {
      return {
        name: area.name,
        lat: area.centroid_lat,
        lng: area.centroid_lng,
        source: area.area_type,
        score: 1,
      };
    }
    let overlap = 0;
    for (const t of qt) if (at.has(t)) overlap++;
    if (overlap === 0) continue;
    const score = overlap / Math.max(qt.size, at.size);
    if (!best || score > best.score) {
      best = {
        name: area.name,
        lat: area.centroid_lat,
        lng: area.centroid_lng,
        source: area.area_type,
        score,
      };
    }
  }
  return best && best.score >= 0.34 ? best : null;
}

/** Build a centroid index from curated location coords + Special_Areas +
 *  Zone_Boundaries rows. Curated coords are matched first (exact name), so
 *  every vocabulary term in the dataset resolves to a real coordinate. */
function buildAreaIndex(specialAreas, zones, locationCoords) {
  const areas = [];
  for (const r of locationCoords || []) {
    areas.push({
      name: r.location_name,
      area_type: 'curated',
      subtype: 'curated',
      centroid_lat: Number(r.latitude),
      centroid_lng: Number(r.longitude),
    });
  }
  for (const r of specialAreas || []) {
    areas.push({
      name: r.area_name,
      area_type: 'special_area',
      subtype: r.subtype,
      centroid_lat: Number(r.centroid_lat),
      centroid_lng: Number(r.centroid_lng),
    });
  }
  for (const r of zones || []) {
    areas.push({
      name: r.zone_name,
      area_type: 'cctv_zone',
      subtype: 'cctv_zone',
      centroid_lat: Number(r.centroid_lat),
      centroid_lng: Number(r.centroid_lng),
    });
  }
  return areas;
}

/** Build the location-adjacency map the scoring engine expects:
 *  { <normalisedLoc>: [<normalisedLoc>, ...] } for every vocabulary
 *  term that resolves to a centroid, where "adjacent" = within
 *  `radiusMeters` (default 1200m, ~ a walkable zone-to-zone hop).
 *  Includes self so same-location still resolves through the same path. */
function buildLocationAdjacency(vocabulary, areas, radiusMeters = 1200) {
  const resolved = {};
  for (const loc of vocabulary) {
    const hit = resolveLocation(loc, areas);
    if (hit) resolved[norm(loc)] = { loc, lat: hit.lat, lng: hit.lng };
  }
  const adj = {};
  const keys = Object.keys(resolved);
  for (const k of keys) {
    adj[k] = [];
    const a = resolved[k];
    for (const other of keys) {
      if (other === k) continue;
      const b = resolved[other];
      if (haversine([a.lng, a.lat], [b.lng, b.lat]) <= radiusMeters) {
        adj[k].push(other);
      }
    }
  }
  return adj;
}

module.exports = {
  haversine,
  resolveLocation,
  buildAreaIndex,
  buildLocationAdjacency,
  norm,
};
