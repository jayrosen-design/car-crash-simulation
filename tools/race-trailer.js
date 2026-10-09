/* The Race game's trailer (media/race-trailer.mp4 and the 9:16 media/race-trailer-mobile.mp4): a
 * minute of the game cut to the 'race' song (tools/trailer-music.js), recorded from Race.html by
 * tools/record-video.js with tools/trailer-kit.js.
 *
 * Five takes, each a fresh race on the virtual clock, scripted through the game's opt-in director
 * hook (RaceGame.director) and filmed by several cameras at once:
 *   start     the grid at dusk, the countdown, the launch and the pack through the first corners
 *   oncoming  down the start straight on the centre line at 160 km/h: oncoming near misses
 *   takedown  side by side with a rival at speed, then a slam: it spins out
 *   jump      the second ramp at 200 km/h with boost, filmed in slow motion
 *   headon    into an oncoming car: the full crash solver, its slow-motion crash camera
 * The edit picks frames by each take's events (go, a near miss, the takedown, the jump, the crash),
 * so every launch and impact lands on a beat.
 */
'use strict';
const K = require('./trailer-kit.js');
const { F, DT, TOTAL } = K;

// ---------------------------------------------------------------- the director (in the page)
// Driving: 'ai' (the rivals' driver, optionally held to a lane, flat out with boost), 'line' (the
// circuit at a fixed offset and speed), 'aim' (pure pursuit to a point). Cameras: specs evaluated
// each frame, k = 0..1 through the capture window.
function director() {
  const G = RaceGame, T = THREE, L = G.level, cam = G.R.camera;
  const V = (x, y, z) => new T.Vector3(x, y, z);
  const css = document.createElement('style');
  css.textContent = 'body.cine #hud, body.cine #crash, body.cine .overlay, body.cine #msg, body.cine #chip, body.cine #combo, body.cine #touch { display: none !important; }';
  document.head.appendChild(css);
  document.body.classList.add('cine');
  const ctx = { traffic: G.traffic, racing: true, player: null, lead: () => 0 };
  const D = window.__d = { drive: 'ai', cam: null, k: 0, auto: G.ai.adopt(G.me, 1.75, 1.0), boost: false, lane: null };
  const pursuit = (tx, tz, gain) => {
    const car = G.car, c = Math.cos(car.h), s = Math.sin(car.h), dx = tx - car.x, dz = tz - car.z;
    return Math.max(-1, Math.min(1, Math.atan2(-dx * s + dz * c, dx * c + dz * s) * gain));
  };
  G.director.input = (dt) => {
    const car = G.car;
    if (D.drive === 'ai') {
      if (D.lane !== null) { D.auto.laneT = D.lane; D.auto.laneTimer = 1; }
      const i = G.ai.drive(D.auto, dt, ctx);
      if (D.boost) { i.boost = true; if (!(i.brake > 0)) i.throttle = 1; }
      return i;
    }
    if (D.drive === 'line') {
      const f = L.nearest(car.x, car.z), a = L.poseAt(f.s + Math.max(8, car.speed * 0.45), D.offset), err = D.speed - car.forward;
      return { steer: pursuit(a.x, a.z, 1.6), throttle: err > 0 ? Math.min(1, 0.3 + err * 0.3) : 0, brake: err < -1 ? Math.min(1, -err * 0.2) : 0, boost: D.boost && err > 0 };
    }
    if (D.drive === 'aim') return { throttle: 1, boost: D.boost, steer: pursuit(D.target.x, D.target.z, D.gain || 2.2) };
    return { brake: 1 };
  };
  D.place = (s, l, v, h) => { const p = L.poseAt(s, l); G.car.place(p.x, p.z, h === undefined ? p.h : h, v); G.prog.prevS = s; return p; };
  const inBox = (o, x, z, m) => { const c = Math.cos(o.angle), s = Math.sin(o.angle), dx = x - o.x, dz = z - o.z; return Math.abs(dx * c + dz * s) < o.hx + m && Math.abs(-dx * s + dz * c) < o.hz + m; };
  const blocked = D.blocked = (p) => L.collidersNear(p.x, p.z, 1).some((o) => o.box && !o.rail && inBox(o, p.x, p.z, 0.6));
  // the followed car: the player's, or (subject: a rival) another
  const carOf = () => (D.subject ? D.subject.body.car : G.car);
  const frameOf = () => { const car = carOf(), c = Math.cos(car.h), s = Math.sin(car.h); return { o: V(car.x, car.y || 0, car.z), f: V(c, 0, s), r: V(-s, 0, c) }; };
  const lerp = (a, k) => Array.isArray(a) ? a[0] + (a[1] - a[0]) * k : a;
  const at = (s, l, y) => { const p = L.poseAt(s, l); return V(p.x, y + L.terrain(p.x, p.z), p.z); };
  D.CAMS = {
    // in front, low, looking back at the car: it chases the camera
    front: (k, p) => { const Fr = frameOf(); return { pos: Fr.o.clone().addScaledVector(Fr.f, lerp(p.d, k) || 7.5).addScaledVector(Fr.r, lerp(p.side, k) || 1).add(V(0, lerp(p.y, k) || 0.7, 0)), look: Fr.o.clone().addScaledVector(Fr.f, 0.5).add(V(0, 0.75, 0)) }; },
    // alongside, low (side < 0: the car's left)
    side: (k, p) => { const Fr = frameOf(); return { pos: Fr.o.clone().addScaledVector(Fr.f, lerp(p.a, k) || 1.5).addScaledVector(Fr.r, lerp(p.side, k) || -4).add(V(0, lerp(p.y, k) || 0.85, 0)), look: Fr.o.clone().addScaledVector(Fr.f, 0.8).add(V(0, 0.7, 0)) }; },
    // high behind: the street and the pack ahead
    heli: (k, p) => { const Fr = frameOf(); return { pos: Fr.o.clone().addScaledVector(Fr.f, -(lerp(p.back, k) || 16)).addScaledVector(Fr.r, lerp(p.side, k) || 0).add(V(0, lerp(p.y, k) || 11, 0)), look: Fr.o.clone().addScaledVector(Fr.f, lerp(p.ahead, k) || 16) }; },
    // low behind, just off the bumper
    chase: (k, p) => { const Fr = frameOf(); return { pos: Fr.o.clone().addScaledVector(Fr.f, -(lerp(p.back, k) || 5.2)).addScaledVector(Fr.r, lerp(p.side, k) || 0).add(V(0, lerp(p.y, k) || 1.05, 0)), look: Fr.o.clone().addScaledVector(Fr.f, 6).add(V(0, 0.9, 0)) }; },
    // placed on the circuit: pos at (s, l, y over the ground), looking at the car, or at (ls, ll, ly)
    street: (k, p) => { const car = carOf(); return { pos: at(lerp(p.s, k), lerp(p.l, k), lerp(p.y, k)), look: p.follow ? V(car.x, (car.y || 0) + 0.8, car.z) : at(lerp(p.ls, k), lerp(p.ll, k), lerp(p.ly, k)) }; },
    // around the crash (the game's crash focus), along an arc
    orbit: (k, p) => { const P = G.crashFocus, a = lerp(p.a, k) * Math.PI / 180, r = lerp(p.r, k) || 6; return { pos: V(P.x + Math.cos(a) * r, (P.y || 0) + (lerp(p.y, k) || 1.4), P.z + Math.sin(a) * r), look: V(P.x, (P.y || 0) + (p.lift || 0.6), P.z) }; },
  };
  G.director.camera = () => {
    if (!D.cam) return;
    const c = D.CAMS[D.cam.kind](D.k, D.cam);
    if (blocked(c.pos)) c.pos.y = Math.max(c.pos.y, 16);
    cam.position.copy(c.pos); cam.lookAt(c.look);
    const fov = lerp(D.cam.fov, D.k) || 50;
    if (Math.abs(cam.fov - fov) > 0.01) { cam.fov = fov; cam.updateProjectionMatrix(); }
  };
  D.status = () => {
    const chip = document.querySelector('#chip');
    return { state: G.state, t: +G.simT.toFixed(2), kmh: Math.round(Math.max(0, G.car.forward) * 3.6), s: +G.prog.s.toFixed(1), td: G.takedowns, air: !!G.car.air, pos: G.standings ? G.standings().findIndex(e => e.you) + 1 : 0,
      chip: chip && !chip.hidden ? chip.textContent : '', crash: G.crash ? { done: G.crash.done, kmh: Math.round(G.crash.impactKmh || 0) } : null };
  };
  return true;
}

