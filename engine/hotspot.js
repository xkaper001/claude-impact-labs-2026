'use strict';
/**
 * KumbhRakshak Mode C — HOTSPOT sweep for the ICCC control room.
 *
 * Crowd-danger clustering: flag zones where OPEN missing-person cases
 * cluster near a Traffic choke-point, because co-location of separated
 * people at a chokepoint means a crush is forming before it is visible.
 *
 * Deterministic and config-driven (config.cluster + config.returnRules).
 * Never invents coordinates — every case is resolved to a real centroid
 * from Location_Coordinates / Special_Areas / Zone_Boundaries, and every
 * chokepoint coordinate comes straight from Chokepoints_Parking.csv.
 */

const S = require('./scoring');
const geo = require('./geo');

const OPEN_STATUSES = new Set(['pending', 'unresolved']);

/** nearest({lat,lng}, candidates) → { name, lat, lng, dist } by haversine. */
function nearest(point, candidates, nameKey) {
  let best = null;
  for (const c of candidates) {
    const d = geo.haversine([point.lng, point.lat], [Number(c.centroid_lng || c.longitude), Number(c.centroid_lat || c.latitude)]);
    if (!best || d < best.dist) best = { name: c[nameKey], lat: Number(c.centroid_lat || c.latitude), lng: Number(c.centroid_lng || c.longitude), dist: d };
  }
  return best;
}

function riskRank(risk, riskIndex) {
  return riskIndex[risk] == null ? 99 : riskIndex[risk];
}

function hoursAgo(reportedAt, now) {
  const t = S.parseTime(reportedAt);
  if (t == null) return null;
  const ref = now != null ? (typeof now === 'number' ? now : S.parseTime(now)) : null;
  if (ref == null) return null;
  return Math.round((ref - t) / 36e5);
}

/**
 * @param records        all missing-person records
 * @param zones          Zone_Boundaries rows (zone_name, centroid_lat, centroid_lng)
 * @param chokepoints    Chokepoints_Parking rows (location_name, category, risk_level, longitude, latitude)
 * @param policeStations Police_Stations rows (station_name, longitude, latitude)
 * @param config         config:scoring doc
 * @param opts           { now, specialAreas, locationCoords }
 * @returns hotspot sweep result (see shape below)
 */
function hotspotSweep(records, zones, chokepoints, policeStations, config, opts = {}) {
  const cluster = config.cluster || {};
  const radius = cluster.radiusMeters;
  const minOpen = cluster.minOpenCases;
  const trafficOnly = cluster.trafficChokepointsOnly !== false;
  const riskPriority = cluster.riskPriority || ['very high', 'high', 'medium'];
  const riskIndex = {};
  riskPriority.forEach((r, i) => { riskIndex[S.norm(r)] = i; });
  const trendHours = config.timeWindowHours;
  const topN = config.returnRules.topNHotspots;

  const areaIndex = geo.buildAreaIndex(opts.specialAreas || [], zones, opts.locationCoords || []);
  const zoneRows = zones.map((z) => ({
    name: z.zone_name,
    centroid_lat: Number(z.centroid_lat),
    centroid_lng: Number(z.centroid_lng),
  }));

  // 1. Open cases → coordinate → nearest zone.
  const openCases = records.filter((r) => OPEN_STATUSES.has(S.norm(r.status)));
  const resolved = [];
  let unassigned = 0;
  for (const r of openCases) {
    const hit = geo.resolveLocation(r.last_seen_location, areaIndex);
    if (!hit) { unassigned++; continue; }
    const z = nearest({ lat: hit.lat, lng: hit.lng }, zoneRows, 'name');
    resolved.push({ record: r, lat: hit.lat, lng: hit.lng, zone: z ? z.name : null });
  }

  // 2. Chokepoints (Traffic only when configured).
  const chokes = chokepoints
    .filter((c) => !trafficOnly || S.norm(c.category) === 'traffic choke point')
    .map((c) => ({
      name: c.location_name,
      risk: S.norm(c.risk_level),
      lat: Number(c.latitude),
      lng: Number(c.longitude),
    }));

  // 3. Cluster open cases within radius of each chokepoint.
  const candidates = [];
  for (const ch of chokes) {
    const near = resolved.filter((c) => geo.haversine([c.lng, c.lat], [ch.lng, ch.lat]) <= radius);
    if (near.length < minOpen) continue;
    const z = nearest({ lat: ch.lat, lng: ch.lng }, zoneRows, 'name');
    candidates.push({
      zone: z ? z.name : null,
      chokepoint: ch.name,
      risk: ch.risk,
      count: near.length,
      cases: near,
      chokeLat: ch.lat,
      chokeLng: ch.lng,
    });
  }

  // 4. Keep the strongest cluster per zone (count, then risk).
  const byZone = {};
  for (const cand of candidates) {
    if (!cand.zone) continue;
    const ex = byZone[cand.zone];
    const better = !ex
      || cand.count > ex.count
      || (cand.count === ex.count && riskRank(cand.risk, riskIndex) < riskRank(ex.risk, riskIndex));
    if (better) byZone[cand.zone] = cand;
  }

  // 5. Rank: case count desc → risk priority → zone name. Top N.
  const ranked = Object.values(byZone)
    .sort((a, b) =>
      b.count - a.count ||
      riskRank(a.risk, riskIndex) - riskRank(b.risk, riskIndex) ||
      String(a.zone).localeCompare(String(b.zone)))
    .slice(0, topN);

  // 6. Enrich: distance zone→chokepoint, nearest police station, recent trend.
  const hotspots = ranked.map((h) => {
    const zc = zoneRows.find((z) => z.name === h.zone);
    const distanceM = zc ? Math.round(geo.haversine([zc.centroid_lng, zc.centroid_lat], [h.chokeLng, h.chokeLat])) : null;
    const police = zc
      ? nearest({ lat: zc.centroid_lat, lng: zc.centroid_lng },
        policeStations.map((p) => ({ station_name: p.station_name, longitude: p.longitude, latitude: p.latitude })),
        'station_name')
      : null;
    const recent = h.cases.filter((c) => {
      const hrs = hoursAgo(c.record.reported_at, opts.now);
      return hrs != null && hrs >= 0 && hrs <= trendHours;
    }).length;
    return {
      zone: h.zone,
      openCases: h.count,
      distanceM,
      chokepoint: h.chokepoint,
      riskLevel: h.risk,
      recentCases: recent,
      trendWindowHours: trendHours,
      nearestPoliceStation: police ? police.name : null,
      policeDistanceM: police ? Math.round(police.dist) : null,
      caseIds: h.cases.map((c) => c.record.case_id),
    };
  });

  return {
    mode: 'C',
    openCases: openCases.length,
    resolvedCases: resolved.length,
    unassignedCases: unassigned,
    clustersConsidered: candidates.length,
    hotspots,
    config: { radiusMeters: radius, minOpenCases: minOpen, trafficChokepointsOnly: trafficOnly, topNHotspots: topN },
  };
}

module.exports = { hotspotSweep, OPEN_STATUSES };
