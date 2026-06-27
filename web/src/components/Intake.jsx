import React, { useEffect, useMemo, useRef, useState } from 'react';
import Icon from './Icon.jsx';
import { saveCase, audit, centerId } from '../lib/db.js';
import { transcribe, complete } from '../lib/llm.js';
import { recordAudio, stopRecorder } from '../lib/voice.js';
import { locationVocab, submitCaseToQuery, ageBandFromApprox, buildStructurePrompt, parseStructureFields } from '../lib/engine.js';
import { startVoiceAgent, VOICE_LANGS } from '../lib/voiceAgent.js';

// UI language (en/hi/mr) → default pinned voice language (BCP-47).
const UI_TO_BCP47 = { en: 'en-IN', hi: 'hi-IN', mr: 'mr-IN' };

// Fallback list, used only before the dataset has synced in from CouchDB.
const FALLBACK_LOCATIONS = [
  'Ramkund Ghat', 'Panchavati Circle', 'Dwarka Circle', 'Nashik Road Railway Station',
  'Kumbh Mela Ground', 'Godavari Ghat', 'Tapovan', 'Nashik CBS Bus Stand',
];

// Representative numeric age for a band, used when Claude's structure output
// gives an age_band but no age_approx (the form collects a numeric age).
const BAND_MID = { '0-12': 8, '13-17': 15, '18-40': 29, '41-60': 50, '61-70': 65, '71-80': 75, '80+': 82 };

const AGENT_STATE_LABEL = {
  connecting: 'Connecting to the voice agent…',
  listening: 'Listening — speak with the family.',
  thinking: 'Thinking…',
  speaking: 'Speaking…',
  closed: 'Voice session ended.',
};

