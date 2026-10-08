/* The Race game's trailer (media/race-trailer.mp4): a minute of the game cut to the soundtrack's
 * beat (tools/trailer-music.js, the 'race' song), recorded from Race.html by tools/record-video.js.
 *
 * Three passes:
 *   takes     fresh races on the virtual clock, each scripted: the player is driven by a director
 *             (the game's opt-in hook, RaceGame.director) and filmed by several cameras at once. The
 *             crashes are the game's own: the full crash solver in its worker, which the recorder
 *             lets finish before playing on, so the slow-motion crash camera never waits.
 *   edit      the shot list below picks frames from the takes by their events (the start, a near
 *             miss, the takedown, a crash), so every launch and impact lands on a beat.
 *   composite the chosen frames under the colour grade, titles and flashes, one screenshot each.
 * As in the crash trailer, 150 BPM at 30 fps makes a beat 12 frames and a bar 48, 37.5 bars in all.
 */
'use strict';
const fs = require('fs');
const path = require('path');

const FPS = 30, BEAT = 12, BAR = 48, BARS = 37.5, TOTAL = BARS * BAR;
const F = (bar, beat = 0) => Math.round(bar * BAR + beat * BEAT);
const DT = 1000 / FPS;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ---------------------------------------------------------------- the director (in the page)
// Driving: 'ai' (the rivals' driver, optionally held to a lane, flat out with boost), 'line' (the
// circuit at a fixed offset and speed), 'straight' (hold a heading, flat out), 'aim' (pure pursuit
// to a point). Cameras: specs evaluated each frame, k = 0..1 through the capture window.
function director() {
  const G = RaceGame, T = THREE, L = G.level, cam = G.R.camera;
  const V = (x, y, z) => new T.Vector3(x, y, z);
  const css = document.createElement('style');
  css.textContent = 'body.cine #hud, body.cine #crash, body.cine .overlay, body.cine #msg, body.cine #chip { display: none !important; }';
  document.head.appendChild(css);
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
      return { steer: pursuit(a.x, a.z, 1.6), throttle: err > 0 ? Math.min(1, 0.3 + err * 0.3) : 0, brake: err < -1 ? Math.min(1, -err * 0.2) : 0, boost: D.boost };
    }
    if (D.drive === 'straight') { const e = Math.atan2(Math.sin(D.hold - car.h), Math.cos(D.hold - car.h)); return { throttle: 1, boost: D.boost, steer: Math.max(-1, Math.min(1, e * 3)) }; }
    if (D.drive === 'aim') return { throttle: 1, boost: D.boost, steer: pursuit(D.target.x, D.target.z, D.gain || 2.2) };
    return { brake: 1 };
  };
  D.place = (s, l, v, h) => { const p = L.poseAt(s, l); G.car.place(p.x, p.z, h === undefined ? p.h : h, v); G.prog.prevS = s; return p; };
  // a 2D ray against the level's boxes and cylinders: the first hit { d, o, cos } (cos: how squarely
  // the ray meets the face, 1 = head on)
  D.ray = (x, z, h, maxD) => {
    const dx = Math.cos(h), dz = Math.sin(h);
    let best = null;
    for (let d = 0; d < maxD; d += 2) for (const o of L.collidersNear(x + dx * d, z + dz * d, 3)) {
      let t = Infinity;
      if (o.box) {
        const c = Math.cos(o.angle), s = Math.sin(o.angle), rx = x - o.x, rz = z - o.z;
        const ox = rx * c + rz * s, oz = -rx * s + rz * c, vx = dx * c + dz * s, vz = -dx * s + dz * c;
        let t0 = -Infinity, t1 = Infinity, cos = 0;
        for (const [p, v, e] of [[ox, vx, o.hx], [oz, vz, o.hz]]) {
          if (Math.abs(v) < 1e-9) { if (Math.abs(p) > e) { t0 = Infinity; break; } continue; }
          const a = (-e - p) / v, b = (e - p) / v;
          if (Math.min(a, b) > t0) { t0 = Math.min(a, b); cos = Math.abs(v); }
          t1 = Math.min(t1, Math.max(a, b));
        }
        if (t0 <= t1 && t1 > 0) { t = Math.max(0, t0); var hitCos = cos; }
      } else {
        const rx = x - o.x, rz = z - o.z, bq = rx * dx + rz * dz, cq = rx * rx + rz * rz - o.r * o.r, disc = bq * bq - cq;
        if (disc >= 0 && -bq - Math.sqrt(disc) > 0) { t = -bq - Math.sqrt(disc); var hitCos = 1; }
      }
      if (t < Infinity && (!best || t < best.d)) best = { d: t, o, cos: hitCos };
    }
    return best;
  };
  const inBox = (o, x, z, m) => { const c = Math.cos(o.angle), s = Math.sin(o.angle), dx = x - o.x, dz = z - o.z; return Math.abs(dx * c + dz * s) < o.hx + m && Math.abs(-dx * s + dz * c) < o.hz + m; };
  const blocked = D.blocked = (p) => L.collidersNear(p.x, p.z, 1).some((o) => o.box && inBox(o, p.x, p.z, 0.6));
  const frameOf = () => { const car = G.car, c = Math.cos(car.h), s = Math.sin(car.h); return { o: V(car.x, 0, car.z), f: V(c, 0, s), r: V(-s, 0, c) }; };
  const lerp = (a, k) => Array.isArray(a) ? a[0] + (a[1] - a[0]) * k : a;
  const at = (s, l, y) => { const p = L.poseAt(s, l); return V(p.x, y, p.z); };
  D.CAMS = {
    // in front, low, looking back at the car: it chases the camera
    front: (k, p) => { const F = frameOf(); return { pos: F.o.clone().addScaledVector(F.f, lerp(p.d, k) || 7.5).addScaledVector(F.r, lerp(p.side, k) || 1).setY(lerp(p.y, k) || 0.7), look: F.o.clone().addScaledVector(F.f, 0.5).setY(0.75) }; },
    // alongside, low (side < 0: the car's left)
    side: (k, p) => { const F = frameOf(); return { pos: F.o.clone().addScaledVector(F.f, lerp(p.a, k) || 1.5).addScaledVector(F.r, lerp(p.side, k) || -4).setY(lerp(p.y, k) || 0.85), look: F.o.clone().addScaledVector(F.f, 0.8).setY(0.7) }; },
    // high behind: the street and the pack ahead
    heli: (k, p) => { const F = frameOf(); return { pos: F.o.clone().addScaledVector(F.f, -(lerp(p.back, k) || 16)).addScaledVector(F.r, lerp(p.side, k) || 0).setY(lerp(p.y, k) || 11), look: F.o.clone().addScaledVector(F.f, lerp(p.ahead, k) || 16).setY(0) }; },
    // low behind, just off the bumper
    chase: (k, p) => { const F = frameOf(); return { pos: F.o.clone().addScaledVector(F.f, -(lerp(p.back, k) || 5.2)).addScaledVector(F.r, lerp(p.side, k) || 0).setY(lerp(p.y, k) || 1.05), look: F.o.clone().addScaledVector(F.f, 6).setY(0.9) }; },
    // placed on the circuit: pos at (s, l, y), looking at the car, or at (ls, ll, ly)
    street: (k, p) => ({ pos: at(lerp(p.s, k), lerp(p.l, k), lerp(p.y, k)), look: p.follow ? V(G.car.x, 0.8, G.car.z) : at(lerp(p.ls, k), lerp(p.ll, k), lerp(p.ly, k)) }),
    // fixed world point, looking at the car
    fixed: (k, p) => ({ pos: V(lerp(p.x, k), lerp(p.y, k), lerp(p.z, k)), look: V(G.car.x, 0.8, G.car.z) }),
    // around the crash (the game's crash focus), along an arc
    orbit: (k, p) => { const P = G.crashFocus, a = lerp(p.a, k) * Math.PI / 180, r = lerp(p.r, k) || 6; return { pos: V(P.x + Math.cos(a) * r, lerp(p.y, k) || 1.4, P.z + Math.sin(a) * r), look: V(P.x, p.lift || 0.6, P.z) }; },
  };
  G.director.camera = () => {
    if (!D.cam || D.cam.kind === 'game') return;
    const c = D.CAMS[D.cam.kind](D.k, D.cam);
    if (blocked(c.pos)) c.pos.y = Math.max(c.pos.y, 16);
    cam.position.copy(c.pos); cam.lookAt(c.look);
    const fov = lerp(D.cam.fov, D.k) || 50;
    if (Math.abs(cam.fov - fov) > 0.01) { cam.fov = fov; cam.updateProjectionMatrix(); }
  };
  D.status = () => {
    const chip = document.querySelector('#chip');
    return { state: G.state, t: +G.simT.toFixed(2), kmh: Math.round(G.car.forward * 3.6), s: +G.prog.s.toFixed(1), td: G.takedowns,
      chip: chip && !chip.hidden ? chip.textContent : '', crash: G.crash ? { done: G.crash.done, parts: G.crash.debris.length, glass: G.crash.glass.length, kmh: Math.round(G.crash.impactKmh || 0) } : null };
  };
  return true;
}

