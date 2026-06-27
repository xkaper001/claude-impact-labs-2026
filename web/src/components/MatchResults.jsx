import React, { useEffect, useMemo, useState } from 'react';
import Icon from './Icon.jsx';
import {
  runSearch, buildPromptForClaude,
  buildSemanticPrompt, parseSemanticScores, rerankWithSemantic,
} from '../lib/engine.js';
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
  const [reranked, setReranked] = useState(null); // Claude-sharpened matches
  const [rerankBusy, setRerankBusy] = useState(false);
  const [rerankNote, setRerankNote] = useState('');

  const result = useMemo(() => {
    if (!query || !data.config) return null;
    return runSearch(query, data, { mode: query.mode || 'A', now: query.reportedAt });
  }, [query, data]);

  // A fresh search invalidates any previous Claude re-rank.
  useEffect(() => { setReranked(null); setRerankNote(''); }, [result]);

  async function explain() {
    setLlmBusy(true);
    const prompt = buildPromptForClaude(query, data, { phase: 2 });
    const out = await complete(prompt, { capability: 'explain' });
    setLlmBusy(false);
    setLlmText(out.text || '');
    setLlmPending(out.pending);
    if (out.text) audit({ type: 'explain', caseQuery: query });
  }

  // Make AI real on the ranking: Claude scores each candidate's description
  // semantically; those numbers re-score and re-sort the deterministic matches.
  async function sharpen() {
    const base = result?.matches || [];
    if (!base.length) return;
    setRerankBusy(true);
    setRerankNote('');
    const prompt = buildSemanticPrompt(query, base, data.config);
    const out = await complete(prompt, { capability: 'semanticDescription' });
    setRerankBusy(false);
    if (out.pending || !out.text) { setRerankNote(tr('semanticPending')); return; }
    const scores = parseSemanticScores(out.text);
    if (!Object.keys(scores).length) { setRerankNote('Could not read Claude scores — keeping offline ranking.'); return; }
    setReranked(rerankWithSemantic(query, data, base, scores));
    audit({ type: 'semantic_rerank', caseQuery: query, scored: Object.keys(scores).length });
  }

  if (!data.config) {
    return (
      <div className="page wide">
        <div className="page-head">
          <button className="icon-btn" onClick={onBack} aria-label={tr('back')}><Icon name="back" /></button>
          <h2>{tr('matches')}</h2>
        </div>
        <div className="card card-pad empty">
          <div className="empty-ico"><Icon name="inbox" /></div>
          <h3>Waiting for data</h3>
          <p>Syncing from the kendra box…</p>
          <div style={{ maxWidth: 280, margin: '20px auto 0', display: 'grid', gap: 10 }}>
            <div className="skeleton-line" style={{ width: '100%' }} />
            <div className="skeleton-line" style={{ width: '80%' }} />
            <div className="skeleton-line" style={{ width: '60%' }} />
          </div>
        </div>
      </div>
    );
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

  return (
    <div className="page wide">
      <div className="page-head">
        <button className="icon-btn" onClick={onBack} aria-label={tr('back')}><Icon name="back" /></button>
        <div>
          <h2>{tr('matches')}</h2>
          <div className="sub">{top.length} {top.length === 1 ? 'result' : 'results'}, ranked by confidence</div>
        </div>
      </div>

      {summary.length > 0 && (
        <div className="query-summary">
          {summary.map((s, i) => <span className="tag" key={i}>{s}</span>)}
        </div>
      )}

      {top.length === 0 && (
        <div className="card card-pad empty">
          <div className="empty-ico"><Icon name="search" /></div>
          <h3>{tr('noMatches')}</h3>
          <p>Try fewer details, or check the ops map for nearby hotspots.</p>
        </div>
      )}

      {top.map((m, i) => {
        const r = m.record || m;
        const breakdown = m.breakdown || {};
        return (
          <div className={`match ${bandClass(m.band)}`} key={r.case_id || i}>
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
                <Icon name="alert" />
                Near {m.chokepoint.name} · {m.chokepoint.riskLevel} risk · {m.chokepoint.distanceM}m
              </div>
            )}

            <div className="breakdown">
              {Object.entries(breakdown).map(([k, v]) => (
                <span key={k} className={`chip ${v.assessed ? 'ok' : ''}`}>
                  {k}: {v.points}/{v.max}
                </span>
              ))}
            </div>

            {(m.warnings || []).map((w, j) => (
              <div className="flag" key={j}><Icon name="alert" /> {w.message || w}</div>
            ))}
            {(m.escalationFlags || []).map((f, j) => (
              <div className="flag" key={`e${j}`}><Icon name="alert" /> {f.message}</div>
            ))}
          </div>
        );
      })}

      <div style={{ marginTop: 18, display: 'flex', alignItems: 'center', gap: 12, flexWrap: 'wrap' }}>
        <button className="btn" onClick={sharpen} disabled={rerankBusy || !online || top.length === 0}>
          <Icon name="spark" /> {rerankBusy ? 'Scoring…' : reranked ? 'Re-sharpen ranking' : 'Sharpen ranking with Claude'}
        </button>
        <button className="btn ghost" onClick={explain} disabled={llmBusy || !online}>
          <Icon name="spark" /> {llmBusy ? 'Thinking…' : 'Explain with Claude'}
        </button>
        {reranked && <span className="hint">Ranking sharpened by Claude (semantic description).</span>}
        {rerankNote && <span className="hint">{rerankNote}</span>}
        {!online && <span className="hint">{tr('semanticPending')}</span>}
      </div>

      {llmText && (
        <div className="llm-out">
          <div className="llm-out-head"><Icon name="spark" /> Claude explanation</div>
          {llmText}
        </div>
      )}
      {llmPending && <p className="hint" style={{ marginTop: 10 }}>{tr('semanticPending')}</p>}
    </div>
  );
}
