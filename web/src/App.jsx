import React, { useEffect, useMemo, useState } from 'react';
import Home from './components/Home.jsx';
import Intake from './components/Intake.jsx';
import MatchResults from './components/MatchResults.jsx';
import OpsMap from './components/OpsMap.jsx';
import Icon from './components/Icon.jsx';
import { t, LANGS } from './lib/i18n.js';
import { startSync, syncState, loadAll, emptyData } from './lib/db.js';

export default function App() {
  const [lang, setLang] = useState('en');
  const [view, setView] = useState('home'); // home | intake | matches | map
  const [intakeMode, setIntakeMode] = useState('lost'); // lost | found
  const [lastQuery, setLastQuery] = useState(null);
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

  function startIntake(mode) {
    setIntakeMode(mode);
    setView('intake');
  }

  function onSearched(query) {
    setLastQuery(query);
    setView('matches');
  }

  return (
    <div className="app">
      <header className="topbar">
        <button className="brand" onClick={() => setView('home')} aria-label={tr('appName')}>
          <span className="logo"><Icon name="bridge" /></span>
          <div>
            <div className="brand-name">{tr('appName')}</div>
            <div className="brand-sub">{tr('tagline')}</div>
          </div>
        </button>
        <nav className="nav">
          <button
            className={`nav-link ${view === 'map' ? 'active' : ''}`}
            onClick={() => setView('map')}
          >
            <Icon name="map" /> {tr('opsMap')}
          </button>
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
        {view === 'home' && <Home tr={tr} onLost={() => startIntake('lost')} onFound={() => startIntake('found')} onMap={() => setView('map')} sync={sync} />}
        {view === 'intake' && (
          <Intake
            tr={tr}
            lang={lang}
            mode={intakeMode}
            config={config}
            data={data}
            online={online}
            onBack={() => setView('home')}
            onSearched={onSearched}
          />
        )}
        {view === 'matches' && (
          <MatchResults tr={tr} lang={lang} query={lastQuery} data={data} online={online} onBack={() => setView('intake')} />
        )}
        {view === 'map' && <OpsMap tr={tr} data={data} online={online} />}
      </main>
    </div>
  );
}
