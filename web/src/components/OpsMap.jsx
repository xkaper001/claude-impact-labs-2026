import React, { useEffect, useMemo, useRef, useState } from 'react';
import L from 'leaflet';
import { runHotspot, runResolve } from '../lib/engine.js';

const RISK_COLOR = { 'very high': '#d7263d', high: '#f5a623', medium: '#ffd166', low: '#8b9bc4' };
const ZONE_STYLE = { color: '#2d6cff', weight: 1, fillColor: '#2d6cff', fillOpacity: 0.06 };

export default function OpsMap({ tr, data, online }) {
  const elRef = useRef(null);
  const mapRef = useRef(null);
  const layerRef = useRef(null);
  const [hotspots, setHotspots] = useState([]);

  const hot = useMemo(() => runHotspot(data), [data]);
  useEffect(() => setHotspots(hot.hotspots || []), [hot]);

  // Base map once.
  useEffect(() => {
    if (mapRef.current || !elRef.current) return;
    const m = L.map(elRef.current).setView([19.997, 73.79], 13);
    L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', {
      attribution: '© OpenStreetMap', maxZoom: 19,
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
          color: f.properties && f.properties.area_type === 'special' ? '#f5a623' : '#2d6cff',
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
      if (hit) L.circleMarker([hit.lat, hit.lng], { radius: 3, color: '#ff5c5c', fillOpacity: 0.5 }).addTo(layer);
    });
    (hotspots || []).forEach((h) => {
      if (h.lat == null || h.lng == null) return;
      L.circle([h.lat, h.lng], {
        radius: Math.max(120, (h.caseCount || 1) * 90),
        color: RISK_COLOR[String(h.riskLevel || 'high').toLowerCase()] || '#f5a623',
        fillColor: '#f5a623', fillOpacity: 0.18, weight: 2,
      }).addTo(layer).bindPopup(
        `HOTSPOT · ${h.caseCount} open cases · ${h.chokepointName || 'chokepoint'} (${h.riskLevel})`,
      );
    });
  }, [data, hotspots]);

  return (
    <div className="map-wrap">
      <div className="mapbar">{tr('opsMap')} · {hotspots.length} hotspots · {data.records.length} cases</div>
      <div ref={elRef} style={{ height: '100%' }} />
      <div className="legend">
        <div><span className="swatch" style={{ background: RISK_COLOR['very high'] }} />very high</div>
        <div><span className="swatch" style={{ background: RISK_COLOR.high }} />high</div>
        <div><span className="swatch" style={{ background: RISK_COLOR.medium }} />medium</div>
        <div><span className="swatch" style={{ background: '#ff5c5c' }} />open case</div>
      </div>
    </div>
  );
}
