/* The Destruction mode's trailer (media/destruction-trailer.mp4 and the 9:16
 * media/destruction-trailer-mobile.mp4): a minute of the game cut to the 'destruction' song
 * (tools/trailer-music.js), recorded from Destruction.html by tools/record-video.js with
 * tools/trailer-kit.js.
 *
 * One take: the countdown is held 22 s (the traffic already flowing) while sweeping cameras fly over
 * the junction at dusk; then a gold-medal run, scripted: flat out with boost down the right lane,
 * over the ramp (filmed in slow motion) through the x4, into the gas tanker in mid-air; the impact in
 * the crash solver's slow motion; the tanker going up, the pile-up, the Crashbreaker the moment it's
 * ready; the total counted up to gold. The junction's traffic is the same every attempt, so the take
 * is too (the crash solver runs in its worker; the recorder waits for it in real time).
 */
'use strict';
const K = require('./trailer-kit.js');
const { F, DT, TOTAL } = K;

// ---------------------------------------------------------------- the director (in the page)
function director() {
  const G = DestructionGame, T = THREE, R = G.R, cam = R.camera;
  const V = (x, y, z) => new T.Vector3(x, y, z);
  const css = document.createElement('style');
  css.textContent = 'body.cine #hud > :not(#popups), body.cine .overlay, body.cine #touch, body.cine #loading { display: none !important; } body.cine #hud { display: block !important; }';
  document.head.appendChild(css);
  document.body.classList.add('cine');
  const D = window.__d = { cam: null, k: 0, drive: null };
  // the gold run: down the right lane (onto the ramp), flat out, boosting while there's boost
  G.director.input = () => {
    const c = G.car, lane = -5.25;
    const steer = Math.max(-0.4, Math.min(0.4, (c.x - lane) * 0.25 - Math.sin(c.h - Math.PI / 2) * 1.2));
    return { throttle: 1, steer, boost: G.boost > 0.01 };
  };
  const lerp = (a, k) => Array.isArray(a) ? a[0] + (a[1] - a[0]) * k : a;
  const lerp3 = (a, b, k) => V(a[0] + (b[0] - a[0]) * k, a[1] + (b[1] - a[1]) * k, a[2] + (b[2] - a[2]) * k);
  // a smooth path through points (Catmull-Rom), k = 0..1
  const path = (pts, k) => {
    if (pts.length === 2) return lerp3(pts[0], pts[1], k * k * (3 - 2 * k));
    const n = pts.length - 1, x = Math.min(n - 1e-6, Math.max(0, k * n)), i = Math.floor(x), u = x - i;
    const p = (j) => pts[Math.max(0, Math.min(n, j))], P0 = p(i - 1), P1 = p(i), P2 = p(i + 1), P3 = p(i + 2);
    const c = (a, b, cc, d) => 0.5 * (2 * b + (-a + cc) * u + (2 * a - 5 * b + 4 * cc - d) * u * u + (-a + 3 * b - 3 * cc + d) * u * u * u);
    return V(c(P0[0], P1[0], P2[0], P3[0]), c(P0[1], P1[1], P2[1], P3[1]), c(P0[2], P1[2], P2[2], P3[2]));
  };
  // the car (or, after the crash, the player's wreck): position, heading, height
  const subject = () => {
    const w = G.playerWreck;
    if (w) { const f = new T.Vector3(1, 0, 0).applyQuaternion(new T.Quaternion(w.q[0], w.q[1], w.q[2], w.q[3])); return { x: w.p[0], z: w.p[2], y: w.p[1] - 0.8, h: Math.atan2(f.z, f.x) }; }
    if (G.state === 'impact') return { x: G.crashFocus.x, z: G.crashFocus.z, y: G.crashFocus.y, h: G.car.h };
    return { x: G.car.x, z: G.car.z, y: G.car.y, h: G.car.h };
  };
  const frameOf = () => { const s = subject(), c = Math.cos(s.h), sn = Math.sin(s.h); return { o: V(s.x, s.y, s.z), f: V(c, 0, sn), r: V(-sn, 0, c) }; };
  D.CAMS = {
    // world paths: pos and look, each a list of points
    path: (k, p) => ({ pos: path(p.pos, k), look: path(p.look, k) }),
    // relative to the car: in front looking back, alongside, behind low, behind high
    front: (k, p) => { const Fr = frameOf(); return { pos: Fr.o.clone().addScaledVector(Fr.f, lerp(p.d, k)).addScaledVector(Fr.r, lerp(p.side, k) || 0).add(V(0, lerp(p.y, k), 0)), look: Fr.o.clone().addScaledVector(Fr.f, 0.5).add(V(0, 0.8, 0)) }; },
    side: (k, p) => { const Fr = frameOf(); return { pos: Fr.o.clone().addScaledVector(Fr.f, lerp(p.a, k) || 0).addScaledVector(Fr.r, lerp(p.side, k)).add(V(0, lerp(p.y, k), 0)), look: Fr.o.clone().addScaledVector(Fr.f, 1).add(V(0, 0.8, 0)) }; },
    chase: (k, p) => { const Fr = frameOf(); return { pos: Fr.o.clone().addScaledVector(Fr.f, -lerp(p.back, k)).addScaledVector(Fr.r, lerp(p.side, k) || 0).add(V(0, lerp(p.y, k), 0)), look: Fr.o.clone().addScaledVector(Fr.f, lerp(p.ahead, k) || 8).add(V(0, lerp(p.ly, k) || 1, 0)) }; },
    // a fixed point, looking at the car
    fixed: (k, p) => { const s = subject(); return { pos: V(lerp(p.x, k), lerp(p.y, k), lerp(p.z, k)), look: V(s.x, s.y + (p.ly || 1), s.z) }; },
    // around a point: the crash (crash), the pile-up's focus (pile), the wreck (wreck), or [x, z]
    orbit: (k, p) => {
      const P = p.at === 'crash' ? G.crashFocus : p.at === 'pile' ? G.focus : p.at === 'wreck' ? (() => { const s = subject(); return { x: s.x, z: s.z, y: s.y }; })() : { x: p.at[0], z: p.at[1], y: 0 };
      const a = lerp(p.a, k) * Math.PI / 180, r = lerp(p.r, k), y0 = P.y || 0;
      return { pos: V(P.x + Math.cos(a) * r, y0 + lerp(p.y, k), P.z + Math.sin(a) * r), look: V(P.x, y0 + (p.lift || 0.8), P.z) };
    },
  };
  G.director.camera = () => {
    if (!D.cam) return;
    const c = D.CAMS[D.cam.kind](D.k, D.cam);
    cam.position.copy(c.pos); cam.lookAt(c.look);
    const fov = lerp(D.cam.fov, D.k);
    if (Math.abs(cam.fov - fov) > 0.01) { cam.fov = fov; cam.updateProjectionMatrix(); }
  };
  D.status = () => {
    const L = G.wrecks && G.wrecks.ledger;
    return { state: G.state, t: +G.simT.toFixed(3), kmh: Math.round(Math.max(0, G.car.forward) * 3.6), air: !!G.car.air,
      total: L ? L.total : 0, mult: L ? L.mult : 1, booms: L ? L.explosions : 0, wrecked: L ? L.wrecked : 0,
      cbReady: document.querySelector('#cb').classList.contains('ready'), impactKmh: G.crash ? Math.round(G.crash.impactKmh || 0) : 0 };
  };
  return true;
}