// ---------------------------------------------------------------- cameras (fov: the 16:9 frame's)
const C = {
  front: { kind: 'front', d: [7.5, 6.2], side: 1.1, y: [0.7, 0.6], fov: 46 },
  frontWide: { kind: 'front', d: 11, side: -2.2, y: 1.2, fov: 52 },
  sideL: { kind: 'side', a: [2.5, 0.5], side: -4.2, y: 0.8, fov: 50 },
  sideR: { kind: 'side', a: [2.2, 0.2], side: 4.0, y: 0.9, fov: 50 },
  heli: { kind: 'heli', back: [18, 14], y: [12, 10], ahead: 18, fov: 50 },
  chase: { kind: 'chase', back: 5.6, y: 1.1, fov: 58 },
};

// ---------------------------------------------------------------- the takes
const push = `{ const G = RaceGame, L = G.level, f = L.nearest(G.car.x, G.car.z), inner = (c) => c.lane > 0;
  let far = 505;
  for (const c of G.traffic.cars) { const d = L.wrapDiff(c.s, f.s); if (inner(c) && d >= 505) far = Math.max(far, d + 25); }
  for (const c of G.traffic.cars.slice()) {
    const d = L.wrapDiff(c.s, f.s);
    if (!inner(c) || !c.body.kinematic || d <= -20 || d >= 505) continue;
    if (far > 575) { G.traffic.remove(c); continue; }
    c.s = ((f.s + far) % L.length + L.length) % L.length; far += 25;
    const p = L.poseAt(c.s, c.lane); c.body.car.setKinematic(p.x, p.z, p.h, c.v, c.v * p.k);
  } }`;
