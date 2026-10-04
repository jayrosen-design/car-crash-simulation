/* Event-driven effects (TRD §5.1): synthesized Web Audio sounds and a point-particle system.
 * Physics events arrive already merged within 0.1 m (physics.js); here audio is filtered by
 * fragment mass (heavy -> low crunch/thud, light -> scatter, tiny -> culled) and capped by a
 * voice limit so dense break events cannot starve the audio channel. */
const FX = (() => {
  'use strict';
  const T = THREE;

  // ---------------------------------------------------------------- audio
  let ctx = null, master = null, noiseBuf = null, enabled = true, voices = 0, engine = null;
  const MAX_VOICES = 14;

  function initAudio() {
    if (ctx) { if (ctx.state === 'suspended') ctx.resume(); return; }
    const AC = window.AudioContext || window.webkitAudioContext;
    if (!AC) return;
    ctx = new AC();
    master = ctx.createGain();
    master.gain.value = enabled ? 0.7 : 0;
    master.connect(ctx.destination);
    noiseBuf = ctx.createBuffer(1, ctx.sampleRate * 2, ctx.sampleRate);
    const d = noiseBuf.getChannelData(0);
    for (let i = 0; i < d.length; i++) d[i] = Math.random() * 2 - 1;
  }
  function setEnabled(on) { enabled = on; if (master) master.gain.value = on ? 0.7 : 0; }
  function take(dur) {
    if (!ctx || !enabled || voices >= MAX_VOICES) return false;
    voices++;
    setTimeout(() => { voices--; }, dur * 1000 + 60);
    return true;
  }
  function out(pan) {
    if (ctx.createStereoPanner) { const p = ctx.createStereoPanner(); p.pan.value = Math.max(-1, Math.min(1, pan || 0)); p.connect(master); return p; }
    return master;
  }
  function noise({ dur, gain, type, f0, f1, Q, pan, attack = 0.002 }) {
    const t = ctx.currentTime;
    const src = ctx.createBufferSource(); src.buffer = noiseBuf;
    src.playbackRate.value = 0.8 + Math.random() * 0.4;
    const flt = ctx.createBiquadFilter(); flt.type = type; flt.Q.value = Q || 0.7;
    flt.frequency.setValueAtTime(f0, t); flt.frequency.exponentialRampToValueAtTime(Math.max(20, f1), t + dur);
    const g = ctx.createGain();
    g.gain.setValueAtTime(0.0001, t); g.gain.exponentialRampToValueAtTime(gain, t + attack); g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
    src.connect(flt).connect(g).connect(out(pan));
    src.start(t, Math.random() * 1.5); src.stop(t + dur + 0.05);
  }
  function tone({ dur, gain, f0, f1, pan, type = 'sine' }) {
    const t = ctx.currentTime;
    const o = ctx.createOscillator(); o.type = type;
    o.frequency.setValueAtTime(f0, t); o.frequency.exponentialRampToValueAtTime(f1, t + dur);
    const g = ctx.createGain();
    g.gain.setValueAtTime(gain, t); g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
    o.connect(g).connect(out(pan));
    o.start(t); o.stop(t + dur + 0.05);
  }
  // Structural crunch of the car on the barrier; intensity 0..1.
  function crunch(intensity, pan) {
    if (!take(0.6)) return;
    const k = Math.max(0.15, Math.min(1, intensity));
    noise({ dur: 0.55, gain: 0.9 * k, type: 'lowpass', f0: 2400, f1: 180, Q: 1.2, pan });
    noise({ dur: 0.25, gain: 0.35 * k, type: 'bandpass', f0: 3200, f1: 900, Q: 6, pan });
    tone({ dur: 0.35, gain: 0.8 * k, f0: 90, f1: 38, pan });
  }
  function scatter(count, pan) {
    const n = Math.min(4, 1 + Math.floor(count / 2));
    for (let i = 0; i < n; i++) setTimeout(() => {
      if (!take(0.08)) return;
      noise({ dur: 0.05 + Math.random() * 0.05, gain: 0.25, type: 'bandpass', f0: 3000 + Math.random() * 3000, f1: 1500, Q: 4, pan });
    }, i * (20 + Math.random() * 40));
  }
  function thud(mass, pan) {
    if (!take(0.25)) return;
    const k = Math.min(1, mass / 40);
    noise({ dur: 0.18, gain: 0.5 * k, type: 'lowpass', f0: 700, f1: 120, pan });
    tone({ dur: 0.16, gain: 0.45 * k, f0: 140, f1: 55, pan });
  }
  function pop(pan) {
    if (!take(0.4)) return;
    noise({ dur: 0.3, gain: 0.7, type: 'highpass', f0: 900, f1: 300, pan });
    tone({ dur: 0.25, gain: 0.6, f0: 70, f1: 40, pan });
  }
  // The emergency-braking warning chime.
  function beep(f) {
    if (!take(0.15)) return;
    tone({ dur: 0.12, gain: 0.22, f0: f || 1760, f1: f || 1760, pan: 0, type: 'square' });
  }
  function hit(force, pan) {
    if (!take(0.2)) return;
    const k = Math.min(1, force / 8000);
    noise({ dur: 0.12, gain: 0.5 * k + 0.1, type: 'lowpass', f0: 1200, f1: 200, pan });
  }
  // A panel or wheel tearing off: a metallic clank (inharmonic partials) over a noise burst.
  function clank(mass, pan) {
    if (!take(0.5)) return;
    const k = Math.max(0.3, Math.min(1, mass / 20));
    noise({ dur: 0.3, gain: 0.45 * k, type: 'bandpass', f0: 1800, f1: 500, Q: 2, pan });
    for (const f of [310, 523, 847]) tone({ dur: 0.35 + Math.random() * 0.2, gain: 0.12 * k, f0: f * (0.9 + Math.random() * 0.2), f1: f * 0.8, pan, type: 'triangle' });
  }
  // Tempered glass: a sharp burst, then a shower of small tinkles.
  function glass(area, pan) {
    if (!take(0.2)) return;
    noise({ dur: 0.18, gain: 0.5, type: 'highpass', f0: 4000, f1: 2500, pan });
    const nTink = Math.min(10, 3 + Math.round(area * 2));
    for (let i = 0; i < nTink; i++) setTimeout(() => {
      if (!take(0.06)) return;
      tone({ dur: 0.04 + Math.random() * 0.05, gain: 0.08, f0: 3500 + Math.random() * 4500, f1: 3000, pan, type: 'sine' });
    }, 40 + i * (25 + Math.random() * 50));
  }
  // Laminated windshield cracking: a short dry crackle.
  function crack(intensity, pan) {
    if (!take(0.15)) return;
    noise({ dur: 0.12, gain: 0.35 * intensity, type: 'bandpass', f0: 2600, f1: 1200, Q: 3, pan });
  }
  // Mass filtering: heavy fragments crunch, light ones scatter, tiny ones are culled.
  function breakSound(mass, count, pan) {
    if (mass < 5) return;
    if (mass >= 30) thud(mass, pan); else scatter(count, pan);
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
        src.connect(flt).connect(g).connect(master); src.start();
        return { src, g };
      };
      burn = { roar: loop('lowpass', 420, 0.8), hiss: loop('highpass', 3200, 0.7) };
    }
    const t = ctx.currentTime;
    burn.roar.g.gain.setTargetAtTime(0.32 * fire, t, 0.2);
    burn.hiss.g.gain.setTargetAtTime(0.07 * steam, t, 0.2);
    // crackles: a few short bursts a second while it burns
    if (fire > 0.05 && Math.random() < 0.09 * fire && take(0.08)) noise({ dur: 0.03 + Math.random() * 0.05, gain: 0.12 + 0.25 * Math.random() * fire, type: 'bandpass', f0: 1500 + Math.random() * 3000, f1: 900, Q: 2 });
    if (fire <= 0 && steam <= 0) { const b = burn; burn = null; b.roar.g.gain.setTargetAtTime(0, t, 0.05); b.hiss.g.gain.setTargetAtTime(0, t, 0.05); setTimeout(() => { b.roar.src.stop(); b.hiss.src.stop(); }, 400); }
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
  const KINDS = {
    dust: { color: [0.62, 0.58, 0.52], size: [0.25, 0.7], grow: 0.5, life: [1.2, 2.6], speed: [0.4, 1.8], up: 0.6, gravity: -0.15, drag: 1.6, alpha: 0.45 },
    chip: { color: [0.58, 0.24, 0.16], size: [0.04, 0.07], grow: 0, life: [1.0, 1.8], speed: [1.5, 4.5], up: 1.2, gravity: 1, drag: 0.1, alpha: 1 },
    spark: { color: [1.0, 0.78, 0.35], size: [0.03, 0.05], grow: 0, life: [0.12, 0.3], speed: [3, 8], up: 0.8, gravity: 1, drag: 0.5, alpha: 1 },
    glass: { color: [0.75, 0.88, 0.95], size: [0.02, 0.04], grow: 0, life: [0.6, 1.2], speed: [1, 3], up: 0.5, gravity: 1, drag: 0.2, alpha: 0.9 },
  };

  class Particles {
    constructor(scene, max = 3000) {
      this.max = max; this.n = 0;
      this.pos = new Float32Array(3 * max); this.col = new Float32Array(3 * max);
      this.size = new Float32Array(max); this.alpha = new Float32Array(max);
      this.vel = new Float32Array(3 * max); this.life = new Float32Array(max); this.maxLife = new Float32Array(max);
      this.kind = new Array(max); this.size0 = new Float32Array(max);
      const g = new T.BufferGeometry();
      g.setAttribute('position', new T.BufferAttribute(this.pos, 3).setUsage(T.DynamicDrawUsage));
      g.setAttribute('pcolor', new T.BufferAttribute(this.col, 3).setUsage(T.DynamicDrawUsage));
      g.setAttribute('size', new T.BufferAttribute(this.size, 1).setUsage(T.DynamicDrawUsage));
      g.setAttribute('alpha', new T.BufferAttribute(this.alpha, 1).setUsage(T.DynamicDrawUsage));
      g.setDrawRange(0, 0);
      this.geo = g;
      this.mat = new T.ShaderMaterial({ vertexShader: VERT, fragmentShader: FRAG, uniforms: { scale: { value: 600 } }, transparent: true, depthWrite: false });
      this.points = new T.Points(g, this.mat);
      this.points.frustumCulled = false;
      scene.add(this.points);
    }
    setScale(px) { this.mat.uniforms.scale.value = px; }
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
        this.alpha[i] = k.alpha; this.kind[i] = k;
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
        this.size[i] = this.size0[i] * (1 + k.grow * (1 - f) * 3);
        i++;
      }
      for (const name of ['position', 'pcolor', 'size', 'alpha']) this.geo.attributes[name].needsUpdate = true;
      this.geo.setDrawRange(0, this.n);
    }
    kill(i) {
      const j = --this.n;
      if (i !== j) {
        for (let d = 0; d < 3; d++) { this.pos[3 * i + d] = this.pos[3 * j + d]; this.vel[3 * i + d] = this.vel[3 * j + d]; this.col[3 * i + d] = this.col[3 * j + d]; }
        this.size[i] = this.size[j]; this.size0[i] = this.size0[j]; this.alpha[i] = this.alpha[j];
        this.life[i] = this.life[j]; this.maxLife[i] = this.maxLife[j]; this.kind[i] = this.kind[j];
      }
    }
    clear() { this.n = 0; this.geo.setDrawRange(0, 0); }
  }

  return { initAudio, setEnabled, crunch, scatter, thud, pop, hit, beep, breakSound, clank, glass, crack, engineStart, engineUpdate, engineStop, fireUpdate, Particles, get enabled() { return enabled; } };
})();
