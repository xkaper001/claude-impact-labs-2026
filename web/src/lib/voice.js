// Voice capture for intake. Two paths (auto-chosen):
//  1. Whisper.cpp box (kendra LAN) — POST the recorded Blob to /api/stt.
//     Works offline because the box is local; this is the production path.
//  2. Web Speech API — browser-native, online on Chrome/Edge. Used as a
//     convenience fallback when the box is unreachable and signal is up.
//  3. Typed input — always available; the cut-order fallback.
// See DESIGN.md §STT for the box contract.

export function isWebSpeechSupported() {
  return typeof window !== 'undefined' && !!(
    window.SpeechRecognition || window.webkitSpeechRecognition
  );
}

/** Record audio from the mic and return a Blob (webm/opus). */
export async function recordAudio() {
  const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
  const recorder = new MediaRecorder(stream);
  const chunks = [];
  recorder.ondataavailable = (e) => chunks.push(e.data);
  return new Promise((resolve, reject) => {
    recorder.onstop = () => {
      stream.getTracks().forEach((t) => t.stop());
      resolve(new Blob(chunks, { type: recorder.mimeType || 'audio/webm' }));
    };
    recorder.onerror = reject;
    recorder.start();
    // Caller stops via stopRecorder(recorder).
    resolve.__recorder = recorder;
  });
}

export function stopRecorder(promise) {
  const r = promise.__recorder;
  if (r && r.state !== 'inactive') r.stop();
}

/** Live Web Speech recognition → returns a transcript string via callback. */
export function webSpeechListen(lang, onText) {
  const SR = window.SpeechRecognition || window.webkitSpeechRecognition;
  if (!SR) return null;
  const rec = new SR();
  rec.lang = lang === 'hi' ? 'hi-IN' : lang === 'mr' ? 'mr-IN' : 'en-IN';
  rec.interimResults = true;
  rec.continuous = false;
  rec.onresult = (e) => {
    const txt = Array.from(e.results).map((r) => r[0].transcript).join(' ');
    onText(txt, e.results[e.results.length - 1].isFinal);
  };
  rec.start();
  return rec;
}
