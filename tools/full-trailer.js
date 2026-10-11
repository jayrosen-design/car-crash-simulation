/* The full trailer, for YouTube (tools/out/trailer/car-crash-simulation-trailer.mp4, 1920 x 1080, 30 fps):
 * about two minutes of the whole project cut to the soundtrack's Full Throttle, recorded by
 * tools/record-video.js full with tools/trailer-kit.js.
 *
 * The song (2:41) is cut to 2:10 at two phrase boundaries, each spliced 25 ms before a drum hit that
 * both sides share: the second half of the first verse goes (bars 13-20), and the bridge (bars
 * 57-62), so the second break drops straight into the last chorus. Its beat (107.4 BPM) is found
 * from the drums (analyze), and every cut lands on a beat, snapped to the hit nearest the grid.
 *   intro          the website, glimpses of the three modes, the title on the verse's downbeat
 *   verse          the crash lab: the simulator's crash tests on the WebGPU solver
 *   breakdown      Race: the grid and the countdown, "Go" on the first chorus
 *   chorus 1       Race on its three tracks: the start, the pack, near misses at night, a jump, a
 *                  takedown (its own crash camera), the motorcycle, the armoured car, a head-on
 *   break          the garage: the twelve vehicles, one a beat
 *   chorus 2       Destruction on its three junctions: the ramp into the tanker, explosions, the
 *                  Crashbreaker, the pile-up, the medal
 *   break          the physics write-up
 *   last chorus    everything again, faster, and the title
 * Crashes run on the WebGPU solver (the simulator's brick wall on the CPU: the GPU solver doesn't do
 * it). The sound: the song under the game's own sound effects (js/fx.js: crunches, glass, tearing
 * metal, explosions, the countdown, pass-bys, the recorded engines), rendered offline on the
 * trailer's clock. No address or credits in the picture.
 *
 * The takes are fresh runs of the games on the virtual clock (Race.html, Destruction.html, through
 * their director hooks), the simulator's runs (tools/trailer.js, filmed square), the Race select
 * screen, and the home and physics pages (filmed in 16:9). Each take keeps its events in its own
 * file, so takes can be recorded in parallel (--takes a,b).
 */
'use strict';
const fs = require('fs');
const path = require('path');
const K = require('./trailer-kit.js');
const Race = require('./race-trailer.js');
const Destr = require('./destruction-trailer.js');
const Sim = require('./trailer.js');

const FPS = 30, DT = 1000 / FPS;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ---------------------------------------------------------------- the song
const SONG = 'full-throttle';
const GRID = { first: 0.115, bpm: 107.38 };   // the beat grid fitted to the drums (analyze)
// the song's pieces, in bars of the grid: [from, to) (null: to the end)
const PIECES = [[0, 13], [21, 57], [63, null]];
const TAIL = 1.2;   // s of the end title after the song stops

// in the page: the song's beats, each snapped to the strongest drum hit within 90 ms of the grid
// (kick, and snare at 0.6); -> { duration, beats: [song s], snapped: share of beats moved to a hit }
function analyzeSong(song, grid) {
  return (async () => {
    const b64 = window.MUSIC_DATA[song];
    const ab = await (await fetch('data:audio/mpeg;base64,' + b64)).arrayBuffer();
    const buf = await new OfflineAudioContext(1, 44100, 44100).decodeAudioData(ab), sr = buf.sampleRate;
    const band = async (type, f, q) => { const o = new OfflineAudioContext(1, buf.length, sr); const s = o.createBufferSource(); s.buffer = buf; const b = o.createBiquadFilter(); b.type = type; b.frequency.value = f; if (q) b.Q.value = q; s.connect(b).connect(o.destination); s.start(); return (await o.startRendering()).getChannelData(0); };
    const hop = Math.round(sr * 0.005);
    const env = (x) => { const N = Math.floor(x.length / hop), e = new Float32Array(N); for (let i = 0; i < N; i++) { let s = 0; for (let j = i * hop; j < (i + 1) * hop; j++) s += x[j] * x[j]; e[i] = Math.log(1e-5 + Math.sqrt(s / hop)); } return e; };
    const flux = (e) => { const o = new Float32Array(e.length); for (let i = 2; i < e.length; i++) o[i] = Math.max(0, e[i] - Math.max(e[i - 1], e[i - 2])); return o; };
    const kick = flux(env(await band('lowpass', 110))), snare = flux(env(await band('bandpass', 2500, 0.8)));
    const on = kick.map((v, i) => v + 0.6 * snare[i]);
    const beat = 60 / grid.bpm, beats = [];
    let moved = 0;
    for (let t = grid.first; t < buf.duration; t += beat) {
      let best = 0, at = t;
      for (let i = Math.round((t - 0.09) * 200); i <= Math.round((t + 0.09) * 200); i++) if ((on[i] || 0) > best) { best = on[i]; at = i / 200; }
      if (best > 0.6) moved++; else at = t;
      beats.push(+at.toFixed(4));
    }
    return { duration: buf.duration, beats, snapped: moved / beats.length };
  })();
}

// the song's beats -> the trailer's timeline: the pieces (song from, to; trailer at) and its beats
function timeline(an) {
  const B = an.beats, cut = (bar) => B[bar * 4] - 0.025;   // 25 ms before the downbeat's hit
  const pieces = [];
  let at = 0;
  for (const [a, b] of PIECES) {
    const s0 = a === 0 ? 0 : cut(a), s1 = b === null ? an.duration : cut(b);
    pieces.push({ s0, s1, at });
    at += s1 - s0;
  }
  const beats = [];
  for (const p of PIECES.map((x, i) => [x, pieces[i]])) {
    const [[a, b], q] = p;
    for (let i = a * 4; i < (b === null ? B.length : b * 4); i++) beats.push(q.at + B[i] - q.s0);
  }
  return { pieces, beats, songEnd: at, total: Math.ceil((at + TAIL) * FPS) };
}

// ---------------------------------------------------------------- the takes
const GPU = '&touch=0&solver=gpu';
// the Race director: race-trailer's, plus the takedown camera (and a camera around it), the game's
// own camera, straights to find, the crash solver's mode in the status
function raceExtras() {
  const G = RaceGame, D = window.__d, cam = G.R.camera, T = THREE;
  const css = document.createElement('style');
  css.textContent = 'body.cine #td-skip, body.cine #music-now { display: none !important; }';
  document.head.appendChild(css);
  G.director.takedownCam = true;
  const keep = { pos: new T.Vector3(), q: new T.Quaternion(), fov: 60 }, base = G.director.camera;
  G.director.camera = (dt, st) => {
    if (!D.cam) { keep.pos.copy(cam.position); keep.q.copy(cam.quaternion); keep.fov = cam.fov; return; }
    if (D.cam.kind === 'game') { cam.position.copy(keep.pos); cam.quaternion.copy(keep.q); if (cam.fov !== keep.fov) { cam.fov = keep.fov; cam.updateProjectionMatrix(); } return; }
    base(dt, st);
  };
  const lerp = (a, k) => Array.isArray(a) ? a[0] + (a[1] - a[0]) * k : a;
  // round the takedown's rival: a from the player's heading (degrees; negative: the player's left, the
  // road side when the rival went into the kerb), pulled in toward it out of any building
  D.CAMS.td = (k, p) => {
    const t = G.tdCam, P = t && t.P ? t.P : { x: G.car.x, z: G.car.z, y: 0 }, a = G.car.h + lerp(p.a, k) * Math.PI / 180;
    let r = lerp(p.r, k) || 8, pos;
    for (; ; r -= 0.5) { pos = new T.Vector3(P.x + Math.cos(a) * r, (P.y || 0) + (lerp(p.y, k) || 2), P.z + Math.sin(a) * r); if (r <= 3 || !D.blocked(pos)) break; }
    return { pos, look: new T.Vector3(P.x, (P.y || 0) + 0.7, P.z) };
  };
  D.straight = (len, from = 0) => {
    const L = G.level;
    for (let s = from; s < L.length; s += 10) {
      let ok = true;
      for (let d = 0; d <= len && ok; d += 10) ok = Math.abs(L.poseAt(s + d, 0).k) < 0.002;
      if (ok && !L.ramps.some((r) => Math.abs(L.wrapDiff(r.s, s + len / 2)) < len / 2 + 60)) return s;
    }
    return null;
  };
  const st0 = D.status;
  D.status = () => Object.assign(st0(), { tdcam: !!G.tdCam, mode: G.crash ? G.crash.mode : null, tdmode: G.tdCam ? G.tdCam.cr.mode : null });
  return true;
}
const composed = (base, extra) => ({ toString: () => `() => { (${base.toString()})(); (${extra.toString()})(); return true; }` });
const raceGame = Object.assign({}, Race.game, {
  director: composed(Race.game.director, raceExtras),
  crashWait: `(RaceGame.state === 'crash' && RaceGame.crash && !RaceGame.crash.done) || (!!RaceGame.tdCam && !RaceGame.tdCam.cr.done)`,
  events(prev, s, n, push) {
    Race.game.events(prev, s, n, push);
    if (s.tdcam && !prev.tdcam) push('tdcam', { mode: s.tdmode });
    if (!s.tdcam && prev.tdcam) push('tdcamEnd');
    if (s.state === 'crash' && prev.state !== 'crash') push('solver', { text: s.mode || '' });
  },
});
const RT = Race.game.takes, RC = Race.C;
// start the race, film the countdown (cams optional)
async function go(t, cams) {
  await t.key('Enter', true); await t.frames(2, cams); await t.key('Enter', false);
  for (let i = 0; i < 400 && (await t.page('RaceGame.state')) !== 'race'; i++) await t.frames(1, cams);
}
const since = (t, from) => { for (const type of ['nearmiss', 'air', 'land', 'takedown', 'crash', 'crashEnd', 'tdcam', 'tdcamEnd', 'solver']) t.forget(type, from); };
// the player driven into an oncoming car on a straight (from race-trailer's head-on), at kmh
async function meetOncoming(t, kmh, boost) {
  let setup = null;
  for (let tries = 0; tries < 40 && !setup; tries++) {
    if (tries) await t.frames(15);
    setup = await t.page(`(() => { const G = RaceGame, L = G.level, D = __d, f = L.nearest(G.car.x, G.car.z);
      for (const ahead of [180, 260, 340, 420, 520, 640]) for (const lane of [-1.75, -5.25]) {
        const sp = f.s + ahead;
        if ([0, 60, 140, 200].some(d => Math.abs(L.poseAt(sp + d, 0).k) > 0.002)) continue;
        if (L.ramps.some(r => Math.abs(L.wrapDiff(r.s, sp + 80)) < 110)) continue;
        const inLane = G.traffic.cars.filter(o => o.body.kinematic && Math.abs(o.lane - lane) < 1).map(o => ({ o, d: L.wrapDiff(o.s, sp) }));
        if (inLane.some(e => e.d > -15 && e.d < 60)) continue;
        const c = inLane.filter(e => e.d >= 70 && e.d < 200).sort((a, b) => a.d - b.d)[0];
        if (!c) continue;
        D.place(sp, lane, ${kmh} / 3.6); D.drive = 'line'; D.offset = lane; D.speed = ${kmh} / 3.6; D.boost = ${!!boost}; D.other = c.o;
        return { lane, key: c.o.key, gap: Math.round(c.d) };
      }
      return null; })()`);
  }
  // none found (a track of bends): an oncoming car put on the longest straight, its lane cleared
  if (!setup) setup = await t.page(`(() => { const G = RaceGame, L = G.level, D = __d, s = D.straight(200) !== null ? D.straight(200) : D.straight(160);
    const o = s === null ? null : G.traffic.cars.find((c) => c.body.kinematic && c.lane < 0);
    if (!o) return null;
    for (const c of G.traffic.cars.slice()) if (c !== o && c.lane < 0 && Math.abs(L.wrapDiff(c.s, s + 100)) < 180) G.traffic.remove(c);
    o.lane = -1.75; o.s = (s + 150) % L.length;
    const p = L.poseAt(o.s, o.lane); o.body.car.setKinematic(p.x, p.z, p.h + Math.PI, o.v, -o.v * p.k);
    D.place(s, -1.75, ${kmh} / 3.6); D.drive = 'line'; D.offset = -1.75; D.speed = ${kmh} / 3.6; D.boost = ${!!boost}; D.other = o;
    return { lane: -1.75, key: o.key, gap: 150, placed: true }; })()`);
  if (!setup) throw new Error('no oncoming car to meet');
  return setup;
}
const crashCams = (extra) => Object.assign({
  orbit: { kind: 'orbit', a: [100, 160], r: 6, y: 1.3, fov: 48 },
  orbitHigh: { kind: 'orbit', a: [300, 340], r: 7.5, y: 4.5, fov: 48 },
  orbitLow: { kind: 'orbit', a: [200, 240], r: 5.2, y: 0.7, fov: 50 },
}, extra);
const untilSettled = `if (RaceGame.state === 'crash') __d.crashed = 0; else if (__d.crashed !== undefined) __d.crashed++;`;

