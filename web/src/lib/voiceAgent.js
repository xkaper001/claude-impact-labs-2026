// Deepgram Voice Agent intake client (browser, online-only enhancement).
//
// The operator runs a spoken conversation with the family in their language;
// Deepgram does listen (STT, nova-3) + think (Claude/anthropic) + speak (TTS,
// aura-2) over ONE WebSocket. The agent calls the `submit_case` function whose
// structured output we hand to the deterministic engine — that's what puts AI on
// the search path. See web/src/lib/engine.js submitCaseToQuery for the mapping.
//
// Auth: browsers can't set WebSocket headers, so we fetch a short-lived JWT from
// the server (/api/deepgram-token, which holds DEEPGRAM_API_KEY) and connect with
// ?token=<JWT>. The long-lived key never reaches the browser.
//
// think.provider = anthropic relies on the Deepgram project having an Anthropic
// integration configured (so no Anthropic key is sent in the Settings message —
// that message originates in the browser and must never carry a secret). If the
// project has no Anthropic integration, switch config.voice.think.provider to
// 'open_ai' or a Deepgram-hosted model.
//
// Offline: this whole module is bypassed — Deepgram Agent is cloud-only. Intake
// falls back to the typed form + Whisper.cpp box (lib/voice.js). Search never
// blocks on it.

const AGENT_URL = 'wss://agent.deepgram.com/v1/agent/converse';
const IN_RATE = 24000; // mic → agent (linear16)
const OUT_RATE = 24000; // agent TTS → speaker (linear16)

// Bundled defaults so the agent works even before config:voiceAgent syncs in.
const DEFAULT_PROMPT =
  'You are Setu Voice Intake, a calm assistant helping a trained volunteer at a ' +
  'missing-person help center at the Kumbh Mela. Talk to the family through the ' +
  'operator in their language (Hindi/Marathi/English). Ask ONE short question at a ' +
  'time, tolerate missing data, never ask for government IDs, never claim a match. ' +
  'Gather mode (lost/found), name, age band, gender, state, last-seen location, ' +
  'physical description, and time. Once you have mode plus an age or description ' +
  'plus a last-seen location, call submit_case with what you have (empty strings ' +
  'for unknowns), then tell the family the volunteer will check across all centers.';

