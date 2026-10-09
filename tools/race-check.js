/* Checks for the Race game's DOM-free parts, in Node:
 *   node tools/race-check.js            all checks
 *   node tools/race-check.js race       only checks whose name contains "race"
 *
 * level:   the circuit's length and smallest radius are in range, no collider reaches into the
 *          road, the same seed gives the same city
 * car:     the car-select screen's figures (RaceCar.measure): 0-100 km/h, top speed, braking from
 *          100 and cornering grip in plausible bands, boost faster, for both cars; a crash is
 *          detected head-on into a wall and not in a shallow scrape
 * nearmiss: passing traffic within a metre counts, 1.5 m doesn't, oncoming is told apart
 * props:   each kind, driven into: knocked over (or away), no crash, the car only a little slower,
 *          settled again
 * jump:    airtime off the first ramp (fast and slow) and over a hill's crest (stays down at
 *          108 km/h, takes off at 216)
 * damage:  the health bar's rule: a scrape is free, a nudge cheap, a 47 km/h wall a fifth, 100 km/h
 *          a wreck
 * race:    eight AI cars race three laps through the traffic; all must finish, none stuck for more
 *          than 5 s, the winner's time near the 3 minutes the race is laid out for; the lane-bound
 *          traffic never overlaps
 * wall-angle: nose first into a wall at 18 m/s along its normal is a crash; the same 18 m/s with the
 *          car 60 degrees off square (sliding in) is not, and costs the player less health
 * wall-slide: a car pushed broadside into a wall touches it at the middle of its side (not at a
 *          corner, one or the other from step to step); a 26 degree scrape at 108 km/h keeps most of
 *          its speed (the walls are slippery: 84% kept with the old friction) and leaves the car
 *          running along the wall, not spun round
 * slam:    real contacts classified (rules.js): the player's shunt from behind, side slams, a rub, and
 *          a rival's slam on the player
 * takedown-rules: the rules' timeline: a fragile slammed rival wrecks on a light touch, the takedown
 *          counts half a second later, a second one soon after is a double, a crash before it counts
 *          loses it, a slammed rival that touches something and comes through is denied (and not
 *          without a touch), a tailgated rival's wreck is a psyche-out, three in 30 s a spree; a
 *          player crashing within the window of a rival's slam was taken down by it, and taking it
 *          down then is a revenge takedown; a player who touches something after a rival's full
 *          slam and comes through had a lucky escape
 * attack:  an aggressive rival (ai.js) 15 m behind the player's car in the next lane catches it and
 *          drives into it within 8 s; a calm one never does
 * drift:   the player's handling (vehicle.js, car.arcade) at 90 km/h: a brake tap with full lock,
 *          then throttle steering in, holds a 20-45 degree slide for at least 1.5 s keeping over 80%
 *          of the speed, and straightens up within 1.5 s of letting go (both cars); the same
 *          inputs don't make a rival's car drift
 * shove:   steering into a car alongside pushes it away harder than holding the wheel straight, and
 *          faster than the contacts alone would (6.3 m/s sideways at most without world.js's shove)
 * Exits non-zero on any failure.
 */
'use strict';
const path = require('path');
global.CAR_PHYS = {};
require(path.join(__dirname, '../models/lexus.phys.js'));
require(path.join(__dirname, '../models/mustang.phys.js'));
const Veh = require(path.join(__dirname, '../js/vehicles.js'));
global.CrashLevel = require(path.join(__dirname, '../js/race/level.js'));
global.RaceCar = require(path.join(__dirname, '../js/race/vehicle.js'));
const RaceWorld = require(path.join(__dirname, '../js/race/world.js'));
const RaceAI = require(path.join(__dirname, '../js/race/ai.js'));
const RaceProps = require(path.join(__dirname, '../js/race/props.js'));
const RaceRules = require(path.join(__dirname, '../js/race/rules.js'));
const filter = process.argv[2];
let failures = 0;
const check = (name, ok, detail) => { console.log(`=== ${name}: ${detail} ${ok ? 'OK' : 'PROBLEM'}`); if (!ok) failures++; };
const want = (name) => !filter || name.includes(filter);