// the rivals away from a stretch of the circuit (none from `ahead` m before s to `behind` m after),
// the player a ghost meanwhile (no crash, no takedown); near misses from the wait are forgotten
async function clearRivals(t, s, ahead = 520, behind = 380) {
  await t.page(`RaceGame.me.ghost = 1e6`);
  const clear = `RaceGame.ai.rivals.every((r) => { const d = RaceGame.level.wrapDiff(r.body.track ? r.body.track.s : r.prog.s, ${s}); return d > ${ahead} || d < -${behind}; })`;
  for (let i = 0; i < 60 && !(await t.page(clear)); i++) await t.frames(15);
}
// only events from frame `from` on count (what came before was not filmed)
const since = (t, from) => { for (const type of ['nearmiss', 'air', 'land', 'takedown', 'crash', 'crashEnd']) t.forget(type, from); };
// start the race (Enter at the select screen) and film the countdown
async function go(t, cams) {
  await t.key('Enter', true);
  await t.frames(2, cams);
  await t.key('Enter', false);
  for (let i = 0; i < 400 && (await t.page('RaceGame.state')) !== 'race'; i++) await t.frames(1, cams);
}
const TAKES = {
  start: {
    query: 'director&car=mustang&touch=0',
    async run(t) {
      const grid = await t.page(`RaceGame.level.start.s - 8`);
      const gridLow = { kind: 'street', s: grid + 22, l: 0.6, y: 0.75, ls: grid - 12, ll: 3.5, ly: 1.1, fov: 42 };
      const gridHigh = { kind: 'street', s: grid + 8, l: -10, y: [6, 8], ls: grid - 14, ll: 3.5, ly: 0, fov: 48 };
      const gantry = { kind: 'street', s: grid + 40, l: -4, y: [7.5, 7.5], ls: grid - 10, ll: 2, ly: 0, fov: 46 };
      await t.page(`__d.drive = 'ai'; __d.boost = true;`);
      await go(t, { gridLow, gridHigh, gantry });
      // the pack: up the start straight, over the first ramp, through the first corners
      const ramp = await t.page(`RaceGame.level.ramps[0].s`);
      const rampLow = { kind: 'street', s: ramp + 30, l: -9.5, y: 0.9, follow: true, fov: 44 };
      await t.frames(330, { gridHigh, gantry, rampLow, heli: C.heli, sideL: C.sideL, front: C.front, chase: C.chase });
    },
  },
  oncoming: {
    query: 'director&car=mustang&touch=0',
    async run(t) {
      await go(t);
      await clearRivals(t, 255);
      // down the back straight (s 250-460, no ramp) 0.75 m from the centre line at 160 km/h: the
      // oncoming cars in the inner lane are spaced to meet the player 45, 85 and 125 frames into the run
      t.mark('run');
      const run = t.n;
      await t.page(`RaceGame.me.ghost = 0; for (const c of RaceGame.traffic.cars.slice()) RaceGame.traffic.remove(c);
        __d.place(255, 0.75, 160 / 3.6); __d.drive = 'line'; __d.offset = 0.75; __d.speed = 44; __d.boost = false;`);
      await t.frames(3, null, push);
      await t.page(`{ const G = RaceGame, L = G.level, f = L.nearest(G.car.x, G.car.z);
        const on = G.traffic.cars.filter((c) => Math.abs(c.lane + 1.75) < 0.1 && c.body.kinematic);
        on.forEach((c, i) => {
          if (i < 3) c.s = ((f.s + (44 + c.v) * (45 + 40 * i) / 30) % L.length + L.length) % L.length;
          else G.traffic.remove(c);
          const p = L.poseAt(c.s, c.lane); c.body.car.setKinematic(p.x, p.z, p.h + Math.PI, c.v, -c.v * p.k);
        }); }`);
      await t.frames(160, { front: { kind: 'front', d: 8, side: -0.3, y: 0.65, fov: 50 }, sideR: { kind: 'side', a: [3, 0], side: 4.4, y: 0.8, fov: 48 }, heli: C.heli, chase: C.chase }, push);
      since(t, run);
    },
  },
  takedown: {
    query: 'director&car=mustang&traffic=0&touch=0',
    async run(t) {
      await go(t);
      await t.frames(60);
      const run = t.n;
      await t.page(`(() => { const G = RaceGame, L = G.level, r = G.ai.rivals.find(r => r.key === 'lexus') || G.ai.rivals[0];
        const s = 760, p = L.poseAt(s, 5.25); r.body.car.place(p.x, p.z, p.h, 30); r.lane = r.l = r.laneT = 5.25; r.prog.prevS = s;
        __d.place(s - 1, 1.75, 30); __d.drive = 'ai'; __d.lane = 1.75; __d.boost = false; __d.rival = r; __d.td0 = G.takedowns; })()`);
      const cams = { sideL: { kind: 'side', a: [6, 2], side: -5.2, y: 1.0, fov: 50 }, heli: { kind: 'heli', back: 14, y: 9, ahead: 10, side: -3, fov: 50 }, front: C.frontWide,
        low: { kind: 'front', d: 9, side: 4.5, y: 0.6, fov: 46 } };
      await t.frames(70, cams);
      await t.page(`(() => { const r = __d.rival.body.car; __d.drive = 'aim'; __d.gain = 3; __d.target = { x: r.x + Math.cos(r.h) * 6, z: r.z + Math.sin(r.h) * 6 }; __d.boost = true; })()`);
      await t.frames(140, cams, `if (__d.drive === 'aim') { const r = __d.rival.body.car; __d.target = { x: r.x + Math.cos(r.h) * 5, z: r.z + Math.sin(r.h) * 5 }; if (RaceGame.takedowns > __d.td0) { __d.drive = 'ai'; __d.lane = 1.75; } }`);
      since(t, run);
    },
  },
  jump: {
    query: 'director&car=mustang&traffic=0&touch=0',
    async run(t) {
      await go(t);
      // the first ramp: 160 m of straight before it, 240 m after
      const r = await t.page(`(() => { const r = RaceGame.level.ramps[0]; return { s: r.s, len: r.len, up: r.up }; })()`);
      await clearRivals(t, r.s, 300, 200);
      // about 190 km/h at the ramp, flat out with boost
      const run = t.n;
      await t.page(`RaceGame.me.ghost = 0; __d.place(${r.s} - 150, 1.75, 180 / 3.6); __d.drive = 'line'; __d.offset = 1.75; __d.speed = 53; __d.boost = true;`);
      // beside the lip, low; on the road beyond it (the car flies over); where it lands, looking back
      const lip = r.s + r.up, rampLow = { kind: 'street', s: lip + 10, l: -6.2, y: 0.45, follow: true, fov: 50 }, under = { kind: 'street', s: lip + 30, l: 0.6, y: 0.3, follow: true, fov: 62 };
      const rampAhead = { kind: 'street', s: lip + 82, l: 6.6, y: 0.8, follow: true, fov: 34 };
      const cams = { rampLow, under, rampAhead, chase: C.chase, heli: { kind: 'heli', back: 14, side: -5, y: 7, ahead: 14, fov: 52 }, sideR: { kind: 'side', a: 0, side: 6, y: 1.6, fov: 50 } };
      await t.frames(150, cams, null, { until: `RaceGame.car.air` });
      // in the air and the landing: slow motion (a quarter of the speed)
      await t.frames(300, cams, null, { dt: DT / 4, until: `!RaceGame.car.air` });
      await t.frames(40, cams, null, { dt: DT / 4 });
      await t.frames(60, cams);
      since(t, run);
    },
  },
  headon: {
    query: 'director&car=mustang&touch=0',
    async run(t) {
      await go(t);
      await t.frames(100);
      let setup = null;
      for (let tries = 0; tries < 40 && !setup; tries++) {
        if (tries) await t.frames(15);
        setup = await t.page(`(() => { const G = RaceGame, L = G.level, D = __d, f = L.nearest(G.car.x, G.car.z);
          for (const ahead of [180, 260, 340, 420]) for (const lane of [-1.75, -5.25]) {
            const sp = f.s + ahead;
            if ([0, 60, 140, 200].some(d => Math.abs(L.poseAt(sp + d, 0).k) > 0.002)) continue;
            if (L.ramps.some(r => Math.abs(L.wrapDiff(r.s, sp + 80)) < 110)) continue;
            const inLane = G.traffic.cars.filter(o => o.body.kinematic && Math.abs(o.lane - lane) < 1).map(o => ({ o, d: L.wrapDiff(o.s, sp) }));
            if (inLane.some(e => e.d > -15 && e.d < 60)) continue;
            const c = inLane.filter(e => e.d >= 70 && e.d < 200).sort((a, b) => a.d - b.d)[0];
            if (!c) continue;
            D.place(sp, lane, 175 / 3.6); D.drive = 'line'; D.offset = lane; D.speed = 50; D.boost = true; D.other = c.o;
            return { lane, key: c.o.key, gap: Math.round(c.d) };
          }
          return null; })()`);
      }
      if (!setup) throw new Error('headon: no oncoming car to meet');
      const run = t.n;
      await t.frames(330, { front: { kind: 'front', d: 9, side: 2.2, y: 0.8, fov: 48 }, sideR: { kind: 'side', a: [6, 1], side: 4.5, y: 1.0, fov: 50 }, heli: { kind: 'heli', back: 12, y: 8, ahead: 12, side: 3, fov: 50 },
        orbit: { kind: 'orbit', a: [100, 160], r: 6, y: 1.3, fov: 48 }, orbitHigh: { kind: 'orbit', a: [300, 340], r: 7.5, y: 4.5, fov: 48 } },
        `if (RaceGame.state === 'crash') __d.crashed = 0; else if (__d.crashed !== undefined) __d.crashed++;`, { until: `__d.crashed > 6` });
      since(t, run);
      return setup;
    },
  },
};