const RACE = {
  // the grid at dusk, the countdown, the launch and the pack (race-trailer's start), in the GT-R
  rstart: { query: 'director&car=gtr&level=downtown' + GPU, run: RT.start.run },
  // the first ramp at 200 km/h in the pickup, in slow motion (race-trailer's jump)
  rjump: { query: 'director&car=trx&level=downtown&traffic=0' + GPU, run: RT.jump.run },
  // the harbour at night in the SF90: down a straight on the centre line, oncoming near misses
  rnight: {
    query: 'director&car=sf90&level=harbour' + GPU,
    async run(t) {
      await go(t);
      const s = await t.page(`__d.straight(220)`);
      if (s === null) throw new Error('rnight: no straight');
      await t.page(`RaceGame.me.ghost = 1e6`);
      const clear = `RaceGame.ai.rivals.every((r) => { const d = RaceGame.level.wrapDiff(r.body.track ? r.body.track.s : r.prog.s, ${s}); return d > 520 || d < -380; })`;
      for (let i = 0; i < 60 && !(await t.page(clear)); i++) await t.frames(15);
      const run = t.n;
      t.mark('run');
      await t.page(`RaceGame.me.ghost = 0; for (const c of RaceGame.traffic.cars.slice()) if (c.lane > 0) RaceGame.traffic.remove(c);
        __d.place(${s}, 1.0, 170 / 3.6); __d.drive = 'line'; __d.offset = 1.0; __d.speed = 47; __d.boost = false;`);   // (1 m off the centre line: the SF90 is wide)
      // the oncoming cars spaced to meet the player 40, 75 and 110 frames in
      await t.page(`{ const G = RaceGame, L = G.level, f = L.nearest(G.car.x, G.car.z);
        const on = G.traffic.cars.filter((c) => Math.abs(c.lane + 1.75) < 0.1 && c.body.kinematic);
        on.forEach((c, i) => {
          if (i < 3) c.s = ((f.s + (47 + c.v) * (40 + 35 * i) / 30) % L.length + L.length) % L.length;
          else if (Math.abs(L.wrapDiff(c.s, f.s)) < 400) G.traffic.remove(c);
          const p = L.poseAt(c.s, c.lane); c.body.car.setKinematic(p.x, p.z, p.h + Math.PI, c.v, -c.v * p.k);
        }); }`);
      await t.frames(150, { front: { kind: 'front', d: 8, side: -0.3, y: 0.65, fov: 50 }, sideR: { kind: 'side', a: [3, 0], side: 4.4, y: 0.8, fov: 48 }, heli: RC.heli, chase: RC.chase, game: { kind: 'game' } });
      since(t, run);
    },
  },
  // side by side with a rival at 100 km/h, shoved into the street trees: the takedown camera
  rtakedown: {
    query: 'director&car=supra&level=downtown&traffic=0' + GPU,
    async run(t) {
      await go(t);
      await t.page(`RaceGame.me.ghost = 1e6`);
      await t.frames(30);
      const run = t.n;
      t.mark('run');
      await t.page(`(() => { const G = RaceGame, L = G.level, r = G.ai.rivals[0];
        for (const o of G.ai.rivals.slice(1)) { const p = L.poseAt(((L.nearest(G.car.x, G.car.z).s + 700) % L.length), 1.75); o.body.car.place(p.x, p.z, p.h, 0); o.wreck = 1e6; }
        const p = L.poseAt(300, 1.75), p2 = L.poseAt(300, 5.25);
        G.me.ghost = 0; G.car.place(p.x, p.z, p.h, 100 / 3.6); G.prog.prevS = 300;
        r.body.car.place(p2.x, p2.z, p2.h, 100 / 3.6); r.lane = r.l = r.laneT = 5.25; r.prog.prevS = 300;
        __d.rival = r; __d.t0 = G.simT; __d.drive = 'shove'; })()`);
      await t.page(`{ const base = RaceGame.director.input; RaceGame.director.input = (dt) => __d.drive === 'shove' ? (RaceGame.tdCam ? { throttle: 0.4 } : { throttle: 1, steer: RaceGame.simT - __d.t0 < 1.2 ? 0.5 : -0.5 }) : base(dt); }`);
      const cams = { sideL: { kind: 'side', a: [5, 1], side: -5.2, y: 1.0, fov: 50 }, heli: { kind: 'heli', back: 14, y: 9, ahead: 10, side: -3, fov: 50 },
        low: { kind: 'front', d: 9, side: 4.5, y: 0.6, fov: 46 }, td: { kind: 'td', a: [-50, -100], r: 8, y: 2.4, fov: 46 }, tdLow: { kind: 'td', a: [-150, -120], r: 6, y: 0.8, fov: 50 }, game: { kind: 'game' } };
      await t.frames(300, cams, `if (RaceGame.tdCam) __d.tdSeen = true;`, { until: `__d.tdSeen && !RaceGame.tdCam && (__d.after = (__d.after || 0) + 1) > 30` });
      since(t, run);
    },
  },
  // the motorcycle at night: flat out through the traffic, then into an oncoming car (the rider thrown)
  rbike: {
    query: 'director&car=ducati&level=harbour' + GPU,
    async run(t) {
      await go(t);
      await t.frames(60);
      const run = t.n;
      await t.page(`__d.drive = 'ai'; __d.boost = true; __d.lane = 1.75;`);
      await t.frames(120, { front: { kind: 'front', d: 6.5, side: 0.8, y: 0.55, fov: 46 }, sideL: { kind: 'side', a: [2, 0], side: -3.4, y: 0.7, fov: 50 }, chase: { kind: 'chase', back: 4.2, y: 1.0, fov: 58 } });
      await meetOncoming(t, 150, true);
      await t.frames(330, crashCams({ front: { kind: 'front', d: 8, side: 1.8, y: 0.7, fov: 48 }, sideR: { kind: 'side', a: [5, 1], side: 4.2, y: 0.9, fov: 50 } }), untilSettled, { until: `__d.crashed > 6` });
      since(t, run);
    },
  },
  // the armoured car on the hillside at noon, shoving the traffic ahead out of its way
  rtank: {
    query: 'director&car=type87&level=hillside' + GPU,
    async run(t) {
      await go(t);
      await t.frames(60);
      const s = await t.page(`__d.straight(160, 400)`);
      if (s === null) throw new Error('rtank: no straight');
      await t.page(`RaceGame.me.ghost = 1e6`);
      const run = t.n;
      t.mark('run');
      // three cars ahead in the player's lane, slower: the armoured car runs into them
      await t.page(`{ const G = RaceGame, L = G.level;
        __d.place(${s}, 1.75, 26); __d.drive = 'line'; __d.offset = 1.75; __d.speed = 28; __d.boost = true;
        for (const c of G.traffic.cars.slice()) if (Math.abs(L.wrapDiff(c.s, ${s})) < 260) G.traffic.remove(c);
        G.me.ghost = 0; }`);
      await t.page(`{ const G = RaceGame, L = G.level, mk = G.traffic.cars.filter((c) => c.lane > 0 && c.body.kinematic);
        mk.slice(0, 3).forEach((c, i) => { c.s = (${s} + 45 + 22 * i) % L.length; c.lane = 1.75; c.v = 10; const p = L.poseAt(c.s, c.lane); c.body.car.setKinematic(p.x, p.z, p.h, c.v, c.v * p.k); }); }`);
      await t.frames(210, { front: { kind: 'front', d: 11, side: 2.5, y: 1.2, fov: 48 }, sideL: { kind: 'side', a: [3, 0], side: -6.5, y: 1.4, fov: 50 }, heli: { kind: 'heli', back: 16, y: 9, ahead: 14, side: -3, fov: 50 }, low: { kind: 'front', d: 7, side: -3, y: 0.5, fov: 52 } });
      since(t, run);
    },
  },
  // a head-on at noon in the police car: the full crash solver on WebGPU
  rheadon: {
    query: 'director&car=crownvic&level=hillside' + GPU,
    async run(t) {
      await go(t);
      await t.frames(100);
      const run = t.n;
      const setup = await meetOncoming(t, 175, true);
      await t.frames(330, crashCams({ front: { kind: 'front', d: 9, side: 2.2, y: 0.8, fov: 48 }, sideR: { kind: 'side', a: [6, 1], side: 4.5, y: 1.0, fov: 50 }, heli: { kind: 'heli', back: 12, y: 8, ahead: 12, side: 3, fov: 50 } }), untilSettled, { until: `__d.crashed > 6` });
      since(t, run);
      return setup;
    },
  },
};

