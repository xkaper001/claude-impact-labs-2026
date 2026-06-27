// Browser LLM client. The browser NEVER holds the Anthropic key — it posts the
// assembled prompt (built by engine/prompt.js via lib/engine.js) to the server
// proxy at /api/llm, which runs engine/llm.js (ClaudeBackend now, LocalBackend
// later). If the proxy is unreachable (offline), we return {pending:true} and
// the UI shows "semantic pending" — search ranking still works on the
// deterministic fields. See DESIGN.md §LLM.

/** Run a filled prompt through the backend via the server proxy. */
export async function complete(prompt, { capability, timeoutMs = 30000 } = {}) {
  try {
    const ctrl = new AbortController();
    const t = setTimeout(() => ctrl.abort(), timeoutMs);
    const res = await fetch('/api/llm', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ prompt, capability }),
      signal: ctrl.signal,
    });
    clearTimeout(t);
    if (!res.ok) return { text: '', pending: true, reason: `http_${res.status}` };
    return await res.json();
  } catch (e) {
    return { text: '', pending: true, reason: e.name === 'AbortError' ? 'timeout' : 'offline' };
  }
}

/** Transcribe an audio Blob via the Whisper.cpp box (online: server proxy;
 *  offline: the kendra box is on LAN). Falls back to {pending} so the operator
 *  can type. See lib/voice.js for the capture side and DESIGN.md §STT. */
export async function transcribe(audioBlob, { language } = {}) {
  const form = new FormData();
  form.append('audio', audioBlob, 'voice.webm');
  if (language) form.append('language', language);
  try {
    const res = await fetch('/api/stt', { method: 'POST', body: form });
    if (!res.ok) return { text: '', pending: true, reason: `http_${res.status}` };
    return await res.json();
  } catch (e) {
    return { text: '', pending: true, reason: 'offline' };
  }
}
