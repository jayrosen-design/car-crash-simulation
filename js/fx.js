/* Event-driven effects (TRD §5.1): synthesized Web Audio sounds and a point-particle system.
 * Physics events arrive already merged within 0.1 m (physics.js); here audio is filtered by
 * fragment mass (heavy -> low crunch/thud, light -> scatter, tiny -> culled) and capped by a
 * voice limit so dense break events cannot starve the audio channel.
 *
 * Sounds are placed in 3D (HRTF panners at the event, a listener that follows the camera). In
 * slow motion they are pitched down and drawn out (setTimeScale), as a high-speed film's sound
 * would be. Besides the one-shot sounds there is a continuous structural sound whose loudness,
 * resonance and distortion follow the power the crash is dissipating (structureUpdate). */
const FX = (() => {
  'use strict';
  const T = THREE;

  // ---------------------------------------------------------------- audio
  let ctx = null, master = null, noiseBuf = null, enabled = true, engine = null;
  let rate = 1;   // pitch factor of new sounds: below 1 in slow motion
  let voiceEnds = [];   // when the sounds now playing end
  const MAX_VOICES = 14;
  // While a video is being saved (export.js) the sounds go to an offline context instead, on a
  // clock the exporter sets frame by frame: { live: the live context and output, t: the clock }.
  let cap = null;
  const now = () => cap ? cap.t : ctx.currentTime;
  // run fn ms milliseconds from now (in capture: at that point on the clock)
  function later(ms, fn) {
    if (!cap) { setTimeout(fn, ms); return; }
    const t = cap.t; cap.t += ms / 1000; fn(); cap.t = t;
  }
  // set an audio parameter now (in capture: at the clock's time)
  function setp(param, v) { if (cap) param.setValueAtTime(v, cap.t); else param.value = v; }

  function initAudio() {
    if (ctx) { if (ctx.state === 'suspended') ctx.resume(); return; }
    const AC = window.AudioContext || window.webkitAudioContext;
    if (!AC) return;
    ctx = new AC();
    master = ctx.createGain();
    master.gain.value = enabled ? 0.7 : 0;
    master.connect(limiter(ctx));
    noiseBuf = ctx.createBuffer(1, ctx.sampleRate * 2, ctx.sampleRate);
    const d = noiseBuf.getChannelData(0);
    for (let i = 0; i < d.length; i++) d[i] = Math.random() * 2 - 1;
  }
  // a limiter in front of the speakers, so the loudest moments of a crash don't clip
  function limiter(c) {
    const k = c.createDynamicsCompressor();
    k.threshold.value = -6; k.knee.value = 6; k.ratio.value = 12; k.attack.value = 0.003; k.release.value = 0.25;
    k.connect(c.destination);
    return k;
  }
  function setEnabled(on) { enabled = on; if (master) master.gain.value = on ? 0.7 : 0; }
  // playback speed of the replay (1 = real time): slow motion lowers the pitch, down to 0.4
  function setTimeScale(speed) { rate = Math.max(0.4, Math.min(1, Math.pow(speed, 0.25))); }
  const stretch = (dur) => dur / Math.sqrt(rate);
  function take(dur) {
    if (!ctx || (!enabled && !cap)) return false;
    const t = now();
    voiceEnds = voiceEnds.filter(e => e > t);
    if (voiceEnds.length >= MAX_VOICES) return false;
    voiceEnds.push(t + stretch(dur) + 0.06);
    return true;
  }
  // the listener: the camera's position and orientation, set every frame
  function listen(p, fwd, up) {
    if (!ctx) return;
    const L = ctx.listener;
    if (L.positionX) {
      setp(L.positionX, p.x); setp(L.positionY, p.y); setp(L.positionZ, p.z);
      setp(L.forwardX, fwd.x); setp(L.forwardY, fwd.y); setp(L.forwardZ, fwd.z);
      setp(L.upX, up.x); setp(L.upY, up.y); setp(L.upZ, up.z);
    } else { L.setPosition(p.x, p.y, p.z); L.setOrientation(fwd.x, fwd.y, fwd.z, up.x, up.y, up.z); }
  }
  function place(pn, pos) {
    if (pn.positionX) { setp(pn.positionX, pos[0]); setp(pn.positionY, pos[1]); setp(pn.positionZ, pos[2]); }
    else pn.setPosition(pos[0], pos[1], pos[2]);
  }
  // where a sound goes: a panner at pos (world coordinates), or straight to the speakers
  function out(pos) {
    if (!pos || !ctx.createPanner) return master;
    const pn = ctx.createPanner();
    pn.panningModel = 'HRTF'; pn.distanceModel = 'inverse'; pn.refDistance = 6; pn.rolloffFactor = 0.7;
    place(pn, pos);
    pn.connect(master);
    return pn;
  }
  // soft-clipping curves for distortion, by drive
  const curves = {};
  function curve(drive) {
    const k = Math.max(0.25, Math.round(drive * 4) / 4);
    if (!curves[k]) curves[k] = Float32Array.from({ length: 1024 }, (_, i) => Math.tanh(k * (i / 511.5 - 1)) / Math.tanh(k));
    return curves[k];
  }
  function shaper(drive) { const w = ctx.createWaveShaper(); w.curve = curve(drive); w.oversample = '2x'; return w; }
  function noise({ dur, gain, type, f0, f1, Q, pos, attack = 0.002, drive = 0 }) {
    const t = now(), d = stretch(dur);
    const src = ctx.createBufferSource(); src.buffer = noiseBuf;
    src.playbackRate.value = (0.8 + Math.random() * 0.4) * rate;
    const flt = ctx.createBiquadFilter(); flt.type = type; flt.Q.value = Q || 0.7;
    flt.frequency.setValueAtTime(f0 * rate, t); flt.frequency.exponentialRampToValueAtTime(Math.max(20, f1 * rate), t + d);
    const g = ctx.createGain();
    g.gain.setValueAtTime(0.0001, t); g.gain.exponentialRampToValueAtTime(gain, t + attack); g.gain.exponentialRampToValueAtTime(0.0001, t + d);
    (drive ? src.connect(flt).connect(shaper(drive)) : src.connect(flt)).connect(g).connect(out(pos));
    src.start(t, Math.random() * 1.5); src.stop(t + d + 0.05);
  }
  function tone({ dur, gain, f0, f1, pos, type = 'sine' }) {
    const t = now(), d = stretch(dur);
    const o = ctx.createOscillator(); o.type = type;
    o.frequency.setValueAtTime(f0 * rate, t); o.frequency.exponentialRampToValueAtTime(f1 * rate, t + d);
    const g = ctx.createGain();
    g.gain.setValueAtTime(gain, t); g.gain.exponentialRampToValueAtTime(0.0001, t + d);
    o.connect(g).connect(out(pos));
    o.start(t); o.stop(t + d + 0.05);
  }
  // Structural crunch of the car on the barrier; intensity 0..1. Harder hits are lower, more
  // resonant and more distorted.
  function crunch(intensity, pos) {
    if (!take(0.6)) return;
    const k = Math.max(0.15, Math.min(1, intensity)), low = 1.25 - 0.5 * k;
    noise({ dur: 0.55, gain: 0.9 * k, type: 'lowpass', f0: 2400 * low, f1: 180, Q: 1.2 + 3 * k, pos, drive: 1 + 5 * k });
    noise({ dur: 0.25, gain: 0.35 * k, type: 'bandpass', f0: 3200 * low, f1: 900, Q: 6, pos });
    tone({ dur: 0.35, gain: 0.8 * k, f0: 90 * low, f1: 38, pos });
  }
  function scatter(count, pos) {
    const n = Math.min(4, 1 + Math.floor(count / 2));
    for (let i = 0; i < n; i++) later(i * (20 + Math.random() * 40) / rate, () => {
      if (!take(0.08)) return;
      noise({ dur: 0.05 + Math.random() * 0.05, gain: 0.25, type: 'bandpass', f0: 3000 + Math.random() * 3000, f1: 1500, Q: 4, pos });
    });
  }
  function thud(mass, pos) {
    if (!take(0.25)) return;
    const k = Math.min(1, mass / 40);
    noise({ dur: 0.18, gain: 0.5 * k, type: 'lowpass', f0: 700, f1: 120, pos });
    tone({ dur: 0.16, gain: 0.45 * k, f0: 140, f1: 55, pos });
  }
  function pop(pos) {
    if (!take(0.4)) return;
    noise({ dur: 0.3, gain: 0.7, type: 'highpass', f0: 900, f1: 300, pos });
    tone({ dur: 0.25, gain: 0.6, f0: 70, f1: 40, pos });
  }
  // A tyre bursting under load: a sharp bang, the thump of the casing, a rubber flap and the rush
  // of escaping air.
  function blowout(pos) {
    if (!take(0.9)) return;
    noise({ dur: 0.07, gain: 1.0, type: 'highpass', f0: 320, f1: 200, pos, attack: 0.001, drive: 3 });
    tone({ dur: 0.24, gain: 0.8, f0: 85, f1: 32, pos });
    noise({ dur: 0.35, gain: 0.3, type: 'bandpass', f0: 600, f1: 140, Q: 1.5, pos });
    noise({ dur: 0.9, gain: 0.3, type: 'highpass', f0: 5200, f1: 1800, pos, attack: 0.01 });
  }
  // The emergency-braking warning chime.
  function beep(f) {
    if (!take(0.15)) return;
    tone({ dur: 0.12, gain: 0.22, f0: f || 1760, f1: f || 1760, type: 'square' });
  }
  function hit(force, pos) {
    if (!take(0.2)) return;
    const k = Math.min(1, force / 8000);
    noise({ dur: 0.12, gain: 0.5 * k + 0.1, type: 'lowpass', f0: 1200, f1: 200, pos });
  }
  // A panel or wheel tearing off: a metallic clank (inharmonic partials) over a noise burst.
  function clank(mass, pos) {
    if (!take(0.5)) return;
    const k = Math.max(0.3, Math.min(1, mass / 20));
    noise({ dur: 0.3, gain: 0.45 * k, type: 'bandpass', f0: 1800, f1: 500, Q: 2, pos });
    for (const f of [310, 523, 847]) tone({ dur: 0.35 + Math.random() * 0.2, gain: 0.12 * k, f0: f * (0.9 + Math.random() * 0.2), f1: f * 0.8, pos, type: 'triangle' });
  }
  // Sheet metal tearing along a seam: a screech whose pitch jumps about as the tear runs, over a
  // buzzing saw tone, both driven hard.
  function tear(mass, pos) {
    if (!take(0.7)) return;
    const k = Math.max(0.35, Math.min(1, mass / 20)), t = now(), d = stretch(0.45 + 0.25 * k);
    const jitter = (n, lo, hi) => Float32Array.from({ length: n }, () => (lo + Math.random() * (hi - lo)) * rate);
    const env = (gain, attack) => { const g = ctx.createGain(); g.gain.setValueAtTime(0.0001, t); g.gain.exponentialRampToValueAtTime(gain, t + attack); g.gain.exponentialRampToValueAtTime(0.0001, t + d); return g; };
    const src = ctx.createBufferSource(); src.buffer = noiseBuf;
    const bp = ctx.createBiquadFilter(); bp.type = 'bandpass'; bp.Q.value = 9;
    bp.frequency.setValueCurveAtTime(jitter(24, 700, 3200), t, d);
    src.connect(bp).connect(shaper(4)).connect(env(0.5 * k, 0.01)).connect(out(pos));
    src.start(t, Math.random() * 1.5); src.stop(t + d + 0.05);
    const o = ctx.createOscillator(); o.type = 'sawtooth';
    o.frequency.setValueCurveAtTime(jitter(16, 90, 260), t, d);
    const lp = ctx.createBiquadFilter(); lp.type = 'lowpass'; lp.frequency.value = 1800 * rate;
    o.connect(lp).connect(env(0.16 * k, 0.02)).connect(out(pos));
    o.start(t); o.stop(t + d + 0.05);
  }
  // Tempered glass: a sharp burst, then a shower of small tinkles.
  function glass(area, pos) {
    if (!take(0.2)) return;
    noise({ dur: 0.18, gain: 0.5, type: 'highpass', f0: 4000, f1: 2500, pos });
    const nTink = Math.min(10, 3 + Math.round(area * 2));
    for (let i = 0; i < nTink; i++) later((40 + i * (25 + Math.random() * 50)) / rate, () => {
      if (!take(0.06)) return;
      tone({ dur: 0.04 + Math.random() * 0.05, gain: 0.08, f0: 3500 + Math.random() * 4500, f1: 3000, pos, type: 'sine' });
    });
  }
  // Laminated windshield cracking: a short dry crackle.
  function crack(intensity, pos) {
    if (!take(0.15)) return;
    noise({ dur: 0.12, gain: 0.35 * intensity, type: 'bandpass', f0: 2600, f1: 1200, Q: 3, pos });
  }
  // Mass filtering: heavy fragments crunch, light ones scatter, tiny ones are culled.
  function breakSound(mass, count, pos) {
    if (mass < 5) return;
    if (mass >= 30) thud(mass, pos); else scatter(count, pos);
  }

  // The sound of the structure giving way, set every frame from the power the crash is
  // dissipating (W): about 0.5 at 1 MW, 0.85 at 5 MW, 1.2 at 25 MW. More power: louder, a higher
  // and more resonant band, more distortion, and a deeper rumble under it.
  let bed = null;
  function structureUpdate(powerW, pos) {
    if (!ctx) return;
    const lv = powerW > 1e5 ? Math.min(1.3, Math.log10(powerW / 1e5) / 2) : 0;
    if (!bed) {
      if (lv <= 0 || (!enabled && !cap)) return;
      const src = ctx.createBufferSource(); src.buffer = noiseBuf; src.loop = true;
      const drive = ctx.createGain(), bp = ctx.createBiquadFilter(), g = ctx.createGain();
      bp.type = 'bandpass'; g.gain.value = 0;
      const rum = ctx.createOscillator(); rum.type = 'sawtooth';
      const rlp = ctx.createBiquadFilter(); rlp.type = 'lowpass'; rlp.frequency.value = 160;
      const rg = ctx.createGain(); rg.gain.value = 0;
      const pn = out(pos);
      src.connect(drive).connect(shaper(6)).connect(bp).connect(g).connect(pn);
      rum.connect(rlp).connect(rg).connect(pn);
      src.start(now()); rum.start(now());
      bed = { src, drive, bp, g, rum, rg, pn, quiet: 0, last: now() };
    }
    const t = now();
    if (pos && bed.pn !== master) place(bed.pn, pos);
    bed.src.playbackRate.setTargetAtTime(rate, t, 0.05);
    bed.drive.gain.setTargetAtTime(0.4 + 2.5 * lv, t, 0.03);
    bed.bp.frequency.setTargetAtTime((260 + 1100 * lv) * rate, t, 0.03);
    bed.bp.Q.setTargetAtTime(1.5 + 4 * lv, t, 0.03);
    bed.g.gain.setTargetAtTime(0.32 * lv, t, 0.03);
    bed.rum.frequency.setTargetAtTime((36 + 30 * lv) * rate, t, 0.05);
    bed.rg.gain.setTargetAtTime(0.22 * lv, t, 0.04);
    // stop it once it has been silent for a second
    bed.quiet = lv > 0 ? 0 : bed.quiet + (t - bed.last);
    bed.last = t;
    if (bed.quiet > 1) { const b = bed; bed = null; b.src.stop(t); b.rum.stop(t); }
  }

  // Saving a video: from beginCapture until endCapture the sounds are rendered offline, for a
  // recording `seconds` long, at the times captureClock sets. endCapture returns the AudioBuffer.
  function stopLoops() {
    const t = now();
    if (bed) { bed.src.stop(t); bed.rum.stop(t); bed = null; }
    if (burn) { burn.roar.src.stop(t); burn.hiss.src.stop(t); burn = null; }
  }
  function beginCapture(seconds) {
    initAudio();
    if (!ctx || cap || typeof OfflineAudioContext !== 'function') return false;
    stopLoops();
    const off = new OfflineAudioContext(2, Math.ceil(seconds * ctx.sampleRate), ctx.sampleRate);
    const m = off.createGain(); m.gain.value = 0.7; m.connect(limiter(off));
    cap = { live: { ctx, master }, t: 0 };
    ctx = off; master = m; voiceEnds = [];
    return true;
  }
  function captureClock(t) { if (cap) cap.t = t; }
  function endCapture(render = true) {
    if (!cap) return Promise.resolve(null);
    stopLoops();
    const off = ctx;
    ({ ctx, master } = cap.live); cap = null; voiceEnds = [];
    return render ? off.startRendering() : Promise.resolve(null);
  }

  function engineStart() {
    if (!ctx || engine) return;
    const o = ctx.createOscillator(); o.type = 'sawtooth';
    const o2 = ctx.createOscillator(); o2.type = 'square';
    const f = ctx.createBiquadFilter(); f.type = 'lowpass'; f.frequency.value = 500;
    const g = ctx.createGain(); g.gain.value = 0.0001;
    o.connect(f); o2.connect(f); f.connect(g).connect(master);
    o.start(); o2.start();
    g.gain.exponentialRampToValueAtTime(0.06, ctx.currentTime + 0.4);
    engine = { o, o2, g, f };
  }
  function engineUpdate(kmh, load) {
    if (!engine) return;
    const t = ctx.currentTime, rpm = 900 + (kmh % 45) * 90 + kmh * 12;
    engine.o.frequency.setTargetAtTime(rpm / 30, t, 0.05);
    engine.o2.frequency.setTargetAtTime(rpm / 60, t, 0.05);
    engine.f.frequency.setTargetAtTime(350 + 600 * Math.max(0, load), t, 0.08);
  }
  function engineStop() {
    if (!engine) return;
    const e = engine; engine = null;
    e.g.gain.setTargetAtTime(0.0001, ctx.currentTime, 0.03);
    setTimeout(() => { e.o.stop(); e.o2.stop(); }, 300);
  }

  // After the crash: the roar and crackle of a fire, the hiss of steam (levels 0..1, set every frame).
  let burn = null;
  function fireUpdate(fire, steam) {
    if (!ctx) return;
    if (!burn) {
      if (fire <= 0 && steam <= 0) return;
      const loop = (type, f, Q) => {
        const src = ctx.createBufferSource(); src.buffer = noiseBuf; src.loop = true;
        const flt = ctx.createBiquadFilter(); flt.type = type; flt.frequency.value = f; flt.Q.value = Q;
        const g = ctx.createGain(); g.gain.value = 0;
        src.connect(flt).connect(g).connect(master); src.start(now());
        return { src, g };
      };
      burn = { roar: loop('lowpass', 420, 0.8), hiss: loop('highpass', 3200, 0.7) };
    }
    const t = now();
    burn.roar.g.gain.setTargetAtTime(0.32 * fire, t, 0.2);
    burn.hiss.g.gain.setTargetAtTime(0.07 * steam, t, 0.2);
    // crackles: a few short bursts a second while it burns
    if (fire > 0.05 && Math.random() < 0.09 * fire && take(0.08)) noise({ dur: 0.03 + Math.random() * 0.05, gain: 0.12 + 0.25 * Math.random() * fire, type: 'bandpass', f0: 1500 + Math.random() * 3000, f1: 900, Q: 2 });
    if (fire <= 0 && steam <= 0) { const b = burn; burn = null; b.roar.g.gain.setTargetAtTime(0, t, 0.05); b.hiss.g.gain.setTargetAtTime(0, t, 0.05); b.roar.src.stop(t + 0.4); b.hiss.src.stop(t + 0.4); }
  }

  // ---------------------------------------------------------------- particles
  const VERT = `
    attribute float size; attribute float alpha; attribute vec3 pcolor;
    uniform float scale;
    varying vec3 vColor; varying float vAlpha;
    void main() {
      vColor = pcolor; vAlpha = alpha;
      vec4 mv = modelViewMatrix * vec4(position, 1.0);
      gl_PointSize = size * scale / max(0.1, -mv.z);
      gl_Position = projectionMatrix * mv;
    }`;
  const FRAG = `
    varying vec3 vColor; varying float vAlpha;
    void main() {
      float d = length(gl_PointCoord - 0.5);
      if (d > 0.5) discard;
      gl_FragColor = vec4(vColor, vAlpha * smoothstep(0.5, 0.15, d));
    }`;
  // the glow layer (scene.js blurs it into a bloom): only kinds with a glow, e.g. hot sparks
  const GLOW_VERT = VERT.replace('attribute float alpha;', 'attribute float alpha; attribute float glow;').replace('vAlpha = alpha;', 'vAlpha = alpha * glow;');
  const GLOW_FRAG = `
    varying vec3 vColor; varying float vAlpha;
    void main() {
      float d = length(gl_PointCoord - 0.5);
      if (d > 0.5 || vAlpha <= 0.0) discard;
      gl_FragColor = vec4(vColor * vAlpha * smoothstep(0.5, 0.0, d), 1.0);
    }`;
  const KINDS = {
    dust: { color: [0.62, 0.58, 0.52], size: [0.25, 0.7], grow: 0.5, life: [1.2, 2.6], speed: [0.4, 1.8], up: 0.6, gravity: -0.15, drag: 1.6, alpha: 0.45, glow: 0 },
    chip: { color: [0.58, 0.24, 0.16], size: [0.04, 0.07], grow: 0, life: [1.0, 1.8], speed: [1.5, 4.5], up: 1.2, gravity: 1, drag: 0.1, alpha: 1, glow: 0 },
    spark: { color: [1.0, 0.78, 0.35], size: [0.03, 0.05], grow: 0, life: [0.12, 0.3], speed: [3, 8], up: 0.8, gravity: 1, drag: 0.5, alpha: 1, glow: 1.5 },
    glass: { color: [0.75, 0.88, 0.95], size: [0.02, 0.04], grow: 0, life: [0.6, 1.2], speed: [1, 3], up: 0.5, gravity: 1, drag: 0.2, alpha: 0.9, glow: 0 },
  };

  class Particles {
    constructor(scene, max = 3000) {
      this.max = max; this.n = 0;
      this.pos = new Float32Array(3 * max); this.col = new Float32Array(3 * max);
      this.size = new Float32Array(max); this.alpha = new Float32Array(max); this.glow = new Float32Array(max);
      this.vel = new Float32Array(3 * max); this.life = new Float32Array(max); this.maxLife = new Float32Array(max);
      this.kind = new Array(max); this.size0 = new Float32Array(max);
      const g = new T.BufferGeometry();
      g.setAttribute('position', new T.BufferAttribute(this.pos, 3).setUsage(T.DynamicDrawUsage));
      g.setAttribute('pcolor', new T.BufferAttribute(this.col, 3).setUsage(T.DynamicDrawUsage));
      g.setAttribute('size', new T.BufferAttribute(this.size, 1).setUsage(T.DynamicDrawUsage));
      g.setAttribute('alpha', new T.BufferAttribute(this.alpha, 1).setUsage(T.DynamicDrawUsage));
      g.setAttribute('glow', new T.BufferAttribute(this.glow, 1).setUsage(T.DynamicDrawUsage));
      g.setDrawRange(0, 0);
      this.geo = g;
      this.mat = new T.ShaderMaterial({ vertexShader: VERT, fragmentShader: FRAG, uniforms: { scale: { value: 600 } }, transparent: true, depthWrite: false });
      this.points = new T.Points(g, this.mat);
      this.points.frustumCulled = false;
      this.points.layers.set(2);   // effects
      scene.add(this.points);
      // the same points on the glow layer, drawn larger so the bloom has something to spread
      this.glowMat = new T.ShaderMaterial({ vertexShader: GLOW_VERT, fragmentShader: GLOW_FRAG, uniforms: { scale: { value: 600 } }, transparent: true, depthWrite: false, blending: T.AdditiveBlending });
      this.glowPoints = new T.Points(g, this.glowMat);
      this.glowPoints.frustumCulled = false;
      this.glowPoints.layers.set(3);
      scene.add(this.glowPoints);
    }
    setScale(px) { this.mat.uniforms.scale.value = px; this.glowMat.uniforms.scale.value = 1.6 * px; }
    spawn(x, y, z, count, kindName, dir) {
      const k = KINDS[kindName];
      for (let c = 0; c < count; c++) {
        if (this.n >= this.max) return;
        const i = this.n++, rnd = (a) => a[0] + Math.random() * (a[1] - a[0]);
        const sp = rnd(k.speed);
        let vx = Math.random() * 2 - 1, vy = Math.random() * k.up, vz = Math.random() * 2 - 1;
        if (dir) { vx += dir[0] * 1.2; vy += dir[1] * 1.2; vz += dir[2] * 1.2; }
        const l = Math.hypot(vx, vy, vz) || 1;
        this.vel[3 * i] = vx / l * sp; this.vel[3 * i + 1] = vy / l * sp; this.vel[3 * i + 2] = vz / l * sp;
        this.pos[3 * i] = x + (Math.random() - 0.5) * 0.2; this.pos[3 * i + 1] = y + Math.random() * 0.1; this.pos[3 * i + 2] = z + (Math.random() - 0.5) * 0.2;
        const shade = 0.85 + Math.random() * 0.3;
        this.col[3 * i] = k.color[0] * shade; this.col[3 * i + 1] = k.color[1] * shade; this.col[3 * i + 2] = k.color[2] * shade;
        this.size0[i] = this.size[i] = rnd(k.size);
        this.life[i] = this.maxLife[i] = rnd(k.life);
        this.alpha[i] = k.alpha; this.glow[i] = k.glow; this.kind[i] = k;
      }
    }
    update(dt) {
      if (dt <= 0 || !this.n) { this.geo.setDrawRange(0, this.n); return; }
      let i = 0;
      while (i < this.n) {
        this.life[i] -= dt;
        if (this.life[i] <= 0) { this.kill(i); continue; }
        const k = this.kind[i], i3 = 3 * i, drag = Math.exp(-k.drag * dt);
        this.vel[i3] *= drag; this.vel[i3 + 2] *= drag;
        this.vel[i3 + 1] = this.vel[i3 + 1] * drag - 9.81 * k.gravity * dt;
        this.pos[i3] += this.vel[i3] * dt; this.pos[i3 + 1] += this.vel[i3 + 1] * dt; this.pos[i3 + 2] += this.vel[i3 + 2] * dt;
        if (this.pos[i3 + 1] < 0.01) { this.pos[i3 + 1] = 0.01; this.vel[i3 + 1] *= -0.3; this.vel[i3] *= 0.6; this.vel[i3 + 2] *= 0.6; }
        const f = this.life[i] / this.maxLife[i];
        this.alpha[i] = k.alpha * Math.min(1, f * 2.5);
        this.glow[i] = k.glow * f * f;   // a spark cools as it flies
        this.size[i] = this.size0[i] * (1 + k.grow * (1 - f) * 3);
        i++;
      }
      for (const name of ['position', 'pcolor', 'size', 'alpha', 'glow']) this.geo.attributes[name].needsUpdate = true;
      this.geo.setDrawRange(0, this.n);
    }
    kill(i) {
      const j = --this.n;
      if (i !== j) {
        for (let d = 0; d < 3; d++) { this.pos[3 * i + d] = this.pos[3 * j + d]; this.vel[3 * i + d] = this.vel[3 * j + d]; this.col[3 * i + d] = this.col[3 * j + d]; }
        this.size[i] = this.size[j]; this.size0[i] = this.size0[j]; this.alpha[i] = this.alpha[j]; this.glow[i] = this.glow[j];
        this.life[i] = this.life[j]; this.maxLife[i] = this.maxLife[j]; this.kind[i] = this.kind[j];
      }
    }
    clear() { this.n = 0; this.geo.setDrawRange(0, 0); }
  }

  return { initAudio, setEnabled, setTimeScale, listen, beginCapture, captureClock, endCapture, get sampleRate() { return ctx ? ctx.sampleRate : 48000; }, crunch, scatter, thud, pop, blowout, hit, beep, breakSound, clank, tear, glass, crack, structureUpdate, engineStart, engineUpdate, engineStop, fireUpdate, Particles, get enabled() { return enabled; } };
})();