// Destruction: the gold run (destruction-trailer's take, on the GPU), and two more junctions
const DC = Destr.C;
function destrExtras() {
  const G = DestructionGame, D = window.__d;
  const css = document.createElement('style');
  css.textContent = 'body.cine #music-now { display: none !important; }';
  document.head.appendChild(css);
  // the other junctions' runs: down the right lane by pure pursuit of a point on it (steady in any
  // vehicle; the gold run keeps its own steering), then, hunting, after the junction's edge the
  // nearest lorry, bus or tanker ahead
  const base = G.director.input;
  const toward = (c, tx, tz, gain) => { const dx = tx - c.x, dz = tz - c.z, ch = Math.cos(c.h), sh = Math.sin(c.h); return Math.max(-1, Math.min(1, Math.atan2(-dx * sh + dz * ch, dx * ch + dz * sh) * gain)); };
  G.director.input = (dt) => {
    const i = base(dt), c = G.car;
    if (D.pursuit) i.steer = toward(c, -5.25, c.z + Math.max(14, c.speed * 0.7), 1.6);
    if (!D.hunt || c.z < -40) return i;
    let best = null, bd = 1e9;
    for (const v of G.traffic.vehicles) {
      if (!/truck|bus|tanker/.test(v.type)) continue;
      const b = v.body.car, dx = b.x - c.x, dz = b.z - c.z, d = Math.hypot(dx, dz);
      if (d < bd && dx * Math.cos(c.h) + dz * Math.sin(c.h) > 4) { bd = d; best = b; }
    }
    if (!best) return i;
    return Object.assign(i, { steer: toward(c, best.x, best.z, 2) });
  };
  return true;
}
const destrGame = Object.assign({}, Destr.game, { director: composed(Destr.game.director, destrExtras) });
// a run on another junction: a short countdown, the run, the ramp in slow motion, the impact, the
// pile-up (the Crashbreaker when it's ready), the tally
const destrRun = (hunt) => async (t) => {
  await t.page(`DestructionGame.start(4); __d.hunt = ${!!hunt}; __d.pursuit = true;`);
  await t.frames(2, null, null, { waitCrash: false });
  await t.frames(400, { start: DC.start, startHigh: DC.startHigh }, null, { until: `DestructionGame.state === 'run'` });
  await t.frames(600, { startHigh: DC.startHigh, chase: DC.chase, front: DC.front, sideR: DC.sideR, heli: DC.heli }, null, { until: `DestructionGame.car.z > -85 || DestructionGame.state !== 'run'` });
  t.mark('ramp');
  await t.frames(600, { rampSide: DC.rampSide, rampUnder: DC.rampUnder, front: Object.assign({}, DC.front, { d: 11, y: 2 }), chase: DC.chase, heli: DC.heli }, null, { dt: DT / 4, until: `DestructionGame.state !== 'run' || DestructionGame.car.z > -20` });
  await t.frames(600, { front: Object.assign({}, DC.front, { d: 11, y: 2 }), chase: DC.chase, heli: DC.heli, sideR: DC.sideR }, null, { until: `DestructionGame.state !== 'run'` });
  await t.frames(400, { orbitA: DC.orbitA, orbitB: DC.orbitB, wreck: DC.wreck }, null, { until: `DestructionGame.state !== 'impact'` });
  const cb = `{ const s = __d.status(); if (s.cbReady && !__d.cbDone) { __d.cbDone = true; window.dispatchEvent(new KeyboardEvent('keydown', { code: 'ShiftLeft' })); } else if (__d.cbDone && !__d.cbUp) { __d.cbUp = true; window.dispatchEvent(new KeyboardEvent('keyup', { code: 'ShiftLeft' })); } }`;
  await t.frames(900, { pileLow: DC.pileLow, pileHigh: DC.pileHigh, wreck2: DC.wreck2, crane: DC.crane }, cb, { until: `DestructionGame.state !== 'pileup'` });
  await t.frames(240, { tally: DC.tally });
};
const DESTR = {
  dgold: { query: 'director&car=lexus' + GPU, run: Destr.game.takes.gold.run },
  ddocks: { query: 'director&car=mustang&level=docklands' + GPU, run: destrRun(false) },
  dboulevard: { query: 'director&car=type87&level=boulevard' + GPU, run: destrRun(true) },
};

// the crash lab: the simulator's runs (tools/trailer.js records them, filmed square), shots laid end to
// end on their own timeline; SIMF[id]: where shot id starts on it
const scam = (anchor, a, d, h, o = {}) => Object.assign({ anchor, a, d, h, ahead: 0, lift: 0.5, fov: 40 }, o);
const ONBOARD = { onboard: true, fov: 58 };
const slow = (s) => [[0, s], [1e9, s]];
const SIM_SHOTS = [], SIMF = {};
const simShot = (id, o) => { const f = SIM_SHOTS.reduce((a, s) => a + s.n, 0); SIMF[id] = f; SIM_SHOTS.push(Object.assign({ f }, o)); };
simShot('bApproach', { kind: 'approach', scene: 'barrier', n: 40, end: 0, cam: { anchor: 'world', pos: [-0.9, 0.42, -2.0], look: [-18, 0.7, 0.2], fov: 50 } });
simShot('bHit', { kind: 'replay', scene: 'barrier', from: 0, n: 110, speed: [[0, 0.06], [6, 0.025], [110, 0.03]], cam: scam('start', [-104, -112], [5.6, 4.8], [1.0, 0.95], { ahead: 0.9, lift: 0.6, fov: 42 }) });
simShot('bOnboard', { kind: 'replay', scene: 'barrier', from: 24, n: 90, speed: slow(0.01), cam: ONBOARD });
simShot('bGlass', { kind: 'replay', scene: 'barrier', from: 30, n: 80, speed: slow(0.014), cam: scam('start', [-96, -102], [3.4, 3.0], [1.5, 1.45], { ahead: 0.2, lift: 1.05, fov: 42 }) });
simShot('oApproach', { kind: 'approach', scene: 'overlap', n: 24, end: 0, cam: { anchor: 'world', pos: [-1.6, 0.45, -1.5], look: [-18, 0.7, -0.4], fov: 52 } });
simShot('oHit', { kind: 'replay', scene: 'overlap', from: 0, n: 90, speed: [[0, 0.05], [30, 0.04], [90, 0.25]], cam: scam('start', [28, 38], [5.6, 4.8], [1.4, 1.5], { ahead: 1.6, lift: 0.5, fov: 42 }) });
simShot('tApproach', { kind: 'approach', scene: 'twocar', n: 30, end: 0, cam: scam('mid', [-86, -82], [7.5, 7.0], [0.5, 0.5], { lift: 0.55, fov: 58 }) });
simShot('tHit', { kind: 'replay', scene: 'twocar', from: 0, n: 110, speed: [[0, 0.04], [60, 0.03], [110, 0.25]], cam: scam('mid', [-80, -96], [7.0, 5.8], [0.9, 1.0], { lift: 0.6, fov: 40 }) });
simShot('tSlow', { kind: 'replay', scene: 'twocar', from: 8, n: 70, speed: slow(0.012), cam: scam('mid', [-60, -68], [4.8, 4.2], [2.5, 2.3], { lift: 0.5, fov: 38 }) });
simShot('sApproach', { kind: 'approach', scene: 'side', n: 20, end: 0, cam: scam('car', [-120, -124], [4.2, 4.0], [0.8, 0.8], { lift: 0.8, fov: 52 }) });
simShot('sHit', { kind: 'replay', scene: 'side', from: 0, n: 80, speed: [[0, 0.05], [40, 0.04], [80, 0.12]], cam: scam('start', [-140, -148], [6.0, 5.4], [1.5, 1.4], { lift: 0.8, fov: 42 }) });
simShot('xray', { kind: 'replay', scene: 'restraint', from: 12, n: 90, speed: slow(0.035), xray: true, cam: scam('start', [-96, -86], [3.3, 2.9], [0.9, 1.0], { ahead: 0.4, lift: 0.9, fov: 40 }) });
simShot('wHit', { kind: 'replay', scene: 'brick', from: 0, n: 100, speed: [[0, 0.06], [20, 0.06], [100, 0.22]], cam: scam('start', [-28, -38], [7.2, 6.4], [1.1, 1.0], { ahead: 1.0, lift: 0.9, fov: 44 }) });
simShot('wSide', { kind: 'replay', scene: 'brick', from: 90, n: 70, speed: [[0, 0.12], [70, 0.3]], cam: scam('start', [-112, -122], [7.4, 7.0], [1.6, 1.8], { ahead: 1.2, lift: 0.8, fov: 44 }) });
simShot('wWide', { kind: 'replay', scene: 'brick', from: 330, n: 80, speed: [[0, 0.4], [80, 0.6]], cam: scam('start', [-40, -14], [9.0, 11], [2.6, 3.6], { ahead: 1.5, lift: 0.6, fov: 44 }) });
simShot('fire', { kind: 'after', scene: 'barrier', after: 7, n: 80, cam: scam('start', [-150, -134], [6.8, 6.0], [1.1, 1.0], { ahead: 1.6, lift: 0.9, fov: 42 }) });
simShot('mBarrier', { kind: 'replay', scene: 'barrier', from: 0, n: 30, speed: slow(0.05), cam: scam('start', [-96, -100], [4.6, 4.3], [0.8, 0.8], { ahead: 0.9, lift: 0.6, fov: 44 }) });
simShot('mTwocar', { kind: 'replay', scene: 'twocar', from: 0, n: 30, speed: slow(0.06), cam: scam('mid', [-118, -124], [5.6, 5.2], [0.7, 0.7], { lift: 0.6, fov: 44 }) });
simShot('mBrick', { kind: 'replay', scene: 'brick', from: 45, n: 30, speed: slow(0.15), cam: scam('start', [-20, -24], [6.2, 5.8], [0.9, 0.9], { ahead: 1.0, lift: 1.0, fov: 46 }) });
simShot('mSide', { kind: 'replay', scene: 'side', from: 0, n: 30, speed: slow(0.06), cam: scam('start', [-150, -154], [4.8, 4.6], [1.1, 1.1], { lift: 0.8, fov: 46 }) });
simShot('mOverlap', { kind: 'replay', scene: 'overlap', from: 0, n: 30, speed: slow(0.06), cam: scam('start', [20, 26], [4.6, 4.4], [1.0, 1.0], { ahead: 1.8, lift: 0.5, fov: 46 }) });
simShot('mStrain', { kind: 'replay', scene: 'barrier', from: 90, n: 30, speed: slow(0.05), strain: true, cam: scam('start', [-110, -112], [6.0, 5.8], [1.6, 1.6], { ahead: 0.9, lift: 0.6 }) });
simShot('end', { kind: 'replay', scene: 'brick', from: 60, n: 200, speed: slow(0.03), cam: scam('start', [-24, -36], [7.0, 6.0], [1.2, 1.1], { ahead: 1.0, lift: 1.0, fov: 44 }) });
const SIM_TOTAL = SIM_SHOTS.reduce((a, s) => a + s.n, 0);

