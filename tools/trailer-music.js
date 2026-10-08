/* The trailer's soundtrack: an original rock track at 150 BPM (drums, bass, double-tracked
 * distorted guitars, a lead guitar and trailer hits), synthesised with Web Audio in an
 * OfflineAudioContext, so no samples or licensed music are involved.
 * renderMusic runs inside the page (record-video.js passes its source to headless Chrome):
 *   renderMusic({ bars, hits: [{ t, kind }] }) -> resolves to the byte length of a 16-bit stereo
 *   WAV it leaves in window.__wav
 * The arrangement follows the trailer's bar grid (tools/trailer.js): a 150 BPM bar is 1.6 s,
 * exactly 48 video frames at 30 fps, so cuts and impacts land on the beat. `hits` are the sound
 * effects the picture asks for (impacts, whooshes, the intro's title cards). */
'use strict';

function renderMusic(opts) {
  const SR = 48000, BPM = 150, BEAT = 60 / BPM, BAR = 4 * BEAT, E8 = BEAT / 2, E16 = BEAT / 4;
  const LEN = opts.bars * BAR;
  const SOLO = opts.solo || null;   // analysis: render one bus alone
  const ctx = new OfflineAudioContext(2, Math.round(LEN * SR), SR);
  const T = (bar, beat = 0) => (bar * 4 + beat) * BEAT;
  const mtof = (m) => 440 * Math.pow(2, (m - 69) / 12);

  // seeded random numbers, so every render is identical
  let seed = 0x5eed1234;
  const rnd = () => { seed |= 0; seed = seed + 0x6D2B79F5 | 0; let t = Math.imul(seed ^ seed >>> 15, 1 | seed); t = t + Math.imul(t ^ t >>> 7, 61 | t) ^ t; return ((t ^ t >>> 14) >>> 0) / 4294967296; };
  const noiseBuf = (() => { const b = ctx.createBuffer(2, SR * 6, SR); for (let c = 0; c < 2; c++) { const d = b.getChannelData(c); for (let i = 0; i < d.length; i++) d[i] = rnd() * 2 - 1; } return b; })();

  // ---------------------------------------------------------------- mix buses
  const mix = ctx.createGain();
  const glue = ctx.createDynamicsCompressor();
  glue.threshold.value = -20; glue.ratio.value = 2.5; glue.attack.value = 0.01; glue.release.value = 0.2; glue.knee.value = 8;
  const makeup = ctx.createGain(); makeup.gain.value = 1.0;
  const limit = ctx.createDynamicsCompressor();
  limit.threshold.value = -2; limit.knee.value = 0; limit.ratio.value = 20; limit.attack.value = 0.001; limit.release.value = 0.08;
  const clip = ctx.createWaveShaper(); clip.curve = shaper((x) => Math.tanh(1.2 * x) / Math.tanh(1.2)); clip.oversample = '4x';
  const fadeOut = ctx.createGain();
  fadeOut.gain.setValueAtTime(1, LEN - 1.8); fadeOut.gain.linearRampToValueAtTime(0, LEN - 0.05);
  const air = ctx.createBiquadFilter(); air.type = 'highshelf'; air.frequency.value = 7000; air.gain.value = 3;
  mix.connect(air); air.connect(glue); glue.connect(makeup); makeup.connect(limit); limit.connect(clip); clip.connect(fadeOut); fadeOut.connect(ctx.destination);

  // reverb: a generated stereo room tail
  const verb = ctx.createConvolver();
  verb.buffer = (() => {
    const n = Math.round(SR * 2.4), b = ctx.createBuffer(2, n, SR);
    for (let c = 0; c < 2; c++) { const d = b.getChannelData(c); for (let i = 0; i < n; i++) { const t = i / SR; d[i] = (rnd() * 2 - 1) * Math.exp(-t / 0.55) * (t < 0.012 ? t / 0.012 : 1); } }
    return b;
  })();
  const verbIn = ctx.createGain(); verbIn.gain.value = 0.35;
  const verbHp = ctx.createBiquadFilter(); verbHp.type = 'highpass'; verbHp.frequency.value = 250;
  verbIn.connect(verbHp); verbHp.connect(verb); verb.connect(mix);

  function bus(name, gain, comp) {
    const g = ctx.createGain(); g.gain.value = SOLO && SOLO !== name ? 0 : gain;
    if (comp) {
      const c = ctx.createDynamicsCompressor();
      c.threshold.value = comp[0]; c.ratio.value = comp[1]; c.attack.value = comp[2]; c.release.value = comp[3]; c.knee.value = 4;
      g.connect(c); c.connect(mix);
    } else g.connect(mix);
    return g;
  }
  const drums = bus('drums', 0.9, [-20, 4, 0.004, 0.12]);
  const drumSat = ctx.createWaveShaper(); drumSat.curve = shaper((x) => Math.tanh(1.6 * x) / Math.tanh(1.6)); drumSat.oversample = '2x';
  const drumIn = ctx.createGain(); drumIn.connect(drumSat); drumSat.connect(drums);
  const bassBus = ctx.createBiquadFilter(); bassBus.type = 'highpass'; bassBus.frequency.value = 34;
  bassBus.connect(bus('bass', 0.42, [-18, 4, 0.01, 0.15]));
  const gtrBus = bus('guitars', 0.62);
  const leadBus = bus('lead', 0.32);
  const fxBus = bus('fx', 0.8, [-14, 3, 0.002, 0.2]);
  // the intro opens up: the guitars start behind a low-pass filter
  const gtrTone = ctx.createBiquadFilter(); gtrTone.type = 'lowpass'; gtrTone.Q.value = 0.9;
  gtrTone.frequency.setValueAtTime(380, 0); gtrTone.frequency.exponentialRampToValueAtTime(1200, T(2)); gtrTone.frequency.exponentialRampToValueAtTime(20000, T(3, 3.5));
  gtrTone.connect(gtrBus);

  function shaper(fn) { const n = 4096, c = new Float32Array(n); for (let i = 0; i < n; i++) c[i] = fn(i / (n - 1) * 2 - 1); return c; }
  function env(g, t, peak, attack, tau, stop) {
    g.gain.setValueAtTime(0, t); g.gain.linearRampToValueAtTime(peak, t + attack); g.gain.setTargetAtTime(0, t + attack, tau);
    if (stop) g.gain.setValueAtTime(0, stop);
  }
  function noise(t, dur, out, filters, peak, attack, tau, ch) {
    const s = ctx.createBufferSource(); s.buffer = noiseBuf;
    let node = s;
    for (const [type, f, q] of filters) { const b = ctx.createBiquadFilter(); b.type = type; b.frequency.value = f; if (q !== undefined) b.Q.value = q; node.connect(b); node = b; }
    const g = ctx.createGain(); env(g, t, peak, attack, tau);
    node.connect(g); g.connect(out);
    s.start(t, rnd(), dur);
    return g;
  }
  function pan(out, p) { const pn = ctx.createStereoPanner(); pn.pan.value = p; pn.connect(out); return pn; }

  // ---------------------------------------------------------------- drums
  function kick(t, v = 1) {
    const o = ctx.createOscillator(), g = ctx.createGain();
    o.frequency.setValueAtTime(165, t); o.frequency.exponentialRampToValueAtTime(52, t + 0.06); o.frequency.exponentialRampToValueAtTime(40, t + 0.4);
    env(g, t, 1.0 * v, 0.002, 0.11);
    o.connect(g); g.connect(drumIn); o.start(t); o.stop(t + 0.7);
    noise(t, 0.03, drumIn, [['highpass', 1800], ['lowpass', 7000]], 0.35 * v, 0.001, 0.006);
  }
  function snare(t, v = 1) {
    for (const [f, a, tau] of [[188, 0.55, 0.045], [335, 0.28, 0.03]]) {
      const o = ctx.createOscillator(), g = ctx.createGain(); o.type = 'triangle';
      o.frequency.setValueAtTime(f, t); o.frequency.exponentialRampToValueAtTime(f * 0.82, t + 0.08);
      env(g, t, a * v, 0.001, tau); o.connect(g); g.connect(drumIn); o.start(t); o.stop(t + 0.4);
    }
    const n = noise(t, 0.5, drumIn, [['highpass', 1100], ['peaking', 3500, 1]], 0.75 * v, 0.001, 0.075);
    const send = ctx.createGain(); send.gain.value = 0.5; n.connect(send); send.connect(verbIn);
  }
  const hatOut = pan(drumIn, 0.25);
  function hat(t, v = 1, open = false) {
    // a metallic cluster (six square waves at inharmonic ratios) plus noise
    const g = ctx.createGain(), hp = ctx.createBiquadFilter(), bp = ctx.createBiquadFilter();
    hp.type = 'highpass'; hp.frequency.value = 7000; bp.type = 'bandpass'; bp.frequency.value = 10500; bp.Q.value = 0.6;
    for (const r of [2, 3, 4.16, 5.43, 6.79, 8.21]) { const o = ctx.createOscillator(); o.type = 'square'; o.frequency.value = 40 * r * 7.6; o.connect(bp); o.start(t); o.stop(t + (open ? 0.6 : 0.12)); }
    bp.connect(hp); hp.connect(g); env(g, t, 0.1 * v, 0.001, open ? 0.13 : 0.016); g.connect(hatOut);
    noise(t, open ? 0.6 : 0.1, hatOut, [['highpass', 7000]], 0.38 * v, 0.001, open ? 0.12 : 0.014);
  }
  function crash(t, v = 1, tau = 0.75) {
    for (const p of [-0.55, 0.55]) {
      const out = pan(drumIn, p);
      const g = ctx.createGain(), hp = ctx.createBiquadFilter(); hp.type = 'highpass'; hp.frequency.value = 4200;
      for (const f of [205.3, 304.4, 369.6, 522.7, 540, 800]) { const o = ctx.createOscillator(); o.type = 'square'; o.frequency.value = f * (1 + (rnd() - 0.5) * 0.04) * 2.1; o.connect(hp); o.start(t); o.stop(t + 4); }
      hp.connect(g); env(g, t, 0.05 * v, 0.003, tau); g.connect(out);
      const n = noise(t, 4, out, [['highpass', 3800], ['peaking', 7000, 0.8]], 0.4 * v, 0.004, tau);
      const s = ctx.createGain(); s.gain.value = 0.35; n.connect(s); s.connect(verbIn);
    }
  }
  function tom(t, f, v = 1) {
    const o = ctx.createOscillator(), g = ctx.createGain();
    o.frequency.setValueAtTime(f, t); o.frequency.exponentialRampToValueAtTime(f * 0.68, t + 0.25);
    env(g, t, 0.8 * v, 0.002, 0.13); o.connect(g); g.connect(drumIn); o.start(t); o.stop(t + 0.8);
    noise(t, 0.1, drumIn, [['bandpass', f * 4, 1]], 0.25 * v, 0.001, 0.03);
  }
  // reverse cymbal swelling into time t
  function swell(t, dur, v = 1) {
    const n = Math.round(dur * SR), b = ctx.createBuffer(2, n, SR);
    for (let c = 0; c < 2; c++) { const d = b.getChannelData(c); for (let i = 0; i < n; i++) { const k = i / n; d[i] = (rnd() * 2 - 1) * Math.pow(k, 3.2); } }
    const s = ctx.createBufferSource(); s.buffer = b;
    const hp = ctx.createBiquadFilter(); hp.type = 'highpass'; hp.frequency.value = 3000;
    const g = ctx.createGain(); g.gain.value = 0.42 * v;
    s.connect(hp); hp.connect(g); g.connect(drumIn); s.start(t - dur);
  }

  // ---------------------------------------------------------------- bass
  function bass(t, dur, m, v = 1) {
    const f = mtof(m), g = ctx.createGain(), lp = ctx.createBiquadFilter();
    lp.type = 'lowpass'; lp.Q.value = 2;
    lp.frequency.setValueAtTime(1600, t); lp.frequency.exponentialRampToValueAtTime(420, t + Math.min(dur, 0.25));
    const o = ctx.createOscillator(); o.type = 'sawtooth'; o.frequency.value = f;
    const sub = ctx.createOscillator(); sub.frequency.value = f; const sg = ctx.createGain(); sg.gain.value = 0.3;
    o.connect(lp); lp.connect(g); sub.connect(sg); sg.connect(g);
    g.gain.setValueAtTime(0, t); g.gain.linearRampToValueAtTime(0.55 * v, t + 0.004); g.gain.setTargetAtTime(0.38 * v, t + 0.01, 0.1);
    g.gain.setTargetAtTime(0, t + dur - 0.02, 0.012);
    g.connect(bassBus); o.start(t); sub.start(t); o.stop(t + dur + 0.1); sub.stop(t + dur + 0.1);
  }

  // ---------------------------------------------------------------- guitars
  // Plucked strings (Karplus-Strong), cached per note and damping; each side of the double-tracked
  // guitar has its own takes. The strings go through an amp (drive + clipping) and a cabinet EQ.
  const ksCache = new Map();
  function string(m, muted, take) {
    const key = m + (muted ? 'm' : 'o') + take;
    if (ksCache.has(key)) return ksCache.get(key);
    const f = mtof(m), N = Math.max(2, Math.round(SR / f)), len = Math.round(SR * (muted ? 0.45 : 3.2));
    const b = ctx.createBuffer(1, len, SR), d = b.getChannelData(0);
    let lp = 0;
    for (let i = 0; i < N; i++) { lp += 0.6 * ((rnd() * 2 - 1) - lp); d[i] = lp; }   // a slightly dark pick
    const decay = muted ? 0.965 : 0.9985, mix2 = muted ? 0.38 : 0.5;
    for (let i = N; i < len; i++) d[i] = decay * ((1 - mix2) * d[i - N] + mix2 * d[i - N - 1 < 0 ? 0 : i - N - 1]);
    ksCache.set(key, b);
    return b;
  }
  function amp(p, gain) {
    const inp = ctx.createGain(), hp = ctx.createBiquadFilter(), drive = ctx.createGain(), ws = ctx.createWaveShaper();
    hp.type = 'highpass'; hp.frequency.value = 110;
    drive.gain.value = gain;
    ws.curve = shaper((x) => Math.tanh(x * 2.5) * 0.9 + 0.1 * Math.tanh(x * 9)); ws.oversample = '4x';
    let node = ws;
    for (const [type, f, q, dB] of [['highpass', 85, 0.7], ['peaking', 120, 1.1, 3], ['peaking', 480, 1.3, -6], ['peaking', 1900, 1.2, 3], ['peaking', 3300, 2, 4], ['lowpass', 5400, 0.75], ['lowpass', 6400, 0.6]]) {
      const b = ctx.createBiquadFilter(); b.type = type; b.frequency.value = f; b.Q.value = q; if (dB !== undefined) b.gain.value = dB;
      node.connect(b); node = b;
    }
    const out = ctx.createGain(); out.gain.value = 0.3;
    inp.connect(hp); hp.connect(drive); drive.connect(ws); node.connect(out); out.connect(pan(gtrTone, p));
    return inp;
  }
  const rhythm = [amp(-0.85, 14), amp(0.85, 14)];
  const CH = { E: [40, 47, 52], F: [42, 49, 54], G: [43, 50, 55], A: [45, 52, 57], B: [47, 54, 59], C: [48, 55, 60], D: [50, 57, 62], d: [38, 45, 50] };
  function chord(t, dur, name, muted, v = 1) {
    const notes = CH[name];
    rhythm.forEach((inp, side) => {
      const g = ctx.createGain(), lp = ctx.createBiquadFilter();
      lp.type = 'lowpass'; lp.frequency.value = muted ? 900 : 9000;
      const t1 = t + side * 0.006 + rnd() * 0.004;   // the two takes are never exactly together
      notes.forEach((m, k) => {
        const s = ctx.createBufferSource(); s.buffer = string(m, muted, side * 3 + (k % 3));
        s.detune.value = (side ? 5 : -5) + (rnd() - 0.5) * 4;
        const sg = ctx.createGain(); sg.gain.value = (k === 0 ? 1 : 0.8) * 0.5 * v;
        s.connect(sg); sg.connect(lp); s.start(t1 + k * 0.002); s.stop(t1 + dur + 0.1);
      });
      g.gain.setValueAtTime(1, t1); g.gain.setTargetAtTime(0, t1 + Math.max(0.02, dur - 0.025), 0.015);
      lp.connect(g); g.connect(inp);
    });
  }
  // A riff: one token per eighth note; a chord name (E F G A B C D d) is played open, a lower-case
  // e is a palm-muted low E power chord, '-' holds the previous chord, '.' is a rest.
  function riff(bar, tokens, v = 1, withBass = true, unit = E8) {
    const tk = tokens.replace(/\s+/g, '').split('');
    for (let i = 0; i < tk.length; i++) {
      const c = tk[i];
      if (c === '-' || c === '.') continue;
      let n = 1; while (tk[i + n] === '-') n++;
      const t = T(bar) + i * unit, muted = c === 'e' || c === 'm';
      chord(t, n * unit, muted ? 'E' : c, muted, v * (muted ? 0.85 : 1));
      if (withBass) bass(t, n * unit - 0.01, (muted ? CH.E : CH[c])[0] - 12, v);
    }
  }

  // lead guitar: a saw and a square through a hotter amp, with vibrato, glides and a delay
  const leadAmp = (() => {
    const inp = ctx.createGain(), drive = ctx.createGain(), ws = ctx.createWaveShaper();
    drive.gain.value = 9; ws.curve = shaper((x) => Math.tanh(x * 3)); ws.oversample = '4x';
    const hp = ctx.createBiquadFilter(); hp.type = 'highpass'; hp.frequency.value = 220;
    const lp = ctx.createBiquadFilter(); lp.type = 'lowpass'; lp.frequency.value = 4800; lp.Q.value = 0.9;
    const mid = ctx.createBiquadFilter(); mid.type = 'peaking'; mid.frequency.value = 1500; mid.Q.value = 1; mid.gain.value = 5;
    inp.connect(hp); hp.connect(drive); drive.connect(ws); ws.connect(mid); mid.connect(lp);
    const dl = ctx.createDelay(1); dl.delayTime.value = BEAT * 0.75; const fb = ctx.createGain(); fb.gain.value = 0.32;
    const wet = ctx.createGain(); wet.gain.value = 0.3;
    lp.connect(leadBus); lp.connect(dl); dl.connect(fb); fb.connect(dl); dl.connect(wet); wet.connect(pan(leadBus, 0.3));
    const s = ctx.createGain(); s.gain.value = 0.6; lp.connect(s); s.connect(verbIn);
    return inp;
  })();
  // notes: [[beat offset from the bar, length in beats, midi], ...]
  function lead(bar, notes, v = 1) {
    let prev = null;
    for (const [b, len, m] of notes) {
      const t = T(bar, b), dur = len * BEAT, f = mtof(m);
      const g = ctx.createGain();
      for (const [type, a] of [['sawtooth', 0.22], ['square', 0.12]]) {
        const o = ctx.createOscillator(); o.type = type;
        o.frequency.setValueAtTime(prev && prev.end > t - 0.05 ? prev.f : f * 0.94, t);
        o.frequency.exponentialRampToValueAtTime(f, t + 0.07);
        const vib = ctx.createOscillator(), vg = ctx.createGain(); vib.frequency.value = 5.6;
        vg.gain.setValueAtTime(0, t); vg.gain.linearRampToValueAtTime(f * 0.012, t + Math.min(dur, 0.5));
        vib.connect(vg); vg.connect(o.frequency);
        const og = ctx.createGain(); og.gain.value = a; o.connect(og); og.connect(g);
        o.start(t); o.stop(t + dur + 0.2); vib.start(t); vib.stop(t + dur + 0.2);
      }
      g.gain.setValueAtTime(0, t); g.gain.linearRampToValueAtTime(v, t + 0.01); g.gain.setTargetAtTime(0.75 * v, t + 0.02, 0.3);
      g.gain.setTargetAtTime(0, t + dur - 0.03, 0.03);
      g.connect(leadAmp);
      prev = { f, end: t + dur };
    }
  }

  // ---------------------------------------------------------------- trailer sounds
  function boom(t, v = 1) {
    const o = ctx.createOscillator(), g = ctx.createGain();
    o.frequency.setValueAtTime(78, t); o.frequency.exponentialRampToValueAtTime(30, t + 1.1);
    env(g, t, 0.95 * v, 0.004, 0.42); o.connect(g); g.connect(fxBus); o.start(t); o.stop(t + 2.5);
    noise(t, 1.2, fxBus, [['lowpass', 520]], 0.7 * v, 0.003, 0.22);
    const n = noise(t, 0.4, fxBus, [['highpass', 1800]], 0.35 * v, 0.001, 0.035);
    const s = ctx.createGain(); s.gain.value = 0.6; n.connect(s); s.connect(verbIn);
  }
  // twisted metal: resonant noise bursts scattered over a third of a second
  function crunch(t, v = 1) {
    for (let i = 0; i < 9; i++) {
      const t1 = t + rnd() * 0.3 * (i / 9);
      noise(t1, 0.3, pan(fxBus, (rnd() - 0.5) * 0.8), [['bandpass', 500 + rnd() * 3200, 6 + rnd() * 8]], (1.6 + rnd()) * v * (1 - i / 14), 0.002, 0.04 + rnd() * 0.06);
    }
    noise(t, 0.4, fxBus, [['lowpass', 300]], 0.5 * v, 0.002, 0.08);
  }
  function glass(t, v = 1) {
    for (let i = 0; i < 26; i++) {
      const t1 = t + Math.pow(rnd(), 1.6) * 0.45, o = ctx.createOscillator(), g = ctx.createGain();
      o.frequency.value = 2600 + rnd() * 6500;
      env(g, t1, (0.03 + rnd() * 0.05) * v, 0.0005, 0.02 + rnd() * 0.09);
      o.connect(g); g.connect(pan(fxBus, (rnd() - 0.5) * 1.4)); o.start(t1); o.stop(t1 + 0.5);
    }
    noise(t, 0.5, fxBus, [['highpass', 5200]], 0.4 * v, 0.001, 0.07);
  }
  function whoosh(t, dur = 0.5, v = 1) {
    const s = ctx.createBufferSource(); s.buffer = noiseBuf;
    const bp = ctx.createBiquadFilter(); bp.type = 'bandpass'; bp.Q.value = 1.6;
    bp.frequency.setValueAtTime(260, t - dur); bp.frequency.exponentialRampToValueAtTime(3800, t); bp.frequency.exponentialRampToValueAtTime(600, t + 0.25);
    const g = ctx.createGain(); g.gain.setValueAtTime(0, t - dur); g.gain.linearRampToValueAtTime(0.55 * v, t); g.gain.setTargetAtTime(0, t, 0.08);
    const p = ctx.createStereoPanner(); p.pan.setValueAtTime(-0.7, t - dur); p.pan.linearRampToValueAtTime(0.7, t + 0.2);
    s.connect(bp); bp.connect(g); g.connect(p); p.connect(fxBus); s.start(t - dur, rnd(), dur + 0.6);
  }
  function riser(t0, t1, v = 1) {
    const s = ctx.createBufferSource(); s.buffer = noiseBuf; s.loop = true;
    const bp = ctx.createBiquadFilter(); bp.type = 'bandpass'; bp.Q.value = 2.2;
    bp.frequency.setValueAtTime(220, t0); bp.frequency.exponentialRampToValueAtTime(9000, t1);
    const g = ctx.createGain(); g.gain.setValueAtTime(0.0001, t0); g.gain.exponentialRampToValueAtTime(0.5 * v, t1 - 0.02); g.gain.linearRampToValueAtTime(0, t1);
    s.connect(bp); bp.connect(g); g.connect(fxBus); s.start(t0); s.stop(t1 + 0.05);
    // and a rising saw an octave up
    const o = ctx.createOscillator(), og = ctx.createGain(), lp = ctx.createBiquadFilter(); o.type = 'sawtooth'; lp.type = 'lowpass'; lp.frequency.value = 2200;
    o.frequency.setValueAtTime(mtof(40), t0); o.frequency.exponentialRampToValueAtTime(mtof(64), t1);
    og.gain.setValueAtTime(0.0001, t0); og.gain.exponentialRampToValueAtTime(0.09 * v, t1 - 0.02); og.gain.linearRampToValueAtTime(0, t1);
    o.connect(lp); lp.connect(og); og.connect(fxBus); o.start(t0); o.stop(t1 + 0.05);
  }
  // the trailer horn: a stack of detuned saws whose filter opens and closes
  function braam(t, v = 1, dur = 2.2) {
    const g = ctx.createGain(), lp = ctx.createBiquadFilter(), ws = ctx.createWaveShaper();
    lp.type = 'lowpass'; lp.Q.value = 3;
    lp.frequency.setValueAtTime(120, t); lp.frequency.exponentialRampToValueAtTime(1400, t + 0.12); lp.frequency.exponentialRampToValueAtTime(260, t + dur);
    ws.curve = shaper((x) => Math.tanh(2 * x)); ws.oversample = '2x';
    for (const m of [28, 40, 47, 52]) for (const dt of [-9, 0, 9]) {
      const o = ctx.createOscillator(); o.type = 'sawtooth'; o.frequency.value = mtof(m); o.detune.value = dt;
      const og = ctx.createGain(); og.gain.value = m < 30 ? 0.12 : 0.07; o.connect(og); og.connect(lp); o.start(t); o.stop(t + dur + 0.5);
    }
    lp.connect(ws); ws.connect(g);
    g.gain.setValueAtTime(0, t); g.gain.linearRampToValueAtTime(0.5 * v, t + 0.04); g.gain.setTargetAtTime(0, t + 0.3, dur / 3);
    g.connect(fxBus);
    const s = ctx.createGain(); s.gain.value = 0.5; g.connect(s); s.connect(verbIn);
  }
  function tick(t, v = 1) { noise(t, 0.05, fxBus, [['bandpass', 2600, 4]], 0.9 * v, 0.0005, 0.008); }

  // ---------------------------------------------------------------- drum patterns (8th-note grid)
  function beat(bar, style) {
    for (let i = 0; i < 8; i++) {
      const t = T(bar) + i * E8;
      if (style === 'rock') {
        if (i === 0 || i === 4 || i === 5 || (bar % 2 && i === 3)) kick(t, i % 4 ? 0.85 : 1);
        if (i === 2 || i === 6) snare(t);
        hat(t, i % 2 ? 0.6 : 1, i === 7);
      } else if (style === 'drive') {   // the chorus: kick on every beat and the off-beats of 1 and 3
        if (i % 2 === 0 || i === 1 || i === 5) kick(t, i % 2 ? 0.8 : 1);
        if (i === 2 || i === 6) snare(t, 1.05);
        hat(t, i % 2 ? 0.7 : 1, i % 2 === 1);
      } else if (style === 'double') {   // the last chorus: kick on every eighth
        kick(t, i % 2 ? 0.8 : 1);
        if (i === 2 || i === 6) snare(t, 1.1);
        hat(t, 0.9, true);
      } else if (style === 'half') {   // half-time: snare on 3
        if (i === 0 || i === 3) kick(t);
        if (i === 4) snare(t, 1.1);
        if (i % 2 === 0) hat(t, 0.8, true);
      }
    }
  }
  function roll(bar, from, to, beat0, beats) {   // a snare roll in 16ths, getting louder
    const n = beats * 4;
    for (let i = 0; i < n; i++) snare(T(bar, beat0) + i * E16, from + (to - from) * i / (n - 1));
  }
  function toms(bar, beat0) { [220, 220, 170, 170, 130, 130, 100, 100].forEach((f, i) => tom(T(bar, beat0) + i * E16, f, 0.9)); }

  // ---------------------------------------------------------------- the arrangement
  const VERSE = ['e e G - e e A -', 'e e G - e e D C', 'e e G - e e A -', 'e e B - A - G -'];
  // intro (bars 0-3): palm-muted chugs behind a filter that opens, then drums come in
  riff(0, 'e e e e e e e e', 0.9, false); riff(1, 'e e e e e e e e', 0.9, false);
  riff(2, 'e e e e e e e e'); riff(3, 'e e e e G A . .');
  for (let i = 0; i < 4; i++) kick(T(2, i), 0.9);
  for (let i = 0; i < 8; i++) hat(T(2) + i * E8, 0.7);
  roll(3, 0.25, 1.0, 0, 3);
  riser(T(2), T(4) - 0.01, 0.9); swell(T(4), 1.4);
  // verse (bars 4-11)
  for (let b = 4; b < 12; b++) { riff(b, VERSE[(b - 4) % 4]); beat(b, 'rock'); }
  crash(T(4), 1.2); crash(T(8)); toms(11, 2);
  // pre-chorus (bars 12-15): half-time, held chords, a rising lead
  riff(12, 'C - - - - - - -'); riff(13, 'D - - - - - - -'); riff(14, 'E - - - - - - -'); riff(15, 'e e e e e e . .', 1);
  for (let b = 12; b < 15; b++) beat(b, 'half');
  crash(T(12)); crash(T(14), 0.8);
  lead(12, [[0, 4, 64]], 0.8); lead(13, [[0, 2, 66], [2, 2, 67]], 0.85); lead(14, [[0, 4, 71]], 0.9);
  roll(15, 0.3, 1.1, 0, 3); riser(T(14), T(16) - 0.01, 1); swell(T(16), 1.6, 1.1);
  // chorus (bars 16-23)
  const CHORUS = ['E', 'C', 'G', 'D', 'E', 'C', 'G', 'D'];
  for (let b = 16; b < 24; b++) {
    const c = CHORUS[b - 16];
    riff(b, `${c} ${c} ${c} ${c} ${c} ${c} ${c} ${c}`, 0.95); beat(b, 'drive'); crash(T(b), b === 16 ? 1.3 : 0.8);
  }
  const HOOK = [[[0, 3, 71], [3, 1, 76]], [[0, 2, 74], [2, 2, 71]], [[0, 3, 67], [3, 1, 69]], [[0, 4, 71]],
    [[0, 3, 71], [3, 1, 76]], [[0, 2, 74], [2, 2, 71]], [[0, 2, 67], [2, 2, 69]], [[0, 4, 64]]];
  HOOK.forEach((n, i) => lead(16 + i, n));
  toms(23, 3);
  // breakdown (bars 24-27): half-time, syncopated low chugs doubled by the kick
  const BREAK = 'x x . x . . x . x . x x . . . .';
  for (let b = 24; b < 27; b++) {
    BREAK.split(' ').forEach((c, i) => { if (c === 'x') { const t = T(b) + i * E16; chord(t, E16 * 1.6, 'd', true, 1.1); bass(t, E16 * 1.5, 26); kick(t, 0.95); } });
    snare(T(b, 2), 1.1); crash(T(b), 0.55, 0.4);
  }
  riff(27, 'd - - - e e . .'); roll(27, 0.3, 1.1, 0, 3); riser(T(26), T(28) - 0.01, 1.1); swell(T(28), 1.6, 1.2);
  // last chorus (bars 28-33): double kick, the hook an octave higher at the end
  const FINAL = ['E', 'C', 'G', 'D', 'C', 'D'];
  for (let b = 28; b < 34; b++) {
    const c = FINAL[b - 28];
    riff(b, `${c} ${c} ${c} ${c} ${c} ${c} ${c} ${c}`); beat(b, b < 33 ? 'double' : 'drive'); crash(T(b), b === 28 ? 1.3 : 0.85);
  }
  HOOK.slice(0, 4).forEach((n, i) => lead(28 + i, n));
  lead(32, [[0, 2, 79], [2, 2, 78]]); lead(33, [[0, 2, 76], [2, 2, 74]]);
  roll(33, 0.4, 1.2, 2, 2);
  // ending (bars 34-37.5): three hits under the title cards, then the ring-out
  for (const [b, c, len] of [[34, 'E', BAR], [35, 'C', BAR], [36, 'E', LEN - T(36)]]) {
    chord(T(b), len, c, false, 1.05); bass(T(b), len - 0.05, CH[c][0] - 12);
    kick(T(b), 1.1); snare(T(b), 0.8); crash(T(b), 1.2, 1.1);
  }
  lead(36, [[0, 5.5, 76]], 0.9);

  // the picture's sound effects
  for (const h of opts.hits) {
    if (h.kind === 'impact') { boom(h.t, h.v || 1); crunch(h.t + 0.01, h.v || 1); if (h.glass) glass(h.t + 0.02, 0.9); }
    else if (h.kind === 'card') { boom(h.t, 0.75); braam(h.t, 0.55, 1.4); }
    else if (h.kind === 'title') { boom(h.t, 1.1); braam(h.t, 0.9, 2.6); }
    else if (h.kind === 'whoosh') whoosh(h.t, h.dur || 0.45, h.v || 1);
    else if (h.kind === 'tick') tick(h.t, h.v || 1);
    else if (h.kind === 'glass') glass(h.t, h.v || 1);
  }

  // ---------------------------------------------------------------- render to a WAV
  return ctx.startRendering().then((buf) => {
    const L = buf.getChannelData(0), R = buf.getChannelData(1), n = buf.length;
    let peak = 0, sum = 0;
    for (let i = 0; i < n; i++) { peak = Math.max(peak, Math.abs(L[i]), Math.abs(R[i])); sum += L[i] * L[i] + R[i] * R[i]; }
    const gain = peak > 0 ? 0.7 / peak : 1;   // peak at -3 dBFS: AAC overshoots by up to 2 dB
    const bytes = new Uint8Array(44 + n * 4), dv = new DataView(bytes.buffer);
    const str = (o, s) => { for (let i = 0; i < s.length; i++) bytes[o + i] = s.charCodeAt(i); };
    str(0, 'RIFF'); dv.setUint32(4, 36 + n * 4, true); str(8, 'WAVE'); str(12, 'fmt ');
    dv.setUint32(16, 16, true); dv.setUint16(20, 1, true); dv.setUint16(22, 2, true); dv.setUint32(24, SR, true);
    dv.setUint32(28, SR * 4, true); dv.setUint16(32, 4, true); dv.setUint16(34, 16, true); str(36, 'data'); dv.setUint32(40, n * 4, true);
    for (let i = 0, o = 44; i < n; i++, o += 4) {
      dv.setInt16(o, Math.max(-32767, Math.min(32767, Math.round(L[i] * gain * 32767))), true);
      dv.setInt16(o + 2, Math.max(-32767, Math.min(32767, Math.round(R[i] * gain * 32767))), true);
    }
    window.__wav = bytes;
    window.__wavStats = { peakDb: 20 * Math.log10(peak), rmsDb: 10 * Math.log10(sum / (2 * n)) + 20 * Math.log10(gain), seconds: n / SR };
    return bytes.length;
  });
}

module.exports = { renderMusic };
