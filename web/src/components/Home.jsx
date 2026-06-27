import React from 'react';
import Icon from './Icon.jsx';

export default function Home({ tr, onLost, onFound, sync, onMap }) {
  const synced = sync.configured && sync.remote;
  const syncMsg = sync.configured
    ? sync.remote
      ? 'Live sync with kendra box · multi-master replication'
      : 'Kendra box configured · sync resumes when reachable'
    : 'Offline mode · cases stored on this device';

  return (
    <div className="home">
      <div className="home-head">
        <p className="eyebrow">Kumbh Mela · ICCC</p>
        <h1>{tr('appName')}</h1>
        <p className="lead">{tr('tagline')}. Register a case and find likely matches across centers in seconds, online or off.</p>
      </div>

      <div className="big-buttons">
        <button className="big-btn lost" onClick={onLost}>
          <span className="ico"><Icon name="personLost" /></span>
          <span className="lbl">{tr('iLostSomeone')}</span>
          <span className="sub">Family intake · voice or typed</span>
          <span className="go">Start intake <Icon name="arrow" /></span>
        </button>
        <button className="big-btn found" onClick={onFound}>
          <span className="ico"><Icon name="personFound" /></span>
          <span className="lbl">{tr('iFoundSomeone')}</span>
          <span className="sub">Register a found person</span>
          <span className="go">Start intake <Icon name="arrow" /></span>
        </button>
      </div>

      <div className="home-foot">
        <span className={`sync-note ${synced ? '' : 'local'}`}>
          <span className="dot" />
          {syncMsg}
        </span>
        {onMap && (
          <button className="text-link" onClick={onMap}>
            <Icon name="map" /> {tr('opsMap')}
          </button>
        )}
      </div>
    </div>
  );
}