// pages filmed in 16:9 (1280 x 720 CSS px at 1.5x), frame by frame on the virtual clock
const WIDE = { w: 1280, h: 720 };
const ease = (k) => k * k * (3 - 2 * k);
const PAGES = {
  // the home page: the hero, then down through the tests, the game modes and the garage
  whome: {
    file: 'home.html', ready: `document.readyState === 'complete' && document.fonts.status === 'loaded'`,
    async frames(b, shoot) {
      await b.ev(`document.documentElement.style.scrollBehavior = 'auto'; document.querySelectorAll('video').forEach((v) => { v.muted = true; v.play && v.play().catch(() => {}); })`);
      await sleep(1500);
      const to = await b.ev(`(() => { const g = document.querySelector('#garage'); return g ? g.offsetTop + g.offsetHeight - innerHeight * 0.9 : 3000; })()`);
      const sims = await b.ev(`document.querySelector('#simulations').offsetTop - 40`);
      for (let i = 0; i < 90; i++) { await shoot(`scrollTo(0, 0)`, i === 0 ? 'hero' : null); await sleep(25); }
      for (let i = 0; i < 60; i++) await shoot(`scrollTo(0, ${sims} * ${ease(i / 59)})`, i === 0 ? 'down' : null);
      for (let i = 0; i < 150; i++) await shoot(`scrollTo(0, ${sims} + (${to} - ${sims}) * ${i / 149})`, i === 0 ? 'cards' : null);
    },
  },
  // the physics write-up: the equations and diagrams
  wphysics: {
    file: 'physics.html', ready: `document.readyState === 'complete' && document.fonts.status === 'loaded' && document.querySelectorAll('.katex').length > 20`,   // (the equations; the diagrams are further up)
    async frames(b, shoot) {
      const at = await b.ev(`(() => { const k = [...document.querySelectorAll('.katex-display')]; const e = k[Math.min(6, k.length - 1)]; return e ? e.getBoundingClientRect().top + scrollY - 160 : 2000; })()`);
      for (let i = 0; i < 200; i++) await shoot(`scrollTo(0, ${at} + ${i} * 9)`, i === 0 ? 'start' : null);
    },
  },
};

// the Race select screen: the twelve vehicles, one after another (each filmed once its model is in)
async function filmGarage(b, { url, dir, log }) {
  await b.send('Emulation.setDeviceMetricsOverride', { width: WIDE.w, height: WIDE.h, deviceScaleFactor: 1.5, mobile: false });
  await b.send('Page.navigate', { url });
  const ready = `typeof RaceGame === 'object' && document.querySelector('#loading').hidden && RaceGame.state === 'select' && !document.querySelector('#btn-start').disabled`;
  for (let i = 0; i < 600; i++) { await sleep(200); try { if (await b.ev(ready)) break; } catch { /* loading */ } }
  // no credits in the picture (they're on the website)
  await b.ev(`(() => { const c = document.createElement('style'); c.textContent = '.credits, #music-now { display: none !important; }'; document.head.appendChild(c); })()`);
  const ev = { list: [], frames: 0, captured: { main: [] }, status: [] };
  const out = path.join(dir, 'wgarage', 'main');
  fs.mkdirSync(out, { recursive: true });
  const keys = await b.ev(`[...document.querySelectorAll('.sel-lineup [data-key], .sel-lineup button')].length`);
  for (let v = 0; v < 12; v++) {
    if (v) {
      await b.send('Input.dispatchKeyEvent', { type: 'keyDown', key: 'ArrowRight', code: 'ArrowRight', windowsVirtualKeyCode: 39 });
      await b.ev(`__vstep(${DT})`);
      await b.send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'ArrowRight', code: 'ArrowRight', windowsVirtualKeyCode: 39 });
      for (let i = 0; i < 300; i++) { await b.ev(`__vstep(${DT})`); await sleep(40); if (await b.ev(ready)) break; }
      for (let i = 0; i < 6; i++) await b.ev(`__vstep(${DT})`);
    }
    ev.list.push({ type: 'car' + v, n: ev.frames, text: await b.ev('RaceGame.carKey') });
    for (let i = 0; i < 30; i++) {
      await b.ev(`__vstep(${DT})`);
      fs.writeFileSync(path.join(out, String(ev.frames).padStart(5, '0') + '.jpg'), await b.shot(92));
      ev.captured.main.push(ev.frames); ev.status.push({}); ev.frames++;
    }
  }
  log(`wgarage: ${ev.frames} frames (${ev.list.map((e) => e.text).join(', ')}; lineup ${keys})`);
  return ev;
}

