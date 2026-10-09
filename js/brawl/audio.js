/* The Hurricane Brawl game's sound, synthesised with Web Audio (no sound files):
 *   the wind    a bed of filtered noise that follows your storm's energy and the camera's height,
 *               with a low rumble under it when storms brawl near you
 *   one-shots   whoosh (boost, dash, surge, dust wall), thunder (crack then rumble), freeze, fire
 *               crackle, thud (hits), KO, energy surge, city hits, countdown and menu blips
 * It starts on the first key, click or button (browsers keep audio off until then). M mutes.
 */
const BrawlAudio = (() => {
  'use strict';
  let ctx = null, master = null, noise = null, wind = null, rumble = null, muted = false;
  try { muted = localStorage.getItem('brawl-muted') === '1'; } catch (e) { /* no storage */ }

  function start() {
    if (ctx) { if (ctx.state === 'suspended') ctx.resume(); return; }
    const AC = window.AudioContext || window.webkitAudioContext;
    if (!AC) return;
    ctx = new AC();
    master = ctx.createGain();
    master.gain.value = muted ? 0 : 0.8;
    const comp = ctx.createDynamicsCompressor();
    comp.threshold.value = -14; comp.ratio.value = 4;
    master.connect(comp).connect(ctx.destination);
    noise = ctx.createBuffer(1, ctx.sampleRate * 2, ctx.sampleRate);
    const d = noise.getChannelData(0);
    for (let i = 0, b = 0; i < d.length; i++) { const w = Math.random() * 2 - 1; b = 0.97 * b + 0.03 * w; d[i] = w * 0.5 + b * 3; }
    const bed = (type, freq, q) => {
      const src = ctx.createBufferSource(); src.buffer = noise; src.loop = true;
      const f = ctx.createBiquadFilter(); f.type = type; f.frequency.value = freq; f.Q.value = q;
      const g = ctx.createGain(); g.gain.value = 0;
      src.connect(f).connect(g).connect(master); src.start();
      return { f, g };
    };
    wind = bed('bandpass', 500, 0.7);
    rumble = bed('lowpass', 110, 0.8);
  }
  ['keydown', 'pointerdown', 'gamepadconnected'].forEach((t) => window.addEventListener(t, start, { passive: true }));

  // energy 0-1 (your storm), height 0-1 (the camera: near is louder), brawl 0-1, on (false when paused)
  function update(energy, height, brawl, on) {
    if (!ctx) return;
    const t = ctx.currentTime, v = on ? 1 : 0;
    wind.g.gain.setTargetAtTime(v * (0.05 + 0.22 * energy) * (1.15 - 0.6 * height), t, 0.3);
    wind.f.frequency.setTargetAtTime(320 + 700 * energy + 250 * Math.sin(t * 0.7), t, 0.4);
    rumble.g.gain.setTargetAtTime(v * (0.08 * energy + 0.5 * brawl), t, 0.2);
  }
  function setMuted(m) {
    muted = m;
    try { localStorage.setItem('brawl-muted', m ? '1' : '0'); } catch (e) { /* no storage */ }
    if (ctx) master.gain.setTargetAtTime(m ? 0 : 0.8, ctx.currentTime, 0.05);
  }

  const env = (g, t, a, peak, dur) => { g.gain.setValueAtTime(0.0001, t); g.gain.exponentialRampToValueAtTime(peak, t + a); g.gain.exponentialRampToValueAtTime(0.0001, t + dur); };
  function noiseShot(type, f0, f1, q, peak, a, dur, delay = 0) {
    const t = ctx.currentTime + delay, src = ctx.createBufferSource(), f = ctx.createBiquadFilter(), g = ctx.createGain();
    src.buffer = noise; src.loop = true;
    f.type = type; f.Q.value = q; f.frequency.setValueAtTime(f0, t); f.frequency.exponentialRampToValueAtTime(f1, t + dur);
    env(g, t, a, peak, dur);
    src.connect(f).connect(g).connect(master); src.start(t, Math.random()); src.stop(t + dur + 0.05);
  }
  function tone(type, f0, f1, peak, a, dur, delay = 0) {
    const t = ctx.currentTime + delay, o = ctx.createOscillator(), g = ctx.createGain();
    o.type = type; o.frequency.setValueAtTime(f0, t); o.frequency.exponentialRampToValueAtTime(f1, t + dur);
    env(g, t, a, peak, dur);
    o.connect(g).connect(master); o.start(t); o.stop(t + dur + 0.05);
  }
  const SOUNDS = {
    whoosh: (v) => noiseShot('bandpass', 300, 1800, 1.2, 0.5 * v, 0.08, 0.7),
    dash: (v) => { noiseShot('bandpass', 200, 2400, 1.5, 0.7 * v, 0.03, 0.6); tone('sawtooth', 90, 45, 0.15 * v, 0.02, 0.6); },
    surge: (v) => { noiseShot('lowpass', 1800, 160, 0.7, 0.9 * v, 0.02, 1.4); tone('sine', 70, 35, 0.4 * v, 0.02, 1.2); },
    haboob: (v) => { noiseShot('lowpass', 900, 200, 0.6, 0.8 * v, 0.15, 1.6); noiseShot('bandpass', 2500, 600, 0.8, 0.25 * v, 0.1, 1.2); },
    thunder: (v) => { noiseShot('highpass', 3000, 1500, 0.5, 0.9 * v, 0.003, 0.18); noiseShot('lowpass', 400, 60, 0.7, 0.8 * v, 0.05, 2.2, 0.06); },
    freeze: (v) => { for (const [f, d] of [[1760, 0], [2349, 0.06], [2637, 0.12], [3520, 0.18]]) tone('sine', f, f * 1.01, 0.08 * v, 0.02, 1.2, d); noiseShot('highpass', 6000, 3000, 0.7, 0.2 * v, 0.2, 1.5); },
    fire: (v) => { noiseShot('lowpass', 700, 300, 0.7, 0.6 * v, 0.1, 1.6); for (let i = 0; i < 14; i++) noiseShot('highpass', 2500, 2000, 2, 0.25 * v, 0.002, 0.03, Math.random() * 1.4); },
    thud: (v) => { tone('sine', 110, 38, 0.8 * v, 0.005, 0.45); noiseShot('lowpass', 600, 120, 0.8, 0.5 * v, 0.005, 0.35); },
    ko: (v) => { tone('sawtooth', 320, 50, 0.3 * v, 0.01, 1.1); noiseShot('bandpass', 1500, 150, 1, 0.6 * v, 0.02, 1.3); },
    win: (v) => { [523, 659, 784, 1047].forEach((f, i) => tone('triangle', f, f, 0.22 * v, 0.01, 0.35, i * 0.09)); },
    pickup: (v) => { [440, 660, 880, 1320].forEach((f, i) => tone('sine', f, f * 1.02, 0.2 * v, 0.01, 0.25, i * 0.06)); },
    city: (v) => tone('triangle', 200 + Math.random() * 60, 120, 0.12 * v, 0.004, 0.18),
    beep: (v) => tone('square', 880, 880, 0.12 * v, 0.005, 0.12),
    go: (v) => tone('square', 1320, 1320, 0.16 * v, 0.005, 0.4),
    blip: (v) => tone('sine', 660, 760, 0.08 * v, 0.005, 0.07),
  };
  // a one-shot at volume v (0-1)
  function play(name, v = 1) {
    if (!ctx || muted || v < 0.02 || !SOUNDS[name]) return;
    SOUNDS[name](Math.min(1, v));
  }
  return { start, update, play, setMuted, get muted() { return muted; } };
})();
