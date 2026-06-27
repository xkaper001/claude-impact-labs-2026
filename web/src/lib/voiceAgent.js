// Voice intake agent (browser, online-only enhancement).
//
// Turn-based conversational loop we orchestrate ourselves — no single-vendor
// bundle. Each turn:
//   1. record the family's utterance (mic + client VAD silence-detect)
//   2. POST /api/voice-stt   → Sarvam AI Speech-to-Text (auto-detects the language)
//   3. POST /api/converse    → Claude (our key) with the submit_case tool
//   4. POST /api/voice-tts   → Sarvam AI Text-to-Speech in the family's OWN language
//      → play, then loop back to (1)
// When Claude calls submit_case we hand the structured record to the engine
// (see web/src/lib/engine.js submitCaseToQuery) and end the session.
//
// All secrets stay server-side; the browser only ever talks to /api/*.
//
// Offline: this whole module is bypassed (cloud STT/TTS/LLM). Intake falls back
// to the typed form + Whisper.cpp box (lib/voice.js). Search never blocks on it.

const SILENCE_RMS = 0.012; // below this = silence
const SILENCE_MS = 1200; // trailing silence that ends an utterance
const SPEECH_RMS = 0.02; // above this = speech has started
const MAX_UTTERANCE_MS = 20000; // hard cap per turn

// Bundled defaults so the agent works even before config:voiceAgent syncs in.
const DEFAULT_PROMPT =
  'You are Setu Voice Intake, a calm assistant helping a trained volunteer at a ' +
  'missing-person help center at the Kumbh Mela. Speak with the family in their ' +
  'own language (Hindi/Marathi/English) — reply in whichever they are using. Ask ' +
  'ONE short spoken question at a time, tolerate missing data, never ask for ' +
  'government IDs, never claim a match. Gather mode (lost/found), name, age band, ' +
  'gender, state, last-seen location, physical description, and time. Once you ' +
  'have mode plus an age or description plus a last-seen location, call ' +
  'submit_case with what you have (empty strings for unknowns), then tell the ' +
  'family the volunteer will check across all centers.';

const DEFAULT_GREETING =
  'Namaste. I am here to help. Please tell me — did you lose someone, or did you find someone?';

// Languages the operator can pin the session to. `auto` keeps the old behavior
// (Sarvam auto-detects, agent mirrors whatever the family speaks). Every other
// entry FORCES that one language across STT, the Claude reply, and TTS — no
// code-switching. `code` is the Sarvam/BCP-47 tag; `name` feeds the prompt.
export const VOICE_LANGS = [
  { code: 'auto', label: 'Auto-detect (mixed)', name: '' },
  { code: 'en-IN', label: 'English', name: 'English' },
  { code: 'hi-IN', label: 'हिन्दी (Hindi)', name: 'Hindi' },
  { code: 'mr-IN', label: 'मराठी (Marathi)', name: 'Marathi' },
  { code: 'bn-IN', label: 'বাংলা (Bengali)', name: 'Bengali' },
  { code: 'gu-IN', label: 'ગુજરાતી (Gujarati)', name: 'Gujarati' },
  { code: 'ta-IN', label: 'தமிழ் (Tamil)', name: 'Tamil' },
  { code: 'te-IN', label: 'తెలుగు (Telugu)', name: 'Telugu' },
  { code: 'kn-IN', label: 'ಕನ್ನಡ (Kannada)', name: 'Kannada' },
  { code: 'ml-IN', label: 'മലയാളം (Malayalam)', name: 'Malayalam' },
  { code: 'pa-IN', label: 'ਪੰਜਾਬੀ (Punjabi)', name: 'Punjabi' },
  { code: 'od-IN', label: 'ଓଡ଼ିଆ (Odia)', name: 'Odia' },
];