// ---------------------------------------------------------------- the edit
// at(bar, beat): the trailer frame of that beat (fractions between beats interpolated)
function makeEdit(tl) {
  const B = tl.beats;
  const tAt = (bar, beat = 0) => { const x = bar * 4 + beat, i = Math.floor(x), u = x - i; return i + 1 < B.length ? B[i] + (B[i + 1] - B[i]) * u : B[B.length - 1] + (x - (B.length - 1)) * (60 / GRID.bpm); };
  const at = (bar, beat = 0) => Math.round(tAt(bar, beat) * FPS);
  const E = [];
  // a shot from beat (bar, beat) to (bar2, beat2)
  const shot = (b0, k0, b1, k1, o) => { const f = b0 || k0 ? at(b0, k0) : 0; E.push(Object.assign({ f, n: at(b1, k1) - f }, o)); };
  const src = (take, cam, ref, off, rate) => ({ take, cam, ref, off, rate });
  const sim = (id, off = 0) => src('sim', 'main', 'abs', SIMF[id] + off);

  // intro (bars 0-4): the website, glimpses, the title on bar 5
  shot(0, 0, 2, 0, { src: src('whome', 'main', 'hero', 0), web: true });
  shot(2, 0, 3, 0, { src: src('whome', 'main', 'cards', 10), web: true, lower: ['A crash lab and two games', 'Eight crash tests · Race · Destruction'] });
  shot(3, 0, 3, 1, { src: src('rstart', 'gridHigh', 'go', 1), hit: 'go', snd: [['rev', 0]] });
  shot(3, 1, 3, 2, { src: sim('mBarrier', 2), hit: 'glass', snd: [['crash', 0, 1]] });
  shot(3, 2, 3, 3, { src: src('dgold', 'pileLow', 'pileup', 1), hit: 'boom', snd: [['boom', 0, 0.8]] });
  shot(3, 3, 4, 0, { src: src('rtakedown', 'game', 'tdcam', 30), hit: 'crash', snd: [['crash', 0, 0.8]] });
  shot(4, 0, 4, 2, { card: { tag: 'Crash lab · Race · Destruction', title: 'One <em>physics</em> engine' }, sfx: 'card' });
  // the barrier rushing in, contact on the verse's downbeat
  shot(4, 2, 5, 0, { src: sim('bApproach', 40 - (at(5) - at(4, 2))), card: { title: 'Every crash <em>computed</em>', over: true }, sfx: 'whoosh' });

  // verse (bars 5-12): the crash lab, on the WebGPU solver
  shot(5, 0, 6, 0, { src: sim('bHit'), hit: 'glass', hud: true, dim: 0.3, snd: [['crash', 0, 1], ['glass', 2, 1], ['tear', 12, 0.7]], card: { kind: 'title', title: 'The crash lab', tag: 'Real crash physics · WebGPU' } });
  shot(6, 0, 7, 0, { src: sim('bOnboard'), hud: true, lower: ['150 km/h · rigid barrier', 'Lexus RX 350 · the WebGPU solver'] });
  shot(7, 0, 7, 1, { src: sim('oApproach', 24 - (at(7, 1) - at(7))) });
  shot(7, 1, 8, 0, { src: sim('oHit'), hit: 'impact', hud: true, snd: [['crash', 0, 0.8], ['tear', 8, 0.6]], lower: ['Small overlap · 80 km/h', 'The wheel is driven back into the footwell'] });
  shot(8, 0, 8, 1, { src: sim('tApproach', 30 - (at(8, 1) - at(8))) });
  shot(8, 1, 9, 2, { src: sim('tHit'), hit: 'glass', hud: true, snd: [['crash', 0, 1], ['glass', 3, 0.9], ['tear', 14, 0.7]], lower: ['Head-on · 60 + 60 mph', 'Mustang GT500 against Lexus RX 350'] });
  shot(9, 2, 9, 3, { src: sim('sApproach', 20 - (at(9, 3) - at(9, 2))) });
  shot(9, 3, 10, 2, { src: sim('sHit'), hit: 'glass', hud: true, snd: [['crash', 0, 0.8], ['glass', 2, 0.7]], lower: ['Side impact · 60 km/h', 'A 1,900 kg barrier into the B-pillar'] });
  shot(10, 2, 11, 2, { src: sim('xray'), hud: true, lower: ['X-ray', 'The belt, the airbag and the dummy inside the crash'] });
  shot(11, 2, 12, 0, { src: sim('bGlass'), hud: true, card: { tag: 'Bullet-time', title: 'Every <em>millisecond</em>', over: true } });
  shot(12, 0, 13, 0, { src: sim('wHit'), hit: 'glass', hud: true, snd: [['crash', 0, 1], ['glass', 1, 1], ['scatter', 4, 1]], lower: ['Brick wall · 120 km/h', '366 mortared bricks'] });
  // bar 13: the wall comes down; the games
  shot(13, 0, 14, 0, { src: sim('wWide'), card: { tag: 'Then get behind the wheel', title: 'Two <em>game</em> modes', over: true }, sfx: 'whoosh' });

  // breakdown (bars 14-16): Race, the grid, the countdown on the last beats
  shot(14, 0, 15, 0, { src: src('rjump', 'chase', 'air', -92), card: { tag: 'Mode one', title: 'Race' }, sfx: 'card', snd: [['engine', 0, 'trx', 1.2]] });
  shot(15, 0, 16, 0, { src: src('rstart', 'gridHigh', 'go', -105), lower: ['Eight cars · three tracks', 'Traffic both ways'] });
  shot(16, 0, 16, 1, { src: src('rstart', 'gridLow', 'go', -84), big: '3', bigKind: 'count', bigFor: 16, snd: [['count', 0]] });
  shot(16, 1, 16, 2, { src: src('rstart', 'gantry', 'go', -54), big: '2', bigKind: 'count', bigFor: 16, snd: [['count', 0]] });
  shot(16, 2, 16, 3, { src: src('rstart', 'gridLow', 'go', -24), big: '1', bigKind: 'count', bigFor: 16, snd: [['count', 0]] });
  shot(16, 3, 17, 0, { src: src('rstart', 'gantry', 'go', -10), snd: [['rev', 0]] });

  // chorus 1 (bars 17-33): Race
  const DOWNTOWN = ['Downtown at dusk', 'Nissan GT-R Nismo'];
  shot(17, 0, 18, 0, { src: src('rstart', 'gridHigh', 'go', 1), hit: 'go', big: 'Go!', snd: [['go', 0], ['engine', 0, 'gtr', 1.1]] });
  shot(18, 0, 19, 0, { src: src('rstart', 'gantry', 'go', 40), speed: true, lower: DOWNTOWN, snd: [['engine', 0, 'gtr', 1.25]] });
  shot(19, 0, 20, 0, { src: src('rstart', 'rampLow', 'air', -30), snd: [['engine', 0, 'gtr', 1.3], ['passby', 24]] });
  shot(20, 0, 21, 0, { src: src('rstart', 'heli', 'air', 30), speed: true, snd: [['engine', 0, 'gtr', 1.3]] });
  shot(21, 0, 22, 0, { src: src('rnight', 'heli', 'run', 10), speed: true, wipe: true, lower: ['Harbour at night', 'Ferrari SF90 Stradale'], snd: [['engine', 0, 'sf90', 1.4]] });
  shot(22, 0, 23, 0, { src: src('rnight', 'front', 'nearmiss', -30), speed: true, snd: [['engine', 0, 'sf90', 1.4], ['passby', 30]], big: 'Near miss', bigKind: 'red', bigAt: 30, bigFor: 26 });
  shot(23, 0, 24, 0, { src: src('rnight', 'sideR', 'nearmiss', 0), speed: true, snd: [['engine', 0, 'sf90', 1.4], ['passby', 0], ['passby', 35]] });
  // the jump, in slow motion
  shot(24, 0, 24, 2, { src: src('rjump', 'chase', 'air', -40), speed: true, snd: [['engine', 0, 'trx', 1.3]] });
  shot(24, 2, 25, 2, { src: src('rjump', 'rampLow', 'air', -8), slow: true, hit: 'go', hitV: 0.6, lower: ['Jumps', 'Ram 1500 TRX · no grip in the air'], snd: [['engine', 0, 'trx', 0.8]] });
  shot(25, 2, 26, 0, { src: src('rjump', 'rampAhead', 'land', -16), slow: true, hit: 'go', hitAt: 16, hitV: 0.5, snd: [['thud', 16, 1]] });
  // the takedown: alongside, the shove, the rival's crash on its own camera
  shot(26, 0, 27, 0, { src: src('rtakedown', 'sideL', 'tdcam', -34), speed: true, snd: [['engine', 0, 'supra', 1.2], ['hit', 20, 0.8]] });
  shot(27, 0, 28, 0, { src: src('rtakedown', 'game', 'tdcam', 0), hit: 'crash', big: 'Takedown', bigKind: 'td', bigFor: 30, snd: [['crash', 0, 1], ['glass', 2, 0.8], ['tear', 10, 0.8]] });
  shot(28, 0, 28, 2, { src: src('rtakedown', 'td', 'tdcam', 28), lower: ['Takedowns', 'The rival crashes on the full solver'], snd: [['scatter', 0, 1]] });
  shot(28, 2, 29, 0, { src: src('rtakedown', 'heli', 'tdcam', 62), snd: [['thud', 4, 1]] });
  // the motorcycle at night, into an oncoming car
  shot(29, 0, 29, 2, { src: src('rbike', 'front', 'crash', -70), speed: true, lower: ['Ducati Hypermotard', 'Twelve vehicles, two wheels to six'], snd: [['engine', 0, 'ducati', 1.5]] });
  shot(29, 2, 30, 0, { src: src('rbike', 'orbit', 'crash', 0), hit: 'crash', snd: [['crashBike', 0], ['crash', 0, 0.7]] });
  // the armoured car shoving the traffic
  shot(30, 0, 31, 0, { src: src('rtank', 'front', 'run', 40), lower: ['Hillside at noon', 'Type 87 · 15 tonnes'], snd: [['engine', 0, 'type87', 1.0]] });
  // the head-on on the GPU solver
  shot(31, 0, 31, 2, { src: src('rheadon', 'sideR', 'crash', -26), speed: true, snd: [['engine', 0, 'crownvic', 1.35]] });
  shot(31, 2, 32, 2, { src: src('rheadon', 'orbit', 'crash', 0), hit: 'crash', impact: true, snd: [['crash', 0, 1], ['glass', 2, 1], ['tear', 10, 0.8], ['blowout', 18, 0.7]], lower: ['Head-on · police interceptor', 'The full crash solver on WebGPU'] });
  shot(32, 2, 34, 0, { src: src('rheadon', 'orbitHigh', 'crash', 24), impact: true, snd: [['scatter', 0, 1]] });

  // break (bars 34-36): the garage, one vehicle a beat
  for (let v = 0; v < 12; v++) shot(34 + Math.floor(v / 4), v % 4, 34 + Math.floor((v + 1) / 4), (v + 1) % 4, { src: src('wgarage', 'main', 'car' + v, 8), web: true, snd: [['ui', 0]] });

  // chorus 2 (bars 37-46): Destruction
  const SCORE = { score: true };
  shot(37, 0, 38, 0, { src: src('dgold', 'flyTop', 'abs', 150), card: { tag: 'Mode two', title: 'Destruction' }, sfx: 'whoosh' });
  shot(38, 0, 39, 0, { src: src('dgold', 'startHigh', 'go', 0), hit: 'go', speed: true, lower: ['Crossroads at dusk', 'Wreck all you can'], snd: [['go', 0], ['engine', 0, 'lexus', 1.3]] });
  shot(39, 0, 40, 0, { src: src('dgold', 'rampSide', 'air', -24), slow: true, big: '×4', bigKind: 'mult', bigAt: 30, bigFor: 18, snd: [['engine', 0, 'lexus', 0.8], ['cash', 30]] });
  shot(40, 0, 41, 0, { src: src('dgold', 'orbitB', 'crash', 1), hit: 'crash', impact: true, ...SCORE, snd: [['crash', 0, 1], ['glass', 2, 1], ['tear', 9, 0.8]] });
  shot(41, 0, 41, 2, { src: src('dgold', 'wreck', 'boom', -34), ...SCORE });
  shot(41, 2, 42, 0, { src: src('dgold', 'pileHigh', 'pileup', 1), hit: 'boom', big: 'Boom', bigKind: 'boom', bigFor: 14, ...SCORE, snd: [['boom', 0, 1.2]] });
  shot(42, 0, 43, 0, { src: src('dgold', 'pileLow', 'cbReady', 1), hit: 'boom', big: 'Crashbreaker', bigKind: 'red', bigFor: 30, ...SCORE, snd: [['boom', 0, 1]], lower: null });
  shot(43, 0, 43, 2, { src: src('ddocks', 'orbitA', 'crash', 1), hit: 'crash', impact: true, lower: ['Docklands at night', 'Ford Mustang GT500'], snd: [['crash', 0, 1], ['glass', 2, 0.8]] });
  shot(43, 2, 44, 0, { src: src('ddocks', 'pileHigh', 'pileup', 30), ...SCORE });
  shot(44, 0, 45, 0, { src: src('ddocks', 'wreck2', 'pileup', 1), hit: 'boom', ...SCORE, snd: [['boom', 0, 1]] });
  shot(45, 0, 46, 0, { src: src('dboulevard', 'orbitA', 'crash', 1), hit: 'crash', impact: true, lower: ['Boulevard at noon', 'Type 87 into the traffic'], snd: [['crash', 0, 1], ['tear', 6, 0.8]] });
  shot(46, 0, 47, 0, { src: src('dgold', 'tally', 'tally', 60), tally: true, hit: 'boom', hitAt: 24, big: 'Gold', bigKind: 'gold', bigAt: 24, bigFor: 40, snd: [['medal', 24]] });

  // break (bars 47-48): the physics write-up
  shot(47, 0, 49, 0, { src: src('wphysics', 'main', 'start', 0), web: true, lower: ['The physics', 'Every model and equation, written up'], sfx: 'whoosh' });

  // last chorus (bars 49-56): everything again, faster
  const M1 = [
    [src('rheadon', 'orbitLow', 'crash', 2), 'crash'], [src('dgold', 'pileLow', 'pileup', 8), 'boom'],
    [sim('tSlow'), 'crash'], [src('rjump', 'under', 'air', 30), 'go'],
    [src('rtakedown', 'tdLow', 'tdcam', 10), 'crash'], [src('ddocks', 'pileLow', 'cbReady', 1), 'boom'],
    [sim('wSide'), 'crash'], [src('rnight', 'front', 'nearmiss', -6), null],
  ];
  M1.forEach(([s, h], i) => shot(49 + Math.floor(i / 2), (i % 2) * 2, 49 + Math.floor((i + 1) / 2), ((i + 1) % 2) * 2, { src: s, hit: h, hitV: 0.7, snd: h === 'boom' ? [['boom', 0, 0.8]] : h === 'crash' ? [['crash', 0, 0.8]] : h === 'go' ? [['rev', 0]] : [['passby', 4]] }));
  const M2 = [
    [src('dboulevard', 'orbitB', 'crash', 10), 'crash'], [sim('mTwocar'), 'crash'], [src('rbike', 'orbitHigh', 'crash', 8), 'crash'], [src('dgold', 'orbitA', 'crash', 4), 'crash'],
    [src('rstart', 'gridHigh', 'go', 2), 'go'], [sim('mSide'), 'crash'], [src('ddocks', 'wreck', 'crash', 20), 'crash'], [sim('fire', 20), null],
  ];
  M2.forEach(([s, h], i) => shot(53 + Math.floor(i / 4), i % 4, 53 + Math.floor((i + 1) / 4), (i + 1) % 4, { src: s, hit: h, hitV: 0.55, snd: h === 'crash' ? [['crash', 0, 0.6]] : h === 'go' ? [['rev', 0]] : [] }));
  const M3 = [
    [sim('mBrick')], [src('rheadon', 'orbit', 'crash', 6)], [src('dgold', 'orbitB', 'crash', 6)], [src('rjump', 'rampLow', 'air', 4)],
    [sim('mOverlap')], [src('rtakedown', 'td', 'tdcam', 20)], [src('ddocks', 'orbitA', 'crash', 4)], [sim('mStrain')],
  ];
  M3.forEach(([s], i) => shot(55 + Math.floor(i / 8), (i % 8) / 2, 55 + Math.floor((i + 1) / 8), ((i + 1) % 8) / 2, { src: s, hit: i % 2 ? null : 'impact', hitV: 0.45, snd: i % 2 ? [] : [['crash', 0, 0.45]] }));
  // the title over the last bars and the song's end
  const end = tl.total, f56 = at(56);
  E.push({ f: f56, n: end - f56, src: sim('end'), dim: 0.62, hit: 'boom', hitV: 0.8, snd: [['boom', 0, 0.6]] });
  const TITLES = [
    [f56, { kind: 'title', title: 'Car Crash Simulation', tag: 'Crash lab · Race · Destruction' }, 'title'],
    [at(57, 2), { kind: 'title', title: 'Car Crash Simulation', tag: 'Play free in your browser', cta: 'Play now' }, 'title'],
  ];
  // the sounds' frames (shot frame + offset), for the mix
  return { E, TITLES, total: end, at };
}