// ---------------------------------------------------------------- cameras (fov: the 16:9 frame's)
const C = {
  // the flyover, one sweep after another (the paths kept clear of the buildings: tools check them
  // against the level's boxes): down the hill from behind the start, round the junction above the
  // rooftops, a push in from the junction to the gas station, along the right lane over the ramp
  flyHill: { kind: 'path', pos: [[0, 46, -372], [-4, 34, -250], [2, 26, -150]], look: [[0, 6, -230], [0, 2, -60], [0, 2, 10]], fov: 46 },
  flyTop: { kind: 'path', pos: [[-70, 118, -30], [-30, 126, -70], [28, 138, -66], [70, 120, -24]], look: [[0, 0, 0], [0, 0, 0], [0, 0, 4], [2, 0, 8]], fov: 44 },
  flyGas: { kind: 'path', pos: [[-8, 10, -6], [3, 7.5, 4], [13, 4.8, 12]], look: [[30, 2, 30], [30, 2.2, 31], [30, 2.5, 31]], fov: 44 },
  flyRamp: { kind: 'path', pos: [[-5.3, 1.6, -118], [-5.3, 3.2, -78], [-4, 6, -40]], look: [[-5.3, 1.4, -60], [-5.3, 2.2, -20], [-2, 2, 20]], fov: 52 },
  // the car
  start: { kind: 'front', d: [9, 7], side: -1.2, y: 0.8, fov: 44 },
  startHigh: { kind: 'chase', back: 12, y: 6, ahead: 30, ly: 0, fov: 46 },
  chase: { kind: 'chase', back: 7, y: 1.6, ahead: 10, fov: 58 },
  front: { kind: 'front', d: 10, side: 1.4, y: 0.9, fov: 46 },
  sideR: { kind: 'side', a: [3, 0], side: -4.8, y: 1.0, fov: 50 },
  heli: { kind: 'chase', back: 18, side: 0, y: 12, ahead: 24, ly: 0, fov: 50 },
  // the ramp: beside its lip, low, looking across as the car takes off
  rampSide: { kind: 'fixed', x: -13, y: 1.4, z: -50, ly: 1.2, fov: 48 },
  rampAhead: { kind: 'fixed', x: 6, y: 2.2, z: -18, ly: 1.4, fov: 44 },
  // on the road beyond the lip, low: the car flies over it
  rampUnder: { kind: 'fixed', x: -3.4, y: 0.35, z: -36, ly: 0.5, fov: 58 },
  // the crash and the pile-up
  orbitA: { kind: 'orbit', at: 'crash', a: [215, 245], r: 8, y: 1.5, lift: 0.9, fov: 48 },
  orbitB: { kind: 'orbit', at: 'crash', a: [300, 250], r: 13, y: 5, lift: 1, fov: 48 },
  pileLow: { kind: 'orbit', at: 'pile', a: [200, 250], r: 24, y: 3, lift: 2, fov: 46 },
  pileHigh: { kind: 'orbit', at: 'pile', a: [20, 80], r: 34, y: 18, lift: 1, fov: 50 },
  wreck: { kind: 'orbit', at: 'wreck', a: [60, 110], r: 9, y: 2.5, lift: 0.8, fov: 46 },
  wreck2: { kind: 'orbit', at: 'wreck', a: [130, 200], r: 10, y: 3, lift: 0.8, fov: 46 },
  crane: { kind: 'orbit', at: [0, 4], a: [255, 285], r: 52, y: [30, 36], lift: 0, fov: 50 },
  tally: { kind: 'orbit', at: [0, 4], a: [205, 285], r: 58, y: [86, 78], lift: 0, fov: 46 },
};

