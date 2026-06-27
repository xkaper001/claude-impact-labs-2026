// Tiny server proxy for the PWA. Keeps secrets server-side:
//  /api/llm  → engine/llm.js (ClaudeBackend now, LocalBackend later)
//  /api/stt  → Whisper.cpp box on the kendra LAN (offline STT)
//  /api/health
//
// In dev, Vite proxies /api → this server (see vite.config.js). In production,
// run it behind the same origin that serves the built PWA.

import express from 'express';
import multer from 'multer';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import llmMod from '../../engine/llm.js';
const { complete } = llmMod;

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..', '..');
const config = JSON.parse(fs.readFileSync(path.join(ROOT, 'config-scoring.json'), 'utf8'));

const app = express();
const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 8 * 1024 * 1024 } });
const PORT = process.env.PORT || 8787;

app.use(express.json({ limit: '2mb' }));

app.get('/api/health', (_req, res) => {
  res.json({
    ok: true,
    llm: (config.llm && config.llm.backend) || 'claude',
    hasAnthropicKey: !!process.env.ANTHROPIC_API_KEY,
    hasDeepgramKey: !!process.env.DEEPGRAM_API_KEY,
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

// Provide the browser Voice Agent its WebSocket credential. Browsers can't set
// headers, so the client authenticates via the Sec-WebSocket-Protocol subprotocol
// (['<scheme>', <token>]). Two paths:
//   1. PREFERRED — mint a short-lived JWT via /v1/auth/grant (needs an API key
//      with Member+ role). Returns { scheme:'bearer', token:<jwt> }; raw key never
//      leaves the server.
//   2. FALLBACK — if grant is unavailable (e.g. 403: restricted key role), return
//      the API key itself with { scheme:'token' }. The browser uses it directly
//      (['token', key]). This exposes the key to the client — acceptable for a
//      local/single-kendra demo; for production, use a Member+ key so path 1 works.
app.post('/api/deepgram-token', async (req, res) => {
  const key = process.env.DEEPGRAM_API_KEY;
  if (!key) return res.status(503).json({ error: 'no_deepgram_key' });
  const ttl = Math.min(3600, Math.max(10, Number(req.body?.ttl_seconds) || 60));
  try {
    const r = await fetch('https://api.deepgram.com/v1/auth/grant', {
      method: 'POST',
      headers: { Authorization: `Token ${key}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ ttl_seconds: ttl }),
    });
    if (r.ok) {
      const data = await r.json();
      return res.json({ scheme: 'bearer', token: data.access_token, expires: data.expires_in });
    }
    // Grant not permitted for this key — fall back to direct API-key auth.
    console.warn(`deepgram grant unavailable (${r.status}); serving raw key to client`);
    res.json({ scheme: 'token', token: key, fallback: `grant_http_${r.status}` });
  } catch (e) {
    // Network failure reaching the grant API — still allow direct auth.
    res.json({ scheme: 'token', token: key, fallback: 'grant_unreachable', detail: e.message });
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

app.listen(PORT, () => {
  console.log(`Setu API proxy on :${PORT}  (llm=${config.llm && config.llm.backend})`);
});
