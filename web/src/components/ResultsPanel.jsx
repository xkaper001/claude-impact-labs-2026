import React, { useEffect, useMemo, useState } from 'react';
import Icon from './Icon.jsx';
import {
  buildPromptForClaude, buildSemanticPrompt, parseSemanticScores, rerankWithSemantic,
} from '../lib/engine.js';
import { complete } from '../lib/llm.js';
import { audit } from '../lib/db.js';

function bandClass(b) {
  if (!b) return 'band-low';
  return b === 'high' ? 'band-high' : b === 'medium' ? 'band-mid' : 'band-low';
}

/** ResultsPanel — slides in over the hero map when a search runs. Compact,
 *  scrollable list of ranked matches with the per-field breakdown, warnings,
 *  escalation flags, the Claude sharpen/explain actions, and a scenario
 *  summary (zone, nearest chokepoint, nearest police station, hotspot). */
export default function ResultsPanel({ tr, lang, query, data, result, scenario, online, onClose, onFocusMatch }) {
  const [llmText, setLlmText] = useState('');
  const [llmPending, setLlmPending] = useState(false);
  const [llmBusy, setLlmBusy] = useState(false);
  const [llmNote, setLlmNote] = useState('');
  const [reranked, setReranked] = useState(null);
  const [rerankBusy, setRerankBusy] = useState(false);
  const [rerankNote, setRerankNote] = useState('');

  // A fresh search invalidates any previous Claude re-rank.
  useEffect(() => { setReranked(null); setRerankNote(''); setLlmText(''); setLlmNote(''); }, [result]);

  // Turn an offline/pending LLM outcome into a user-facing hint. A specific
  // reason (no_api_key, http_500, …) is shown verbatim so the operator knows
  // it's a config issue, not just "offline".
  function pendingNote(out) {
    if (out && out.reason && out.reason !== 'offline') return `AI unavailable: ${out.reason}`;
    return tr('semanticPending');
  }

  async function explain() {
    setLlmBusy(true);
    setLlmNote('');
    const prompt = buildPromptForClaude(query, data, { phase: 2 });
    const out = await complete(prompt, { capability: 'explain' });
    setLlmBusy(false);
    setLlmText(out.text || '');
    setLlmPending(out.pending);
    setLlmNote(out.pending ? pendingNote(out) : '');
    if (out.text) audit({ type: 'explain', caseQuery: query });
  }

  async function sharpen() {
    const base = result?.matches || [];
    if (!base.length) return;
    setRerankBusy(true);
    setRerankNote('');
    const prompt = buildSemanticPrompt(query, base, data.config);
    const out = await complete(prompt, { capability: 'semanticDescription' });
    setRerankBusy(false);
    if (out.pending || !out.text) { setRerankNote(pendingNote(out)); return; }
    const scores = parseSemanticScores(out.text);
    if (!Object.keys(scores).length) { setRerankNote('Could not read Claude scores — keeping offline ranking.'); return; }
    setReranked(rerankWithSemantic(query, data, base, scores));
    audit({ type: 'semantic_rerank', caseQuery: query, scored: Object.keys(scores).length });
  }

  if (!result) return null;
  const top = reranked || result.matches || [];

  const summary = [
    query?.name,
    query?.gender,
    query?.ageApprox ? `~${query.ageApprox}y` : null,
    query?.state,
    query?.lastSeenLocation,
  ].filter(Boolean);

  const sc = scenario || {};
  const scenarioRows = [
    sc.focus && { k: 'Zone', v: sc.focus.name || 'last seen' },
    sc.nearestChokepoint && { k: 'Chokepoint', v: `${sc.nearestChokepoint.name} · ${sc.nearestChokepoint.riskLevel} · ${sc.nearestChokepoint.distanceM}m` },
    sc.nearestStation && { k: 'Nearest police', v: `${sc.nearestStation.name} · ${sc.nearestStation.distanceM}m` },
    sc.hotspot && { k: 'Nearby hotspot', v: `${sc.hotspot.caseCount} open cases · ${sc.hotspot.riskLevel}` },
  ].filter(Boolean);

  return (
    <aside className="results-panel" role="complementary" aria-label={tr('matches')}>
      <div className="results-head">
        <div>
          <h3>{tr('matches')}</h3>
          <div className="sub">{top.length} {top.length === 1 ? 'result' : 'results'} · {result.recordsSearched} searched</div>
        </div>
        <button className="icon-btn" onClick={onClose} aria-label="Close results"><Icon name="back" /></button>
      </div>

      {summary.length > 0 && (
        <div className="query-summary">
          {summary.map((s, i) => <span className="tag" key={i}>{s}</span>)}
        </div>
      )}

      <div className="results-scroll">
        {top.length === 0 && (
          <div className="card card-pad empty small">
            <div className="empty-ico"><Icon name="search" /></div>
            <h4>{tr('noMatches')}</h4>
            <p>{result.candidatesConsidered === 0
              ? (query?.mode === 'A' ? tr('noFoundPool') : tr('noLostPool'))
              : 'Try fewer details, or check the ops map for nearby hotspots.'}</p>
          </div>
        )}

        {top.map((m, i) => {
          const r = m.record || m;
          const breakdown = m.breakdown || {};
          return (
            <div
              className={`match compact ${bandClass(m.band)}`}
              key={r.case_id || i}
              onClick={() => onFocusMatch && onFocusMatch(m)}
              role="button"
              tabIndex={0}
              onKeyDown={(e) => { if ((e.key === 'Enter' || e.key === ' ') && onFocusMatch) { e.preventDefault(); onFocusMatch(m); } }}
              title="Focus this match on the map"
            >
              <div className="top">
                <div>
                  <div className="name">{r.missing_person_name || '(no name)'}</div>
                  <div className="case-id">{r.case_id}</div>
                </div>
                {m.score != null && (
                  <div className="score-badge">
                    <span className="num">{m.score}</span>
                    {m.band && <span className="band">{m.band}</span>}
                  </div>
                )}
              </div>
              <p className="meta">
                {[
                  [r.gender, r.age_band || r.ageApprox].filter(Boolean).join(', '),
                  r.last_seen_location,
                  r.reporting_center,
                ].filter(Boolean).join(' · ')}
              </p>
              {r.physical_description && <p className="meta dim">{r.physical_description}</p>}
              {m.chokepoint && (
                <div className="chokepoint">
                  <Icon name="alert" /> Near {m.chokepoint.name} · {m.chokepoint.riskLevel} · {m.chokepoint.distanceM}m
                </div>
              )}
              <div className="breakdown">
                {Object.entries(breakdown).map(([k, v]) => (
                  <span key={k} className={`chip ${v.assessed ? 'ok' : ''}`}>{k}: {v.points}/{v.max}</span>
                ))}
              </div>
              <div className="match-focus-hint"><Icon name="map" /> Zoom on map</div>
              {(m.warnings || []).map((w, j) => (
                <div className="flag" key={j}><Icon name="alert" /> {w.message || w}</div>
              ))}
              {(m.escalationFlags || []).map((f, j) => (
                <div className="flag" key={`e${j}`}><Icon name="alert" /> {f.message}</div>
              ))}
            </div>
          );
        })}

        {(result.warnings || []).map((w, j) => (
          <div className="flag" key={`w${j}`}><Icon name="alert" /> {w.message}</div>
        ))}
      </div>

      {scenarioRows.length > 0 && (
        <div className="scenario-card">
          <div className="scenario-title"><Icon name="map" /> Scenario</div>
          {scenarioRows.map((row, i) => (
            <div className="scenario-row" key={i}>
              <span className="k">{row.k}</span>
              <span className="v">{row.v}</span>
            </div>
          ))}
        </div>
      )}

      <div className="results-actions">
        <button className="btn sm" onClick={sharpen} disabled={rerankBusy || !online || top.length === 0}>
          <Icon name="spark" /> {rerankBusy ? 'Scoring…' : reranked ? 'Re-sharpen' : 'Sharpen'}
        </button>
        <button className="btn sm ghost" onClick={explain} disabled={llmBusy || !online}>
          <Icon name="spark" /> {llmBusy ? 'Thinking…' : 'Explain'}
        </button>
        {!online && <span className="hint">{tr('semanticPending')}</span>}
        {rerankNote && <span className="hint">{rerankNote}</span>}
      </div>

      {llmText && (
        <div className="llm-out small">
          <div className="llm-out-head"><Icon name="spark" /> Claude explanation</div>
          {llmText}
        </div>
      )}
      {llmPending && <p className="hint" style={{ marginTop: 6 }}>{llmNote || tr('semanticPending')}</p>}
    </aside>
  );
}
