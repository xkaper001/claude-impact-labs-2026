import React, { useMemo } from 'react';
import { feedItems, relativeTime, caseCoord } from '../lib/engine.js';
import Icon from './Icon.jsx';

/** LostFoundFeed — a continuously auto-scrolling marquee of recent cases from
 *  the active dataset. Pauses on hover; clicking a row flies the map to that
 *  case's last-seen location (via onFocus). Newly-registered cases (passed in
 *  via newCaseIds) render with a NEW badge and a flash so the control center
 *  notices them. */
export default function LostFoundFeed({ data, now, onFocus, newCaseIds }) {
  const items = useMemo(() => feedItems(data, { limit: 40 }), [data]);
  const newSet = useMemo(() => new Set(newCaseIds || []), [newCaseIds]);

  if (!items.length) {
    return (
      <div className="feed empty">
        <span className="feed-empty"><Icon name="inbox" /> Waiting for cases to sync from the kendra box…</span>
      </div>
    );
  }

  // Sort new cases to the front so they're visible immediately, but keep the
  // rest in feed order.
  const ordered = [...items].sort((a, b) => {
    const an = newSet.has(a.case_id) ? 0 : 1;
    const bn = newSet.has(b.case_id) ? 0 : 1;
    return an - bn;
  });

  // Duplicate the list so the translateX(-50%) marquee loops seamlessly.
  const loop = [...ordered, ...ordered];

  function clickRow(it) {
    if (!onFocus) return;
    const coord = caseCoord(it.case_id, data);
    if (coord) onFocus(it.case_id, coord.lat, coord.lng);
  }

  return (
    <div className="feed" role="region" aria-label="Recent lost and found cases">
      <div className="feed-label">
        <span className="feed-dot" /> Live feed
      </div>
      <div className="feed-track" tabIndex={0}>
        <ul className="feed-strip">
          {loop.map((it, i) => {
            const isNew = newSet.has(it.case_id);
            return (
              <li
                key={`${it.case_id}-${i}`}
                className={`feed-row ${it.kind} ${isNew ? 'new' : ''}`}
                onClick={() => clickRow(it)}
                title={`Focus ${it.case_id} on map`}
              >
                <span className={`feed-status ${it.kind}`} />
                {isNew && <span className="feed-new">NEW</span>}
                <span className="feed-name">{it.name}</span>
                <span className="feed-meta">{[it.gender, it.age_band].filter(Boolean).join(' · ')}</span>
                <span className="feed-loc">{it.last_seen_location || '—'}</span>
                <span className="feed-time">{relativeTime(it.reported_at, now)}</span>
                <span className={`feed-kind ${it.kind}`}>{it.kind}</span>
              </li>
            );
          })}
        </ul>
      </div>
    </div>
  );
}