const game = {
  takes: TAKES,
  ready: `typeof RaceGame === 'object' && document.querySelector('#loading').hidden && RaceGame.state === 'select'`,
  director,
  status: `__d.status()`,
  crashWait: `RaceGame.state === 'crash' && RaceGame.crash && !RaceGame.crash.done`,
  shootJs: `RaceGame.director.camera(0); RaceGame.R.render()`,
  events(prev, s, n, push) {
    if (prev.state === 'countdown' && s.state === 'race') push('go');
    if (s.td > prev.td) push('takedown');
    if (s.chip && s.chip !== prev.chip && /near miss/i.test(s.chip)) push('nearmiss', { text: s.chip });
    if (s.air && !prev.air && s.state === 'race') push('air');
    if (!s.air && prev.air && s.state === 'race') push('land');
    if (s.state === 'crash' && prev.state !== 'crash') push('crash', { kmh: s.crash ? s.crash.kmh : 0 });
    if (s.state !== 'crash' && prev.state === 'crash') push('crashEnd');
  },
};

// ---------------------------------------------------------------- the edit
// On the 'race' song's bars: titles between glimpses (0-2), the countdown (3), the start on the drop
// (4), the pack over the first ramp (5-7), the oncoming lanes (8-10), the takedown (11-14), the jump
// in slow motion (15-19), the head-on (20-23), the breakdown (24-27), faster and faster (28-33), the
// titles (34 on).
const E = [];
const shot = (f, n, o) => E.push(Object.assign({ f, n }, o));
const src = (take, cam, ref, off, rate) => ({ take, cam, ref, off, rate });
shot(F(0), 24, { card: { tag: 'Car Crash Simulation', title: 'Race' }, sfx: 'card' });
shot(F(0, 2), 24, { src: src('start', 'gridHigh', 'abs', 4), sfx: 'whoosh' });
shot(F(1), 24, { card: { title: 'Eight <em>cars</em>' }, sfx: 'card' });
shot(F(1, 2), 24, { src: src('start', 'heli', 'air', -12), sfx: 'whoosh' });
shot(F(2), 24, { card: { tag: 'Traffic both ways', title: 'Full <em>contact</em>' }, sfx: 'card' });
shot(F(2, 2), 24, { src: src('headon', 'orbit', 'crash', 6), hit: 'crash', hitV: 0.5 });
shot(F(3), 36, { src: src('start', 'gridLow', 'go', -36), countdown: true });
shot(F(3, 3), 12, { src: src('start', 'gantry', 'go', -12) });
shot(F(4), 48, { src: src('start', 'gridHigh', 'go', 1), hit: 'go', big: 'Go!' });
shot(F(5), 48, { src: src('start', 'gantry', 'go', 40), speed: true });
shot(F(6), 48, { src: src('start', 'rampLow', 'air', -30), hit: 'go', hitAt: 30, hitV: 0.5, lower: ['Eight cars · three laps', 'A city circuit at dusk, with traffic both ways'] });
shot(F(7), 48, { src: src('start', 'sideL', 'air', 40), speed: true });
// the oncoming lanes
shot(F(8), 48, { src: src('oncoming', 'front', 'nearmiss', -30), speed: true, wipe: true });
shot(F(9), 48, { src: src('oncoming', 'sideR', 'nearmiss', 10), speed: true, lower: ['Near misses', 'Oncoming traffic fills your boost'] });
shot(F(10), 48, { src: src('oncoming', 'heli', 'nearmiss', 50), speed: true });
// the takedown
shot(F(11), 48, { src: src('takedown', 'heli', 'takedown', -72), speed: true });
shot(F(12), 48, { src: src('takedown', 'sideL', 'takedown', -24), hit: 'crash', hitAt: 24, hitV: 0.7, big: 'Takedown', bigKind: 'td', bigAt: 24 });
shot(F(13), 48, { src: src('takedown', 'low', 'takedown', -6) });
shot(F(14), 48, { src: src('takedown', 'heli', 'takedown', 8), lower: ['Takedowns', 'Slam your rivals off the road'] });
// the jump, in slow motion from the lip to the landing
shot(F(15), 48, { src: src('jump', 'chase', 'air', -48), speed: true, wipe: true });
shot(F(16), 48, { src: src('jump', 'rampLow', 'air', -8), slow: true, hit: 'go', hitV: 0.6 });
shot(F(17), 48, { src: src('jump', 'under', 'air', 30), slow: true, lower: ['Jumps', 'No grip in the air'] });
shot(F(18), 48, { src: src('jump', 'sideR', 'air', 80), slow: true });
shot(F(19), 48, { src: src('jump', 'rampAhead', 'land', -36), slow: true, hit: 'go', hitAt: 36, hitV: 0.5 });
// the head-on
shot(F(20), 24, { src: src('headon', 'sideR', 'crash', -24), speed: true });
shot(F(20, 2), 48, { src: src('headon', 'orbit', 'crash', 0), hit: 'crash', impact: true, lower: ['Head-on', 'The full crash solver, in slow motion'] });
shot(F(21, 2), 48, { src: src('headon', 'orbitHigh', 'crash', 40), impact: true });
shot(F(22, 2), 72, { src: src('headon', 'orbit', 'crash', 50) });
// breakdown
shot(F(24), 96, { src: src('start', 'heli', 'go', 60), card: { tag: 'Solved as it happens', title: 'Every crash <em>computed</em>', over: true } });
shot(F(26), 96, { src: src('oncoming', 'heli', 'nearmiss', -40), card: { tag: 'CPU or WebGPU', title: 'Real crash <em>physics</em>', over: true } });
// last chorus: faster and faster
[['start', 'gridHigh', 'go', 1, 'go'], ['headon', 'orbit', 'crash', 0, 'crash'], ['oncoming', 'front', 'nearmiss', -6, null], ['jump', 'rampLow', 'air', 0, 'go'],
  ['takedown', 'sideL', 'takedown', -8, 'crash'], ['headon', 'orbitHigh', 'crash', 10, 'crash'], ['start', 'rampLow', 'air', -4, null], ['jump', 'sideR', 'air', 40, 'go']]
  .forEach(([take, cam, ref, off, hit], i) => shot(F(28 + i / 2), 24, { src: src(take, cam, ref, off), hit, hitV: 0.6 }));
