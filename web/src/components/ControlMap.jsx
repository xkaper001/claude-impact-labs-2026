import React, { useEffect, useMemo, useRef, useImperativeHandle, forwardRef } from 'react';
import L from 'leaflet';
import { runHotspot, buildGeoOpts, geo } from '../lib/engine.js';

const RISK_COLOR = { 'very high': '#ff4d5a', high: '#ff8a3d', medium: '#e6bb3f', low: '#7a8499' };
const SPECIAL_COLOR = '#ff8a3d';
const ZONE_COLOR = '#3a6df0';
const OPEN_CASE = '#ff5a6e';
const ZONE_STYLE = { color: ZONE_COLOR, weight: 1, fillColor: ZONE_COLOR, fillOpacity: 0.04 };
const BAND_COLOR = { high: '#34d399', medium: '#e6bb3f', low: '#7a8499' };
const POLICE_BLUE = '#2b6fd6';
const FOCUS_BLUE = '#5b97ff';

const DEFAULT_CENTER = [19.997, 73.79];
const DEFAULT_ZOOM = 13;

/* ---------------- inline-SVG divIcons (offline-safe, no image assets) ---------------- */

function policeIcon() {
  return L.divIcon({
    className: 'micon-wrap',
    html: `<div class="micon police"><svg viewBox="0 0 24 24" width="28" height="28">
      <path d="M12 2l8 3v6c0 5-3.4 8.4-8 11-4.6-2.6-8-6-8-11V5l8-3z" fill="${POLICE_BLUE}" stroke="#04101f" stroke-width="1.3"/>
      <path d="M12 6.4l1.4 2.9 3.1.45-2.25 2.2.53 3.1L12 13.7l-2.78 1.45.53-3.1-2.25-2.2 3.1-.45z" fill="#fff"/></svg></div>`,
    iconSize: [28, 30], iconAnchor: [14, 28], popupAnchor: [0, -26],
  });
}

function chokeIcon(color, size = 26) {
  return L.divIcon({
    className: 'micon-wrap',
    html: `<div class="micon choke" style="--c:${color}"><svg viewBox="0 0 24 24" width="${size}" height="${size}">
      <path d="M12 3 1.8 18a2 2 0 0 0 1.7 3h17a2 2 0 0 0 1.7-3L13.7 3a2 2 0 0 0-3.4 0z" fill="${color}" stroke="#04101f" stroke-width="1.2"/>
      <path d="M12 9.4v4" stroke="#04101f" stroke-width="2" stroke-linecap="round"/>
      <circle cx="12" cy="16.6" r="1.15" fill="#04101f"/></svg></div>`,
    iconSize: [size, size], iconAnchor: [size / 2, size - 2], popupAnchor: [0, -(size - 2)],
  });
}

function matchPinIcon(color, size = 34) {
  return L.divIcon({
    className: 'micon-wrap',
    html: `<div class="micon pin" style="--c:${color}"><svg viewBox="0 0 24 24" width="${size}" height="${size}">
      <path d="M12 1.5a7.5 7.5 0 0 0-7.5 7.5c0 5.4 7.5 13.5 7.5 13.5s7.5-8.1 7.5-13.5A7.5 7.5 0 0 0 12 1.5z" fill="${color}" stroke="#04101f" stroke-width="1.4"/>
      <circle cx="12" cy="8.6" r="2.3" fill="#04101f"/>
      <path d="M7.6 15.2a4.4 4.4 0 0 1 8.8 0" fill="none" stroke="#04101f" stroke-width="1.8" stroke-linecap="round"/></svg></div>`,
    iconSize: [size, size], iconAnchor: [size / 2, size], popupAnchor: [0, -(size - 2)],
  });
}

function focusIcon() {
  return L.divIcon({
    className: 'micon-wrap',
    html: `<div class="micon focus"><svg viewBox="0 0 24 24" width="26" height="26">
      <circle cx="12" cy="12" r="7" fill="rgba(91,151,255,.22)" stroke="${FOCUS_BLUE}" stroke-width="2"/>
      <circle cx="12" cy="12" r="2.3" fill="${FOCUS_BLUE}"/>
      <path d="M12 2v4M12 18v4M2 12h4M18 12h4" stroke="${FOCUS_BLUE}" stroke-width="2" stroke-linecap="round"/></svg></div>`,
    iconSize: [26, 26], iconAnchor: [13, 13], popupAnchor: [0, -13],
  });
}