// Greeting spoken in the pinned language (so the very first TTS turn is on-
// language too). Falls back to DEFAULT_GREETING for `auto` / unknown codes.
const GREETINGS = {
  'en-IN': 'Hello. I am here to help. Did you lose someone, or did you find someone?',
  'hi-IN': 'नमस्ते। मैं आपकी मदद के लिए हूँ। क्या आपने किसी को खोया है, या आपको कोई मिला है?',
  'mr-IN': 'नमस्कार. मी तुमची मदत करण्यासाठी आहे. तुम्ही कुणाला हरवलंय का, की तुम्हाला कुणी सापडलंय?',
  'bn-IN': 'নমস্কার। আমি সাহায্য করতে এসেছি। আপনি কি কাউকে হারিয়েছেন, নাকি কাউকে খুঁজে পেয়েছেন?',
  'gu-IN': 'નમસ્તે. હું મદદ માટે છું. શું તમે કોઈને ગુમાવ્યું છે, કે તમને કોઈ મળ્યું છે?',
  'ta-IN': 'வணக்கம். நான் உதவ இருக்கிறேன். நீங்கள் யாரையாவது தொலைத்துவிட்டீர்களா, அல்லது யாரையாவது கண்டுபிடித்தீர்களா?',
  'te-IN': 'నమస్తే. నేను సహాయం చేయడానికి ఉన్నాను. మీరు ఎవరినైనా పోగొట్టుకున్నారా, లేదా ఎవరైనా మీకు దొరికారా?',
  'kn-IN': 'ನಮಸ್ಕಾರ. ನಾನು ಸಹಾಯ ಮಾಡಲು ಇದ್ದೇನೆ. ನೀವು ಯಾರನ್ನಾದರೂ ಕಳೆದುಕೊಂಡಿದ್ದೀರಾ, ಅಥವಾ ನಿಮಗೆ ಯಾರಾದರೂ ಸಿಕ್ಕಿದ್ದಾರಾ?',
  'ml-IN': 'നമസ്കാരം. ഞാൻ സഹായിക്കാൻ ഉണ്ട്. നിങ്ങൾക്ക് ആരെയെങ്കിലും നഷ്ടപ്പെട്ടോ, അതോ ആരെയെങ്കിലും കണ്ടെത്തിയോ?',
  'pa-IN': 'ਸਤ ਸ੍ਰੀ ਅਕਾਲ। ਮੈਂ ਮਦਦ ਲਈ ਹਾਂ। ਕੀ ਤੁਸੀਂ ਕਿਸੇ ਨੂੰ ਗੁਆਇਆ ਹੈ, ਜਾਂ ਤੁਹਾਨੂੰ ਕੋਈ ਮਿਲਿਆ ਹੈ?',
  'od-IN': 'ନମସ୍କାର। ମୁଁ ସାହାଯ୍ୟ ପାଇଁ ଅଛି। ଆପଣ କାହାକୁ ହରାଇଛନ୍ତି କି, ନା ଆପଣଙ୍କୁ କେହି ମିଳିଛନ୍ତି?',
};

const DEFAULT_SUBMIT_CASE = {
  name: 'submit_case',
  description:
    'Submit the structured missing/found person intake record. Missing fields allowed — pass empty strings.',
  input_schema: {
    type: 'object',
    properties: {
      mode: { type: 'string', enum: ['lost', 'found'] },
      missing_person_name: { type: 'string' },
      age_band: { type: 'string', enum: ['0-12', '13-17', '18-40', '41-60', '61-70', '71-80', '80+', ''] },
      age_approx: { type: 'integer' },
      gender: { type: 'string', enum: ['Male', 'Female', 'Other', ''] },
      state: { type: 'string' },
      last_seen_location: { type: 'string' },
      physical_description: { type: 'string' },
      last_seen_when: { type: 'string' },
      reporter_mobile: { type: 'string' },
    },
    required: ['mode', 'age_band', 'gender', 'last_seen_location', 'physical_description'],
  },
};

// The Anthropic API names the tool field `input_schema`; config:voiceAgent stores
// it as `parameters` (the JSON-schema body). Normalize either shape into a tool.
function toAnthropicTool(submitCase) {
  if (!submitCase) return DEFAULT_SUBMIT_CASE;
  if (submitCase.input_schema) return submitCase;
  if (submitCase.parameters) {
    const { parameters, ...rest } = submitCase;
    return { ...rest, input_schema: parameters };
  }
  return submitCase;
}

/**
 * Start a turn-based voice intake session.
 *
 * @param {object}   o
 * @param {'lost'|'found'} o.mode    intake mode (steers the agent + the search mode)
 * @param {object}   o.voiceAgent    the config:voiceAgent doc (prompt + submit_case schema)
 * @param {object}   o.voice         config.voice block (languages)
 * @param {function} o.onSubmitCase  (args) => void  — called with the submit_case payload
 * @param {function} o.onEvent       (evt) => void    — {type:'state'|'transcript'|'error', ...}
 * @returns {Promise<{stop: function}>}
 */