// ---------------------------------------------------------------- the take
const TAKES = {
  gold: {
    query: 'director&car=lexus&touch=0&solver=cpu',
    async run(t) {
      // the countdown held 22 s, the traffic flowing: the flyover, one sweep after another
      await t.page(`DestructionGame.start(22)`);
      await t.frames(2, null, null, { waitCrash: false });
      for (const [cam, n] of [['flyHill', 120], ['flyTop', 120], ['flyGas', 120], ['flyRamp', 96]]) await t.frames(n, { [cam]: C[cam] }, null, { waitCrash: false });
      // the last seconds of the countdown, at the top of the hill
      await t.frames(400, { start: C.start, startHigh: C.startHigh }, null, { until: `DestructionGame.state === 'run'` });
      // the run down the hill until just before the ramp
      await t.frames(600, { startHigh: C.startHigh, chase: C.chase, front: C.front, sideR: C.sideR, heli: C.heli }, null, { until: `DestructionGame.car.z > -85` });
      // slow motion (a quarter of the speed): up the ramp, through the x4, into the junction
      t.mark('ramp');
      await t.frames(600, { rampSide: C.rampSide, rampAhead: C.rampAhead, rampUnder: C.rampUnder, front: Object.assign({}, C.front, { d: 11, y: 2 }), chase: C.chase }, null, { dt: DT / 4, until: `DestructionGame.state !== 'run'` });
      // the impact (the crash solver's slow motion) until the wrecks take over
      await t.frames(400, { orbitA: C.orbitA, orbitB: C.orbitB, wreck: C.wreck }, null, { until: `DestructionGame.state !== 'impact'` });
      // the pile-up; the Crashbreaker as soon as it's ready
      const cb = `{ const s = __d.status(); if (s.cbReady && !__d.cbDone) { __d.cbDone = true; window.dispatchEvent(new KeyboardEvent('keydown', { code: 'ShiftLeft' })); __d.cbAt = s.t; } else if (__d.cbDone && !__d.cbUp) { __d.cbUp = true; window.dispatchEvent(new KeyboardEvent('keyup', { code: 'ShiftLeft' })); } }`;
      await t.frames(900, { pileLow: C.pileLow, pileHigh: C.pileHigh, wreck2: C.wreck2, crane: C.crane }, cb, { until: `DestructionGame.state !== 'pileup'` });
      // the tally, from high above the junction
      await t.frames(400, { tally: C.tally });
    },
  },
};