const level = CrashLevel.build();
if (want('level')) {
  const C = level.circuit;
  let kmax = 0; for (let i = 0; i < C.N; i++) kmax = Math.max(kmax, Math.abs(C.k[i]));
  let inRoad = 0;
  for (const q of level.colliders.cyls) { const f = level.nearest(q.x, q.z), p = level.poseAt(f.s, 0); if (Math.hypot(q.x - p.x, q.z - p.z) < level.roadHalf) inRoad++; }
  for (const b of level.colliders.boxes) {
    const c = Math.cos(b.angle), s = Math.sin(b.angle);
    for (const [u, w] of [[1, 1], [1, -1], [-1, 1], [-1, -1], [0, 0]]) {
      const x = b.x + c * u * b.hx - s * w * b.hz, z = b.z + s * u * b.hx + c * w * b.hz, f = level.nearest(x, z), p = level.poseAt(f.s, 0);
      if (Math.hypot(x - p.x, z - p.z) < level.roadHalf) inRoad++;
    }
  }
  const again = CrashLevel.build();
  const same = JSON.stringify(again.buildings) === JSON.stringify(level.buildings) && JSON.stringify(again.colliders) === JSON.stringify(level.colliders);
  check('level', level.length > 1400 && level.length < 1800 && 1 / kmax >= 25 && inRoad === 0 && same,
    `lap ${level.length.toFixed(0)} m (1400-1800), tightest corner ${(1 / kmax).toFixed(0)} m radius (at least 25), ${level.buildings.length} buildings, ${inRoad} colliders in the road (must be 0), same seed same city: ${same}`);
}

if (want('car')) {
  for (const key of ['lexus', 'mustang']) {
    // the figures the car-select screen shows
    const { t100, top, topBoost, stop100: stop, lateralG } = RaceCar.measure(Veh.get(key));
    check(`car-${key}`, t100 > 3.5 && t100 < 8 && top > 190 && top < 260 && topBoost > top && stop > 30 && stop < 45 && lateralG > 0.8 && lateralG < 1.3,
      `0-100 km/h ${t100.toFixed(1)} s (3.5-8), top ${top.toFixed(0)} km/h (190-260), ${topBoost.toFixed(0)} with boost (faster), 100-0 in ${stop.toFixed(1)} m (30-45), cornering ${lateralG.toFixed(2)} g (0.8-1.3)`);
  }
  // crash detection: square into a wall at 120 km/h crashes, a 10 degree scrape at 200 km/h doesn't
  const W1 = RaceWorld.create(level), c1 = RaceCar.create(Veh.get('lexus')), b0 = level.buildings.find(b => b.front === 1), f0 = level.nearest(b0.x, b0.z), p0 = level.poseAt(f0.s, 0);
  c1.place(p0.x, p0.z, Math.atan2(b0.z - p0.z, b0.x - p0.x), 120 / 3.6); W1.add(c1);
  let hit = false; for (let i = 0; i < 240 * 3 && !hit; i++) for (const e of W1.step(1 / 240, () => ({ throttle: 0.3 }))) if (e.crash) hit = true;
  // a plain wall with nothing along it: a 400 m box beside the car's path
  const wallLevel = { collidersNear: () => [{ box: true, x: 200, z: 4, hx: 200, hz: 1, angle: 0, height: 10 }] };
  const W2 = RaceWorld.create(wallLevel), c2 = RaceCar.create(Veh.get('lexus'));
  c2.place(0, 0, 0.17, 200 / 3.6); W2.add(c2);
  let scrape = false, contacts = 0; for (let i = 0; i < 240 * 3; i++) for (const e of W2.step(1 / 240, () => ({ throttle: 1 }))) { contacts++; if (e.crash) scrape = true; }
  check('car-crash-detect', hit && !scrape && contacts > 0, `square into a building at 120 km/h: ${hit ? 'crash' : 'no crash'} (must crash); 10 degree scrape at 200 km/h: ${contacts} contacts, ${scrape ? 'crash' : 'no crash'} (must not)`);
}

if (want('nearmiss')) {
  // the player passes a lane-bound traffic car with a given side gap; once with the traffic going the
  // same way, once oncoming
  const pass = (gap, dir) => {
    const me = RaceCar.create(Veh.get('lexus')), o = RaceCar.create(Veh.get('mustang'));
    const side = me.spec.width / 2 + o.spec.width / 2 + gap;
    me.place(-40, 0, 0, 30); o.place(0, side, dir > 0 ? 0 : Math.PI, 12);
    const t = { body: { kinematic: true, car: o }, dir, nm: null };
    let got = null;
    for (let i = 0; i < 240 * 4; i++) {
      me.step(1 / 240, { throttle: 0.4 });
      o.setKinematic(o.pose.x + Math.cos(o.h) * 12 / 240, o.pose.z + Math.sin(o.h) * 12 / 240, o.h, 12, 0);
      if (i % 4 === 0) { const k = RaceAI.nearMiss(me, t); if (k) got = k; }
    }
    return got;
  };
  const a = pass(0.8, 1), b = pass(1.5, 1), c = pass(0.6, -1), d = pass(0.03, 1);
  check('nearmiss', a === 'near' && b === null && c === 'oncoming' && d === null,
    `0.8 m alongside: ${a} (must count); 1.5 m: ${b} (must not); 0.6 m past an oncoming car: ${c} (must count as oncoming); 3 cm (a touch): ${d} (must not)`);
}