[['headon', 'orbit', 'crash', 16], ['oncoming', 'sideR', 'nearmiss', -4], ['jump', 'rampAhead', 'land', -6], ['takedown', 'low', 'takedown', 0],
  ['start', 'heli', 'air', 0], ['headon', 'front', 'crash', -2], ['jump', 'under', 'air', 20], ['start', 'gridHigh', 'go', 30]]
  .forEach(([take, cam, ref, off], i) => shot(F(32, i), 12, { src: src(take, cam, ref, off), hit: 'crash', hitV: 0.4 }));
// the end: title, line, call to action, over the pack
shot(F(34), TOTAL - F(34), { src: src('start', 'heli', 'go', 100), dim: 0.62 });
const TITLES = [
  [F(34), { kind: 'title', title: 'Race', tag: 'Eight cars · traffic both ways' }, 'title'],
  [F(35), { kind: 'title', title: 'Race', tag: 'Takedowns · jumps · real crashes' }, 'card'],
  [F(36), { kind: 'title', title: 'Race', tag: 'Play free in your browser', cta: 'Play now', url: 'car-crash-simulation.vercel.app/race' }, 'title'],
];
const POSTER = { take: 'headon', cam: 'orbit', ref: 'crash', off: 12 };
const edit = { E, TITLES };

// the game's own overlay parts: the car's speed and the impact readout
function extra(o, s, f, src) {
  if (!src) return;
  const st = src.status;
  if (s.speed && st.kmh > 5) o.speed = st.kmh;
  if (s.impact) { const e = st.crash; o.impact = { kmh: e ? e.kmh : 0, label: 'FULL CRASH SOLVER' }; }
}

module.exports = { game, edit, extra, POSTER, C };