const game = {
  takes: TAKES,
  ready: `typeof DestructionGame === 'object' && document.querySelector('#loading').hidden && DestructionGame.state === 'select'`,
  director,
  status: `__d.status()`,
  crashWait: `DestructionGame.state === 'impact' && DestructionGame.crash && !DestructionGame.crash.done`,
  shootJs: `DestructionGame.director.camera(0); DestructionGame.popupsFor(); DestructionGame.look.render()`,
  events(prev, s, n, push) {
    if (prev.state === 'countdown' && s.state === 'run') push('go');
    if (s.state === 'run' && s.air && !prev.air) push('air');
    if (s.mult >= 4 && prev.mult < 4) push('mult4');
    if (prev.state === 'run' && s.state === 'impact') push('crash', { kmh: s.impactKmh });
    if (s.booms > prev.booms) push('boom', { count: s.booms });
    if (s.cbReady && !prev.cbReady) push('cbReady');
    if (prev.state === 'impact' && s.state === 'pileup') push('pileup');
    if (prev.state !== 'tally' && s.state === 'tally') push('tally', { total: s.total });
  },
};

// ---------------------------------------------------------------- the edit
// On the 'destruction' song's bars: the flyover (0-4), the countdown (5), the start on the drop (6),
// down the hill (7-9), the ramp in slow motion (10-11), the impact (12-14), the pile-up and the
// Crashbreaker (15-19), replays (20-21), the burning junction (22-27), the tally and the medal
// (28-33), the titles (34 on).
const E = [];
const shot = (f, n, o) => E.push(Object.assign({ f, n }, o));
const src = (take, cam, ref, off, rate) => ({ take, cam, ref, off, rate });
const g = (cam, ref, off, rate) => src('gold', cam, ref, off, rate);
// (an event that ends a capture window falls on that window's last frame: the next window's
// cameras start one frame later, hence the offsets of 1)
// the flyover: the take's first 458 frames are four sweeps (flyHill 2-121, flyTop 122-241, flyGas
// 242-361, flyRamp 362-457)
shot(F(0), 72, { src: g('flyHill', 'abs', 2), card: { tag: 'Car Crash Simulation', title: 'Crossroads <em>at dusk</em>', over: true }, sfx: 'card' });
shot(F(1, 2), 48, { src: g('flyTop', 'abs', 140), lower: ['One busy junction', 'Cars, buses, box trucks and gas tankers'], wipe: true });
shot(F(2, 2), 48, { src: g('flyGas', 'abs', 300), lower: ['A gas station', 'Its fuel pumps explode'] });
shot(F(3, 2), 36, { src: g('flyRamp', 'abs', 385), lower: ['A ramp', 'Fly over the traffic'] });
shot(F(4, 1), 36, { src: g('flyTop', 'abs', 200), card: { title: 'Cause <em>maximum</em> damage', over: true }, sfx: 'card' });
// the countdown on the beat (bar 5), the start on the drop (bar 6), down the hill
shot(F(5), 36, { src: g('start', 'go', -36), countdown: true });
shot(F(5, 3), 12, { src: g('startHigh', 'go', -12) });
shot(F(6), 48, { src: g('startHigh', 'go', 0), hit: 'go', big: 'Go!', speed: true });
shot(F(7), 48, { src: g('sideR', 'go', 60), lower: ['Full boost from the start', 'Spend it on speed, or save it for the Crashbreaker'], speed: true });
shot(F(8), 48, { src: g('front', 'go', 150), speed: true });
shot(F(9), 48, { src: g('heli', 'ramp', -48), wipe: true, speed: true });
// the ramp, in slow motion, through the x4
shot(F(10), 48, { src: g('rampSide', 'air', -30), slow: true, hit: 'go', hitAt: 30, hitV: 0.6 });
shot(F(11), 24, { src: g('rampUnder', 'mult4', -8), slow: true, big: '×4', bigKind: 'mult', bigAt: 8, bigFor: 16, sfx: 'cash' });
shot(F(11, 2), 24, { src: g('rampAhead', 'crash', -24), slow: true });
// the impact on bar 12: the crash solver's slow motion; the tanker goes up
shot(F(12), 48, { src: g('orbitB', 'crash', 1), hit: 'crash', impact: true });
shot(F(13), 48, { src: g('orbitB', 'crash', 49), impact: true, score: true });
shot(F(14), 48, { src: g('wreck', 'boom', -40), hit: 'boom', hitAt: 40, big: 'Boom', bigKind: 'boom', bigAt: 40, bigFor: 8, score: true });
// the pile-up; the Crashbreaker on the chorus's downbeat
shot(F(15), 36, { src: g('pileHigh', 'pileup', 1), score: true, lower: ['The pile-up', 'The traffic keeps coming'] });
shot(F(15, 3), 12, { src: g('wreck2', 'cbReady', -12), score: true });
shot(F(16), 48, { src: g('pileLow', 'cbReady', 1), hit: 'boom', big: 'Crashbreaker', bigKind: 'red', bigFor: 30, score: true });
shot(F(17), 48, { src: g('wreck2', 'cbReady', 30), score: true, lower: ['Crashbreaker', 'Blow up your own wreck'] });
shot(F(18), 48, { src: g('pileHigh', 'cbReady', 80), score: true });
shot(F(19), 48, { src: g('crane', 'cbReady', 130), score: true });
// replays, cut to the beat
shot(F(20), 24, { src: g('orbitB', 'crash', 1), hit: 'crash', hitV: 0.7 });
shot(F(20, 2), 24, { src: g('rampUnder', 'air', 40), slow: true });
shot(F(21), 24, { src: g('wreck', 'boom', -16), hit: 'boom', hitAt: 16, hitV: 0.8 });
shot(F(21, 2), 24, { src: g('pileLow', 'cbReady', 1), hit: 'boom', hitV: 0.8 });
shot(F(22), 48, { src: g('pileLow', 'cbReady', 180), score: true });
shot(F(23), 48, { src: g('pileHigh', 'cbReady', 230), score: true, lower: ['Chain reactions', 'Tankers, pumps and wrecks explode'] });
// breakdown: the burning junction
shot(F(24), 96, { src: g('crane', 'pileup', 1), score: true, card: { tag: 'Real crash physics', title: 'Every impact <em>solved</em>', over: true } });
shot(F(26), 96, { src: g('wreck2', 'cbReady', 80), score: true, card: { tag: 'Bronze · silver · gold', title: 'Beat your <em>best</em>', over: true } });
// the tally: the total counted up, then the medal
shot(F(28), 96, { src: g('tally', 'tally', 1), tally: true });
shot(F(30), 96, { src: g('tally', 'tally', 97), tally: true, hit: 'boom', big: 'Gold', bigKind: 'gold', bigAt: 0, bigFor: 90 });
// quick cuts back through it
[['orbitB', 'crash', 10], ['rampSide', 'air', 4], ['pileLow', 'cbReady', 4], ['orbitB', 'crash', 30], ['flyGas', 'abs', 340], ['pileHigh', 'cbReady', 20], ['wreck', 'crash', 70], ['startHigh', 'go', 6]]
  .forEach(([cam, ref, off], i) => shot(F(32, i / 2), 6, { src: g(cam, ref, off), hit: i % 2 ? null : 'crash', hitV: 0.4 }));
