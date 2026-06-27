// Tiny server proxy for the PWA. Keeps secrets server-side:
//  /api/llm         → engine/llm.js (ClaudeBackend now, LocalBackend later)
//  /api/converse    → engine/llm.js converse() — voice intake conversation (Claude + submit_case)
//  /api/voice-stt   → Sarvam AI Speech-to-Text (online conversational STT, Indian languages)
//  /api/voice-tts   → Sarvam AI Text-to-Speech (speaks the family's language)
//  /api/stt         → Whisper.cpp box on the kendra LAN (offline STT fallback)
//  /api/health
//
// The voice intake (Talk to family) is a turn-based loop the browser drives:
// mic → /api/voice-stt → /api/converse → /api/voice-tts → play, repeat until
// the agent calls submit_case. Replaces the old Deepgram Voice Agent WebSocket.
//
// In dev, Vite proxies /api → this server (see vite.config.js). In production,
// run it behind the same origin that serves the built PWA.

import express from 'express';
import multer from 'multer';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import llmMod from '../../engine/llm.js';
const { complete, converse } = llmMod;

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..', '..');
const config = JSON.parse(fs.readFileSync(path.join(ROOT, 'config-scoring.json'), 'utf8'));
// Bundled prompt + submit_case schema; used as the fallback when the browser
// doesn't send its own (synced) copy. Edit in config:voiceAgent for live changes.
let voiceAgentDoc = {};
try { voiceAgentDoc = JSON.parse(fs.readFileSync(path.join(ROOT, 'voice-agent.json'), 'utf8')); } catch { /* defaults below */ }

const app = express();
const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 8 * 1024 * 1024 } });
const PORT = process.env.PORT || 8787;

// Sarvam AI — powers voice STT + TTS (Indian languages) with SARVAM_API_KEY.
const SARVAM_STT_URL = 'https://api.sarvam.ai/speech-to-text';
const SARVAM_TTS_URL = 'https://api.sarvam.ai/text-to-speech';

app.use(express.json({ limit: '2mb' }));

app.get('/api/health', (_req, res) => {
  res.json({
    ok: true,
    llm: (config.llm && config.llm.backend) || 'claude',
    hasAnthropicKey: !!process.env.ANTHROPIC_API_KEY,
    hasSarvamKey: !!process.env.SARVAM_API_KEY,
    voice: !!(config.voice && config.voice.enabled),
    whisperBox: !!process.env.WHISPER_BOX_URL,
  });
});

// Run a filled prompt (assembled client-side by engine/prompt.js) through the
// LlmBackend. The browser sends the prompt; the server holds the key.
app.post('/api/llm', async (req, res) => {
  const { prompt, capability } = req.body || {};
  if (!prompt) return res.status(400).json({ error: 'missing prompt' });
  try {
    const out = await complete(prompt, config, { capability, timeoutMs: 30000 });
    res.json(out);
  } catch (e) {
    res.status(500).json({ text: '', pending: true, reason: 'server_error', error: e.message });
  }
});

// Voice intake conversation. The browser sends the running messages array plus
// the system prompt and tool schema (from the synced config:voiceAgent doc); the
// server holds ANTHROPIC_API_KEY and runs the turn through engine/llm converse().
// Returns the assistant's spoken text, the parsed submit_case input (when the
// agent decides it has enough), and the echoed messages for the next turn.
app.post('/api/converse', async (req, res) => {
  const { messages, system, tools } = req.body || {};
  if (!Array.isArray(messages) || !messages.length) {
    return res.status(400).json({ error: 'missing messages' });
  }
  const sys = system || voiceAgentDoc.systemPrompt;
  const toolList = tools || (voiceAgentDoc.submitCase ? [voiceAgentDoc.submitCase] : []);
  try {
    const out = await converse(messages, config, { system: sys, tools: toolList, timeoutMs: 30000 });
    res.json(out);
  } catch (e) {
    res.status(500).json({ text: '', submitCase: null, messages, pending: true, reason: 'server_error', error: e.message });
  }
});

