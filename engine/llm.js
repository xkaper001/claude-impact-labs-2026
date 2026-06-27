'use strict';
/**
 * LlmBackend — the swappable seam between the deterministic engine and the
 * language model. config-scoring.json drives which backend is active:
 *
 *   llm.backend = "claude"  → ClaudeBackend (online; needs ANTHROPIC_API_KEY)
 *   llm.backend = "local"   → LocalBackend   (on-box LLM; stub for now)
 *
 * The engine's deterministic fields (name-phonetic, age/gender, zone-time,
 * hotspot clustering) are ALWAYS computed offline by engine/search + engine/
 * hotspot. The LlmBackend only fills the language-heavy `useFor` capabilities:
 *   transcribe · translate · structure · semanticDescription · explain · duplicateDetection
 *
 * When the backend is unreachable (offline), callers mark the semantic points
 * "semantic pending" and the rules engine still returns a ranked result —
 * search never blocks on the LLM. One config doc, two consumers, no drift.
 */

const ANTHROPIC_URL = 'https://api.anthropic.com/v1/messages';
const ANTHROPIC_VERSION = '2023-06-01';

/** Map a config `useFor` capability to a backend call. Each backend implements
 *  the same surface so the caller is backend-agnostic. */
const CAPABILITIES = ['transcribe', 'translate', 'structure', 'semanticDescription', 'explain', 'duplicateDetection'];

/** Run a filled prompt (from engine/prompt.js) through the backend and return
 *  the model's text. This is the hot path: search/hotspot pass the assembled
 *  prompt; the backend just completes it.
 *
 *  @param {string} prompt   full prompt text (system + payload)
 *  @param {object} config   config:scoring doc (uses llm.model, llm.backend)
 *  @param {object} opts     { capability, timeoutMs, fetchImpl }
 *  @returns {Promise<{text:string, backend:string, model:string, pending:boolean}>}
 */
async function complete(prompt, config, opts = {}) {
  const llm = (config && config.llm) || {};
  const backend = (llm.backend || 'claude').toLowerCase();
  if (backend === 'local') return LocalBackend.complete(prompt, config, opts);
  return ClaudeBackend.complete(prompt, config, opts);
}

/** Multi-turn conversation (voice intake agent). Same backend seam as complete().
 *  @param {Array}  messages  Anthropic messages array
 *  @param {object} config    config:scoring doc
 *  @param {object} opts      { system, tools, timeoutMs, maxTokens, fetchImpl }
 *  @returns {Promise<{text:string, submitCase:object|null, messages:Array, pending:boolean}>}
 */
async function converse(messages, config, opts = {}) {
  const llm = (config && config.llm) || {};
  const backend = (llm.backend || 'claude').toLowerCase();
  if (backend === 'local') return LocalBackend.converse(messages, config, opts);
  return ClaudeBackend.converse(messages, config, opts);
}

const ClaudeBackend = {
  async complete(prompt, config, opts = {}) {
    const llm = config.llm || {};
    const model = process.env.CLAUDE_MODEL || llm.model || 'claude-opus-4-8';
    const apiKey = process.env.ANTHROPIC_API_KEY;
    if (!apiKey) {
      // No key configured → degrade gracefully to the offline path rather than throw.
      return { text: '', backend: 'claude', model, pending: true, reason: 'no_api_key' };
    }
    const fetchImpl = opts.fetchImpl || (typeof fetch !== 'undefined' ? fetch : null);
    if (!fetchImpl) throw new Error('No fetch implementation available for ClaudeBackend');
    const maxTokens = opts.maxTokens || 1200;
    const res = await fetchImpl(ANTHROPIC_URL, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-api-key': apiKey,
        'anthropic-version': ANTHROPIC_VERSION,
      },
      body: JSON.stringify({
        model,
        max_tokens: maxTokens,
        messages: [{ role: 'user', content: prompt }],
      }),
      signal: opts.timeoutMs ? AbortSignal.timeout(opts.timeoutMs) : undefined,
    });
    if (!res.ok) {
      const body = await res.text().catch(() => '');
      return { text: '', backend: 'claude', model, pending: true, reason: `http_${res.status}`, body };
    }
    const data = await res.json();
    const text = (data.content && data.content[0] && data.content[0].text) || '';
    return { text, backend: 'claude', model, pending: false };
  },

  // Multi-turn conversation for the voice intake agent. Unlike complete() (one
  // prompt → one answer for the scoring path), this keeps a messages array and a
  // system prompt, and offers the submit_case tool. Returns the assistant's
  // spoken text plus, when present, the parsed submit_case input.
  async converse(messages, config, opts = {}) {
    const voiceThink = (config.voice && config.voice.think) || {};
    const llm = config.llm || {};
    const model = process.env.VOICE_MODEL || voiceThink.model || llm.model || 'claude-sonnet-4-6';
    const apiKey = process.env.ANTHROPIC_API_KEY;
    if (!apiKey) {
      return { text: '', submitCase: null, messages, backend: 'claude', model, pending: true, reason: 'no_api_key' };
    }
    const fetchImpl = opts.fetchImpl || (typeof fetch !== 'undefined' ? fetch : null);
    if (!fetchImpl) throw new Error('No fetch implementation available for ClaudeBackend');
    const body = {
      model,
      max_tokens: opts.maxTokens || 800,
      messages,
    };
    if (opts.system) body.system = opts.system;
    if (opts.tools && opts.tools.length) body.tools = opts.tools;
    const res = await fetchImpl(ANTHROPIC_URL, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-api-key': apiKey,
        'anthropic-version': ANTHROPIC_VERSION,
      },
      body: JSON.stringify(body),
      signal: opts.timeoutMs ? AbortSignal.timeout(opts.timeoutMs) : undefined,
    });
    if (!res.ok) {
      const errBody = await res.text().catch(() => '');
      return { text: '', submitCase: null, messages, backend: 'claude', model, pending: true, reason: `http_${res.status}`, body: errBody };
    }
    const data = await res.json();
    const content = Array.isArray(data.content) ? data.content : [];
    const text = content.filter((b) => b.type === 'text').map((b) => b.text).join(' ').trim();
    const toolUse = content.find((b) => b.type === 'tool_use' && b.name === 'submit_case');
    const submitCase = toolUse ? toolUse.input || {} : null;
    // Echo the assistant turn back so the caller maintains conversation state.
    const nextMessages = [...messages, { role: 'assistant', content }];
    return { text, submitCase, messages: nextMessages, backend: 'claude', model, pending: false };
  },
};

/** Stub for the future on-box LLM. Returns pending so the engine keeps scoring
 *  with the deterministic fields. Swap the body for a localhost fetch to a
 *  local inference server (e.g. llama.cpp / Ollama) when ready. */
const LocalBackend = {
  async complete(_prompt, config, _opts = {}) {
    const llm = config.llm || {};
    return { text: '', backend: 'local', model: llm.model || 'local', pending: true, reason: 'local_not_configured' };
  },
  async converse(messages, config, _opts = {}) {
    const llm = config.llm || {};
    return { text: '', submitCase: null, messages, backend: 'local', model: llm.model || 'local', pending: true, reason: 'local_not_configured' };
  },
};

module.exports = { complete, converse, CAPABILITIES, ClaudeBackend, LocalBackend };
