import React, { useEffect, useMemo, useState } from 'react';
import Dashboard from './components/Dashboard.jsx';
import Icon from './components/Icon.jsx';
import { t, LANGS } from './lib/i18n.js';
import { startSync, syncState, loadAll, emptyData } from './lib/db.js';
import { runSearch, scenarioFor } from './lib/engine.js';

export default function App() {
  const [lang, setLang] = useState('en');
  const [intakeOpen, setIntakeOpen] = useState(false);
  const [intakeMode, setIntakeMode] = useState('lost'); // lost | found
  const [searchState, setSearchState] = useState(null); // { query, result, scenario }
  const [newCaseIds, setNewCaseIds] = useState([]); // recently-registered case IDs (for feed/map highlight)
  const [online, setOnline] = useState(navigator.onLine);
  const [sync, setSync] = useState({ configured: false, remote: false });
  const [data, setData] = useState(emptyData);
  const [config, setConfig] = useState(null);

  useEffect(() => {
    const on = () => setOnline(true);
    const off = () => setOnline(false);
    window.addEventListener('online', on);
    window.addEventListener('offline', off);
    return () => {
      window.removeEventListener('online', on);
      window.removeEventListener('offline', off);
    };
  }, []);

  useEffect(() => {
    let alive = true;
    // All data lives in CouchDB (replicated into PouchDB). Reload on mount and
    // again on every replication change, so the console fills in as docs arrive.
    const reload = async () => {
      const d = await loadAll();
      if (!alive) return;
      setData(d);
      setConfig(d.config);
    };
    reload();
    startSync(reload);
    setSync(syncState());
    return () => { alive = false; };
  }, []);

  const tr = useMemo(() => (k) => t(lang, k), [lang]);

  function openIntake(mode) {
    setIntakeMode(mode);
    setIntakeOpen(true);
  }

  // Inline search: stay on the dashboard, compute matches + scenario, let the
  // map fly to the resolved zone and the ResultsPanel slide in.
  function onSearch(query) {
    if (!data.config) return;
    const result = runSearch(query, data, { mode: query.mode || 'A', now: query.reportedAt });
    const scenario = scenarioFor(query, data);
    setSearchState({ query, result, scenario });
  }

  function clearSearch() {
    setSearchState(null);
  }

  // A newly-registered case (lost or found) is highlighted in the feed and
  // pinged on the map for a short window so the control center notices it.
  function registerNewCase(caseId) {
    if (!caseId) return;
    setNewCaseIds((ids) => (ids.includes(caseId) ? ids : [...ids, caseId]));
    setTimeout(() => {
      setNewCaseIds((ids) => ids.filter((id) => id !== caseId));
    }, 60000);
  }

  return (
    <div className="app">
      <header className="topbar">
        <button className="brand" aria-label={tr('appName')}>
          <span className="logo" aria-hidden="true">
            <svg viewBox="0 0 48 48" width="42" height="42">
              <defs>
                <linearGradient id="ksLogo" x1="0" y1="0" x2="1" y2="1">
                  <stop offset="0" stopColor="#ff9933" />
                  <stop offset=".55" stopColor="#ff7a59" />
                  <stop offset="1" stopColor="#3b6fd4" />
                </linearGradient>
              </defs>
              <rect x="3" y="3" width="42" height="42" rx="13" fill="url(#ksLogo)" />
              {/* Reuniting person above the bridge (Setu) */}
              <circle cx="24" cy="13.5" r="3.4" fill="#fff" />
              <path d="M24 17.5v3.5" fill="none" stroke="#fff" strokeWidth="2.2" strokeLinecap="round" />
              {/* Bridge arches spanning the rivers/convergence */}
              <path
                d="M9 31h30 M9 31c4-9.5 26-9.5 30 0 M15 31v6 M24 28.5v8.5 M33 31v6"
                fill="none" stroke="#fff" strokeWidth="2.2"
                strokeLinecap="round" strokeLinejoin="round"
              />
            </svg>
          </span>
          <span className="brand-text">
            <span className="brand-name">{tr('appName')}</span>
            <span className="brand-sub">{tr('tagline')}</span>
          </span>
        </button>

        <span className="topbar-divider" aria-hidden="true" />
        <span className="topbar-badge"><Icon name="map" /> ICCC · Control Center</span>

        <nav className="nav">
          <div className="lang">
            {LANGS.map((l) => (
              <button key={l} className={lang === l ? 'active' : ''} onClick={() => setLang(l)}>
                {l.toUpperCase()}
              </button>
            ))}
          </div>
          <span className={`status ${online ? 'on' : 'off'}`} title={online ? tr('online') : tr('offline')}>
            <span className="dot" />
            {online ? tr('online') : tr('offline')}
          </span>
        </nav>
      </header>

      <main className="content">
        <Dashboard
          tr={tr}
          lang={lang}
          config={config}
          data={data}
          online={online}
          sync={sync}
          newCaseIds={newCaseIds}
          searchState={searchState}
          onSearch={onSearch}
          onClearSearch={clearSearch}
          onOpenIntake={openIntake}
          intakeOpen={intakeOpen}
          intakeMode={intakeMode}
          onCloseIntake={() => setIntakeOpen(false)}
          onCaseSaved={registerNewCase}
        />
      </main>
    </div>
  );
}