shot(F(33), 48, { src: g('tally', 'tally', 185), tally: true, dim: 0.35 });
// the end: title, line, call to action, over the junction from above
shot(F(34), TOTAL - F(34), { src: g('tally', 'tally', 233), dim: 0.62 });
const TITLES = [
  [F(34), { kind: 'title', title: 'Destruction', tag: 'One junction · real crash physics' }, 'title'],
  [F(35), { kind: 'title', title: 'Destruction', tag: 'Gas tankers · chain reactions · Crashbreaker' }, 'card'],
  [F(36), { kind: 'title', title: 'Destruction', tag: 'Play free in your browser', cta: 'Play now', url: 'car-crash-simulation.vercel.app/destruction' }, 'title'],
];
// the poster: the car overhead, flying off the ramp at the tanker and the bus crossing below
const POSTER = { take: 'gold', cam: 'rampUnder', ref: 'ramp', off: 178 };
const edit = { E, TITLES };

// the game's own overlay parts: the car's speed, the impact readout, the damage counter
function extra(o, s, f, src, age) {
  if (!src) return;
  const st = src.status;
  const medals = { bronze: 300000, silver: 1000000, gold: 3000000 };
  if (s.speed && st.kmh > 5) o.speed = st.kmh;
  if (s.impact) o.impact = { kmh: st.impactKmh, label: 'FULL CRASH SOLVER' };
  if (s.score) o.score = Object.assign({ total: st.total, mult: st.mult, label: `${st.wrecked} WRECKED · ${st.booms} EXPLOSIONS` }, medals);
  if (s.tally) {
    // the total counted up over the first two bars of the tally, then held
    const t0 = F(28), k = Math.min(1, (f - t0) / (2 * 48)), e = 1 - Math.pow(1 - k, 3);
    o.score = Object.assign({ total: Math.round(st.total * e), mult: st.mult, label: 'TOTAL DAMAGE' }, medals);
  }
}

module.exports = { game, edit, extra, POSTER, C };
