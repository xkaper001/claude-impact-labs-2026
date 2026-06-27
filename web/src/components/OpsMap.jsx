import React, { useEffect, useMemo, useRef, useState } from 'react';
import L from 'leaflet';
import { runHotspot, runResolve } from '../lib/engine.js';

const RISK_COLOR = { 'very high': '#c62433', high: '#de6a18', medium: '#c98a00', low: '#7a8499' };
const SPECIAL_COLOR = '#de6a18';
const ZONE_COLOR = '#1f5fc4';
const OPEN_CASE = '#d6455a';
const ZONE_STYLE = { color: ZONE_COLOR, weight: 1.2, fillColor: ZONE_COLOR, fillOpacity: 0.05 };

export default function OpsMap({ tr, data, online }) {
  const elRef = useRef(null);
  const mapRef = useRef(null);
  const layerRef = useRef(null);
  const [hotspots, setHotspots] = useState([]);

  const hot = useMemo(() => (data.config ? runHotspot(data) : { hotspots: [] }), [data]);
  useEffect(() => setHotspots(hot.hotspots || []), [hot]);

  // Base map once.
  useEffect(() => {
    if (mapRef.current || !elRef.current) return;
    const m = L.map(elRef.current, { zoomControl: false }).setView([19.997, 73.79], 13);
    L.control.zoom({ position: 'topright' }).addTo(m);
    L.tileLayer('https://{s}.basemaps.cartocdn.com/light_all/{z}/{x}/{y}{r}.png', {
      attribution: '© OpenStreetMap © CARTO', maxZoom: 19,
    }).addTo(m);
    layerRef.current = L.layerGroup().addTo(m);
    mapRef.current = m;
  }, []);

  // Draw layers whenever data changes.
  useEffect(() => {
    const layer = layerRef.current;
    if (!layer) return;
    layer.clearLayers();

    // Zone + special-area polygons from GeoJSON.
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

    // Chokepoints sized/colored by risk_level.
    (data.chokepoints || []).forEach((c) => {
      const lat = Number(c.latitude), lng = Number(c.longitude);
      if (!isFinite(lat) || !isFinite(lng)) return;
      const risk = String(c.risk_level || 'low').toLowerCase();
      const r = risk === 'very high' ? 11 : risk === 'high' ? 8 : risk === 'medium' ? 6 : 4;
      L.circleMarker([lat, lng], {
        radius: r, color: RISK_COLOR[risk] || RISK_COLOR.low,
        fillColor: RISK_COLOR[risk] || RISK_COLOR.low, fillOpacity: 0.8, weight: 1,
      }).addTo(layer).bindPopup(`${c.location_name} · ${c.category} · ${risk} risk`);
    });

    // Police stations.
    (data.policeStations || []).forEach((p) => {
      const lat = Number(p.latitude), lng = Number(p.longitude);
      if (!isFinite(lat) || !isFinite(lng)) return;
      L.marker([lat, lng]).addTo(layer).bindPopup(`${p.station_name} (police)`);
    });

    // Open-case dots (geo-resolved) + hotspot heat circles.
    (data.records || []).slice(0, 800).forEach((r) => {
      const hit = runResolve(r.last_seen_location, data);
      if (hit) L.circleMarker([hit.lat, hit.lng], { radius: 3, color: OPEN_CASE, fillColor: OPEN_CASE, fillOpacity: 0.6, weight: 1 }).addTo(layer);
    });
    (hotspots || []).forEach((h) => {
      if (h.lat == null || h.lng == null) return;
      const hc = RISK_COLOR[String(h.riskLevel || 'high').toLowerCase()] || RISK_COLOR.high;
      L.circle([h.lat, h.lng], {
        radius: Math.max(120, (h.caseCount || 1) * 90),
        color: hc,
        fillColor: hc, fillOpacity: 0.16, weight: 2,
      }).addTo(layer).bindPopup(
        `HOTSPOT · ${h.caseCount} open cases · ${h.chokepointName || 'chokepoint'} (${h.riskLevel})`,
      );
    });
  }, [data, hotspots]);

  return (
    <div className="map-wrap">
      <div className="map-panel mapbar">
        <div className="stat">
          <span className="n">{hotspots.length}</span>
          <span className="l">Hotspots</span>
        </div>
        <div className="divider" />
        <div className="stat">
          <span className="n">{(data.records || []).length}</span>
          <span className="l">Open cases</span>
        </div>
      </div>
      <div ref={elRef} style={{ height: '100%' }} />
      <div className="map-panel legend">
        <div className="legend-title">Risk level</div>
        <div className="legend-row"><span className="swatch" style={{ background: RISK_COLOR['very high'] }} /> Very high</div>
        <div className="legend-row"><span className="swatch" style={{ background: RISK_COLOR.high }} /> High</div>
        <div className="legend-row"><span className="swatch" style={{ background: RISK_COLOR.medium }} /> Medium</div>
        <div className="legend-row"><span className="swatch" style={{ background: OPEN_CASE }} /> Open case</div>
        <div className="legend-row"><span className="swatch ring" /> Hotspot cluster</div>
      </div>
    </div>
  );
}