export default function Intake({ tr, lang, mode, config, data, online, onBack, onSearched, onCaseSaved }) {
  // Real last-seen vocabulary from the active dataset; falls back before sync.
  const locations = useMemo(() => {
    const v = locationVocab(data || {});
    return v.length ? v : FALLBACK_LOCATIONS;
  }, [data]);

  // Deepgram voice intake is an online-only enhancement; falls back to the typed
  // form + Whisper.cpp box offline. config:scoring.voice gates it.
  const voiceCfg = (config || data?.config || {}).voice || {};
  const voiceAgentDoc = data?.voiceAgent || null;
  const canVoiceAgent = !!online && voiceCfg.enabled !== false;

  const [form, setForm] = useState({
    missing_person_name: '',
    ageApprox: '',
    gender: 'Male',
    state: '',
    last_seen_location: '',
    physical_description: '',
    reporter_mobile: '',
    reported_at: new Date().toISOString().slice(0, 16).replace('T', ' '),
  });
  // Pinned conversation language. Defaults to the UI language so the session is
  // single-language out of the box; 'auto' restores mirror-the-family behavior.
  const [agentLang, setAgentLang] = useState(UI_TO_BCP47[lang] || 'hi-IN');
  const [recording, setRecording] = useState(false);
  const [busy, setBusy] = useState(false);
  const [sttNote, setSttNote] = useState('');
  const [structuring, setStructuring] = useState(false);
  const [structNote, setStructNote] = useState('');
  const recPromise = useRef(null);

  // Voice-agent session state.
  const [agentState, setAgentState] = useState('idle'); // idle|connecting|listening|thinking|speaking|closed|error
  const [agentErr, setAgentErr] = useState('');
  const [lines, setLines] = useState([]); // {role, content}
  const agentRef = useRef(null);

  function set(k, v) {
    setForm((f) => ({ ...f, [k]: v }));
  }

  // Tear the agent down if the component unmounts mid-session.
  useEffect(() => () => { if (agentRef.current) agentRef.current.stop(); }, []);

  function stopAgent() {
    if (agentRef.current) { agentRef.current.stop(); agentRef.current = null; }
  }

  async function startAgent() {
    if (agentRef.current) { stopAgent(); setAgentState('idle'); return; }
    setAgentErr('');
    setLines([]);
    setAgentState('connecting');
    try {
      agentRef.current = await startVoiceAgent({
        mode,
        lang: agentLang,
        voice: voiceCfg,
        voiceAgent: voiceAgentDoc,
        onEvent: (e) => {
          if (e.type === 'state') setAgentState(e.state);
          else if (e.type === 'transcript') setLines((ls) => [...ls, { role: e.role, content: e.content }]);
          else if (e.type === 'error') { setAgentErr(e.reason); setAgentState('error'); }
        },
        onSubmitCase: (args) => {
          // The agent gathered the report → persist + auto-run the engine.
          const searchMode = (args.mode || mode) === 'found' ? 'B' : 'A';
          const record = {
            missing_person_name: args.missing_person_name || '',
            age_band: args.age_band || '',
            ageApprox: args.age_approx || '',
            gender: args.gender || '',
            state: args.state || '',
            last_seen_location: args.last_seen_location || '',
            physical_description: args.physical_description || '',
            reporter_mobile: args.reporter_mobile || '',
            reported_at: new Date().toISOString().slice(0, 16).replace('T', ' '),
            case_id: `loc-${Date.now()}`,
            reporting_center: centerId(),
            report_type: (args.mode || mode) === 'found' ? 'found' : 'lost',
            status: 'pending',
            is_duplicate_report: 'No',
          };
          saveCase(record).catch(() => {});
          audit({ type: 'voice_intake', mode, fields: Object.keys(args) }).catch(() => {});
          if (onCaseSaved) onCaseSaved(record.case_id, mode);
          stopAgent();
          onSearched({ ...submitCaseToQuery(args), mode: searchMode, caseId: record.case_id });
        },
      });
    } catch (e) {
      setAgentErr(e.message || 'voice_unavailable');
      setAgentState('error');
      agentRef.current = null;
    }
  }

  async function toggleVoice() {
    if (recording) {
      stopRecorder(recPromise.current);
      setRecording(false);
      setBusy(true);
      const blob = await recPromise.current;
      // Pin description transcription to the chosen voice language too (ISO base,
      // e.g. 'hi' from 'hi-IN'); 'auto' falls back to the UI language.
      const sttLang = agentLang && agentLang !== 'auto' ? agentLang.split('-')[0] : lang;
      const out = await transcribe(blob, { language: sttLang });
      setBusy(false);
      if (out.text) {
        setForm((f) => ({ ...f, physical_description: out.text }));
        setSttNote(out.box ? 'transcribed via kendra box' : 'transcribed');
      } else {
        setSttNote(tr('voiceUnsupported'));
      }
      return;
    }
    try {
      recPromise.current = await recordAudio();
      setRecording(true);
    } catch {
      setSttNote(tr('voiceUnsupported'));
    }
  }

  async function submit(searchToo) {
    const record = {
      ...form,
      age_band: ageBandFromApprox(form.ageApprox),
      case_id: `loc-${Date.now()}`,
      reporting_center: centerId(),
      report_type: mode === 'found' ? 'found' : 'lost',
      status: 'pending',
      is_duplicate_report: 'No',
    };
    await saveCase(record);
    if (onCaseSaved) onCaseSaved(record.case_id, mode);
    if (searchToo) {
      onSearched({
        name: form.missing_person_name || undefined,
        gender: form.gender,
        ageApprox: form.ageApprox ? Number(form.ageApprox) : undefined,
        state: form.state || undefined,
        lastSeenLocation: form.last_seen_location,
        description: form.physical_description,
        reportedAt: form.reported_at,
        mode: mode === 'found' ? 'B' : 'A',
        caseId: record.case_id,
      });
    } else {
      onBack();
    }
  }

  // Quick local dry-run so the operator sees matches immediately, even offline.
  function quickMatch() {
    onSearched({
      name: form.missing_person_name || undefined,
      gender: form.gender,
      ageApprox: form.ageApprox ? Number(form.ageApprox) : undefined,
      state: form.state || undefined,
      lastSeenLocation: form.last_seen_location,
      description: form.physical_description,
      reportedAt: form.reported_at,
      mode: mode === 'found' ? 'B' : 'A',
    });
  }

  // Optional AI structuring of the typed free-text into form fields. Online-only;
  // disabled when offline or there's nothing to structure. Preserves any field
  // the operator already filled (Claude output only fills empty/blank fields).
  async function runStructure() {
    if (!online || structuring) return;
    const raw = [form.missing_person_name, form.last_seen_location, form.physical_description]
      .filter(Boolean).join(' · ');
    if (!raw.trim()) return;
    setStructuring(true);
    setStructNote('');
    try {
      const out = await complete(buildStructurePrompt(raw), { capability: 'structure' });
      setStructuring(false);
      if (out.pending || !out.text) { setStructNote(tr('structureFailed')); return; }
      const fields = parseStructureFields(out.text);
      if (!Object.keys(fields).length) { setStructNote(tr('structureFailed')); return; }
      setForm((f) => {
        const next = { ...f };
        const take = (k, v) => { if (v !== '' && v != null && String(next[k] ?? '').trim() === '') next[k] = v; };
        take('missing_person_name', fields.missing_person_name);
        take('state', fields.state);
        take('last_seen_location', fields.last_seen_location);
        take('physical_description', fields.physical_description);
        take('reporter_mobile', fields.reporter_mobile);
        take('gender', fields.gender);
        // Age: prefer an explicit numeric age_approx; else derive from the band.
        if (fields.age_approx && String(fields.age_approx) !== '0' && String(next.ageApprox).trim() === '') {
          next.ageApprox = String(fields.age_approx);
        } else if (fields.age_band && BAND_MID[fields.age_band] && String(next.ageApprox).trim() === '') {
          next.ageApprox = String(BAND_MID[fields.age_band]);
        }
        return next;
      });
      setStructNote(tr('structured'));
      audit({ type: 'structure', fields: Object.keys(fields) }).catch(() => {});
    } catch {
      setStructuring(false);
      setStructNote(tr('structureFailed'));
    }
  }

  const isLost = mode === 'lost';
  return (
    <div className="page">
      <div className="page-head">
        <button className="icon-btn" onClick={onBack} aria-label={tr('back')}><Icon name="back" /></button>
        <div>
          <h2>{isLost ? tr('iLostSomeone') : tr('iFoundSomeone')}</h2>
          <div className="sub">Fill what you know. Partial details still match.</div>
        </div>
        <span className={`mode-pill ${isLost ? 'lost' : 'found'}`}>
          <span className="dot" />{isLost ? 'Lost' : 'Found'}
        </span>
      </div>

      <div className="card card-pad">
        <p className="section-label">Talk to family (AI voice agent)</p>
        <div className="field lang-pick">
          <label>Conversation language</label>
          <select
            value={agentLang}
            onChange={(e) => setAgentLang(e.target.value)}
            disabled={!!agentRef.current}
          >
            {VOICE_LANGS.map((l) => <option key={l.code} value={l.code}>{l.label}</option>)}
          </select>
        </div>
        <div className="voice-bar">
          <button
            className={`btn rec-btn ${agentRef.current ? 'danger' : ''}`}
            onClick={startAgent}
            disabled={!canVoiceAgent}
          >
            {agentRef.current
              ? <><span className="rec-dot" /> {tr('stop')}</>
              : <><Icon name="mic" /> Talk to family</>}
          </button>
          {!online && <span className="voice-hint">Voice agent needs internet — use the form below offline.</span>}
          {online && agentState !== 'idle' && agentState !== 'error' && (
            <span className="voice-hint">{AGENT_STATE_LABEL[agentState] || agentState}</span>
          )}
          {agentErr && <span className="voice-hint">Voice agent unavailable ({agentErr}). Use the form below.</span>}
        </div>
        {lines.length > 0 && (
          <div className="agent-transcript">
            {lines.map((l, i) => (
              <div key={i} className={`agent-line ${l.role === 'assistant' ? 'agent' : 'user'}`}>
                <span className="who">{l.role === 'assistant' ? 'Agent' : 'Family'}</span>
                <span className="said">{l.content}</span>
              </div>
            ))}
          </div>
        )}
        <p className="voice-hint" style={{ marginTop: 8 }}>
          The agent speaks with the family in their language, then logs the report and searches automatically.
        </p>
      </div>

      <div className="card card-pad">
        <p className="section-label">Or capture description by voice</p>
        <div className="voice-bar">
          <button
            className={`btn rec-btn ${recording ? 'danger' : 'ghost'}`}
            onClick={toggleVoice}
            disabled={busy}
          >
            {recording
              ? <><span className="rec-dot" /> {tr('stop')}</>
              : <><Icon name="mic" /> {tr('speak')}</>}
          </button>
          {busy && <span className="voice-hint">transcribing…</span>}
          {!busy && sttNote && <span className="voice-hint">{sttNote}</span>}
          {!busy && !sttNote && <span className="voice-hint">Speak the description, it fills the field below.</span>}
        </div>
      </div>

      <div className="card card-pad">
        <p className="section-label">Person details</p>
        <div className="field">
          <label>{tr('name')}</label>
          <input value={form.missing_person_name} onChange={(e) => set('missing_person_name', e.target.value)} placeholder="If known" />
        </div>

        <div className="row">
          <div className="field">
            <label>{tr('age')}</label>
            <input type="number" value={form.ageApprox} onChange={(e) => set('ageApprox', e.target.value)} placeholder="e.g. 62" />
          </div>
          <div className="field">
            <label>{tr('gender')}</label>
            <select value={form.gender} onChange={(e) => set('gender', e.target.value)}>
              <option>{tr('male')}</option>
              <option>{tr('female')}</option>
              <option>{tr('other')}</option>
            </select>
          </div>
        </div>

        <div className="row">
          <div className="field">
            <label>{tr('state')}</label>
            <input value={form.state} onChange={(e) => set('state', e.target.value)} placeholder="Bihar / UP / …" />
          </div>
          <div className="field">
            <label>{tr('lastSeen')}</label>
            <input list="loc-vocab" value={form.last_seen_location}
              onChange={(e) => set('last_seen_location', e.target.value)}
              placeholder="near Ramkund / type a landmark" />
            <datalist id="loc-vocab">
              {locations.map((l) => <option key={l} value={l} />)}
            </datalist>
          </div>
        </div>

        <div className="field">
          <label>{tr('mobile')}</label>
          <input value={form.reporter_mobile} onChange={(e) => set('reporter_mobile', e.target.value)} placeholder="+91 … (one contact is enough)" />
        </div>

        <div className="field">
          <label>{tr('description')}</label>
          <textarea rows={3} value={form.physical_description}
            onChange={(e) => set('physical_description', e.target.value)}
            placeholder="elderly man, white kurta, rudraksha mala…" />
        </div>

        <div className="voice-bar" style={{ marginTop: 8 }}>
          <button
            className="btn sm ghost"
            onClick={runStructure}
            disabled={!online || structuring || !form.physical_description}
          >
            <Icon name="spark" /> {structuring ? tr('structuring') : tr('structure')}
          </button>
          {structuring && <span className="voice-hint">{tr('structuring')}</span>}
          {!structuring && structNote && <span className="voice-hint">{structNote}</span>}
          {!structuring && !structNote && online && <span className="voice-hint">Paste a Hindi/English note, then fill the fields from it.</span>}
          {!online && <span className="voice-hint">Online only — type the fields manually.</span>}
        </div>
      </div>

      <div className="action-bar">
        <div className="inner">
          <button className="btn ghost" onClick={onBack}>{tr('back')}</button>
          <span className="spacer" />
          <button className="btn ghost" onClick={quickMatch}>
            <Icon name="search" /> {tr('search')}
          </button>
          <button className="btn" onClick={() => submit(true)}>
            {tr('save')}
          </button>
        </div>
      </div>
    </div>
  );
}
