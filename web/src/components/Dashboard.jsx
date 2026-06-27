import React, { useEffect, useRef, useState } from 'react';
import ControlMap from './ControlMap.jsx';
import LostFoundFeed from './LostFoundFeed.jsx';
import ResultsPanel from './ResultsPanel.jsx';
import IntakePanel from './IntakePanel.jsx';
import Icon from './Icon.jsx';
import { caseCoord } from '../lib/engine.js';

/** Dashboard — the control center: hero map on top, the two intake action
 *  buttons beneath it, and the auto-scrolling lost & found feed at the
 *  bottom. Search results overlay the map (ResultsPanel) and the map flies to
 *  the resolved zone; the intake form opens in a slide-over so the map stays
 *  visible. */
export default function Dashboard({
  tr, lang, config, data, online, sync, newCaseIds,
  searchState, onSearch, onClearSearch, onOpenIntake, intakeOpen, intakeMode, onCloseIntake, onCaseSaved,
}) {
  const mapRef = useRef(null);
  const [highlightCaseId, setHighlightCaseId] = useState(null);
  const [fs, setFs] = useState(false); // map fullscreen
  const now = useRef(new Date().toISOString().slice(0, 16).replace('T', ' '));

  // A new search clears any stale feed-click highlight so the scenario reads clean.
  useEffect(() => { if (searchState) setHighlightCaseId(null); }, [searchState]);

  // Re-measure the map when toggling fullscreen (container size changes).
  function toggleFullscreen() {
    setFs((v) => {
      const next = !v;
      setTimeout(() => mapRef.current && mapRef.current.invalidate(), 60);
      return next;
    });
  }

  // Esc exits fullscreen.
  useEffect(() => {
    if (!fs) return;
    const onKey = (e) => { if (e.key === 'Escape') setFs(false); };
    window.addEventListener('keydown', onKey);
    return () => {
      window.removeEventListener('keydown', onKey);
      setTimeout(() => mapRef.current && mapRef.current.invalidate(), 60);
    };
  }, [fs]);

  function handleFeedFocus(caseId, lat, lng) {
    setHighlightCaseId(caseId);
    // Clear any open search scenario so the feed focus reads cleanly.
    if (searchState) onClearSearch();
    mapRef.current && mapRef.current.flyTo(lat, lng, 16);
  }

  // Clicking a result card flies the map to that match's pin (tighter zoom)
  // and drops a highlight marker so the operator can see exactly which one.
  function handleFocusMatch(m) {
    const r = m.record || m;
    if (!r || !r.case_id) return;
    const coord = caseCoord(r.case_id, data);
    if (coord) {
      setHighlightCaseId(r.case_id);
      mapRef.current && mapRef.current.flyTo(coord.lat, coord.lng, 17);
    }
  }

  function handleClearSearch() {
    mapRef.current && mapRef.current.clearScenario();
    setHighlightCaseId(null);
    onClearSearch();
  }

  const synced = sync.configured && sync.remote;
  const syncMsg = sync.configured
    ? sync.remote ? 'Live sync · kendra box' : 'Kendra box · sync paused'
    : 'Offline · on-device';

  return (
    <div className="dashboard">
      <section className={`map-hero ${fs ? 'fullscreen' : ''}`}>
        <ControlMap
          ref={mapRef}
          data={data}
          focus={searchState?.scenario?.focus}
          matches={searchState?.result?.matches}
          scenario={searchState?.scenario}
          highlightCaseId={highlightCaseId}
          newCaseIds={newCaseIds}
        />

        <div className="map-overlay-top">
          <div className="ops-title">
            <span className="ops-eyebrow">ICCC · Nashik Kumbh 2027</span>
            <span className="ops-h">{tr('appName')} <span className="ops-h-sub">Control Center</span></span>
          </div>
          <div className="map-overlay-actions">
            <div className={`ops-sync ${synced ? '' : 'local'}`}><span className="dot" />{syncMsg}</div>
            <button className="fs-btn" onClick={toggleFullscreen} aria-label={fs ? 'Exit fullscreen' : 'Fullscreen'} title={fs ? 'Exit fullscreen' : 'Fullscreen'}>
              {fs ? <Icon name="back" /> : <Icon name="map" />}
            </button>
          </div>
        </div>

        {searchState && (
          <ResultsPanel
            tr={tr}
            lang={lang}
            query={searchState.query}
            data={data}
            result={searchState.result}
            scenario={searchState.scenario}
            online={online}
            onClose={handleClearSearch}
            onFocusMatch={handleFocusMatch}
          />
        )}
      </section>

      <section className="action-row">
        <button className="big-btn lost" onClick={() => onOpenIntake('lost')}>
          <span className="ico"><Icon name="personLost" /></span>
          <span className="lbl">{tr('iLostSomeone')}</span>
          <span className="sub">Family intake · voice or typed</span>
          <span className="go">Start intake <Icon name="arrow" /></span>
        </button>
        <button className="big-btn found" onClick={() => onOpenIntake('found')}>
          <span className="ico"><Icon name="personFound" /></span>
          <span className="lbl">{tr('iFoundSomeone')}</span>
          <span className="sub">Register a found person</span>
          <span className="go">Start intake <Icon name="arrow" /></span>
        </button>
      </section>

      <LostFoundFeed data={data} now={now.current} onFocus={handleFeedFocus} newCaseIds={newCaseIds} />

      <IntakePanel
        open={intakeOpen}
        tr={tr}
        lang={lang}
        mode={intakeMode}
        config={config}
        data={data}
        online={online}
        onClose={onCloseIntake}
        onSearched={onSearch}
        onCaseSaved={onCaseSaved}
      />
    </div>
  );
}