// the thumbnail's picture
const THUMB = { take: 'rtakedown', cam: 'game', ref: 'tdcam', off: 28 };
// the overlay's game parts: speeds, impact readouts, the damage total, the web pages without the grade
const MEDALS = { dgold: { bronze: 300000, silver: 1000000, gold: 3000000 }, ddocks: { bronze: 500000, silver: 1500000, gold: 4000000 }, dboulevard: { bronze: 250000, silver: 800000, gold: 1500000 } };
function extra(o, s, f, src, age) {
  if (s.web) { o.grade = false; o.logo = false; o.nobars = true; }
  if (!src) return;
  const st = src.status || {};
  if (src.take === 'sim') {
    if (s.hud && !s.card && st.ms !== undefined) { const sp = st.speed || 1; o.impact = { text: 'T ' + (st.ms < 0 ? '−' : '+') + Math.abs(st.ms).toFixed(1).padStart(6, '0') + ' MS', label: sp >= 1 ? sp.toFixed(0) + '× SPEED' : '1/' + Math.round(1 / sp) + '× SPEED' }; }
    return;
  }
  if (s.speed && st.kmh > 5) o.speed = st.kmh;
  if (s.impact) o.impact = { kmh: st.crash ? st.crash.kmh : st.impactKmh || 0, label: 'WEBGPU CRASH SOLVER' };
  const m = MEDALS[src.take];
  if (m && s.score) o.score = Object.assign({ total: st.total, mult: st.mult, label: `${st.wrecked} WRECKED · ${st.booms} EXPLOSIONS` }, m);
  if (m && s.tally) { const k = Math.min(1, age / 36), e = 1 - Math.pow(1 - k, 3); o.score = Object.assign({ total: Math.round(st.total * e), mult: st.mult, label: 'TOTAL DAMAGE' }, m); }
}

