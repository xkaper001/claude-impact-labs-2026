import React, { useEffect, useMemo, useState } from 'react';
import { runSearch, buildPromptForClaude } from '../lib/engine.js';
import { complete } from '../lib/llm.js';
import { audit } from '../lib/db.js';

function bandClass(b) {
  if (!b) return 'band-low';
  return b === 'high' ? 'band-high' : b === 'medium' ? 'band-mid' : 'band-low';
}

export default function MatchResults({ tr, lang, query, data, online, onBack }) {
  const [llmText, setLlmText] = useState('');
  const [llmPending, setLlmPending] = useState(false);
  const [llmBusy, setLlmBusy] = useState(false);

  const result = useMemo(() => {
    if (!query) return null;
    return runSearch(query, data, { mode: 'A', now: query.reportedAt });
  }, [query, data]);

  async function explain() {
    setLlmBusy(true);
    const prompt = buildPromptForClaude(query, data, { phase: 2 });
    const out = await complete(prompt, { capability: 'explain' });
    setLlmBusy(false);
    setLlmText(out.text || '');
    setLlmPending(out.pending);
    if (out.text) audit({ type: 'explain', caseQuery: query });
  }

  if (!result) return null;
  const top = result.matches || [];

  return (
    <div className="matches">
      <button className="btn ghost" onClick={onBack} style={{ marginBottom: 16 }}>{tr('back')}</button>
      <h2>{tr('matches')}</h2>

      {top.length === 0 && <div className="meta">{tr('noMatches')}</div>}

      {top.map((m, i) => {
        const r = m.record || m;
        const breakdown = m.breakdown || {};
        return (
          <div className="match" key={r.case_id || i}>
            <div className="top">
              <div className="name">{r.missing_person_name || '(no name)'} <span className="meta">· {r.case_id}</span></div>
              <div className={`score ${bandClass(m.band)}`}>{m.score != null ? m.score : ''}{m.band ? ` · ${m.band}` : ''}</div>
            </div>
            <div className="meta">
              {r.gender}, {r.age_band || r.ageApprox} · {r.last_seen_location} · {r.reporting_center}
            </div>
            <div className="meta">{r.physical_description}</div>
            {m.chokepoint && <div className="meta">⚠ Near {m.chokepoint.name} ({m.chokepoint.riskLevel} risk, {m.chokepoint.distanceM}m)</div>}
            <div className="breakdown">
              {Object.entries(breakdown).map(([k, v]) => (
                <span key={k} className={`chip ${v.assessed ? 'ok' : ''}`}>
                  {k}: {v.points}/{v.max}
                </span>
              ))}
            </div>
            {(m.warnings || []).map((w, j) => <div className="flag" key={j}>{w.message || w}</div>)}
            {(m.escalationFlags || []).map((f, j) => <div className="flag" key={`e${j}`}>{f.message}</div>)}
          </div>
        );
      })}

      <div className="actions" style={{ marginTop: 18 }}>
        <button className="btn" onClick={explain} disabled={llmBusy || !online}>
          {llmBusy ? '…' : 'Explain with Claude'}
        </button>
        {!online && <span className="hint">{tr('semanticPending')}</span>}
      </div>

      {llmText && <div className="llm-out">{llmText}</div>}
      {llmPending && <div className="hint">{tr('semanticPending')}</div>}
    </div>
  );
}
