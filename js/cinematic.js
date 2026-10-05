/* Cinematic replay: bullet-time and camera shake, worked out from the crash's own signals.
 *
 * Bullet-time: the playback speed follows the crash pulse. The replay runs at 1/4x into the crash,
 * slows smoothly to 1/40x around the peak deceleration, and speeds up again as the pulse dies away,
 * reaching real time (1x) for the rebound and the falling debris.
 * Shake: the camera shakes along the direction of the deceleration, by an amount that grows with
 * it, with kicks for single events (first contact, a part tearing off, a tyre bursting). The shake
 * is a function of replay time, so in slow motion it slows down too.
 * Power: the rate at which the crash turns motion into damage (plastic work, fracture, contact
 * losses), which drives the structural sound (fx.js structureUpdate).
 *
 * A track is built once per replay; speed(t), shake(t) and power(t) look it up by replay time. */
const Cinematic = (() => {
  'use strict';
  const G = 9.81, BIN = 0.001;              // s: the signals are kept in 1 ms bins
  const SLOW = 1 / 40, FAST = 1 / 4, REAL = 1;
  const SHAKE_G = 50;                        // g: the deceleration that gives a shake of 1

  // max over a window of +-r bins, then a moving average over +-r2 bins (twice)
  function widen(a, r, r2) {
    const n = a.length, m = new Float64Array(n), out = new Float64Array(n);
    for (let i = 0; i < n; i++) { let v = 0; for (let j = Math.max(0, i - r); j <= Math.min(n - 1, i + r); j++) v = Math.max(v, a[j]); m[i] = v; }
    for (let pass = 0; pass < 2; pass++) {
      const src = pass ? out.slice() : m;
      for (let i = 0; i < n; i++) { let s = 0, c = 0; for (let j = Math.max(0, i - r2); j <= Math.min(n - 1, i + r2); j++) { s += src[j]; c++; } out[i] = s / c; }
    }
    return out;
  }
  const smooth = (x) => { x = Math.max(0, Math.min(1, x)); return x * x * (3 - 2 * x); };

  // sig: { t0: replay time of bin 0, g: deceleration per bin (g), power: W per bin (or null),
  //        dir: [x, y, z] world direction of the main deceleration }
  // opts: { tContact, events: [{ t, type, mass }] for the shake kicks }
  function track(sig, opts = {}) {
    const g = sig.g, n = g.length, t0 = sig.t0;
    let peak = 0;
    for (let i = 0; i < n; i++) peak = Math.max(peak, g[i]);
    const speed = new Float32Array(n).fill(FAST);
    if (peak >= 2) {
      // how far to slow down: the pulse relative to its peak, widened and smoothed so the slow-down
      // starts a little before the peak and eases in and out
      const w = widen(Float64Array.from(g, v => v / peak), 12, 15);
      // the pulse is over once 97% of its impulse (in the 400 ms after contact) has gone by
      const iC = Math.max(0, Math.round(((opts.tContact != null ? opts.tContact : t0) - t0) / BIN));
      let tot = 0, acc = 0, iEnd = n - 1;
      for (let i = iC; i < Math.min(n, iC + 400); i++) tot += g[i];
      for (let i = iC; i < n; i++) { acc += g[i]; if (acc >= 0.97 * tot) { iEnd = i; break; } }
      for (let i = 0; i < n; i++) {
        const fast = FAST * Math.pow(REAL / FAST, i > iEnd ? smooth((i - iEnd) / 250) : 0);   // up to real time over 250 ms
        speed[i] = fast * Math.pow(SLOW / fast, Math.pow(Math.min(1, w[i] * 1.15), 0.6));
      }
    }
    // shake: the deceleration, plus decaying kicks for single events
    const shake = Float32Array.from(g, v => Math.min(1.5, Math.pow(v / SHAKE_G, 0.8)));
    const KICK = { first: 0.9, detach: 0.5, burst: 0.7, thud: 0.6, glass: 0.15, headStrike: 0.25 };
    for (const e of opts.events || []) {
      let k = KICK[e.type];
      if (!k) continue;
      if (e.type === 'detach') k *= Math.min(1.6, 0.5 + (e.mass || 10) / 20);
      const i0 = Math.round((e.t - t0) / BIN);
      for (let j = Math.max(0, i0); j < Math.min(n, i0 + 120); j++) shake[j] = Math.max(shake[j], k * Math.exp(-(j - i0) / 30));
    }
    const look = (a, t) => {
      const x = (t - t0) / BIN;
      if (x <= 0) return a[0];
      if (x >= n - 1) return a[n - 1];
      const i = Math.floor(x), s = x - i;
      return a[i] + (a[i + 1] - a[i]) * s;
    };
    return {
      peakG: peak, dir: sig.dir || [1, 0, 0],
      speed: (t) => look(speed, t),
      shake: (t) => look(shake, t),
      power: (t) => sig.power ? look(sig.power, t) : 0,
      // how long playing from tA to tB takes, in seconds
      duration(tA, tB) { let s = 0; for (let t = tA; t < tB; t += BIN) s += Math.min(BIN, tB - t) / look(speed, t); return s; },
    };
  }

  // A track from a crash result (physics.js finalize): the larger deceleration of the cars at each
  // moment (the horizontal CFC 60 pulse), its direction in the world at the peak, and the power
  // from the energy ledger.
  function fromCrash(res, events) {
    const units = res.units, dt = units[0].pulse.dt, per = Math.max(1, Math.round(BIN / dt));
    const nb = Math.ceil(Math.max(...units.map(U => U.pulse.n)) / per);
    const g = new Float64Array(nb);
    let best = 0, bu = 0, bi = 0;
    units.forEach((U, u) => {
      const p = U.pulse;
      for (let i = 0; i < p.n; i++) {
        const a = Math.hypot(p.ax[i], p.az[i]) / G, b = Math.floor(i / per);
        if (a > g[b]) g[b] = a;
        if (a > best) { best = a; bu = u; bi = i; }
      }
    });
    // world direction of the peak deceleration: f * ax + (f x u) * az
    const U = units[bu], p = U.pulse, F = res.frames, ti = bi * dt;
    let k = 0;
    while (k < F.t.length - 1 && F.t[k + 1] <= ti) k++;
    const A = U.axes[k], f = [A[3], A[4], A[5]], up = [A[6], A[7], A[8]];
    const l = [f[1] * up[2] - f[2] * up[1], f[2] * up[0] - f[0] * up[2], f[0] * up[1] - f[1] * up[0]];
    const d = [0, 1, 2].map(c => f[c] * p.ax[bi] + l[c] * p.az[bi]), dl = Math.hypot(d[0], d[2]) || 1;
    // power: the growth of plastic work, fracture and contact losses between recorded frames
    const E = F.energy, lost = (e) => (e.plastic || 0) + (e.fracture || 0) + Math.max(0, e.contactSolver || 0);
    const power = new Float64Array(nb);
    let j = 0;
    for (let b = 0; b < nb; b++) {
      const t = (b + 0.5) * BIN;
      while (j < F.t.length - 2 && F.t[j + 1] < t) j++;
      const h = F.t[j + 1] - F.t[j];
      power[b] = h > 0 ? Math.max(0, (lost(E[j + 1]) - lost(E[j])) / h) : 0;
    }
    return track({ t0: 0, g, power, dir: [d[0] / dl, 0, d[2] / dl] }, { tContact: res.contact ? res.T0 : 0, events });
  }

  return { track, fromCrash, SLOW, FAST, REAL, BIN };
})();
if (typeof module === 'object' && module.exports) module.exports = Cinematic;