if (want('props')) {
  // each kind of prop alone in a lane on the first straight, driven into: knocked over (or away),
  // no crash, the car only a little slower, and the prop settles again
  const results = [];
  let ok = true;
  for (const [type, kmh] of [['lamp', 100], ['signal', 90], ['cone', 100], ['bin', 80], ['newsbox', 80], ['hydrant', 80], ['bench', 60], ['crate', 80], ['barrel', 80]]) {
    const at = level.poseAt(380, 1.75), L2 = Object.assign({}, level, { props: [{ type, x: at.x, z: at.z, h: at.h + Math.PI / 2, y: 0 }] });
    const W = RaceWorld.create(level), P = RaceProps.create(L2), pr = P.list[0], car = RaceCar.create(Veh.get('lexus')), st = level.poseAt(350, 1.75);
    car.place(st.x, st.z, st.h, kmh / 3.6); W.add(car);
    let hit = null, crashes = 0, settled = -1;
    const x0 = pr.p[0], z0 = pr.p[2];
    for (let i = 0; i < 240 * 12; i++) {
      crashes += W.step(1 / 240, () => ({ brake: i > 240 * 2 ? 1 : 0 })).filter(e => e.crash).length;
      for (const h of P.step(1 / 240, W.bodies)) if (!hit) hit = h;
      if (hit && !pr.awake && settled < 0) settled = i / 240;
    }
    const [qx, , qz] = pr.q, tilt = Math.acos(Math.max(-1, Math.min(1, 1 - 2 * (qx * qx + qz * qz)))) * 180 / Math.PI;
    const moved = Math.hypot(pr.p[0] - x0, pr.p[2] - z0), lost = hit ? hit.dv * 3.6 : 0;
    const good = hit && crashes === 0 && lost < 8 && moved > 3 && settled > 0 && (!pr.T.pole || tilt > 45);
    if (!good) ok = false;
    results.push(`${type} ${moved.toFixed(0)} m${pr.T.pole ? ` ${tilt.toFixed(0)}°` : ''}, -${lost.toFixed(1)} km/h, still at ${settled > 0 ? settled.toFixed(1) + ' s' : 'never'}${crashes ? ', CRASH' : ''}`);
  }
  check('props', ok, `${results.join('; ')} (each: knocked > 3 m, poles over 45°, the car < 8 km/h slower, no crash, settled within 12 s)`);
}

if (want('jump')) {
  // the first ramp and the steepest hill's crest: airtime (s) driving straight at a given speed
  const air = (s0, kmh, secs) => {
    const W = RaceWorld.create(level), car = RaceCar.create(Veh.get('lexus')), p = level.poseAt(s0, 1.75);
    car.place(p.x, p.z, p.h, kmh / 3.6); W.add(car);
    let t = 0, lands = 0;
    for (let i = 0; i < 240 * secs; i++) { lands += W.step(1 / 240, () => ({ throttle: 1, boost: kmh > 180 })).filter(e => e.kind === 'land').length; if (car.air) t += 1 / 240; }
    return { t, lands };
  };
  const fast = air(180, 144, 3), slow = air(195, 43, 4), r0 = level.ramps[0];
  const hillS = (() => { let best = 0, bs = 0; for (let s = 520; s < 680; s++) { const p = level.poseAt(s, 0), h = level.terrain(p.x, p.z); if (h > best) { best = h; bs = s; } } return bs; })();
  const crest = air(522, 108, 2.5), crestFast = air(522, 216, 1.5);
  check('jump', fast.t > 0.8 && fast.t < 1.6 && fast.lands >= 1 && slow.t < fast.t && crest.t < 0.05 && crestFast.t > 0.2,
    `ramp at s ${r0.s} (${r0.height} m): ${fast.t.toFixed(2)} s in the air from 144 km/h (0.8-1.6, lands), ${slow.t.toFixed(2)} s from 43 km/h (less); hill crest at s ${hillS}: ${crest.t.toFixed(2)} s from 108 km/h (stays down), ${crestFast.t.toFixed(2)} s from 216 km/h (takes off)`);
}

