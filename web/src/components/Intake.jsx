import React, { useRef, useState } from 'react';
import { saveCase } from '../lib/db.js';
import { transcribe } from '../lib/llm.js';
import { recordAudio, stopRecorder } from '../lib/voice.js';

const LOCATIONS = [
  'Ramkund Ghat', 'Panchavati Circle', 'Dwarka Circle', 'Nashik Road Railway Station',
  'Kumbh Mela Ground', 'Godavari Ghat', 'Tapovan', 'Nashik CBS Bus Stand',
];

export default function Intake({ tr, lang, mode, onBack, onSearched }) {
  const [form, setForm] = useState({
    missing_person_name: '',
    ageApprox: '',
    gender: 'Male',
    state: '',
    last_seen_location: 'Ramkund Ghat',
    physical_description: '',
    reported_at: new Date().toISOString().slice(0, 16).replace('T', ' '),
  });
  const [recording, setRecording] = useState(false);
  const [busy, setBusy] = useState(false);
  const [sttNote, setSttNote] = useState('');
  const recPromise = useRef(null);

  function set(k, v) {
    setForm((f) => ({ ...f, [k]: v }));
  }

  async function toggleVoice() {
    if (recording) {
      stopRecorder(recPromise.current);
      setRecording(false);
      setBusy(true);
      const blob = await recPromise.current;
      const out = await transcribe(blob, { language: lang });
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
      case_id: `loc-${Date.now()}`,
      reporting_center: mode,
      status: 'pending',
      is_duplicate_report: 'No',
    };
    await saveCase(record);
    if (searchToo) {
      onSearched({
        name: form.missing_person_name || undefined,
        gender: form.gender,
        ageApprox: form.ageApprox ? Number(form.ageApprox) : undefined,
        state: form.state || undefined,
        lastSeenLocation: form.last_seen_location,
        description: form.physical_description,
        reportedAt: form.reported_at,
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
    });
  }

  return (
    <div className="intake">
      <h2>{mode === 'lost' ? tr('iLostSomeone') : tr('iFoundSomeone')}</h2>
      <div className="voice-bar">
        <button className={`btn ${recording ? 'danger' : 'ghost'}`} onClick={toggleVoice} disabled={busy}>
          {recording ? tr('stop') + ' \u25CF' : tr('speak')}
        </button>
        {busy && <span className="hint">transcribing…</span>}
        {sttNote && <span className="hint">{sttNote}</span>}
      </div>

      <div className="field">
        <label>{tr('name')}</label>
        <input value={form.missing_person_name} onChange={(e) => set('missing_person_name', e.target.value)} />
      </div>

      <div className="row">
        <div className="field">
          <label>{tr('age')}</label>
          <input type="number" value={form.ageApprox} onChange={(e) => set('ageApprox', e.target.value)} />
        </div>
        <div className="field">
          <label>{tr('gender')}</label>
          <select value={form.gender} onChange={(e) => set('gender', e.target.value)}>
            <option>{tr('male')}</option>
            <option>{tr('female')}</option>
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
          <select value={form.last_seen_location} onChange={(e) => set('last_seen_location', e.target.value)}>
            {LOCATIONS.map((l) => <option key={l}>{l}</option>)}
          </select>
        </div>
      </div>

      <div className="field">
        <label>{tr('description')}</label>
        <textarea rows={3} value={form.physical_description}
          onChange={(e) => set('physical_description', e.target.value)}
          placeholder="elderly man, white kurta, rudraksha mala…" />
      </div>

      <div className="actions">
        <button className="btn ghost" onClick={onBack}>{tr('back')}</button>
        <button className="btn ghost" onClick={quickMatch}>{tr('search')}</button>
        <button className="btn" onClick={() => submit(true)}>{tr('save')} + {tr('search')}</button>
      </div>
    </div>
  );
}
