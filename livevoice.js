// Live dictation: the microphone is cut into phrases at short pauses, and each phrase is recognised while you keep
// talking, so text appears as you speak and only the last phrase is left when you stop. Shared by the above apps.
(() => {
  const RATE = 16000;
  const FRAME = 4096;
  const VOICE_RMS = 0.008; // above this a frame counts as speech
  const PAUSE_S = 0.7; // a pause this long ends a phrase
  const MIN_PHRASE_S = 1.6; // longer phrases keep more context, so Latvian comes out better
  const MAX_PHRASE_S = 22;

  // 16-bit mono WAV, which Whisper reads directly.
  function toWav(chunks, total) {
    const buf = new ArrayBuffer(44 + total * 2);
    const v = new DataView(buf);
    const w = (o, s) => { for (let i = 0; i < s.length; i++) v.setUint8(o + i, s.charCodeAt(i)); };
    w(0, 'RIFF'); v.setUint32(4, 36 + total * 2, true); w(8, 'WAVE'); w(12, 'fmt ');
    v.setUint32(16, 16, true); v.setUint16(20, 1, true); v.setUint16(22, 1, true); v.setUint32(24, RATE, true);
    v.setUint32(28, RATE * 2, true); v.setUint16(32, 2, true); v.setUint16(34, 16, true); w(36, 'data'); v.setUint32(40, total * 2, true);
    let o = 44;
    for (const c of chunks) for (let i = 0; i < c.length; i++) { const s = Math.max(-1, Math.min(1, c[i])); v.setInt16(o, s < 0 ? s * 0x8000 : s * 0x7fff, true); o += 2; }
    return new Uint8Array(buf);
  }

  // The phrase cutter: feed it frames, it hands finished phrases (as WAV bytes) to onPhrase, in order.
  function cutter(onPhrase) {
    let seg = [];
    let len = 0;
    let silent = 0;
    let voiced = false;
    const emit = () => { if (voiced && len) onPhrase(toWav(seg, len)); seg = []; len = 0; silent = 0; voiced = false; };
    return {
      feed(frame) {
        let sum = 0;
        for (let i = 0; i < frame.length; i++) sum += frame[i] * frame[i];
        const rms = Math.sqrt(sum / frame.length);
        seg.push(frame); len += frame.length;
        if (rms > VOICE_RMS) { voiced = true; silent = 0; } else silent += frame.length;
        if (!voiced && len > RATE * 2) { // only silence so far: keep a second before speech starts (soft first syllables)
          while (len > RATE * 1.0 && seg.length > 1) len -= seg.shift().length;
        }
        if (voiced && silent >= RATE * PAUSE_S && len >= RATE * MIN_PHRASE_S) emit();
        else if (len >= RATE * MAX_PHRASE_S) emit();
      },
      end: emit,
    };
  }

  // start({ transcribe(wavBytes, previousText) → Promise<text>, onText(text), onError(message), source? }) → { stop() → Promise }.
  // previousText (the last words already recognised) is given to Whisper as context for the next phrase.
  // `source` (Float32Array at 16 kHz) replaces the microphone, for tests.
  async function start({ transcribe, onText, onError, source }) {
    let chain = Promise.resolve();
    let said = '';
    const c = cutter((wav) => {
      chain = chain.then(() => transcribe(wav, said.slice(-220))).then((t) => {
        if (t && t.trim()) { said = `${said} ${t.trim()}`.trim(); onText(t.trim()); }
      }, (e) => onError && onError(String(e.message || e)));
    });
    if (source) {
      for (let i = 0; i < source.length; i += FRAME) c.feed(source.subarray(i, Math.min(i + FRAME, source.length)));
      return { stop: async () => { c.end(); await chain; } };
    }
    const stream = await navigator.mediaDevices.getUserMedia({ audio: { channelCount: 1, echoCancellation: true, noiseSuppression: true, autoGainControl: true } });
    const ctx = new AudioContext({ sampleRate: RATE });
    await ctx.resume();
    const src = ctx.createMediaStreamSource(stream);
    const proc = ctx.createScriptProcessor(FRAME, 1, 1);
    proc.onaudioprocess = (e) => c.feed(new Float32Array(e.inputBuffer.getChannelData(0)));
    src.connect(proc);
    proc.connect(ctx.destination);
    return {
      stop: async () => {
        try { proc.disconnect(); src.disconnect(); } catch { /* already */ }
        stream.getTracks().forEach((t) => t.stop());
        c.end();
        await chain;
        ctx.close().catch(() => {});
      },
    };
  }

  window.LiveVoice = { start, toWav, RATE };
})();