if (want('damage')) {
  // the player's damage from real hits (RaceWorld.hitDamage, at the first touch): square into a wall
  // at 13 m/s and 28 m/s, and an 8 m/s nudge from behind into another car
  const wall = { collidersNear: () => [{ box: true, x: 40, z: 0, hx: 1, hz: 30, angle: 0, height: 10 }] };
  const wallHit = (v) => {
    const W = RaceWorld.create(wall), car = RaceCar.create(Veh.get('lexus'));
    car.place(20, 0, 0, v); W.add(car);
    for (let i = 0; i < 240 * 3; i++) for (const e of W.step(1 / 240, () => ({}))) if (e.kind === 'wall') return RaceWorld.hitDamage(e, W.bodies[0]);
    return 0;
  };
  const nudge = (() => {
    const W = RaceWorld.create({ collidersNear: () => [] }), a = RaceCar.create(Veh.get('lexus')), b = RaceCar.create(Veh.get('mustang'));
    a.place(0, 0, 0, 20); b.place(7, 0, 0, 12); W.add(a); W.add(b);
    for (let i = 0; i < 240 * 3; i++) for (const e of W.step(1 / 240, () => ({}))) if (e.kind === 'car') return RaceWorld.hitDamage(e, W.bodies[0]);
    return 0;
  })();
  const d13 = wallHit(13), d28 = wallHit(28), d2 = RaceWorld.damage(2);
  check('damage', d2 === 0 && nudge < 0.03 && d13 > 0.12 && d13 < 0.35 && d28 >= 1,
    `a 2 m/s scrape ${(d2 * 100).toFixed(0)}% (none), an 8 m/s nudge into a car ${(nudge * 100).toFixed(1)}% (under 3%), a wall at 13 m/s ${(d13 * 100).toFixed(0)}% (12-35%), at 28 m/s ${(d28 * 100).toFixed(0)}% (a wreck: 100% or more)`);
}

if (want('race')) {
  // eight AI cars on the grid, traffic around the leader, the props in the street; 3 laps
  const world = RaceWorld.create(level), specs = { lexus: Veh.get('lexus'), mustang: Veh.get('mustang') };
  const props = RaceProps.create(level);
  let propHits = 0, maxAwake = 0;
  const grid = [];
  for (let i = 0; i < 8; i++) { const s = level.start.s - 6 - Math.floor(i / 2) * 9, lane = i % 2 ? 5.25 : 1.75, p = level.poseAt(s, lane); grid.push({ key: i % 3 ? 'lexus' : 'mustang', x: p.x, z: p.z, h: p.h, s, lane, skill: 0.94 + i * 0.008, paint: 0, name: 'AI ' + i }); }
  const ai = RaceAI.createRivals(level, world, { grid, specs, seed: 3 });
  const traffic = RaceAI.createTraffic(level, world, { specs, seed: 5, clearStart: true });
  const STEP = 1 / 240;
  let t = 0, maxStuck = 0, overlaps = 0, crashes = 0, maxTraffic = 0;
  const lead = () => ai.rivals.reduce((m, r) => Math.max(m, (r.prog.lap - 1) * level.length + r.prog.dist), 0);
  const ctx = { traffic, racing: true, player: null, lead: () => 0 };
  while (t < 420 && ai.rivals.some(r => !r.prog.done)) {
    const leader = ai.rivals.reduce((a, b) => ((a.prog.lap - 1) * level.length + a.prog.dist) > ((b.prog.lap - 1) * level.length + b.prog.dist) ? a : b);
    if (Math.round(t * 240) % 4 === 0) traffic.step(STEP * 4, leader.body.track ? leader.body.track.s : level.start.s, ai.rivals.map(r => r.body));
    const ev = world.step(STEP, (b) => b.rival ? ai.drive(b.rival, STEP, ctx) : (b.traffic && !b.kinematic ? { brake: 0.5 } : null));
    for (const e of ev) if (e.crash) { crashes++; for (const b of [e.a, e.b]) if (b && b.rival) { b.rival.wreck = 2.5; } }
    propHits += props.step(STEP, world.bodies).filter(h => h.first).length;
    if (Math.round(t * 240) % 240 === 0) maxAwake = Math.max(maxAwake, props.awake);
    t += STEP;
    for (const r of ai.rivals) {
      ai.track(r, t, level.laps);
      if (r.wreck > 0) { r.wreck -= STEP; if (r.wreck <= 0) ai.respawn(r, r.body.track ? r.body.track.s : level.start.s); }
      if (r.stuck > 3 && !r.prog.done) ai.respawn(r, r.body.track ? r.body.track.s : level.start.s);
      if (!r.prog.done) maxStuck = Math.max(maxStuck, r.stuck);
    }
    maxTraffic = Math.max(maxTraffic, traffic.cars.length);
    if (Math.round(t * 240) % 60 === 0) {
      const tk = traffic.cars.filter(c => c.body.kinematic);
      for (let i = 0; i < tk.length; i++) for (let j = i + 1; j < tk.length; j++) if (tk[i].lane === tk[j].lane && Math.abs(level.wrapDiff(tk[i].s, tk[j].s)) < 4.2) overlaps++;
    }
  }
  const done = ai.rivals.filter(r => r.prog.done), times = done.map(r => r.prog.time).sort((a, b) => a - b);
  check('race', done.length === 8 && maxStuck < 5 && overlaps === 0 && times[0] > 150 && times[0] < 210,
    `${done.length}/8 finished 3 laps; winner ${times.length ? times[0].toFixed(0) : '-'} s, last ${times.length ? times[times.length - 1].toFixed(0) : '-'} s (winner 150-210 s: about 3 minutes); longest stuck ${maxStuck.toFixed(1)} s (under 5); ${crashes} crashes; ${propHits} props knocked over (up to ${maxAwake} moving at once); traffic up to ${maxTraffic} cars, ${overlaps} lane overlaps (must be 0)`);
}

