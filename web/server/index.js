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

// Whisper.cpp box STT. The box exposes /inference and accepts an audio file
// multipart upload; it returns { text: "..." }. See DESIGN.md §STT.
app.post('/api/stt', upload.single('audio'), async (req, res) => {
  const box = process.env.WHISPER_BOX_URL;
  if (!box || !req.file) {
    return res.status(503).json({ text: '', pending: true, reason: 'no_stt_box' });
  }
  try {
    const form = new FormData();
    form.append('audio', new Blob([req.file.buffer], { type: req.file.mimetype }), req.file.originalname);
    if (req.body.language) form.append('language', req.body.language);
    const r = await fetch(`${box}/inference`, { method: 'POST', body: form });
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