// Speech-to-Text via Sarvam AI. Accepts the recorded utterance (multipart audio,
// field `audio`), forwards it to Sarvam with language_code auto-detect so a
// panicked family's Hindi/Marathi/English code-switching is handled. Returns the
// transcript plus the detected language code (so TTS replies in that language).
app.post('/api/voice-stt', upload.single('audio'), async (req, res) => {
  const key = process.env.SARVAM_API_KEY;
  if (!key) return res.status(503).json({ text: '', pending: true, reason: 'no_sarvam_key' });
  if (!req.file) return res.status(400).json({ text: '', pending: true, reason: 'no_audio' });
  const stt = (config.voice && config.voice.stt) || {};
  const model = stt.model || 'saarika:v2.5';
  // Client may pin the language (operator chose one); else auto-detect.
  const pinned = (req.body && req.body.lang) || '';
  const languageCode = pinned || stt.languageCode || 'unknown';
  try {
    const form = new FormData();
    form.append('file', new Blob([req.file.buffer], { type: req.file.mimetype || 'audio/webm' }), req.file.originalname || 'utterance.webm');
    form.append('model', model);
    form.append('language_code', languageCode);
    if (stt.mode) form.append('mode', stt.mode);
    const r = await fetch(SARVAM_STT_URL, {
      method: 'POST',
      headers: { 'api-subscription-key': key },
      body: form,
    });
    if (!r.ok) {
      const body = await r.text().catch(() => '');
      return res.status(502).json({ text: '', pending: true, reason: `sarvam_stt_${r.status}`, body });
    }
    const data = await r.json();
    res.json({ text: data.transcript || '', lang: data.language_code || null });
  } catch (e) {
    res.status(502).json({ text: '', pending: true, reason: 'sarvam_stt_unreachable', error: e.message });
  }
});

// Text-to-Speech via Sarvam AI. Speaks the agent's reply in the family's own
// language (target_language_code = the language detected at STT). Sarvam returns
// base64 WAV in `audios[0]`, played directly by the browser <audio> element.
app.post('/api/voice-tts', async (req, res) => {
  const key = process.env.SARVAM_API_KEY;
  if (!key) return res.status(503).json({ audioContent: '', pending: true, reason: 'no_sarvam_key' });
  const { text, lang } = req.body || {};
  if (!text) return res.status(400).json({ audioContent: '', pending: true, reason: 'no_text' });
  const tts = (config.voice && config.voice.tts) || {};
  const model = tts.model || 'bulbul:v2';
  const speaker = tts.speaker || 'anushka';
  const targetLanguageCode = lang || tts.defaultLanguage || 'hi-IN';
  try {
    const r = await fetch(SARVAM_TTS_URL, {
      method: 'POST',
      headers: { 'api-subscription-key': key, 'content-type': 'application/json' },
      body: JSON.stringify({
        text,
        target_language_code: targetLanguageCode,
        speaker,
        model,
        output_audio_codec: 'wav',
        speech_sample_rate: tts.sampleRate || '22050',
      }),
    });
    if (!r.ok) {
      const body = await r.text().catch(() => '');
      return res.status(502).json({ audioContent: '', pending: true, reason: `sarvam_tts_${r.status}`, body });
    }
    const data = await r.json();
    const audioContent = (data.audios && data.audios[0]) || '';
    if (!audioContent) return res.status(502).json({ audioContent: '', pending: true, reason: 'sarvam_tts_no_audio' });
    res.json({ audioContent, mime: 'audio/wav' });
  } catch (e) {
    res.status(502).json({ audioContent: '', pending: true, reason: 'sarvam_tts_unreachable', error: e.message });
  }
});

// Whisper.cpp box STT. The box exposes /inference and accepts an audio file
// multipart upload; it returns { text: "..." }. See DESIGN.md §STT.
app.post('/api/stt', upload.single('audio'), async (req, res) => {
  const box = process.env.WHISPER_BOX_URL;
  if (!box || !req.file) {
    return res.status(503).json({ text: '', pending: true, reason: 'no_stt_box' });
  }
  try {
    const form = new FormData();
    // whisper.cpp server: field name is `file`, returns { text } with response_format=json.
    form.append('file', new Blob([req.file.buffer], { type: req.file.mimetype }), req.file.originalname);
    form.append('response_format', 'json');
    if (req.body.language) form.append('language', req.body.language);
    // WHISPER_BOX_URL is the base (e.g. http://localhost:8080); endpoint is /inference.
    const endpoint = box.replace(/\/inference\/?$/, '') + '/inference';
    const r = await fetch(endpoint, { method: 'POST', body: form });
    if (!r.ok) return res.status(502).json({ text: '', pending: true, reason: `box_http_${r.status}` });
    const data = await r.json();
    res.json({ text: data.text || '', box: true });
  } catch (e) {
    res.status(502).json({ text: '', pending: true, reason: 'box_unreachable', error: e.message });
  }
});

// Catch-all error handler so multer errors (oversized/unexpected uploads) and any
// other stray throw return JSON the client can read, never a bare 500 HTML page.
// eslint-disable-next-line no-unused-vars
app.use((err, _req, res, _next) => {
  console.error('API error:', err.message);
  if (res.headersSent) return;
  res.status(502).json({ pending: true, reason: 'server_error', error: err.message });
});

app.listen(PORT, () => {
  console.log(`Setu API proxy on :${PORT}  (llm=${config.llm && config.llm.backend})`);
});