// ---------------------------------------------------------------- cameras for the takes
const C = {
  game: { kind: 'game' },
  front: { kind: 'front', d: [7.5, 6.2], side: 1.1, y: [0.7, 0.6], fov: 46 },
  frontWide: { kind: 'front', d: 11, side: -2.2, y: 1.2, fov: 52 },
  sideL: { kind: 'side', a: [2.5, 0.5], side: -4.2, y: 0.8, fov: 50 },
  sideR: { kind: 'side', a: [2.2, 0.2], side: 4.0, y: 0.9, fov: 50 },
  heli: { kind: 'heli', back: [18, 14], y: [12, 10], ahead: 18, fov: 50 },
  chase: { kind: 'chase', back: 5.4, y: 1.0, fov: 60 },
};

// ---------------------------------------------------------------- the takes
// Each take is a fresh race. `run` scripts it with the helpers of take() below; a capture window
// films the listed cameras on every frame.
const TAKES = {
  // the start, the pack, and a run along the centre line past the oncoming traffic
  race: {
    car: 'lexus',
    async run(t) {
      const gridCam = { kind: 'street', s: '__grid+20', l: 0.6, y: 0.75, ls: '__grid-12', ll: 3.5, ly: 1.1, fov: 44 };
      const gridHigh = { kind: 'street', s: '__grid+6', l: -9, y: [5.5, 7], ls: '__grid-14', ll: 3.5, ly: 0, fov: 48 };
      await t.countdown({ grid: gridCam, gridHigh });
      await t.frames(60, { front: C.front, heli: C.heli, game: C.game, sideL: C.sideL, gridHigh: Object.assign({}, gridHigh, { y: 7 }) });
      await t.frames(270, { front: C.front, heli: C.heli, game: C.game, sideL: C.sideL });
      // down the start straight 0.75 m from the centre line at 160 km/h, braking off before the first
      // corner: the oncoming cars pass about 0.6 m away (near misses count under 1 m). The traffic in
      // the inner lane on the player's side
      // is moved 505 m and more ahead every frame, so there is nothing to run into. (Removed instead,
      // the game would fill the empty lane with a new car just ahead.) On a straight the line needs
      // no corner cutting.
      const push = `{ const G = RaceGame, L = G.level, f = L.nearest(G.car.x, G.car.z), inner = (c) => Math.abs(c.lane - 1.75) < 0.1;
        let far = 505;
        for (const c of G.traffic.cars) { const d = L.wrapDiff(c.s, f.s); if (inner(c) && d >= 505) far = Math.max(far, d + 25); }
        for (const c of G.traffic.cars.slice()) {
          const d = L.wrapDiff(c.s, f.s);
          if (!inner(c) || !c.body.kinematic || d <= -20 || d >= 505) continue;
          if (far > 575) { G.traffic.remove(c); continue; }
          c.s = ((f.s + far) % L.length + L.length) % L.length; far += 25;
          const p = L.poseAt(c.s, c.lane); c.body.car.setKinematic(p.x, p.z, p.h, c.v, c.v * p.k);
        } }`;
      // first the rivals go on round, out of the way: none less than 520 m ahead of the run's start
      // or 380 m behind it (they would catch the player up). Meanwhile the player is a ghost (no
      // crash, no takedown), and near misses from the wait are forgotten (none of it is filmed).
      await t.page(`RaceGame.me.ghost = 1e6`);
      const clearOfRivals = `RaceGame.ai.rivals.every((r) => { const d = RaceGame.level.wrapDiff(r.body.track ? r.body.track.s : r.prog.s, 110); return d > 520 || d < -380; })`;
      for (let i = 0; i < 60 && !(await t.page(clearOfRivals)); i++) await t.frames(15);
      // The street around the run is filled afresh (the old traffic is where the player was), then
      // the oncoming cars in the inner lane are spaced to meet the player 45, 85, 125 and 165 frames
      // into the run.
      t.mark('run');
      await t.page(`RaceGame.me.ghost = 0; for (const c of RaceGame.traffic.cars.slice()) RaceGame.traffic.remove(c);
        __d.place(110, 0.75, 160 / 3.6); __d.drive = 'line'; __d.offset = 0.75; __d.speed = 44; __d.boost = false;`);
      await t.frames(3, null, push);
      await t.page(`{ const G = RaceGame, L = G.level, f = L.nearest(G.car.x, G.car.z);
        const on = G.traffic.cars.filter((c) => Math.abs(c.lane + 1.75) < 0.1 && c.body.kinematic);
        on.forEach((c, i) => {
          if (i < 4) c.s = ((f.s + (44 + c.v) * (45 + 40 * i) / 30) % L.length + L.length) % L.length;
          else G.traffic.remove(c);
          const p = L.poseAt(c.s, c.lane); c.body.car.setKinematic(p.x, p.z, p.h + Math.PI, c.v, -c.v * p.k);
        }); }`);
      const run = t.n;
      const runCams = { front: { kind: 'front', d: 8, side: -0.3, y: 0.65, fov: 50 }, game: C.game, heli: C.heli };   // the front camera clear of the oncoming lane
      await t.frames(210, runCams, push);
      // the near misses the shots can use: far enough into the filmed run for their lead-in
      t.forget('chip', run + 30);
    },
  },
  // side by side with a rival at speed, then steer into it: a takedown (the rival spins out)
  takedown: {
    car: 'mustang', params: 'traffic=0',
    async run(t) {
      await t.countdown();
      await t.frames(60);
      await t.page(`(() => { const G = RaceGame, L = G.level, r = G.ai.rivals.find(r => r.key === 'lexus') || G.ai.rivals[0];
        const s = 760, p = L.poseAt(s, 5.25); r.body.car.place(p.x, p.z, p.h, 30); r.lane = r.l = r.laneT = 5.25; r.prog.prevS = s;
        __d.place(s - 1, 1.75, 30); __d.drive = 'ai'; __d.lane = 1.75; __d.boost = false; __d.rival = r; })()`);
      await t.frames(70, { sideL: { kind: 'side', a: [6, 2], side: -5.2, y: 1.0, fov: 50 }, heli: { kind: 'heli', back: 14, y: 9, ahead: 10, side: -3, fov: 50 }, front: C.frontWide });
      await t.page(`(() => { const G = RaceGame, c = G.car, r = __d.rival.body.car; __d.drive = 'aim'; __d.gain = 3; __d.target = { x: r.x + Math.cos(r.h) * 6, z: r.z + Math.sin(r.h) * 6 }; __d.boost = true; })()`);
      await t.frames(130, { sideL: { kind: 'side', a: [2, -2], side: -5.2, y: 1.0, fov: 50 }, heli: { kind: 'heli', back: 14, y: 9, ahead: 10, side: -3, fov: 50 }, front: C.frontWide, game: C.game },
        `if (__d.drive === 'aim') { const r = __d.rival.body.car; __d.target = { x: r.x + Math.cos(r.h) * 5, z: r.z + Math.sin(r.h) * 5 }; if (RaceGame.takedowns > 0) { __d.drive = 'ai'; __d.lane = 1.75; } }`);
    },
  },
  // a missed corner at 180 km/h: straight on, into the building beyond it
  corner: {
    car: 'lexus', params: 'traffic=0',
    async run(t) {
      await t.countdown();
      await t.frames(90);
      const setup = await t.page(`(() => { const G = RaceGame, L = G.level, D = __d;
        let best = null;
        for (const [cx, cz] of L.corners) for (const l of [1.75, 5.25, -1.75, -5.25]) for (const back of [140, 170, 200]) {
          const sc = L.nearest(cx, cz).s, p = L.poseAt(sc - back, l), hit = D.ray(p.x, p.z, p.h, 300);
          if (!hit || !hit.o.box || hit.d < 135 || hit.d > 260) continue;
          // the camera beside the impact point, 3 m out from the wall, in the open
          const hx = p.x + Math.cos(p.h) * hit.d, hz = p.z + Math.sin(p.h) * hit.d, rx = -Math.sin(p.h), rz = Math.cos(p.h);
          let cam = null;
          for (const side of [7, -7, 10, -10]) { const c = { x: hx - Math.cos(p.h) * 3.5 + rx * side, z: hz - Math.sin(p.h) * 3.5 + rz * side }; if (!D.blocked(c) && !D.blocked({ x: (c.x + hx) / 2, z: (c.z + hz) / 2 })) { cam = c; break; } }
          if (!cam) continue;
          const score = hit.cos * 2 - Math.abs(l) * 0.02;
          if (!best || score > best.score) best = { score, p, hit, cam };
        }
        const { p, hit } = best, back = hit.d - 165, x = p.x + Math.cos(p.h) * back, z = p.z + Math.sin(p.h) * back;
        G.car.place(x, z, p.h, 180 / 3.6); G.prog.prevS = L.nearest(x, z).s; D.drive = 'straight'; D.hold = p.h; D.boost = true;
        D.wall = { cx: best.cam.x, cz: best.cam.z };
        return { d: Math.round(hit.d), cos: +hit.cos.toFixed(3), h: p.h }; })()`);
      const w = await t.page('__d.wall');
      // a camera at the wall beside the impact point, looking back down the approach
      const wallCam = { kind: 'fixed', x: w.cx, y: 1.5, z: w.cz, fov: 48 };
      const back = setup.h * 180 / Math.PI + 180;   // the orbits stay on the side the car came from
      await t.frames(300, { front: { kind: 'front', d: 9, side: 1.4, y: 0.7, fov: 46 }, wall: wallCam, chase: { kind: 'chase', back: 7, y: 1.6, fov: 56 },
        orbit: { kind: 'orbit', a: [back - 70, back - 20], r: 6.5, y: 1.5, fov: 48 }, orbitLow: { kind: 'orbit', a: [back + 60, back + 25], r: 5.2, y: 0.8, fov: 50 }, game: C.game }, null, { untilCrashEnd: true });
      return setup;
    },
  },
  // head-on into an oncoming car: the player in its lane at 175 km/h
  headon: {
    car: 'lexus',
    async run(t) {
      await t.countdown();
      await t.frames(100);
      // wait for an oncoming car with a clear lane in front of it
      let setup = null;
      for (let tries = 0; tries < 40 && !setup; tries++) {
        if (tries) await t.frames(15);
        setup = await t.page(`(() => { const G = RaceGame, L = G.level, D = __d, f = L.nearest(G.car.x, G.car.z);
          // a place on a straight ahead; in an oncoming lane, nothing within 60 m of it, a car 70-200 m on
          for (const ahead of [180, 260, 340, 420]) for (const lane of [-1.75, -5.25]) {
            const sp = f.s + ahead;
            if ([0, 60, 140, 200].some(d => Math.abs(L.poseAt(sp + d, 0).k) > 0.002)) continue;
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
      await t.frames(300, { front: { kind: 'front', d: 9, side: 2.2, y: 0.8, fov: 48 }, sideR: { kind: 'side', a: [6, 1], side: 4.5, y: 1.0, fov: 50 }, heli: { kind: 'heli', back: 12, y: 8, ahead: 12, side: 3, fov: 50 },
        orbit: { kind: 'orbit', a: [100, 160], r: 6, y: 1.3, fov: 48 }, orbitHigh: { kind: 'orbit', a: [300, 340], r: 7.5, y: 4.5, fov: 48 }, game: C.game }, null, { untilCrashEnd: true });
      return setup;
    },
  },
  // into a lamp post on the pavement at 170 km/h
  post: {
    car: 'mustang', params: 'traffic=0',
    async run(t) {
      await t.countdown();
      await t.frames(90);
      await t.page(`(() => { const G = RaceGame, L = G.level, D = __d, f = L.nearest(G.car.x, G.car.z);
        const lamp = L.lamps.map(o => ({ o, g: L.nearest(o.x, o.z) })).filter(e => e.g.l > 0 && L.wrapDiff(e.g.s, f.s) > 200 && L.wrapDiff(e.g.s, f.s) < 700
          && Math.abs(L.poseAt(e.g.s, 0).k) < 0.002 && Math.abs(L.poseAt(e.g.s - 130, 0).k) < 0.002)[0];
        D.place(lamp.g.s - 130, 5.25, 170 / 3.6); D.drive = 'line'; D.offset = 5.25; D.speed = 48; D.boost = true; D.post = { x: lamp.o.x, z: lamp.o.z, s: lamp.g.s }; })()`);
      await t.frames(330, { front: { kind: 'front', d: 9, side: -1.8, y: 0.7, fov: 46 }, sideL: { kind: 'side', a: [5, 1], side: -5, y: 0.9, fov: 50 },
        orbit: { kind: 'orbit', a: [40, 100], r: 6, y: 1.2, fov: 48 }, orbitHigh: { kind: 'orbit', a: [220, 260], r: 7, y: 5, fov: 50 }, game: C.game },
        `{ const D = __d, G = RaceGame, g = G.level.nearest(G.car.x, G.car.z); if (D.drive === 'line' && G.level.wrapDiff(D.post.s, g.s) < 50) { D.drive = 'aim'; D.target = D.post; } }`, { untilCrashEnd: true });
    },
  },
};

// ---------------------------------------------------------------- recording the takes
// b: the browser; dir: where take frames go (<take>/<cam>/<n>.jpg); returns the events per take
async function recordTakes(b, { dir, log, only, page }) {
  const events = {};
  for (const [name, take] of Object.entries(TAKES)) {
    if (only && !only.includes(name)) continue;
    const t0 = Date.now();
    await b.send('Page.navigate', { url: page + '?director&car=' + take.car + (take.params ? '&' + take.params : '') });
    for (let i = 0; i < 400; i++) { await sleep(200); try { if (await b.ev(`typeof RaceGame === 'object' && document.querySelector('#loading').hidden`)) break; } catch { /* loading */ } }
    await b.ev(`(${director.toString()})()`);
    const ev = events[name] = { list: [], frames: 0, captured: {} };
    let n = 0, prev = { state: 'intro', td: 0, chip: '' };
    const tdir = path.join(dir, name);
    const grid = await b.ev(`RaceGame.level.start.s - 8`);   // the grid's front row
    const resolve = (spec) => JSON.parse(JSON.stringify(spec).replace(/"__grid([+-]\d+)"/g, (_, d) => String(grid + +d)));
    // the game's own camera (with its HUD) is what the step drew; the others are drawn again here
    const shoot = async (camName, spec, k) => {
      if (spec.kind === 'game') await b.ev(`document.body.classList.remove('cine')`);
      else await b.ev(`__d.cam = ${JSON.stringify(resolve(spec))}; __d.k = ${k.toFixed(4)}; document.body.classList.add('cine'); RaceGame.director.camera(0); RaceGame.R.render()`);
      const d = path.join(tdir, camName); fs.mkdirSync(d, { recursive: true });
      fs.writeFileSync(path.join(d, String(n).padStart(5, '0') + '.jpg'), await b.shot(92));
      (ev.captured[camName] = ev.captured[camName] || []).push(n);
    };
    const t = {
      page: (js) => b.ev(js),
      mark: (type) => ev.list.push({ type, n }),
      // forget events of this type (before frame `before`, if given)
      forget: (type, before = Infinity) => { ev.list = ev.list.filter((e) => e.type !== type || e.n >= before); },
      get n() { return n; },
      // start the race (Enter); film the countdown with these cameras
      async countdown(cams) {
        await b.send('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13 });
        await t.frames(3, cams);
        await b.send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13 });
        let guard = 0;
        while ((await b.ev('RaceGame.state')) !== 'race' && guard++ < 400) await t.frames(1, cams);
      },
      // step frames; film each with every camera (none: just run); each: page JS run every frame
      async frames(count, cams, each, opts = {}) {
        const names = Object.keys(cams || {});
        let crashEnd = -1;
        for (let i = 0; i < count; i++) {
          if (each) await b.ev(each);
          await b.ev(`__d.cam = null; __vstep(${DT})`);
          const s = await b.ev('__d.status()');
          if (s.state === 'crash' && prev.state !== 'crash') {
            ev.list.push({ type: 'crash', n, kmh: s.crash.kmh });
            // the solver runs in real time in its worker: let it finish before playing on
            for (let w = 0; w < 600 && !(await b.ev('RaceGame.crash && RaceGame.crash.done')); w++) await sleep(100);
            const c = await b.ev('__d.status()');
            Object.assign(ev.list[ev.list.length - 1], { parts: c.crash && c.crash.parts, glass: c.crash && c.crash.glass });
          }
          if (s.state !== 'crash' && prev.state === 'crash') { ev.list.push({ type: 'crashEnd', n }); crashEnd = n; }
          if (s.state === 'race' && prev.state === 'countdown') ev.list.push({ type: 'go', n });
          if (s.td > prev.td) ev.list.push({ type: 'takedown', n });
          if (s.chip && s.chip !== prev.chip) ev.list.push({ type: 'chip', n, text: s.chip });
          prev = s;
          const order = names.filter((c) => cams[c].kind === 'game').concat(names.filter((c) => cams[c].kind !== 'game'));
          for (const c of order) await shoot(c, cams[c], count > 1 ? i / (count - 1) : 0);
          n++;
          if (opts.untilCrashEnd && crashEnd >= 0 && n > crashEnd + 6) break;
        }
      },
    };
    const setup = await take.run(t);
    ev.frames = n; ev.setup = setup;
    log(`${name}: ${n} frames, events ${ev.list.map((e) => e.type + '@' + e.n + (e.kmh ? ` ${e.kmh} km/h, ${e.parts} parts` : e.text ? ` ${e.text}` : '')).join(', ')} in ${((Date.now() - t0) / 1000).toFixed(0)} s`);
    if (b.errors.length) throw new Error(`${name}: page errors: ${b.errors.join(' | ')}`);
  }
  return events;
}

// ---------------------------------------------------------------- the edit
// Each shot takes n frames from a take's camera, starting `off` frames from one of the take's
// events (go, a crash, the takedown, a near miss: the first of its kind) or from frame `abs`.
// card: a title on black (or over the picture with over: true); hit: a flash and the impact sound.
const E = [];
const shot = (f, n, o) => E.push(Object.assign({ f, n }, o));
const src = (take, cam, ref, off) => ({ take, cam, ref, off });
// intro: titles between glimpses of the race, then the countdown on the beat
shot(F(0), 24, { card: { tag: 'Car Crash Simulation', title: 'Eight cars' }, sfx: 'card' });
shot(F(0, 2), 24, { src: src('race', 'gridHigh', 'abs', 24), sfx: 'whoosh' });
shot(F(1), 24, { card: { title: 'Two-way traffic' }, sfx: 'card' });
shot(F(1, 2), 24, { src: src('race', 'heli', 'go', 190), sfx: 'whoosh' });
shot(F(2), 24, { card: { tag: 'Full crash physics', title: 'Real crashes' }, sfx: 'card' });
shot(F(2, 2), 24, { src: src('race', 'sideL', 'go', 120), sfx: 'whoosh' });
shot(F(3), 36, { src: src('race', 'grid', 'go', -36), countdown: true });
shot(F(3, 3), 12, { card: null });
// the start on the drop, then the pack and the oncoming lanes
shot(F(4), 48, { src: src('race', 'gridHigh', 'go', 1), hit: 'go', big: 'Go!' });
shot(F(5), 48, { src: src('race', 'heli', 'go', 48) });
shot(F(6), 48, { src: src('race', 'game', 'go', 100) });
shot(F(7), 48, { src: src('race', 'sideL', 'go', 160), lower: ['Seven rivals · three laps', 'A city street circuit, 1.47 km a lap'] });
shot(F(8), 48, { src: src('race', 'front', 'chip', -24), sfx: 'whoosh' });
shot(F(9), 48, { src: src('race', 'game', 'chip', -9), lower: ['Oncoming near miss', 'Near misses, drifts and takedowns fill the boost'] });
shot(F(10), 48, { src: src('race', 'heli', 'chip', 10) });
shot(F(11), 48, { src: src('takedown', 'heli', 'takedown', -60) });
// the takedown, then a corner at 180 km/h
shot(F(12), 48, { src: src('takedown', 'sideL', 'takedown', -24), hitAt: 24, big: 'Takedown', bigAt: 24 });
shot(F(13), 48, { src: src('takedown', 'heli', 'takedown', -15) });
shot(F(14), 48, { src: src('takedown', 'game', 'takedown', -12) });
shot(F(15), 24, { src: src('race', 'heli', 'go', 250) });
shot(F(15, 2), 24, { src: src('corner', 'front', 'crash', -24) });
// the crashes, each impact on a beat
shot(F(16), 48, { src: src('corner', 'orbitLow', 'crash', 0), hit: 'crash', lower: ['Missed the corner', 'The full crash solver, as in the crash tests'] });
shot(F(17), 48, { src: src('corner', 'orbit', 'crash', 40) });
shot(F(18), 24, { src: src('headon', 'sideR', 'crash', -24) });
shot(F(18, 2), 48, { src: src('headon', 'orbit', 'crash', 0), hit: 'crash', lower: ['Head-on', 'Two cars, one solver'] });
shot(F(19, 2), 48, { src: src('headon', 'orbitHigh', 'crash', 40) });
shot(F(20, 2), 24, { src: src('post', 'front', 'crash', -24) });
shot(F(21), 48, { src: src('post', 'orbit', 'crash', 0), hit: 'crash', lower: ['Lamp post', 'Parts, glass and tyres break off'] });
shot(F(22), 48, { src: src('post', 'orbitHigh', 'crash', 40) });
shot(F(23), 48, { src: src('headon', 'game', 'crash', 0), hit: 'crash', hitV: 0.6 });
// breakdown: the wrecks
shot(F(24), 48, { src: src('corner', 'orbit', 'crash', 72), card: { tag: 'Solved as it happens', title: 'Every crash computed', over: true } });
shot(F(25), 48, { src: src('headon', 'orbit', 'crash', 70) });
shot(F(26), 48, { src: src('post', 'orbitHigh', 'crash', 76), card: { tag: 'Bent metal · broken glass', title: 'Real damage', over: true } });
shot(F(27), 36, { src: src('race', 'heli', 'go', 290) });
shot(F(27, 3), 12, { card: null });
// last chorus: faster and faster
[['race', 'heli', 'go', 30, 'go'], ['headon', 'orbit', 'crash', 0, 'crash'], ['race', 'game', 'chip', -6, null], ['corner', 'orbitLow', 'crash', 0, 'crash'],
  ['takedown', 'sideL', 'takedown', -8, 'crash'], ['post', 'orbit', 'crash', 0, 'crash'], ['race', 'heli', 'go', 60, null], ['headon', 'orbitHigh', 'crash', 6, 'crash']]
  .forEach(([take, cam, ref, off, hit], i) => shot(F(28 + i / 2), 24, { src: src(take, cam, ref, off), hit, hitV: 0.6 }));
[['corner', 'orbit', 'crash', 16], ['race', 'front', 'chip', -4], ['headon', 'sideR', 'crash', -4], ['post', 'orbitHigh', 'crash', 14],
  ['race', 'sideL', 'go', 200], ['corner', 'game', 'crash', 0], ['headon', 'heli', 'crash', 0], ['race', 'heli', 'go', 40]]
  .forEach(([take, cam, ref, off], i) => shot(F(32, i), 12, { src: src(take, cam, ref, off), hit: 'crash', hitV: 0.4 }));
// the end: title, line, call to action, over the pack
shot(F(34), TOTAL - F(34), { src: src('race', 'heli', 'run', 40), dim: 0.6 });
const TITLES = [
  [F(34), { kind: 'title', title: 'Race', tag: 'Car Crash Simulation' }, 'title'],
  [F(35), { kind: 'title', title: 'Race', tag: 'Seven rivals · two-way traffic · real crashes' }, 'card'],
  [F(36), { kind: 'title', title: 'Race', tag: 'Play free in your browser', cta: 'car-crash-simulation.vercel.app/race' }, 'title'],
];
const POSTER = { take: 'headon', cam: 'orbit', ref: 'crash', off: 18 };

// the source frame of global frame f (null: black), checked against what the takes captured
function sourceOf(f, events) {
  const s = E.find((x) => f >= x.f && f < x.f + x.n);
  if (!s || !s.src) return null;
  const { take, cam, ref, off } = s.src, ev = events[take];
  if (!ev) throw new Error(`no take "${take}"`);
  let base = 0;
  if (ref !== 'abs') { const e = ev.list.find((x) => x.type === ref); if (!e) throw new Error(`take "${take}" has no ${ref}`); base = e.n; }
  const n = base + off + (f - s.f);
  if (!(ev.captured[cam] || []).includes(n)) throw new Error(`take "${take}" camera ${cam} has no frame ${n} (frame ${f})`);
  return { take, cam, n, kmh: ref === 'crash' ? ev.list.find((x) => x.type === 'crash').kmh : null };
}

// the overlay of global frame f
function overlayAt(f, events) {
  const s = E.find((x) => f >= x.f && f < x.f + x.n), o = { grade: true };
  if (!s) return o;
  const age = f - s.f;
  if (!s.src) o.black = 1;
  if (s.card !== undefined && s.card) o.card = Object.assign({ age }, s.card);
  if (s.dim) o.dim = s.dim;
  const hitAge = age - (s.hitAt || 0);
  if (s.hit && hitAge >= 0) { const v = s.hitV || 1; o.flash = ([0.85, 0.45, 0.2, 0.08][hitAge] || 0) * v; o.punch = 1 + 0.07 * v * Math.exp(-hitAge / 3.5); }
  if (s.countdown) { const i = Math.floor(age / BEAT); o.big = { text: String(3 - i), age: age - i * BEAT, kind: 'count' }; }
  if (s.big && age >= (s.bigAt || 0) && age < (s.bigAt || 0) + 22) o.big = { text: s.big, age: age - (s.bigAt || 0), kind: s.big === 'Go!' ? 'go' : 'td' };
  if (s.lower && age >= 2) o.lower = { title: s.lower[0], sub: s.lower[1], age: age - 2, out: age > s.n - 6 ? age - (s.n - 6) : undefined };
  if (s.src && s.src.ref === 'crash' && s.src.off >= 0 && s.src.cam !== 'game' && !s.card && f < F(28)) {
    const ev = events[s.src.take].list.find((x) => x.type === 'crash');
    o.impact = { kmh: ev.kmh, t: Math.max(0, s.src.off + age) };
  }
  for (const [t0, card] of TITLES) if (f >= t0) o.card = Object.assign({ age: f - t0, titleAge: f - TITLES[0][0] }, card);
  if (f >= TOTAL - 18) o.black = Math.max(o.black || 0, (f - (TOTAL - 18)) / 17);
  return o;
}

// what the music needs: impacts, whooshes, the title hits, the countdown
function musicHits() {
  const hits = [];
  for (const s of E) {
    const t = s.f / FPS;
    if (s.hit === 'crash') hits.push({ t: t + (s.hitAt || 0) / FPS, kind: 'impact', glass: true, v: s.hitV || 1 });
    if (s.hit === 'go') hits.push({ t, kind: 'impact', v: (s.hitV || 1) * 0.7 });
    if (s.sfx === 'card') hits.push({ t, kind: 'card' });
    if (s.sfx === 'whoosh') hits.push({ t, kind: 'whoosh', dur: 0.35 });
  }
  for (const [f, , sfx] of TITLES) hits.push({ t: f / FPS, kind: sfx });
  return hits;
}

// ---------------------------------------------------------------- the compositor (a page)
const COMPOSITOR = `<!doctype html><html><head><meta charset="utf-8">
<link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=Barlow+Condensed:ital,wght@0,700;0,800;1,800;1,900&family=Barlow:wght@500;600&family=JetBrains+Mono:wght@600;700&display=swap">
<style>
  html, body { margin: 0; background: #000; overflow: hidden; }
  #st { position: fixed; inset: 0; overflow: hidden; font-family: "Barlow Condensed", Bahnschrift, sans-serif; color: #fff; }
  #src { position: absolute; inset: 0; width: 100%; height: 100%; object-fit: cover; filter: contrast(1.1) saturate(1.18) brightness(0.98); transform-origin: 50% 50%; }
  #st > div { position: absolute; }
  #tint { inset: 0; mix-blend-mode: soft-light; background: linear-gradient(180deg, rgba(0, 110, 160, 0.45), rgba(0, 60, 90, 0.1) 45%, rgba(255, 140, 50, 0.3)); }
  #vig { inset: 0; background: radial-gradient(ellipse 75% 70% at 50% 52%, transparent 55%, rgba(0, 0, 0, 0.6) 100%); }
  #dim, #black { inset: 0; background: #050608; opacity: 0; }
  #flash { inset: 0; background: #fff; opacity: 0; }
  #bars::before, #bars::after { content: ''; position: fixed; left: 0; right: 0; height: 7.5vh; background: #000; }
  #bars::before { top: 0; } #bars::after { bottom: 0; }
  #lower { left: 4.2vw; bottom: 11.5vh; display: none; }
  #lower i { display: block; height: 0.7vh; background: #ffc400; margin-bottom: 1.2vh; }
  #lower b { display: block; font: italic 800 5.4vh/1 "Barlow Condensed", sans-serif; text-transform: uppercase; text-shadow: 0 0.3vh 1.5vh rgba(0,0,0,0.7); }
  #lower span { display: block; margin-top: 0.9vh; font: 500 2.5vh "Barlow", sans-serif; color: #d6dce4; text-shadow: 0 0.2vh 1vh rgba(0,0,0,0.8); }
  #impact { top: 10.5vh; right: 4.2vw; text-align: right; display: none; font-family: "JetBrains Mono", Consolas, monospace; }
  #impact b { display: block; font-size: 3.4vh; font-weight: 700; letter-spacing: 0.1em; text-shadow: 0 0 1vh rgba(0,0,0,0.8); }
  #impact b i { display: inline-block; width: 1.2vh; height: 1.2vh; border-radius: 50%; background: #ff3b30; margin-right: 0.8vh; }
  #impact span { display: inline-block; margin-top: 0.8vh; font-size: 2.2vh; letter-spacing: 0.14em; color: #111; background: #ffc400; padding: 0.3vh 0.9vh; font-weight: 700; }
  #card { inset: 0; display: none; place-items: center; text-align: center; }
  #card small { display: inline-block; font: italic 800 2.6vh/1 "Barlow Condensed", sans-serif; letter-spacing: 0.3em; text-transform: uppercase; color: #111; background: #ffc400; padding: 0.6vh 1.4vh 0.5vh 1.7vh; margin-bottom: 2.2vh; }
  #card h1 { margin: 0; font: italic 900 15vh/0.9 "Barlow Condensed", sans-serif; text-transform: uppercase; }
  #card.over .in { margin-top: 32vh; } #card.over h1 { font-size: 11vh; text-shadow: 0 0.6vh 3vh rgba(0,0,0,0.75); }
  #card.title h1 { font-size: 30vh; line-height: 0.82; color: #ffc400; }
  #card.title p { margin: 2.6vh 0 0; font: italic 800 3.6vh/1 "Barlow Condensed", sans-serif; letter-spacing: 0.2em; text-transform: uppercase; }
  #card .stripe { height: 1.6vh; margin: 2.4vh auto 0; width: 62vh; background: repeating-linear-gradient(-45deg, #ffc400 0 2.2vh, #111 2.2vh 4.4vh); }
  #card .kick { font: 700 2.6vh "JetBrains Mono", monospace; letter-spacing: 0.3em; text-transform: uppercase; margin-bottom: 1.6vh; color: #fff; }
  #card .cta { display: inline-block; margin-top: 3vh; font: 600 3vh "Barlow", sans-serif; letter-spacing: 0.06em; padding: 1.1vh 2.6vh; border: 0.35vh solid #fff; }
  #big { inset: 0; display: none; place-items: center; }
  #big b { font: italic 900 34vh/1 "Barlow Condensed", sans-serif; text-transform: uppercase; color: #ffc400; text-shadow: 0 1vh 5vh rgba(0,0,0,0.6); -webkit-text-stroke: 0.4vh #111; }
  #big.td b { font-size: 20vh; color: #fff; -webkit-text-stroke: 0; background: #e8241b; padding: 0 4vh; clip-path: polygon(3vh 0, 100% 0, calc(100% - 3vh) 100%, 0 100%); }
</style></head><body><div id="st"><img id="src" alt=""><div id="tint"></div><div id="vig"></div><div id="dim"></div><div id="black"></div>
<div id="impact"><b><i></i></b><span></span></div><div id="lower"><i></i><b></b><span></span></div><div id="big"><b></b></div><div id="card"><div class="in"></div></div><div id="flash"></div><div id="bars"></div></div>
<script>
  const $ = (s) => document.querySelector(s);
  const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]);
  let cardKey = null;
  const slam = (el, a, drift) => {
    const sc = 1 + 0.32 * Math.exp(-a / 1.7) + drift * a, sp = 0.9 * Math.exp(-a / 2.2);
    el.style.transform = 'scale(' + sc.toFixed(4) + ')'; el.style.opacity = Math.min(1, 0.35 + a / 2.5).toFixed(3);
    el.style.textShadow = sp > 0.02 ? (-sp).toFixed(2) + 'vh 0 rgba(255,40,60,.75), ' + sp.toFixed(2) + 'vh 0 rgba(0,200,255,.75)' : '';
  };
  window.show = (url, s) => new Promise((done) => {
    const img = $('#src');
    $('#tint').style.display = $('#vig').style.display = s.grade && !s.black ? 'block' : 'none';
    $('#black').style.opacity = s.black || 0; $('#dim').style.opacity = s.dim || 0; $('#flash').style.opacity = s.flash || 0;
    img.style.transform = s.punch ? 'scale(' + s.punch + ')' : '';
    const im = $('#impact'); im.style.display = s.impact ? 'block' : 'none';
    if (s.impact) { im.querySelector('b').innerHTML = '<i></i>IMPACT ' + s.impact.kmh + ' KM/H'; im.querySelector('span').textContent = 'FULL CRASH SOLVER'; }
    const lw = $('#lower'); lw.style.display = s.lower ? 'block' : 'none';
    if (s.lower) { const k = Math.min(1, s.lower.age / 7); lw.querySelector('b').textContent = s.lower.title; lw.querySelector('span').textContent = s.lower.sub || ''; lw.style.clipPath = 'inset(0 ' + (100 - 100 * k) + '% 0 0)'; lw.querySelector('i').style.width = (3 + 6 * k) + 'vh'; lw.style.opacity = s.lower.out !== undefined ? Math.max(0, 1 - s.lower.out / 5) : 1; }
    const bg = $('#big'); bg.style.display = s.big ? 'grid' : 'none'; bg.className = s.big ? s.big.kind : '';
    if (s.big) { const b = bg.querySelector('b'); b.textContent = s.big.text; slam(b, s.big.age, 0.004); b.style.opacity = Math.min(1, 0.35 + s.big.age / 2.5) * (s.big.kind === 'count' ? Math.max(0, 1 - Math.max(0, s.big.age - 8) / 4) : Math.max(0, 1 - Math.max(0, s.big.age - 16) / 6)); }
    const cd = $('#card'); cd.style.display = s.card ? 'grid' : 'none';
    if (s.card) {
      const c = s.card, key = JSON.stringify([c.tag, c.title, c.cta, c.kind, c.over]);
      if (key !== cardKey) {
        cardKey = key; cd.className = (c.over ? 'over ' : '') + (c.kind === 'title' ? 'title' : '');
        cd.querySelector('.in').innerHTML = c.kind === 'title'
          ? '<div class="kick">Car Crash Simulation</div><h1>' + esc(c.title) + '</h1><div class="stripe"></div><p>' + esc(c.tag) + '</p>' + (c.cta ? '<div class="cta">' + esc(c.cta) + '</div>' : '')
          : (c.tag ? '<small>' + esc(c.tag) + '</small>' : '') + '<h1>' + esc(c.title) + '</h1>';
      }
      const inn = cd.querySelector('.in');
      slam(inn, c.kind === 'title' ? c.titleAge : c.age, c.kind === 'title' ? 0.0008 : 0.0016);
      if (c.kind === 'title') for (const el of inn.querySelectorAll('p, .cta')) slam(el, c.age, 0);
    } else cardKey = null;
    if (!url) { img.style.visibility = 'hidden'; return setTimeout(done, 0); }
    img.style.visibility = 'visible';
    if (img.dataset.url === url) return setTimeout(done, 0);
    img.onload = () => { img.dataset.url = url; setTimeout(done, 0); };
    img.onerror = () => { throw new Error('could not load ' + url); };
    img.src = url;
  });
</script></body></html>`;

// global frames -> composited JPEGs in outDir; takesDir holds the takes, events their logs
async function composite(b, { takesDir, events, outDir, workDir, log }) {
  const page = path.join(workDir, 'compositor.html');
  fs.writeFileSync(page, COMPOSITOR);
  const url = (p) => 'file:///' + p.split(path.sep).join('/');
  await b.send('Page.navigate', { url: url(page) });
  await sleep(1500);
  await b.ev('document.fonts.ready.then(() => true)');
  for (let f = 0; f < TOTAL; f++) {
    const s = sourceOf(f, events), o = overlayAt(f, events);
    const file = s ? url(path.join(takesDir, s.take, s.cam, String(s.n).padStart(5, '0') + '.jpg')) : null;
    await b.ev(`show(${JSON.stringify(file)}, ${JSON.stringify(o)})`);
    fs.writeFileSync(path.join(outDir, 'f' + String(f).padStart(5, '0') + '.jpg'), await b.shot(92));
    if (f % 300 === 299) log(`composited ${f + 1} / ${TOTAL}`);
  }
}
function posterSource(takesDir, events) {
  const e = events[POSTER.take].list.find((x) => x.type === POSTER.ref);
  return path.join(takesDir, POSTER.take, POSTER.cam, String(e.n + POSTER.off).padStart(5, '0') + '.jpg');
}

// every source frame the edit needs exists (run before compositing)
function check(events) { for (let f = 0; f < TOTAL; f++) sourceOf(f, events); for (let f = 0; f < TOTAL; f++) if (!E.some((x) => f >= x.f && f < x.f + x.n)) throw new Error('no shot at frame ' + f); }

module.exports = { recordTakes, composite, check, musicHits, posterSource, TAKES, E, F, FPS, BARS, TOTAL };