const DEFAULT_SUBMIT_CASE = {
  name: 'submit_case',
  description:
    'Submit the structured missing/found person intake record. Missing fields allowed — pass empty strings.',
  parameters: {
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

function floatToPCM16(float32) {
  const out = new Int16Array(float32.length);
  for (let i = 0; i < float32.length; i++) {
    const s = Math.max(-1, Math.min(1, float32[i]));
    out[i] = s < 0 ? s * 0x8000 : s * 0x7fff;
  }
  return out;
}

/**
 * Start a Deepgram Voice Agent intake session.
 *
 * @param {object}   o
 * @param {'lost'|'found'} o.mode    intake mode (steers the agent + the search mode)
 * @param {object}   o.voiceAgent    the config:voiceAgent doc (prompt + submit_case schema)
 * @param {object}   o.voice         config.voice block (models, think provider)
 * @param {function} o.onSubmitCase  (args) => void  — called with the submit_case payload
 * @param {function} o.onEvent       (evt) => void    — {type:'state'|'transcript'|'error', ...}
 * @returns {Promise<{stop: function}>}
 */
export async function startVoiceAgent({ mode, voiceAgent, voice, onSubmitCase, onEvent } = {}) {
  const emit = (e) => { try { onEvent && onEvent(e); } catch { /* ignore */ } };
  const va = voiceAgent || {};
  const v = voice || {};
  // Deepgram-managed model id (Opus is not hosted by Deepgram for the think stage).
  const think = v.think || { provider: 'anthropic', model: 'claude-sonnet-4-20250514' };

  // 1. Get the WebSocket credential from the server. Preferred: a short-lived JWT
  //    (scheme 'bearer'); fallback when the key can't mint tokens: the raw API key
  //    (scheme 'token'). Either way the browser authenticates via subprotocol.
  const tokRes = await fetch('/api/deepgram-token', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ ttl_seconds: 60 }),
  });
  if (!tokRes.ok) {
    const reason = tokRes.status === 503 ? 'no_deepgram_key' : `token_http_${tokRes.status}`;
    emit({ type: 'error', reason });
    throw new Error(reason);
  }
  const { token, scheme = 'token' } = await tokRes.json();

  // 2. Mic capture. AudioContext fixed at 24 kHz so mic frames are already at the
  //    agent's input rate — no manual resampling. (Widely supported; Safari ok.)
  const stream = await navigator.mediaDevices.getUserMedia({
    audio: { channelCount: 1, echoCancellation: true, noiseSuppression: true },
  });
  const inCtx = new (window.AudioContext || window.webkitAudioContext)({ sampleRate: IN_RATE });
  const source = inCtx.createMediaStreamSource(stream);
  const proc = inCtx.createScriptProcessor(4096, 1, 1);

  // 3. Playback queue for the agent's TTS (linear16 @ OUT_RATE).
  const outCtx = new (window.AudioContext || window.webkitAudioContext)({ sampleRate: OUT_RATE });
  let playHead = 0;
  const sources = new Set();
  function playPCM(arrayBuf) {
    const pcm = new Int16Array(arrayBuf);
    if (!pcm.length) return;
    const buf = outCtx.createBuffer(1, pcm.length, OUT_RATE);
    const ch = buf.getChannelData(0);
    for (let i = 0; i < pcm.length; i++) ch[i] = pcm[i] / 0x8000;
    const node = outCtx.createBufferSource();
    node.buffer = buf;
    node.connect(outCtx.destination);
    const now = outCtx.currentTime;
    playHead = Math.max(playHead, now);
    node.start(playHead);
    playHead += buf.duration;
    sources.add(node);
    node.onended = () => sources.delete(node);
  }
  function stopPlayback() {
    for (const n of sources) { try { n.stop(); } catch { /* ignore */ } }
    sources.clear();
    playHead = outCtx.currentTime;
  }

  // 4. Open the agent WebSocket. Deepgram does NOT accept the credential as a
  //    query param; browsers can't set headers — so auth goes through the
  //    Sec-WebSocket-Protocol subprotocol: ['token', <apiKey>] or ['bearer', <jwt>].
  const ws = new WebSocket(AGENT_URL, [scheme, token]);
  ws.binaryType = 'arraybuffer';
  let keepAlive = null;
  let started = false;

  const settings = {
    type: 'Settings',
    audio: {
      input: { encoding: 'linear16', sample_rate: IN_RATE },
      output: { encoding: 'linear16', sample_rate: OUT_RATE, container: 'none' },
    },
    agent: {
      // NOTE: no top-level `agent.language` — it's deprecated and conflicts with
      // the listen-provider language. Multilingual STT goes on listen.provider.
      listen: { provider: { type: 'deepgram', model: v.listen || 'nova-3', language: v.listenLanguage || 'multi' } },
      think: {
        provider: { type: think.provider || 'anthropic', model: think.model || 'claude-sonnet-4-20250514' },
        // Aura TTS is English-only, so the agent SPEAKS English to the operator
        // while UNDERSTANDING the family's Hindi/Marathi and capturing it verbatim.
        prompt:
          `${va.systemPrompt || DEFAULT_PROMPT}\n\n` +
          `The operator opened this as a ${mode === 'found' ? 'FOUND' : 'LOST'} report.\n` +
          `IMPORTANT: Your SPOKEN replies must be in clear English — the trained operator hears you and relays to the family. ` +
          `You still fully understand Hindi/Marathi/English input; capture the family's own words (e.g. "bujurg", "white kurta") verbatim in submit_case.`,
        functions: [va.submitCase || DEFAULT_SUBMIT_CASE],
      },
      speak: { provider: { type: 'deepgram', model: v.speak || 'aura-2-asteria-en' } },
      greeting: va.greeting || undefined,
    },
  };

  function sendMic(e) {
    if (ws.readyState !== WebSocket.OPEN || !started) return;
    const pcm = floatToPCM16(e.inputBuffer.getChannelData(0));
    ws.send(pcm.buffer);
  }

  ws.addEventListener('open', () => emit({ type: 'state', state: 'connecting' }));

  ws.addEventListener('message', (ev) => {
    if (ev.data instanceof ArrayBuffer) { playPCM(ev.data); return; }
    let msg;
    try { msg = JSON.parse(ev.data); } catch { return; }
    switch (msg.type) {
      case 'Welcome':
        ws.send(JSON.stringify(settings));
        break;
      case 'SettingsApplied':
        started = true;
        source.connect(proc);
        proc.connect(inCtx.destination);
        proc.addEventListener('audioprocess', sendMic);
        keepAlive = setInterval(() => {
          if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify({ type: 'KeepAlive' }));
        }, 5000);
        emit({ type: 'state', state: 'listening' });
        break;
      case 'ConversationText':
        emit({ type: 'transcript', role: msg.role, content: msg.content });
        break;
      case 'UserStartedSpeaking':
        stopPlayback(); // barge-in
        emit({ type: 'state', state: 'listening' });
        break;
      case 'AgentThinking':
        emit({ type: 'state', state: 'thinking' });
        break;
      case 'AgentStartedSpeaking':
        emit({ type: 'state', state: 'speaking' });
        break;
      case 'FunctionCallRequest':
        for (const fn of msg.functions || []) {
          if (fn.name !== 'submit_case') continue;
          let args = {};
          try { args = fn.arguments ? JSON.parse(fn.arguments) : {}; } catch { /* keep {} */ }
          try { onSubmitCase && onSubmitCase(args); } catch { /* ignore */ }
          ws.send(JSON.stringify({
            type: 'FunctionCallResponse',
            id: fn.id,
            name: fn.name,
            content: JSON.stringify({ status: 'logged' }),
          }));
        }
        break;
      case 'Error':
        emit({ type: 'error', reason: msg.description || msg.code || 'agent_error' });
        break;
      default:
        break;
    }
  });

  ws.addEventListener('error', () => emit({ type: 'error', reason: 'ws_error' }));
  ws.addEventListener('close', () => emit({ type: 'state', state: 'closed' }));

  function stop() {
    if (keepAlive) clearInterval(keepAlive);
    try { proc.removeEventListener('audioprocess', sendMic); } catch { /* ignore */ }
    try { proc.disconnect(); source.disconnect(); } catch { /* ignore */ }
    stopPlayback();
    try { stream.getTracks().forEach((t) => t.stop()); } catch { /* ignore */ }
    try { inCtx.close(); outCtx.close(); } catch { /* ignore */ }
    try { if (ws.readyState <= WebSocket.OPEN) ws.close(); } catch { /* ignore */ }
    emit({ type: 'state', state: 'closed' });
  }

  return { stop };
}