// ---------------------------------------------------------------- the sound
// The plan, in trailer seconds: the song's pieces; the game's sounds (js/fx.js, rendered offline on the
// trailer's clock); the recorded engines under the driving shots; whooshes on wipes and cards; the
// music ducked a little under the big hits.
function soundPlan(edit, tl) {
  const fx = [], engines = [], whoosh = [], ducks = [];
  const t = (f) => f / FPS;
  for (const s of edit.E) {
    const t0 = t(s.f), t1 = t(s.f + s.n);
    for (const [kind, off, a, b] of s.snd || []) {
      const at = t0 + (off || 0) / FPS;
      if (kind === 'engine') { engines.push({ t0, t1, key: a, rate: b }); continue; }
      fx.push({ t: at, kind, v: a === undefined ? 1 : a });
      if (kind === 'crash' || kind === 'boom') ducks.push({ t: at, v: a === undefined ? 1 : a });
    }
    if (s.wipe || s.sfx === 'whoosh') whoosh.push({ t: t0 - 0.12, dur: 0.4 });
    if (s.sfx === 'card') fx.push({ t: t0, kind: 'card', v: 1 });
  }
  for (const [f] of edit.TITLES) fx.push({ t: t(f), kind: 'card', v: 1 });
  return { song: SONG, pieces: tl.pieces, total: edit.total / FPS, fx, engines, whoosh, ducks };
}
// in the page (Race.html, for js/fx.js, the recorded clips and the vehicles' engine sounds): the mix
// -> window.__wav (16-bit stereo WAV), { seconds, peak, rmsDb }
function renderMix(plan) {
  return (async () => {
    const sr = 48000, N = Math.ceil(plan.total * sr);
    const b64ToBuf = async (b64, ctx) => ctx.decodeAudioData(Uint8Array.from(atob(b64), (c) => c.charCodeAt(0)).buffer);
    const dec = new OfflineAudioContext(2, sr, sr);
    // the song: fetched the way music.js does (media/music/<song>.js)
    if (!(window.MUSIC_DATA && window.MUSIC_DATA[plan.song])) await new Promise((res, rej) => { const s = document.createElement('script'); s.src = 'media/music/' + plan.song + '.js'; s.onload = res; s.onerror = rej; document.head.appendChild(s); });
    const song = await b64ToBuf(window.MUSIC_DATA[plan.song], dec);
    // the game's sounds, captured offline on the trailer's clock
    FX.initAudio(); FX.setEnabled(true); FX.setRecorded(true); FX.setTimeScale(1);
    for (let i = 0; i < 100 && FX.soundState.clips < 20; i++) await new Promise((r) => setTimeout(r, 100));
    if (!FX.beginCapture(plan.total)) throw new Error('no offline capture');
    const P = () => null;   // (the sounds straight to the speakers, not placed in the scene)
    for (const e of plan.fx.sort((a, b) => a.t - b.t)) {
      FX.captureClock(e.t);
      const v = e.v;
      switch (e.kind) {
        case 'crash': FX.crunch(Math.min(1, v), P()); FX.hit(8000 * v, P()); if (v > 0.6) FX.clank(18 * v, P()); break;
        case 'glass': FX.glass(1.2 * v, P()); FX.crack(v, P()); break;
        case 'tear': FX.tear(20 * v, P()); break;
        case 'blowout': FX.blowout(P()); break;
        case 'scatter': FX.scatter(8, P()); break;
        case 'thud': FX.thud(40 * v, P()); break;
        case 'hit': FX.hit(8000 * v, P()); break;
        case 'boom': FX.explosion(0.55 * v, P()); break;   // (the explosion is the game's loudest sound: under the music's level here)
        case 'count': FX.count(false); break;
        case 'go': FX.count(true); break;
        case 'passby': FX.passBy(null); break;
        case 'crashBike': FX.crashClip({ crash: 'crash-bike' }, null); break;
        case 'cash': FX.cash(true); break;
        case 'medal': FX.medal(3); break;
        case 'ui': FX.ui('move'); break;
        case 'card': FX.ui('ok'); break;
        case 'rev': break;   // (an engine rev: added below from the recordings)
      }
    }
    const fxBuf = await FX.endCapture();
    // (the check: how loud the game's sounds are just after each of their moments)
    const fxL = fxBuf.getChannelData(0), fxPeak = (t, d) => { let m = 0; for (let i = Math.floor(t * fxBuf.sampleRate), j = Math.min(fxL.length, i + Math.floor(d * fxBuf.sampleRate)); i < j; i++) m = Math.max(m, Math.abs(fxL[i])); return m; };
    const heard = plan.fx.filter((e) => e.kind !== 'rev').map((e) => ({ kind: e.kind, t: +e.t.toFixed(2), peak: +fxPeak(e.t, 0.4).toFixed(3) }));
    // and against the music there (before the master's compressor): the effect's RMS over 0.25 s
    // over the song's, in dB, by kind
    const songL = song.getChannelData(0), rmsOf = (a, sr, t0, t1) => { let s = 0, n = 0; for (let i = Math.max(0, Math.floor(t0 * sr)); i < Math.min(a.length, t1 * sr); i++) { s += a[i] * a[i]; n++; } return Math.sqrt(s / Math.max(1, n)); };
    const songAt = (t) => { const p = plan.pieces.find((q) => t >= q.at && t < q.at + q.s1 - q.s0) || plan.pieces[0]; return t - p.at + p.s0; };
    const vsMusic = {};
    for (const e of plan.fx) { if (e.kind === 'rev' || e.kind === 'card') continue; const f = rmsOf(fxL, fxBuf.sampleRate, e.t, e.t + 0.25) * (plan.fxGain || 1.7), m = rmsOf(songL, song.sampleRate, songAt(e.t), songAt(e.t) + 0.25) * (1 - 0.5 * Math.min(1, e.v || 1)); (vsMusic[e.kind] = vsMusic[e.kind] || []).push(20 * Math.log10(f / m)); }
    const ratio = Object.entries(vsMusic).map(([k, v]) => k + ' ' + (v.reduce((a, x) => a + x, 0) / v.length).toFixed(1)).join(', ');
    // the recorded engines (the garage's SOUND table, js/garage.js)
    const clipBuf = {};
    const clip = async (name) => clipBuf[name] || (clipBuf[name] = await b64ToBuf(window.SFX_DATA.clips[name], dec));
    const ctx = new OfflineAudioContext(2, N, sr);
    const master = ctx.createGain(); master.gain.value = 1;
    const comp = ctx.createDynamicsCompressor();
    comp.threshold.value = -8; comp.knee.value = 6; comp.ratio.value = 5; comp.attack.value = 0.003; comp.release.value = 0.15;
    master.connect(comp).connect(ctx.destination);
    // the song's pieces, crossfaded over 40 ms at each splice
    const music = ctx.createGain(); music.connect(master);
    const ML = plan.music === undefined ? 1 : plan.music;
    music.gain.value = ML;
    const XF = 0.04;
    plan.pieces.forEach((p, i) => {
      const s = ctx.createBufferSource(); s.buffer = song;
      const g = ctx.createGain(); s.connect(g).connect(music);
      const len = p.s1 - p.s0, first = i === 0, last = i === plan.pieces.length - 1;
      g.gain.setValueAtTime(first ? 1 : 0, p.at);
      if (!first) g.gain.linearRampToValueAtTime(1, p.at + XF);
      if (!last) { g.gain.setValueAtTime(1, p.at + len - 1e-4); g.gain.linearRampToValueAtTime(0, p.at + len + XF); }
      s.start(p.at, p.s0, len + (last ? 0 : XF));
    });
    // ducked a little under the big hits
    for (const d of plan.ducks) { music.gain.setTargetAtTime(ML * (1 - 0.5 * Math.min(1, d.v)), d.t - 0.01, 0.008); music.gain.setTargetAtTime(ML, d.t + 0.18, 0.3); }
    // the game's sounds
    const fxs = ctx.createBufferSource(); fxs.buffer = fxBuf; const fg = ctx.createGain(); fg.gain.value = plan.fxGain || 1.7; fxs.connect(fg).connect(master); fxs.start(0);
    // the engines: each vehicle's drive loop, at the shot's rate, faded in and out
    const SOUND = {}; for (const v of CrashGarage.LIST) SOUND[v.key] = v.sound;
    const EG = plan.engineGain || 0.8;
    for (const e of plan.engines) {
      const snd = SOUND[e.key]; if (!snd || !snd.drive) continue;
      const buf = await clip(snd.drive), lp = window.SFX_DATA.loops[snd.drive];
      const s = ctx.createBufferSource(); s.buffer = buf; s.loop = true; s.loopStart = lp[0]; s.loopEnd = lp[0] + lp[1];
      s.playbackRate.value = Math.max(0.5, Math.min(2.2, e.rate * (snd.pitch || 1)));
      const g = ctx.createGain(); g.gain.setValueAtTime(0, e.t0); g.gain.linearRampToValueAtTime(EG, e.t0 + 0.05); g.gain.setValueAtTime(EG, Math.max(e.t0 + 0.05, e.t1 - 0.06)); g.gain.linearRampToValueAtTime(0, e.t1);
      s.connect(g).connect(master); s.start(e.t0, lp[0]); s.stop(e.t1 + 0.01);
    }
    // engine revs: the vehicle's start or rev clip
    for (const e of plan.fx.filter((x) => x.kind === 'rev')) {
      const buf = await clip('rev-v8'); const s = ctx.createBufferSource(); s.buffer = buf; const g = ctx.createGain(); g.gain.value = 1.2; s.connect(g).connect(master); s.start(e.t);
    }
    // whooshes: filtered noise sweeping up then down
    const noise = ctx.createBuffer(1, sr, sr); { const d = noise.getChannelData(0); for (let i = 0; i < d.length; i++) d[i] = Math.random() * 2 - 1; }
    for (const w of plan.whoosh) {
      const s = ctx.createBufferSource(); s.buffer = noise; s.loop = true;
      const f = ctx.createBiquadFilter(); f.type = 'bandpass'; f.Q.value = 1.4;
      f.frequency.setValueAtTime(400, w.t); f.frequency.exponentialRampToValueAtTime(3800, w.t + w.dur * 0.7); f.frequency.exponentialRampToValueAtTime(1200, w.t + w.dur);
      const g = ctx.createGain(); g.gain.setValueAtTime(0.0001, w.t); g.gain.exponentialRampToValueAtTime(0.35, w.t + w.dur * 0.65); g.gain.exponentialRampToValueAtTime(0.0001, w.t + w.dur);
      s.connect(f).connect(g).connect(master); s.start(w.t); s.stop(w.t + w.dur + 0.02);
    }
    const engVs = [];
    for (const e of plan.engines) {
      const snd = SOUND[e.key]; if (!snd || !snd.drive) continue;
      const cb = clipBuf[snd.drive], lp = window.SFX_DATA.loops[snd.drive], c = rmsOf(cb.getChannelData(0), cb.sampleRate, lp[0], lp[0] + lp[1]) * EG;
      engVs.push(20 * Math.log10(c / rmsOf(songL, song.sampleRate, songAt(e.t0), songAt(e.t1))));
    }
    const engines = engVs.length ? (engVs.reduce((a, x) => a + x, 0) / engVs.length).toFixed(1) + ' (' + Math.min(...engVs).toFixed(1) + ' to ' + Math.max(...engVs).toFixed(1) + ')' : '-';
    const out = await ctx.startRendering();
    // the master: peaks at -1 dBFS
    const L = out.getChannelData(0), R = out.getChannelData(1);
    let peak = 0, sum = 0;
    for (let i = 0; i < N; i++) { peak = Math.max(peak, Math.abs(L[i]), Math.abs(R[i])); sum += L[i] * L[i] + R[i] * R[i]; }
    const k = Math.pow(10, -1 / 20) / Math.max(1e-6, peak);
    const wav = new DataView(new ArrayBuffer(44 + N * 4));
    const str = (o, s) => { for (let i = 0; i < s.length; i++) wav.setUint8(o + i, s.charCodeAt(i)); };
    str(0, 'RIFF'); wav.setUint32(4, 36 + N * 4, true); str(8, 'WAVE'); str(12, 'fmt '); wav.setUint32(16, 16, true); wav.setUint16(20, 1, true); wav.setUint16(22, 2, true);
    wav.setUint32(24, sr, true); wav.setUint32(28, sr * 4, true); wav.setUint16(32, 4, true); wav.setUint16(34, 16, true); str(36, 'data'); wav.setUint32(40, N * 4, true);
    for (let i = 0; i < N; i++) { wav.setInt16(44 + i * 4, Math.max(-32767, Math.min(32767, L[i] * k * 32767)), true); wav.setInt16(46 + i * 4, Math.max(-32767, Math.min(32767, R[i] * k * 32767)), true); }
    window.__wav = new Uint8Array(wav.buffer);
    // loudness per bar-ish window (for the check), dB
    const win = Math.round(sr * 2), levels = [];
    for (let i = 0; i + win <= N; i += win) { let s = 0; for (let j = i; j < i + win; j++) s += L[j] * L[j]; levels.push(Math.round(10 * Math.log10(s / win * k * k + 1e-12))); }
    return { seconds: plan.total, peak, rmsDb: 10 * Math.log10(sum / (2 * N) * k * k), levels, silent: heard.filter((h) => h.peak < 0.02), heard: heard.length, ratio, engines };
  })();
}