export async function startVoiceAgent({ mode, lang, voiceAgent, voice, onSubmitCase, onEvent } = {}) {
  const emit = (e) => { try { onEvent && onEvent(e); } catch { /* ignore */ } };
  const va = voiceAgent || {};

  // Pinned language: when the operator picked one, force it everywhere. `auto`
  // (or no choice) keeps the mirror-the-family behavior.
  const forceLang = lang && lang !== 'auto' ? lang : '';
  const langName = (VOICE_LANGS.find((l) => l.code === forceLang) || {}).name || '';

  // System prompt: the synced doc (or default) plus the mode the operator opened.
  const langDirective = forceLang
    ? `Speak ONLY in ${langName}. Every spoken reply must be in ${langName} and ` +
      `nothing else — never switch languages, even if the family mixes languages or ` +
      `replies in another tongue.`
    : `Reply in the family's own language.`;
  const system =
    `${va.systemPrompt || DEFAULT_PROMPT}\n\n` +
    `The operator opened this as a ${mode === 'found' ? 'FOUND' : 'LOST'} report. ` +
    `${langDirective} Keep every spoken reply short and plain ` +
    `(it is read aloud by a text-to-speech engine — no markdown, no lists).`;
  const tools = [toAnthropicTool(va.submitCase)];
  const greeting = forceLang
    ? (GREETINGS[forceLang] || va.greeting || DEFAULT_GREETING)
    : (va.greeting || DEFAULT_GREETING);

  emit({ type: 'state', state: 'connecting' });

  let stopped = false;
  let controller = null; // aborts the in-flight fetch
  let audioEl = null; // current TTS playback
  let mediaRecorder = null;
  let micStream = null;
  let inCtx = null;
  const messages = []; // Anthropic messages array (conversation state)
  // Language TTS replies in. Pinned when forced; otherwise tracks the language
  // the family last spoke (from STT).
  let lastLang = forceLang || ((voice && voice.tts) || {}).defaultLanguage || 'hi-IN';

  function abortInflight() {
    if (controller) { try { controller.abort(); } catch { /* ignore */ } controller = null; }
  }
  function stopAudio() {
    if (audioEl) { try { audioEl.pause(); } catch { /* ignore */ } audioEl = null; }
  }

  // --- 1. Mic ----------------------------------------------------------------
  try {
    micStream = await navigator.mediaDevices.getUserMedia({
      audio: { channelCount: 1, echoCancellation: true, noiseSuppression: true },
    });
  } catch {
    emit({ type: 'error', reason: 'mic_denied' });
    throw new Error('mic_denied');
  }
  inCtx = new (window.AudioContext || window.webkitAudioContext)();
  const analyser = inCtx.createAnalyser();
  analyser.fftSize = 1024;
  inCtx.createMediaStreamSource(micStream).connect(analyser);
  const buf = new Float32Array(analyser.fftSize);

  function rms() {
    analyser.getFloatTimeDomainData(buf);
    let sum = 0;
    for (let i = 0; i < buf.length; i++) sum += buf[i] * buf[i];
    return Math.sqrt(sum / buf.length);
  }

  // Record one utterance: wait for speech to start, then stop after trailing
  // silence (or the hard cap). Resolves to a webm/opus Blob, or null if no speech.
  function recordUtterance() {
    return new Promise((resolve) => {
      if (stopped) return resolve(null);
      let mime = '';
      if (typeof MediaRecorder !== 'undefined' && MediaRecorder.isTypeSupported) {
        if (MediaRecorder.isTypeSupported('audio/webm;codecs=opus')) mime = 'audio/webm;codecs=opus';
        else if (MediaRecorder.isTypeSupported('audio/webm')) mime = 'audio/webm';
      }
      const rec = mime ? new MediaRecorder(micStream, { mimeType: mime }) : new MediaRecorder(micStream);
      mediaRecorder = rec;
      const chunks = [];
      rec.ondataavailable = (e) => { if (e.data && e.data.size) chunks.push(e.data); };
      rec.onstop = () => {
        clearInterval(poll);
        mediaRecorder = null;
        resolve(chunks.length ? new Blob(chunks, { type: rec.mimeType || 'audio/webm' }) : null);
      };
      rec.start(100);

      const t0 = Date.now();
      let speechStarted = false;
      let lastVoice = Date.now();
      const poll = setInterval(() => {
        if (stopped) { try { rec.stop(); } catch { /* ignore */ } return; }
        const level = rms();
        const now = Date.now();
        if (level > SPEECH_RMS) { speechStarted = true; lastVoice = now; }
        else if (level > SILENCE_RMS) { lastVoice = now; }
        const tooLong = now - t0 > MAX_UTTERANCE_MS;
        const silentEnough = speechStarted && now - lastVoice > SILENCE_MS;
        // If nobody speaks at all for a while, give up on this turn.
        const noSpeechTimeout = !speechStarted && now - t0 > 8000;
        if (tooLong || silentEnough || noSpeechTimeout) {
          if (rec.state !== 'inactive') rec.stop();
        }
      }, 100);
    });
  }

  // --- 2. STT ----------------------------------------------------------------
  async function transcribe(blob) {
    const form = new FormData();
    form.append('audio', blob, 'utterance.webm');
    if (forceLang) form.append('lang', forceLang); // pin STT to the chosen language
    controller = new AbortController();
    const r = await fetch('/api/voice-stt', { method: 'POST', body: form, signal: controller.signal });
    controller = null;
    if (!r.ok) {
      if (r.status === 503) throw new Error('no_sarvam_key');
      throw new Error(`stt_http_${r.status}`);
    }
    return r.json(); // { text, lang }
  }

  // --- 3. Think (Claude + submit_case) --------------------------------------
  async function think() {
    controller = new AbortController();
    const r = await fetch('/api/converse', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ messages, system, tools }),
      signal: controller.signal,
    });
    controller = null;
    if (!r.ok) throw new Error(`converse_http_${r.status}`);
    return r.json(); // { text, submitCase, messages }
  }

  // --- 4. TTS + playback -----------------------------------------------------
  // `lang` is the BCP-47 code the family last spoke (from STT); Sarvam speaks the
  // reply in that language. The server returns base64 WAV + its mime.
  function synthAndPlay(text, lang) {
    return new Promise(async (resolve) => {
      if (stopped || !text) return resolve();
      let audioContent = '';
      let mime = 'audio/wav';
      try {
        controller = new AbortController();
        const r = await fetch('/api/voice-tts', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ text, lang }),
          signal: controller.signal,
        });
        controller = null;
        if (r.ok) { const j = await r.json(); audioContent = j.audioContent || ''; mime = j.mime || mime; }
      } catch { /* fall through — text already shown in transcript */ }
      if (stopped || !audioContent) return resolve();
      emit({ type: 'state', state: 'speaking' });
      audioEl = new Audio(`data:${mime};base64,${audioContent}`);
      audioEl.onended = () => { audioEl = null; resolve(); };
      audioEl.onerror = () => { audioEl = null; resolve(); };
      audioEl.play().catch(() => { audioEl = null; resolve(); });
    });
  }

  // --- Conversation loop -----------------------------------------------------
  (async () => {
    try {
      // Greeting first (in the default language until the family speaks).
      messages.push({ role: 'assistant', content: greeting });
      emit({ type: 'transcript', role: 'assistant', content: greeting });
      await synthAndPlay(greeting, lastLang);

      while (!stopped) {
        emit({ type: 'state', state: 'listening' });
        const blob = await recordUtterance();
        if (stopped) break;
        if (!blob) continue; // silence — keep listening

        let stt;
        try { stt = await transcribe(blob); }
        catch (e) { emit({ type: 'error', reason: e.message || 'stt_error' }); break; }
        const said = (stt.text || '').trim();
        if (!said) continue; // nothing recognized — listen again
        if (!forceLang && stt.lang) lastLang = stt.lang; // mirror the family (auto mode only)
        emit({ type: 'transcript', role: 'user', content: said });
        messages.push({ role: 'user', content: said });

        emit({ type: 'state', state: 'thinking' });
        let out;
        try { out = await think(); }
        catch (e) { emit({ type: 'error', reason: e.message || 'converse_error' }); break; }
        if (stopped) break;
        // Adopt the server's echoed messages (includes the assistant turn).
        if (Array.isArray(out.messages) && out.messages.length) {
          messages.length = 0;
          messages.push(...out.messages);
        }

        if (out.text) emit({ type: 'transcript', role: 'assistant', content: out.text });

        if (out.submitCase) {
          // Speak the closing line (if any) then hand off to the engine.
          if (out.text) await synthAndPlay(out.text, lastLang);
          try { onSubmitCase && onSubmitCase(out.submitCase); } catch { /* ignore */ }
          break;
        }
        await synthAndPlay(out.text, lastLang);
      }
    } catch (e) {
      if (!stopped) emit({ type: 'error', reason: e.message || 'agent_error' });
    } finally {
      cleanup();
    }
  })();

  let cleaned = false;
  function cleanup() {
    if (cleaned) return; // idempotent — loop's finally and stop() both call this
    cleaned = true;
    abortInflight();
    stopAudio();
    try { if (mediaRecorder && mediaRecorder.state !== 'inactive') mediaRecorder.stop(); } catch { /* ignore */ }
    try { micStream && micStream.getTracks().forEach((t) => t.stop()); } catch { /* ignore */ }
    // AudioContext.close() returns a Promise that rejects if already closed —
    // swallow both the sync throw and the async rejection.
    try { if (inCtx && inCtx.state !== 'closed') { const p = inCtx.close(); if (p && p.catch) p.catch(() => {}); } } catch { /* ignore */ }
    emit({ type: 'state', state: 'closed' });
  }

  function stop() {
    if (stopped) return;
    stopped = true;
    cleanup();
  }

  return { stop };
}