if (want('wall-angle')) {
  // a plain wall (its face along x at z = 3), the car coming at it 18 m/s along the wall's normal:
  // nose first, or 60 degrees off square at twice the speed
  const wall = { collidersNear: () => [{ box: true, x: 0, z: 4, hx: 300, hz: 1, angle: 0, height: 10 }] };
  const first = (h, v) => {
    const W = RaceWorld.create(wall), c = RaceCar.create(Veh.get('lexus'));
    c.place(0, -3, h, v); W.add(c);
    for (let i = 0; i < 240 * 2; i++) for (const e of W.step(1 / 240, () => ({}))) if (e.kind === 'wall') return { crash: e.crash, vn: e.vn, sq: e.sq || 0, dmg: RaceWorld.hitDamage(e, W.bodies[0]) };
    return { crash: null, vn: 0, sq: 0, dmg: 0 };
  };
  const square = first(Math.PI / 2, 18), slide = first(Math.PI / 6, 36);
  check('wall-angle', square.crash === true && slide.crash === false && slide.dmg < square.dmg && Math.abs(slide.vn - square.vn) < 2,
    `nose first at ${square.vn.toFixed(1)} m/s (square ${square.sq.toFixed(2)}): ${square.crash ? 'crash' : 'no crash'} (must crash), health ${(square.dmg * 100).toFixed(0)}%; ` +
    `60 degrees off at ${slide.vn.toFixed(1)} m/s (square ${slide.sq.toFixed(2)}): ${slide.crash ? 'crash' : 'no crash'} (must not), health ${(slide.dmg * 100).toFixed(0)}% (less)`);
}

if (want('wall-slide')) {
  const wall = { collidersNear: () => [{ box: true, x: 0, z: 4, hx: 300, hz: 1, angle: 0, height: 10 }] };
  // broadside: heading along the wall, moving sideways into it at 5 m/s
  const W1 = RaceWorld.create(wall), c1 = RaceCar.create(Veh.get('lexus'));
  c1.place(0, 1.5, 0, 0); c1.vz = 5; W1.add(c1);
  let off = null;
  for (let i = 0; i < 240 && off === null; i++) for (const e of W1.step(1 / 240, () => ({}))) if (e.kind === 'wall') { const B = W1.box(W1.bodies[0]); off = Math.abs((e.x - B.x) * B.ux + (e.z - B.z) * B.uz); }
  // a scrape: 26 degrees into the wall at 30 m/s, on the throttle
  const W2 = RaceWorld.create(wall), c2 = RaceCar.create(Veh.get('lexus'));
  c2.place(0, 0, 0.45, 30); W2.add(c2);
  let touches = 0;
  for (let i = 0; i < 240 * 2; i++) for (const e of W2.step(1 / 240, () => ({ throttle: 0.5 }))) if (e.kind === 'wall') touches++;
  const kept = c2.speed / 30;
  check('wall-slide', off !== null && off < 0.3 && touches > 0 && kept > 0.88 && Math.abs(c2.h) < 0.3,
    `broadside contact ${off === null ? '-' : off.toFixed(2)} m from the middle of the side (under 0.3); scrape: ${touches} contacts, ${(kept * 100).toFixed(0)}% of the speed kept after 2 s (over 88%), heading ${c2.h.toFixed(2)} rad off the wall (under 0.3)`);
}

