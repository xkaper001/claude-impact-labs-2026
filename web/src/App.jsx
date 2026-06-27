import React, { useEffect, useMemo, useState } from 'react';
import Home from './components/Home.jsx';
import Intake from './components/Intake.jsx';
import MatchResults from './components/MatchResults.jsx';
import OpsMap from './components/OpsMap.jsx';
import { t, LANGS } from './lib/i18n.js';
import { seedIfEmpty, startSync, syncState, loadCases, loadConfig } from './lib/db.js';
import { seedData, config as bundledConfig } from './lib/engine.js';

export default function App() {
  const [lang, setLang] = useState('en');
  const [view, setView] = useState('home'); // home | intake | matches | map
  const [intakeMode, setIntakeMode] = useState('lost'); // lost | found
  const [lastQuery, setLastQuery] = useState(null);
  const [online, setOnline] = useState(navigator.onLine);
  const [sync, setSync] = useState({ configured: false, remote: false });
  const [data, setData] = useState(seedData);
  const [config, setConfig] = useState(bundledConfig);

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
    (async () => {
      await seedIfEmpty();
      startSync();
      setSync(syncState());
      const [cases, cfg] = await Promise.all([loadCases(), loadConfig()]);
      if (cases.length) {
        // Merge live cases on top of seed (seed provides geo reference data;
        // cases come from PouchDB). Engine reads records from this combined set.
        setData({ ...seedData, records: [...cases, ...seedData.records] });
      }
      setConfig(cfg);
    })();
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
        <div className="brand" onClick={() => setView('home')}>
          <span className="logo">_AHB</span>
          <div>
            <div className="brand-name">{tr('appName')}</div>
            <div className="brand-sub">{tr('tagline')}</div>
          </div>
        </div>
        <nav className="nav">
          <button className={view === 'map' ? 'active' : ''} onClick={() => setView('map')}>
            {tr('opsMap')}
          </button>
          <div className="lang">
            {LANGS.map((l) => (
              <button key={l} className={lang === l ? 'active' : ''} onClick={() => setLang(l)}>
                {l.toUpperCase()}
              </button>
            ))}
          </div>
          <span className={`status ${online ? 'on' : 'off'}`}>
            {online ? tr('online') : tr('offline')}
          </span>
        </nav>
      </header>

      <main className="content">
        {view === 'home' && <Home tr={tr} onLost={() => startIntake('lost')} onFound={() => startIntake('found')} sync={sync} />}
        {view === 'intake' && (
          <Intake
            tr={tr}
            lang={lang}
            mode={intakeMode}
            config={config}
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
