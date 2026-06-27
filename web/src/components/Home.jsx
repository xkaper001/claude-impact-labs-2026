import React from 'react';

export default function Home({ tr, onLost, onFound, sync }) {
  return (
    <div className="home">
      <div className="home-inner">
        <h1>{tr('appName')}</h1>
        <p className="lead">{tr('tagline')}</p>
        <div className="big-buttons">
          <button className="big-btn lost" onClick={onLost}>
            <span className="lbl">{tr('iLostSomeone')}</span>
            <span className="sub">Family intake · voice or typed</span>
          </button>
          <button className="big-btn found" onClick={onFound}>
            <span className="lbl">{tr('iFoundSomeone')}</span>
            <span className="sub">Register a found person</span>
          </button>
        </div>
        <div className="sync-note">
          {sync.configured
            ? sync.remote
              ? 'PouchDB ↔ CouchDB replication live (multi-master).'
              : 'CouchDB configured — replication will start when the box is reachable.'
            : 'Offline mode — cases stored locally in PouchDB; add VITE_COUCHDB_URL to enable sync.'}
        </div>
      </div>
    </div>
  );
}