if (want('slam')) {
  // the player (a) and a rival (b) on an open road; the first slam of the player on the rival
  const run = (pa, pb, rivalSteer = 0) => {
    const W = RaceWorld.create({ collidersNear: () => [] }), A = RaceCar.create(Veh.get('lexus')), B = RaceCar.create(Veh.get('mustang'));
    A.place(...pa); B.place(...pb);
    const a = W.add(A, { kind: 'player' }), b = W.add(B, { kind: 'rival' }), R = RaceRules.create(), r = { body: b };
    let touches = 0;
    for (let i = 0; i < 240 * 2; i++) for (const e of W.step(1 / 240, (x) => x === a ? { throttle: 0.3 } : { throttle: 0.3, steer: rivalSteer })) {
      if (e.kind !== 'car') continue;
      touches++;
      const s = R.contact(e, a, r, i / 240);
      if (s) return `${s.by} ${s.type} ${s.full ? 'full' : 'light'}`;
    }
    return touches ? 'rub' : 'no contact';
  };
  const got = {
    rearFull: run([0, 0, 0, 30], [8, 0, 0, 20]),            // 10 m/s faster, into its tail
    rearLight: run([0, 0, 0, 25], [8, 0, 0, 20]),           // 5 m/s faster
    sideFull: run([0, 0, 0.25, 25], [0, 2.6, 0, 25]),       // turned into it: about 6 m/s sideways
    sideLight: run([0, 0, 0.12, 25], [0, 2.6, 0, 25]),      // about 3 m/s
    rub: run([0, 0, 0.04, 25], [0, 2.6, 0, 25]),            // about 1 m/s
    rivals: run([0, 0, 0, 25], [0, 2.6, -0.25, 25]),        // the rival turned into the player: the rival's slam
  };
  const ok = got.rearFull === 'player rear full' && got.rearLight === 'player rear light' && got.sideFull === 'player side full' && got.sideLight === 'player side light' && got.rub === 'rub' && got.rivals === 'rival side full';
  check('slam', ok, Object.entries(got).map(([k, v]) => `${k}: ${v}`).join('; ') + ' (player rear full, player rear light, player side full, player side light, rub, rival side full)');
}

