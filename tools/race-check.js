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
 * race:    eight AI cars race three laps through the traffic; all must finish, none stuck for more
 *          than 5 s, the winner's time near the 3 minutes the race is laid out for; the lane-bound
 *          traffic never overlaps
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

if (want('race')) {
  // eight AI cars on the grid, traffic around the leader; 3 laps
  const world = RaceWorld.create(level), specs = { lexus: Veh.get('lexus'), mustang: Veh.get('mustang') };
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
    `${done.length}/8 finished 3 laps; winner ${times.length ? times[0].toFixed(0) : '-'} s, last ${times.length ? times[times.length - 1].toFixed(0) : '-'} s (winner 150-210 s: about 3 minutes); longest stuck ${maxStuck.toFixed(1)} s (under 5); ${crashes} crashes; traffic up to ${maxTraffic} cars, ${overlaps} lane overlaps (must be 0)`);
}

console.log(failures ? `\n${failures} check(s) with problems` : '\nall race checks passed');
process.exit(failures ? 1 : 0);