// ---------------------------------------------------------------- running it
// ctx: { openSimulator(q), fileUrl(name), encode(framesDir, out, quality, w, h, wav), arg(name), has(flag), log }
async function run(b, ctx) {
  const t0 = Date.now(), log = ctx.log;
  const work = path.resolve(ctx.arg('--work', path.join(__dirname, 'out', 'trailer')));
  const takesDir = path.join(work, 'takes');
  fs.mkdirSync(takesDir, { recursive: true });
  const evFile = (name) => path.join(work, 'events-' + name + '.json');
  const only = ctx.arg('--takes', null) ? ctx.arg('--takes').split(',') : null;
  const want = (name) => !ctx.has('--edit-only') && (!only || only.includes(name));
  const save = (name, ev) => fs.writeFileSync(evFile(name), JSON.stringify(ev));

  // the song's beats
  const anFile = path.join(work, 'song.json');
  if (!fs.existsSync(anFile) || ctx.has('--analyze')) {
    await b.send('Page.navigate', { url: ctx.fileUrl('Race.html') + '?music=0&touch=0' });
    for (let i = 0; i < 300 && !(await b.ev(`typeof FX === 'object'`).catch(() => false)); i++) await sleep(200);
    await b.ev(`new Promise((res, rej) => { const s = document.createElement('script'); s.src = 'media/music/${SONG}.js'; s.onload = res; s.onerror = rej; document.head.appendChild(s); })`);
    const an = await b.ev(`(${analyzeSong.toString()})(${JSON.stringify(SONG)}, ${JSON.stringify(GRID)})`);
    fs.writeFileSync(anFile, JSON.stringify(an));
    log(`song: ${an.duration.toFixed(2)} s, ${an.beats.length} beats, ${(an.snapped * 100).toFixed(0)}% snapped to a drum hit`);
  }
  const tl = timeline(JSON.parse(fs.readFileSync(anFile, 'utf8')));
  log(`timeline: the song cut to ${tl.songEnd.toFixed(2)} s, the trailer ${(tl.total / FPS).toFixed(2)} s (${tl.total} frames)`);

  // the takes
  for (const [name, take] of Object.entries(RACE)) if (want(name)) {
    fs.rmSync(path.join(takesDir, name), { recursive: true, force: true });
    save(name, (await K.recordTakes(b, Object.assign({}, raceGame, { takes: { [name]: take }, page: ctx.fileUrl('Race.html') }), { dir: takesDir, log }))[name]);
  }
  for (const [name, take] of Object.entries(DESTR)) if (want(name)) {
    fs.rmSync(path.join(takesDir, name), { recursive: true, force: true });
    save(name, (await K.recordTakes(b, Object.assign({}, destrGame, { takes: { [name]: take }, page: ctx.fileUrl('Destruction.html') }), { dir: takesDir, log }))[name]);
  }
  if (want('wgarage')) { fs.rmSync(path.join(takesDir, 'wgarage'), { recursive: true, force: true }); save('wgarage', await filmGarage(b, { url: ctx.fileUrl('Race.html') + '?touch=0&music=0&solver=gpu', dir: takesDir, log })); }
  for (const [name, P] of Object.entries(PAGES)) if (want(name)) {
    fs.rmSync(path.join(takesDir, name), { recursive: true, force: true });
    const ev = { list: [], frames: 0, captured: { main: [] }, status: [] }, out = path.join(takesDir, name, 'main');
    fs.mkdirSync(out, { recursive: true });
    await b.send('Emulation.setDeviceMetricsOverride', { width: WIDE.w, height: WIDE.h, deviceScaleFactor: 1.5, mobile: false });
    await b.send('Page.navigate', { url: ctx.fileUrl(P.file) });
    for (let i = 0; i < 600; i++) { await sleep(200); try { if (await b.ev(P.ready)) break; } catch { /* loading */ } }
    if (!(await b.ev(P.ready))) throw new Error(name + ': the page did not get ready');
    await sleep(1000);
    await P.frames(b, async (js, mark) => {
      await b.ev(`(() => { ${js}; window.__vstep && __vstep(${DT}); })()`);
      if (mark) ev.list.push({ type: mark, n: ev.frames });
      fs.writeFileSync(path.join(out, String(ev.frames).padStart(5, '0') + '.jpg'), await b.shot(92));
      ev.captured.main.push(ev.frames); ev.status.push({}); ev.frames++;
    });
    log(`${name}: ${ev.frames} frames`);
    save(name, ev);
  }
  if (want('sim')) {
    const main = path.join(takesDir, 'sim', 'main');
    fs.rmSync(main, { recursive: true, force: true }); fs.mkdirSync(main, { recursive: true });
    await b.send('Emulation.setDeviceMetricsOverride', { width: K.SQ, height: K.SQ, deviceScaleFactor: 1.5, mobile: false });
    const { status } = await Sim.record(b, { open: (q) => ctx.openSimulator(q), framesDir: main, log, square: true, shots: SIM_SHOTS, total: SIM_TOTAL });
    const captured = fs.readdirSync(main).filter((f) => f.endsWith('.jpg')).map((f) => parseInt(f, 10)).sort((x, y) => x - y);
    save('sim', { list: [], frames: SIM_TOTAL, captured: { main: captured }, status });
  }
  if (b.errors.length) throw new Error('page errors: ' + b.errors.join(' | '));
  if (ctx.has('--takes-only')) return;

  // the edit, checked against the takes
  const events = {};
  for (const f of fs.readdirSync(work)) { const m = /^events-(.+)\.json$/.exec(f); if (m) events[m[1]] = JSON.parse(fs.readFileSync(path.join(work, f), 'utf8')); }
  const edit = makeEdit(tl);
  if (!ctx.has('--sound-only')) K.check(edit, events);   // (the sound needs only the edit)
  log(`edit: ${edit.E.length} shots, ${edit.total} frames`);

  // the sound
  const wav = path.join(work, ctx.has('--no-music') ? 'soundtrack-nomusic.wav' : 'soundtrack.wav');
  if (!(ctx.has('--keep-sound') || ctx.has('--encode-only')) || !fs.existsSync(wav)) {
    await b.send('Emulation.setDeviceMetricsOverride', { width: 1280, height: 720, deviceScaleFactor: 1, mobile: false });
    await b.send('Page.navigate', { url: ctx.fileUrl('Race.html') + '?music=0&touch=0' });
    for (let i = 0; i < 300 && !(await b.ev(`typeof FX === 'object' && typeof CrashGarage === 'object' && !!window.SFX_DATA`).catch(() => false)); i++) await sleep(200);
    const plan = Object.assign(soundPlan(edit, tl), ctx.has('--no-music') ? { music: 0 } : {});
    const st = await b.ev(`(${renderMix.toString()})(${JSON.stringify(plan)})`);
    const parts = [], n = await b.ev('window.__wav.length');
    for (let o = 0; o < n; o += 1 << 20) parts.push(Buffer.from(await b.ev(`(() => { const a = window.__wav.subarray(${o}, ${o + (1 << 20)}); let s = ''; for (let i = 0; i < a.length; i += 8192) s += String.fromCharCode.apply(null, a.subarray(i, i + 8192)); return btoa(s); })()`), 'base64'));
    fs.writeFileSync(wav, Buffer.concat(parts));
    log(`sound: ${st.seconds.toFixed(1)} s, ${st.rmsDb.toFixed(1)} dBFS RMS (peak before the trim ${st.peak.toFixed(2)}); per 2 s: ${st.levels.join(' ')}`);
    log(`sound effects: ${st.heard - st.silent.length} of ${st.heard} heard` + (st.silent.length ? `; silent: ${st.silent.map((h) => h.kind + '@' + h.t).join(', ')}` : ''));
    log(`sound effects over the music (dB, before the compressor): ${st.ratio}; the engines: ${st.engines}`);
  }

  // the picture, then the video
  if (ctx.has('--sound-only')) return;
  const framesDir = path.join(work, 'frames');
  if (!ctx.has('--encode-only')) {   // (--encode-only: the frames and the sound as they are, encoded again)
  fs.rmSync(framesDir, { recursive: true, force: true });
  await K.composite(b, edit, { takesDir, events, outDir: framesDir, workDir: work, log, w: 1280, h: 720, extra });
  // a thumbnail for YouTube (1280 x 720): the takedown's rival upside down, the title over it
  const th = K.sourceOf({ E: [{ f: 0, n: 1, src: THUMB }] }, 0, events);
  await b.send('Emulation.setDeviceMetricsOverride', { width: 1280, height: 720, deviceScaleFactor: 1, mobile: false });
  await b.ev(`show(${JSON.stringify('file:///' + path.join(takesDir, th.take, th.cam, String(th.n).padStart(5, '0') + '.jpg').split(path.sep).join('/'))}, { grade: true, dim: 0.25, card: { kind: 'title', title: 'Car Crash Simulation', tag: 'Crash lab · Race · Destruction', age: 30, titleAge: 30 } })`);
  fs.writeFileSync(path.join(work, 'thumbnail.jpg'), await b.shot(92));
  }
  if (ctx.has('--no-encode')) return;
  const out = path.join(work, 'car-crash-simulation-trailer.mp4');
  ctx.encode(framesDir, out, 'HIGH', 1920, 1080, wav);
  log(`wrote ${path.relative(path.join(__dirname, '..'), out)} (${(fs.statSync(out).size / 1048576).toFixed(1)} MB) in ${((Date.now() - t0) / 60000).toFixed(1)} min`);
}

module.exports = { run, makeEdit, timeline, soundPlan, extra, RACE, DESTR, PAGES, GRID, PIECES };