if (want('takedown-rules')) {
  // the rules on their own, with made-up contacts: the player's car 10 m/s faster into a rival's tail
  const car = (x, v) => ({ x, z: 0, h: 0, vx: v, vz: 0, speed: v, spec: { xMin: -1, length: 4.8 }, cgX: 1.4 });
  const me = { car: car(0, 30) };
  const R = RaceRules.create(), log = [];
  const rival = (name) => ({ name, body: { car: car(5, 20) } });
  const slam = (r, t) => R.contact({ a: me, b: r.body, kind: 'car', vn: 10, x: 2.45, z: 0, nx: -1, nz: 0, ua: 30, ub: -20 }, me, r, t);
  const upd = (t) => R.update(t).map(u => `${u.kind} ${u.r.name}${u.psyche ? ' psyche' : ''}${u.double ? ' double' : ''}${u.kind === 'takedown' ? ' spree ' + u.spree : ''}`);
  const [r1, r2, r3, r4, r5, r6, r7, r8, r9, r10] = 'r1 r2 r3 r4 r5 r6 r7 r8 r9 r10'.split(' ').map(rival);
  const s1 = slam(r1, 0);
  log.push(['full shunt', s1 && s1.type === 'rear' && s1.full]);
  log.push(['cooldown', slam(r1, 0.5) === null]);
  log.push(['fragile: a 2 m/s touch wrecks', R.rivalContact({ vn: 2 }, r1, 0.6) === true && R.wrecked(r1, 0.6) === true]);
  log.push(['not yet counted', upd(1.0).length === 0]);
  log.push(['counts 0.5 s later', upd(1.1).join() === 'takedown r1 spree 1']);
  slam(r2, 1.2); R.rivalContact({ vn: 2 }, r2, 1.5); R.wrecked(r2, 1.5);
  log.push(['double', upd(2.0).join() === 'takedown r2 double spree 2']);
  slam(r3, 10); R.rivalContact({ vn: 2 }, r3, 10.3); R.wrecked(r3, 10.3); R.playerCrashed(10.5);
  log.push(['lost to a crash', upd(10.9).length === 0 && upd(12).length === 0]);
  slam(r4, 20);
  log.push(['a 3 m/s touch after the fragile second: no wreck', R.rivalContact({ vn: 3 }, r4, 21.2) === false]);
  log.push(['denied when the window ends', upd(21.5).length === 0 && upd(22.0).join() === 'denied r4']);
  slam(r5, 30);
  log.push(['no touch: not denied', upd(32.1).length === 0]);
  const near = { car: car(5, 25) }; r6.body.car = car(10, 25);
  R.tail(near, r6, 40);
  log.push(['psyche-out', R.wrecked(r6, 40.5) === true && upd(41.0).join() === 'takedown r6 psyche spree 1']);
  for (const [r, t] of [[r7, 80], [r8, 85], [r9, 90]]) { slam(r, t); R.rivalContact({ vn: 2 }, r, t + 0.2); R.wrecked(r, t + 0.2); }
  const spree = [upd(80.7), upd(85.7), upd(90.7)].map(x => x.join()).join(' / ');
  log.push(['spree', spree === 'takedown r7 spree 1 / takedown r8 spree 2 / takedown r9 spree 3']);
  slam(r10, 120);
  log.push(['a wreck after the window is no takedown', R.wrecked(r10, 123) === false]);
  // the rival drives into the player (it is the faster toward the other)
  const rivalSlam = (Rr, r, t) => Rr.contact({ a: r.body, b: me, kind: 'car', vn: 10, x: 2.45, z: 0, nx: 1, nz: 0, ua: 30, ub: -20 }, me, r, t);
  const R2 = RaceRules.create(), rv = rival('rv');
  const s2 = rivalSlam(R2, rv, 0);
  log.push(["a rival's full slam on the player", !!s2 && s2.by === 'rival' && s2.full]);
  log.push(['taken down by it', R2.playerCrashed(1.0) === rv && R2.revenge === rv]);
  R2.contact({ a: me, b: rv.body, kind: 'car', vn: 10, x: 2.45, z: 0, nx: -1, nz: 0, ua: 30, ub: -20 }, me, rv, 20); R2.rivalContact({ vn: 2 }, rv, 20.3); R2.wrecked(rv, 20.3);
  const rev = R2.update(20.8);
  log.push(['revenge', rev.length === 1 && rev[0].revenge === true && R2.revenge === null]);
  const R3 = RaceRules.create(), rx = rival('rx');
  rivalSlam(R3, rx, 0);
  log.push(['a crash after the window is no one\'s', R3.playerCrashed(2.5) === null && R3.revenge === null]);
  const R4 = RaceRules.create(), ry = rival('ry'), rz = rival('rz');
  rivalSlam(R4, ry, 0); R4.playerContact(2, 0.5);
  log.push(['lucky escape', R4.update(1.0).length === 0 && R4.update(2.0).map(u => u.kind).join() === 'lucky']);
  rivalSlam(R4, rz, 10);
  log.push(['no touch: no lucky escape', R4.update(12.1).length === 0]);
  const bad = log.filter(([, ok]) => !ok).map(([k]) => k);
  check('takedown-rules', !bad.length, `${log.length - bad.length}/${log.length} rules hold${bad.length ? '; failing: ' + bad.join(', ') : ''}`);
}

if (want('shove')) {
  // the player's car beside another at 25 m/s, turned 0.12 rad into it; once they touch it steers
  // into it (or holds the wheel straight): how far the other car is pushed sideways in 1.5 s
  const push = (steer) => {
    const W = RaceWorld.create({ collidersNear: () => [] }), A = RaceCar.create(Veh.get('lexus')), B = RaceCar.create(Veh.get('mustang'));
    A.place(0, 0, 0.12, 25); B.place(0, 2.6, 0, 25);
    const a = W.add(A); W.add(B);
    let touched = false, vside = 0;
    for (let i = 0; i < 240 * 1.5; i++) {
      for (const e of W.step(1 / 240, (x) => x === a ? { steer: touched ? steer : 0, throttle: 0.4 } : { throttle: 0.4 })) if (e.kind === 'car') touched = true;
      vside = Math.max(vside, B.vz);
    }
    return { d: B.z - 2.6, vside };
  };
  const into = push(0.6), straight = push(0);
  check('shove', into.d > straight.d * 1.5 && into.vside > 7, `pushed ${into.d.toFixed(2)} m steering into it, ${straight.d.toFixed(2)} m holding straight (at least 1.5 times); up to ${into.vside.toFixed(1)} m/s sideways (over 7)`);
}