/* ---------------- component ---------------- */

/** ControlMap — the hero map of the control center. Dark CARTO tiles, an
 *  imperative handle the parent uses to flyTo / draw a search scenario
 *  (possible-zone circle, match pins, nearest chokepoint + police station),
 *  and the base ops layers (zones, chokepoints, police, open cases, hotspots).
 *
 *  Props: { data, hotspots, focus, matches, scenario, highlightCaseId, newCaseIds, onReady }
 *  Imperative (via ref): flyTo(lat, lng, zoom), focusCase(caseId, data),
 *                        clearScenario() */
function ControlMap({ data, hotspots, focus, matches, scenario, highlightCaseId, newCaseIds, onReady }, ref) {
  const elRef = useRef(null);
  const mapRef = useRef(null);
  const baseLayerRef = useRef(null);   // zones / chokepoints / police / cases / hotspots
  const scenarioLayerRef = useRef(null); // search overlay (circle, pins, cp, station)
  const highlightRef = useRef(null);   // current highlight marker
  const pingLayerRef = useRef(null);   // live ripples + new-case pings
  const newPingRef = useRef(new Map()); // caseId -> marker (persistent new-case ping)

  const hot = useMemo(() => (data.config ? runHotspot(data) : { hotspots: [] }), [data]);
  const hotList = hotspots || hot.hotspots || [];

  // Base map once.
  useEffect(() => {
    if (mapRef.current || !elRef.current) return;
    const m = L.map(elRef.current, { zoomControl: false, attributionControl: true }).setView(DEFAULT_CENTER, DEFAULT_ZOOM);
    L.control.zoom({ position: 'bottomright' }).addTo(m);
    L.tileLayer('https://{s}.basemaps.cartocdn.com/dark_all/{z}/{x}/{y}{r}.png', {
      attribution: '© OpenStreetMap © CARTO', maxZoom: 19,
    }).addTo(m);
    baseLayerRef.current = L.layerGroup().addTo(m);
    scenarioLayerRef.current = L.layerGroup().addTo(m);
    pingLayerRef.current = L.layerGroup().addTo(m);
    mapRef.current = m;
    // Leaflet sizes tiles from the container at init; a 0px container (flex
    // not yet laid out) renders blank. invalidateSize re-measures; the
    // ResizeObserver covers later resizes too.
    setTimeout(() => m.invalidateSize(), 60);
    const ro = new ResizeObserver(() => m.invalidateSize());
    ro.observe(elRef.current);
    if (onReady) onReady(m);
    return () => ro.disconnect();
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Redraw base ops layers when data/hotspots change.
  useEffect(() => {
    const layer = baseLayerRef.current;
    if (!layer) return;
    layer.clearLayers();

    // One cached geo index for the whole redraw (buildAreaIndex is O(areas)).
    const areaIndex = buildGeoOpts(data).areaIndex;

    const gj = data.areaBoundaries;
    if (gj && gj.features) {
      L.geoJSON(gj, {
        style: (f) => ({
          ...ZONE_STYLE,
          color: f.properties && f.properties.area_type === 'special_area' ? SPECIAL_COLOR : ZONE_COLOR,
        }),
        onEachFeature: (f, l) => l.bindPopup(f.properties && f.properties.name || 'Area'),
      }).addTo(layer);
    }

    // Chokepoints — warning triangles, sized + coloured by risk.
    (data.chokepoints || []).forEach((c) => {
      const lat = Number(c.latitude), lng = Number(c.longitude);
      if (!isFinite(lat) || !isFinite(lng)) return;
      const risk = String(c.risk_level || 'low').toLowerCase();
      const col = RISK_COLOR[risk] || RISK_COLOR.low;
      const size = risk === 'very high' ? 30 : risk === 'high' ? 26 : risk === 'medium' ? 22 : 18;
      L.marker([lat, lng], { icon: chokeIcon(col, size), keyboard: false })
        .addTo(layer)
        .bindPopup(`${c.location_name} · ${c.category} · ${risk} risk`);
    });

    // Police stations — shield pins.
    (data.policeStations || []).forEach((p) => {
      const lat = Number(p.latitude), lng = Number(p.longitude);
      if (!isFinite(lat) || !isFinite(lng)) return;
      L.marker([lat, lng], { icon: policeIcon(), keyboard: false })
        .addTo(layer)
        .bindPopup(`${p.station_name} (police)`);
    });

    // Open cases — small dots (circleMarker for performance with ~800 points).
    (data.records || []).slice(0, 800).forEach((r) => {
      const hit = r.last_seen_location ? geo.resolveLocation(r.last_seen_location, areaIndex) : null;
      if (hit) L.circleMarker([hit.lat, hit.lng], {
        radius: 3, color: OPEN_CASE, fillColor: OPEN_CASE, fillOpacity: 0.55, weight: 1,
      }).addTo(layer);
    });

    // Hotspot heat circles.
    (hotList || []).forEach((h) => {
      if (h.lat == null || h.lng == null) return;
      const hc = RISK_COLOR[String(h.riskLevel || 'high').toLowerCase()] || RISK_COLOR.high;
      L.circle([h.lat, h.lng], {
        radius: Math.max(120, (h.caseCount || 1) * 90),
        color: hc, fillColor: hc, fillOpacity: 0.14, weight: 2,
      }).addTo(layer).bindPopup(
        `HOTSPOT · ${h.caseCount} open cases · ${h.chokepointName || 'chokepoint'} (${h.riskLevel})`,
      );
    });
  }, [data, hotList]);

  // Look up a coordinate by facility name (chokepoints / police stations).
  function coordByName(rows, name) {
    if (!rows || !name) return null;
    const r = rows.find((x) => x.location_name === name || x.station_name === name);
    if (!r) return null;
    const lat = Number(r.latitude), lng = Number(r.longitude);
    if (!isFinite(lat) || !isFinite(lng)) return null;
    return { lat, lng };
  }

  // Draw / clear the search scenario overlay.
  useEffect(() => {
    const layer = scenarioLayerRef.current;
    if (!layer) return;
    layer.clearLayers();

    const areaIndex = buildGeoOpts(data).areaIndex;
    const hasFocus = !!(focus && focus.lat != null);
    const matchList = matches || [];

    // Resolve each match to a coordinate first so we can fly even when the
    // query's own last-seen location didn't resolve to a point.
    const pins = [];
    matchList.forEach((m) => {
      const r = m.record || m;
      const hit = r.last_seen_location ? geo.resolveLocation(r.last_seen_location, areaIndex) : null;
      if (hit) pins.push({ m, r, hit });
    });

    // Nothing geo to draw or fly to — leave the map as-is.
    if (!hasFocus && pins.length === 0) return;

    if (hasFocus) {
      // Possible-zone circle (pulsing via CSS class on the path).
      L.circle([focus.lat, focus.lng], {
        radius: focus.radiusM || 400,
        color: FOCUS_BLUE, fillColor: FOCUS_BLUE, fillOpacity: 0.12, weight: 2,
        className: 'scenario-zone',
      }).addTo(layer).bindPopup(`Possible zone · ${focus.name || 'last seen'}`);

      // Focus target marker.
      L.marker([focus.lat, focus.lng], { icon: focusIcon(), keyboard: false, interactive: false })
        .addTo(layer);

      // Nearest chokepoint + connecting line (scenario-aware, if known).
      const cpName = scenario && scenario.nearestChokepoint && scenario.nearestChokepoint.name;
      const cpCoord = coordByName(data.chokepoints, cpName);
      if (cpCoord) {
        L.polyline([[focus.lat, focus.lng], [cpCoord.lat, cpCoord.lng]], {
          color: RISK_COLOR.high, weight: 1.5, opacity: 0.7, dashArray: '4 6',
        }).addTo(layer);
        L.marker([cpCoord.lat, cpCoord.lng], { icon: chokeIcon(RISK_COLOR.high, 28), keyboard: false })
          .addTo(layer)
          .bindPopup(`Nearest chokepoint · ${cpName} · ${scenario.nearestChokepoint.riskLevel} · ${scenario.nearestChokepoint.distanceM}m`);
      }

      // Nearest police station + connecting line.
      const stName = scenario && scenario.nearestStation && scenario.nearestStation.name;
      const stCoord = coordByName(data.policeStations, stName);
      if (stCoord) {
        L.polyline([[focus.lat, focus.lng], [stCoord.lat, stCoord.lng]], {
          color: POLICE_BLUE, weight: 1.5, opacity: 0.7, dashArray: '4 6',
        }).addTo(layer);
        L.marker([stCoord.lat, stCoord.lng], { icon: policeIcon(), keyboard: false })
          .addTo(layer)
          .bindPopup(`Nearest police · ${stName} · ${scenario.nearestStation.distanceM}m`);
      }
    }

    // Match pins, band-coloured.
    pins.forEach(({ m, r, hit }) => {
      const band = String(m.band || 'low').toLowerCase();
      const col = BAND_COLOR[band] || BAND_COLOR.low;
      const size = band === 'high' ? 38 : band === 'medium' ? 32 : 28;
      L.marker([hit.lat, hit.lng], {
        icon: matchPinIcon(col, size),
        keyboard: false,
        zIndexOffset: band === 'high' ? 800 : band === 'medium' ? 600 : 400,
      }).addTo(layer).bindPopup(
        `<strong>${r.missing_person_name || '(no name)'}</strong><br/>` +
        `${r.case_id} · ${r.reporting_center || ''}<br/>` +
        `Score ${m.score ?? '?'} · ${m.band || ''}<br/>` +
        `${r.last_seen_location || ''}`,
      );
    });

    // Animate to focus + pins (or whichever exists).
    const bounds = L.latLngBounds([]);
    if (hasFocus) bounds.extend([focus.lat, focus.lng]);
    pins.forEach(({ hit }) => bounds.extend([hit.lat, hit.lng]));
    const m = mapRef.current;
    if (!m) return;
    if (bounds.isValid() && pins.length > 0) {
      m.flyToBounds(bounds.pad(0.3), { duration: 1.2, maxZoom: 16 });
    } else if (hasFocus) {
      m.flyTo([focus.lat, focus.lng], 16, { duration: 1.2 });
    }
  }, [focus, matches, scenario, data]);

  // Highlight a single case pin (from feed click) without drawing a scenario.
  useEffect(() => {
    if (highlightRef.current) { highlightRef.current.remove(); highlightRef.current = null; }
    if (!highlightCaseId) return;
    const r = (data.records || []).find((x) => x.case_id === highlightCaseId);
    if (!r) return;
    const hit = r.last_seen_location ? geo.resolveLocation(r.last_seen_location, buildGeoOpts(data).areaIndex) : null;
    if (!hit) return;
    highlightRef.current = L.marker([hit.lat, hit.lng], {
      icon: matchPinIcon('#ffd166', 36), keyboard: false, zIndexOffset: 1000,
    }).addTo(scenarioLayerRef.current);
  }, [highlightCaseId, data]);

  // Spawn a one-shot expanding ripple at a coordinate (the "live ping").
  function spawnRipple(lat, lng, color = '#5b97ff', ttl = 2200) {
    const layer = pingLayerRef.current;
    if (!layer || !isFinite(lat) || !isFinite(lng)) return;
    const ring = L.circleMarker([lat, lng], {
      radius: 6, color, weight: 2, fillColor: color, fillOpacity: 0.25,
      className: 'ping-ripple', interactive: false,
    }).addTo(layer);
    setTimeout(() => ring.remove(), ttl);
  }

  // Cache of resolvable open-case coordinates for the live-ping sampler.
  const coordPoolRef = useRef([]);
  useEffect(() => {
    const areaIndex = buildGeoOpts(data).areaIndex;
    const pool = [];
    for (const r of (data.records || [])) {
      if (!r.last_seen_location) continue;
      const hit = geo.resolveLocation(r.last_seen_location, areaIndex);
      if (hit) pool.push([hit.lat, hit.lng]);
    }
    coordPoolRef.current = pool;
  }, [data]);

  // Live dashboard pings: spawn a ripple at a random open case every ~2.5s.
  useEffect(() => {
    if (typeof window === 'undefined') return;
    const id = setInterval(() => {
      const pool = coordPoolRef.current;
      if (!pool.length) return;
      const [lat, lng] = pool[Math.floor(Math.random() * pool.length)];
      spawnRipple(lat, lng, '#ff5a6e', 2200);
    }, 2500);
    return () => clearInterval(id);
  }, []);

  // New-case pings: persistent pulsing marker + a strong one-shot ripple for
  // each newly-registered case, removed when it leaves `newCaseIds`.
  useEffect(() => {
    const layer = pingLayerRef.current;
    if (!layer) return;
    const areaIndex = buildGeoOpts(data).areaIndex;
    const live = new Set((newCaseIds || []));
    // Add pings for new ids.
    for (const id of live) {
      if (newPingRef.current.has(id)) continue;
      const r = (data.records || []).find((x) => x.case_id === id);
      if (!r || !r.last_seen_location) continue;
      const hit = geo.resolveLocation(r.last_seen_location, areaIndex);
      if (!hit) continue;
      const marker = L.circleMarker([hit.lat, hit.lng], {
        radius: 7, color: '#ffd166', weight: 2, fillColor: '#ffd166', fillOpacity: 0.5,
        className: 'ping-new', interactive: false,
      }).addTo(layer);
      newPingRef.current.set(id, marker);
      spawnRipple(hit.lat, hit.lng, '#ffd166', 2600);
      spawnRipple(hit.lat, hit.lng, '#ffd166', 2600);
    }
    // Remove pings for ids no longer marked new.
    for (const [id, marker] of newPingRef.current) {
      if (!live.has(id)) { marker.remove(); newPingRef.current.delete(id); }
    }
  }, [newCaseIds, data]);

  // Imperative API for the parent (flyTo, focusCase, clearScenario).
  useImperativeHandle(ref, () => ({
    flyTo(lat, lng, zoom = 16) {
      const m = mapRef.current;
      if (m && isFinite(lat) && isFinite(lng)) m.flyTo([lat, lng], zoom, { duration: 1.2 });
    },
    focusCase(caseId, caseData) {
      const d = caseData || data;
      const r = (d.records || []).find((x) => x.case_id === caseId);
      if (!r || !r.last_seen_location) return;
      const hit = geo.resolveLocation(r.last_seen_location, buildGeoOpts(d).areaIndex);
      if (hit) this.flyTo(hit.lat, hit.lng, 16);
    },
    invalidate() { mapRef.current && mapRef.current.invalidateSize(); },
    clearScenario() { scenarioLayerRef.current && scenarioLayerRef.current.clearLayers(); },
  }), [data]);

  return (
    <div className="mapwrap dark">
      <div className="map-stats">
        <div className="stat"><span className="n">{(hotList || []).length}</span><span className="l">Hotspots</span></div>
        <div className="divider" />
        <div className="stat"><span className="n">{(data.chokepoints || []).length}</span><span className="l">Chokepoints</span></div>
        <div className="divider" />
        <div className="stat"><span className="n">{(data.policeStations || []).length}</span><span className="l">Police</span></div>
        <div className="divider" />
        <div className="stat"><span className="n">{(data.records || []).length}</span><span className="l">Cases</span></div>
      </div>
      <div ref={elRef} className="map-canvas" />
      <div className="map-legend">
        <div className="legend-title">Legend</div>
        <div className="legend-row"><span className="lsv" dangerouslySetInnerHTML={{ __html: legendShield() }} /> Police station</div>
        <div className="legend-row"><span className="lsv" dangerouslySetInnerHTML={{ __html: legendTriangle(RISK_COLOR['very high']) }} /> Chokepoint (risk)</div>
        <div className="legend-row"><span className="lsv" dangerouslySetInnerHTML={{ __html: legendPin(BAND_COLOR.high) }} /> Possible match</div>
        <div className="legend-row"><span className="swatch" style={{ background: OPEN_CASE }} /> Open case</div>
        <div className="legend-row"><span className="swatch ring" /> Hotspot / zone</div>
      </div>
    </div>
  );
}

/* tiny inline SVGs for the legend swatches */
function legendShield() {
  return `<svg viewBox="0 0 24 24" width="16" height="16"><path d="M12 2l8 3v6c0 5-3.4 8.4-8 11-4.6-2.6-8-6-8-11V5l8-3z" fill="${POLICE_BLUE}" stroke="#04101f" stroke-width="1"/><path d="M12 6.4l1.4 2.9 3.1.45-2.25 2.2.53 3.1L12 13.7l-2.78 1.45.53-3.1-2.25-2.2 3.1-.45z" fill="#fff"/></svg>`;
}
function legendTriangle(c) {
  return `<svg viewBox="0 0 24 24" width="16" height="16"><path d="M12 3 1.8 18a2 2 0 0 0 1.7 3h17a2 2 0 0 0 1.7-3L13.7 3a2 2 0 0 0-3.4 0z" fill="${c}" stroke="#04101f" stroke-width="1"/></svg>`;
}
function legendPin(c) {
  return `<svg viewBox="0 0 24 24" width="16" height="16"><path d="M12 1.5a7.5 7.5 0 0 0-7.5 7.5c0 5.4 7.5 13.5 7.5 13.5s7.5-8.1 7.5-13.5A7.5 7.5 0 0 0 12 1.5z" fill="${c}" stroke="#04101f" stroke-width="1"/></svg>`;
}

export default forwardRef(ControlMap);