if (want('attack')) {
  // the player's car (driven by the rivals' AI) on the first straight, past its ramp, and one rival
  // 15 m behind in the kerb lane, both at 90 km/h; attacks allowed, no traffic
  const specs = { lexus: Veh.get('lexus'), mustang: Veh.get('mustang') };
  const run = (aggr) => {
    const world = RaceWorld.create(level), s0 = 235, q0 = level.poseAt(s0, 5.25), p0 = level.poseAt(s0 + 15, 1.75);
    const ai = RaceAI.createRivals(level, world, { grid: [{ key: 'mustang', x: q0.x, z: q0.z, h: q0.h, s: s0, lane: 5.25, skill: 1, paint: 0, name: 'R', aggr }], specs, seed: 3 });
    ai.rivals[0].body.car.place(q0.x, q0.z, q0.h, 25);
    const pc = RaceCar.create(specs.lexus); pc.place(p0.x, p0.z, p0.h, 25);
    const me = world.add(pc, { kind: 'player' }), pilot = ai.adopt(me, 1.75, 0.9);
    const none = { cars: [] }, ctxPilot = { traffic: none, racing: true, player: null, lead: () => 0 };
    const ctx = { traffic: none, racing: true, player: me, lead: () => 0, attack: () => true };
    for (let i = 0; i < 240 * 8; i++) {
      for (const e of world.step(1 / 240, (b) => b === me ? ai.drive(pilot, 1 / 240, ctxPilot) : ai.drive(b.rival, 1 / 240, ctx))) {
        if (e.kind === 'car' && RaceRules.attacker(e).rival) return { t: i / 240, vn: e.vn };
      }
    }
    return null;
  };
  const hot = run(1), calm = run(0);
  check('attack', !!hot && !calm, `aggressive rival: ${hot ? `drove into the player at ${hot.t.toFixed(1)} s, ${hot.vn.toFixed(1)} m/s` : 'never touched the player'} (must); calm rival: ${calm ? `drove into the player at ${calm.t.toFixed(1)} s` : 'never did'} (must not)`);
}

if (want('drift')) {
  const run = (key, arcade) => {
    const car = RaceCar.create(Veh.get(key));
    car.arcade = arcade; car.place(0, 0, 0, 25);
    let held = 0, maxSlip = 0, kept = 0, back = -1;
    for (let i = 0; i < 240 * 5; i++) {
      const t = i / 240;
      car.step(1 / 240, t < 0.15 ? { brake: 1, steer: 1 } : t < 2.65 ? { throttle: 0.7, steer: 1 } : { throttle: 0.5, steer: 0 });
      const deg = Math.abs(car.sideSlip) * 180 / Math.PI;
      if (t >= 0.15 && t < 2.65) { if (car.mode === 'drift' && deg >= 20 && deg <= 45) held += 1 / 240; maxSlip = Math.max(maxSlip, deg); }
      if (i === Math.round(2.65 * 240)) kept = car.speed / 25;
      if (t > 2.65 && back < 0 && car.mode === 'grip' && deg < 6) back = t - 2.65;
    }
    return { held, maxSlip, kept, back };
  };
  const lx = run('lexus', true), mu = run('mustang', true), rv = run('lexus', false);
  const good = (d) => d.held >= 1.5 && d.kept > 0.8 && d.back >= 0 && d.back < 1.5;
  const fmt = (d) => `${d.held.toFixed(1)} s at 20-45 degrees (up to ${d.maxSlip.toFixed(0)}), ${(d.kept * 100).toFixed(0)}% of the speed kept, straight ${d.back < 0 ? 'never' : d.back.toFixed(1) + ' s'} after letting go`;
  check('drift', good(lx) && good(mu) && rv.maxSlip < 10,
    `Lexus: ${fmt(lx)}; Mustang: ${fmt(mu)} (at least 1.5 s, over 80%, within 1.5 s); a rival's Lexus: slides up to ${rv.maxSlip.toFixed(0)} degrees (under 10: no drift)`);
}

console.log(failures ? `\n${failures} check(s) with problems` : '\nall race checks passed');
process.exit(failures ? 1 : 0);
