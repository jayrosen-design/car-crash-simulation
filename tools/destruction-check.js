/* Checks for the Destruction mode's DOM-free parts, in Node:
 *   node tools/destruction-check.js           all checks
 *   node tools/destruction-check.js traffic   only checks whose name contains "traffic"
 *
 * junction:   no building, tree or post in a road; every lane inside the roads; the ground flat
 *             around the junction (the crash solver's ground is flat) and climbing up the approach;
 *             the ramp's lip 2 m up in its lane only; the same seed builds the same junction
 * broadphase: the Race cars' reach keeps world.js's old 7 m limit; a car hitting the end of a 12 m
 *             bus is found (it isn't with the old limit)
 * propreach:  a bus's front corner knocks a cone over (props.js looked only 4 m round a car)
 * traffic:    two minutes without the player: no vehicle touches another, the red light holds the
 *             queue, everyone who enters leaves at the far end, and a rerun is identical
 * pileup:     with a wreck left in the junction, the traffic runs into it
 * wrecks:     a dropped wreck settles without sinking or gaining energy; a wreck dropped on another
 *             stays on top and both go to sleep; one at 30 m/s stops at a wall; two cars colliding
 *             keep their momentum (but for friction with the ground); an explosion pushes harder near
 *             it and not at all beyond its radius; the same run twice is identical
 * score:      the cash shown equals what was paid; multipliers scale the total; a totalled car pays
 *             its value and a quarter more; a tanker goes up at a third of its damage
 * Exits non-zero on any failure.
 */
'use strict';
const path = require('path'), crypto = require('crypto');
global.CAR_PHYS = {};
require(path.join(__dirname, '../models/lexus.phys.js'));
require(path.join(__dirname, '../models/mustang.phys.js'));
const Veh = require(path.join(__dirname, '../js/vehicles.js'));
global.RaceCar = require(path.join(__dirname, '../js/race/vehicle.js'));
const RaceWorld = require(path.join(__dirname, '../js/race/world.js'));
const RaceProps = require(path.join(__dirname, '../js/race/props.js'));
const Level = require(path.join(__dirname, '../js/destruction/junction.js'));
const Traffic = require(path.join(__dirname, '../js/destruction/traffic.js'));
const Wrecks = require(path.join(__dirname, '../js/destruction/wrecks.js'));
Object.assign(RaceProps.TYPES, Level.PROP_TYPES);
const filter = process.argv[2];
let failures = 0;
const check = (name, ok, detail) => { console.log(`=== ${name}: ${detail} ${ok ? 'OK' : 'PROBLEM'}`); if (!ok) failures++; };
const want = (name) => !filter || name.includes(filter);
const specs = { lexus: Veh.get('lexus'), mustang: Veh.get('mustang') };
const level = Level.build();
const STEP = 1 / 240;

if (want('junction')) {
  // a point inside an oriented rectangle { x, z, h, len, wid } (with a margin)
  const inRect = (r, x, z, m = 0) => { const c = Math.cos(r.h), s = Math.sin(r.h), dx = x - r.x, dz = z - r.z; return Math.abs(dx * c + dz * s) <= r.len / 2 + m && Math.abs(-dx * s + dz * c) <= r.wid / 2 + m; };
  const roads = level.surfaces.roads;
  let inRoad = 0;
  for (const o of level.colliders.boxes) {
    if (Math.abs(o.x) > level.arm || o.z > level.arm || o.z < -level.approach) continue;   // the barriers closing the arms' far ends
    const c = Math.cos(o.angle), s = Math.sin(o.angle);
    for (const [u, w] of [[1, 1], [1, -1], [-1, 1], [-1, -1], [0, 0], [1, 0], [-1, 0], [0, 1], [0, -1]]) if (roads.some(r => inRect(r, o.x + c * u * o.hx - s * w * o.hz, o.z + s * u * o.hx + c * w * o.hz, -0.05))) { inRoad++; break; }
  }
  for (const q of level.colliders.cyls) if (roads.some(r => inRect(r, q.x, q.z, q.r - 0.05))) inRoad++;
  let laneOut = 0;
  // each lane's middle and both its edges (1.6 m either side) on a road
  for (const L of level.lanes) for (let s = 0; s <= L.len; s += 2) { const p = L.at(s), nx = -Math.sin(L.h), nz = Math.cos(L.h); for (const k of [0, -1.6, 1.6]) if (!roads.some(r => inRect(r, p.x + nx * k, p.z + nz * k, 0))) { laneOut++; break; } }
  let bumpy = 0;
  for (let x = -60; x <= 60; x += 3) for (let z = -level.plateau; z <= 60; z += 3) if (level.terrain(x, z) !== 0) bumpy++;
  const r0 = level.ramps[0], G = {};
  let lip = 0, besideRamp = 0;
  for (let z = r0.z; z < r0.z + r0.len; z += 0.25) { lip = Math.max(lip, level.groundAt(-5.25, z, G).h); besideRamp = Math.max(besideRamp, level.groundAt(-1.75, z, G).h); }
  const same = JSON.stringify(Level.build().colliders) === JSON.stringify(level.colliders) && JSON.stringify(Level.build().schedule) === JSON.stringify(level.schedule);
  check('junction', inRoad === 0 && laneOut === 0 && bumpy === 0 && level.terrain(0, -200) > 3 && Math.abs(lip - r0.height) < 0.02 && besideRamp === 0 && same,
    `${level.buildings.length} buildings, ${level.colliders.boxes.length + level.colliders.cyls.length} colliders, ${inRoad} in a road (must be 0); lane points off the roads ${laneOut} (0); ground off flat round the junction at ${bumpy} points (0), ${level.terrain(0, -200).toFixed(1)} m up the approach at 200 m; ramp lip ${lip.toFixed(2)} m (${r0.height}), beside it ${besideRamp} m (0); same seed same junction: ${same}`);
}

if (want('broadphase')) {
  // the Race cars: world.js's 7 m broad phase unchanged
  const w0 = RaceWorld.create({ collidersNear: () => [] });
  const a = w0.add(RaceCar.create(specs.lexus)), b = w0.add(RaceCar.create(specs.mustang));
  // a car driving square into the end of a stopped bus: at contact its centre is over 7 m from the bus's
  const bus = Traffic.heavySpec('bus');
  const hit = (useOld) => {
    const w = RaceWorld.create({ collidersNear: () => [] });
    const B = RaceCar.create(bus); B.place(0, 0, Math.PI / 2, 0);
    const bb = w.add(B, { kinematic: true, height: bus.height });
    if (useOld) bb.reach = 0;   // as before: the 7 m limit
    const C = RaceCar.create(specs.lexus); C.place(0.4, 20, -Math.PI / 2, 12);
    const cb = w.add(C);
    if (useOld) cb.reach = 0;
    // how far into the bus the car's nose is when the contact is first found (m)
    const nose = specs.lexus.xMin + specs.lexus.length - C.cgX;
    // (where that step moves it to, before the contact pushes it back out)
    for (let i = 0; i < 240 * 2; i++) { const z0 = C.z + C.vz * STEP; if (w.step(STEP, () => ({ throttle: 0.3 })).some(e => e.kind === 'car')) return 6 - (z0 - nose); }
    return Infinity;
  };
  const now = hit(false), before = hit(true);
  check('broadphase', a.reach + b.reach < 7 && now < 0.15 && before > 0.5, `Lexus + Mustang reach ${(a.reach + b.reach).toFixed(2)} m (under 7: Race unchanged); a car square into the end of a 12 m bus is found ${(now * 100).toFixed(0)} cm into it (under 15), with the old 7 m limit not until it was ${(before * 100).toFixed(0)} cm in (over 50)`);
}

if (want('propreach')) {
  // a bus at 10 m/s, a cone 5.4 m ahead of its middle, 0.9 m in from its side
  const L2 = Object.assign({}, level, { props: [{ type: 'cone', x: 5.4, z: 0.9 + 0.2, h: 0, y: 0 }] });
  const P = RaceProps.create(L2), w = RaceWorld.create({ collidersNear: () => [], groundAt: level.groundAt });
  const B = RaceCar.create(Traffic.heavySpec('bus')); B.place(-3, 0, 0, 10);
  w.add(B, { height: 3.2 });
  let hits = 0;
  for (let i = 0; i < 240 * 2; i++) { w.step(STEP, () => ({ throttle: 0.2 })); hits += P.step(STEP, w.bodies).length; }
  const pr = P.list[0];
  check('propreach', hits > 0 && Math.hypot(pr.p[0] - 5.4, pr.p[2] - 1.1) > 2, `a bus at 10 m/s, a cone by its front corner: ${hits} hits, the cone moved ${Math.hypot(pr.p[0] - 5.4, pr.p[2] - 1.1).toFixed(1)} m`);
}

if (want('traffic')) {
  const run = (secs) => {
    const w = RaceWorld.create(level), tr = Traffic.create(level, w, { specs });
    tr.reset();
    let t = -3, touches = 0, ranRed = 0, entered = new Set(), left = 0, h = crypto.createHash('sha1'), maxN = 0;
    const ids = new Set(tr.vehicles.map(v => v.id));
    for (let i = 0; i < secs * 240; i++) {
      tr.step(STEP, t, []);
      touches += w.step(STEP, () => ({})).filter(e => e.kind === 'car').length;
      t += STEP;
      for (const v of tr.vehicles) { ids.add(v.id); if (v.lane.light === 'main' && v.s + v.len / 2 > v.lane.stop + 0.6) ranRed++; }
      maxN = Math.max(maxN, tr.vehicles.length);
      if (i % 240 === 0) for (const v of tr.vehicles) h.update(`${v.id}:${v.s.toFixed(5)}:${v.v.toFixed(5)}`);
    }
    const still = new Set(tr.vehicles.map(v => v.id));
    left = [...ids].filter(id => !still.has(id)).length;
    const stuck = tr.vehicles.filter(v => v.lane.light === 'harbor' && v.v < 1).length;
    return { touches, ranRed, entered: ids.size, left, stuck, hash: h.digest('hex').slice(0, 16), maxN, queue: tr.vehicles.filter(v => v.lane.light === 'main').length };
  };
  const a = run(120), b = run(120);
  check('traffic', a.touches === 0 && a.ranRed === 0 && a.left > a.entered * 0.7 && a.stuck === 0 && a.queue === 8 && a.hash === b.hash,
    `2 minutes: ${a.entered} vehicles, ${a.left} through and gone, up to ${a.maxN} at once, ${a.touches} touches (0), ${a.stuck} stopped on Harbor Blvd (0), queue at the red light ${a.queue} (8, never past the line: ${a.ranRed} times over it); rerun identical: ${a.hash === b.hash}`);
}

if (want('pileup')) {
  // a wrecked car left across Harbor Blvd's eastbound lanes: the drivers who notice it late hit it
  const w = RaceWorld.create(level), tr = Traffic.create(level, w, { specs });
  tr.reset();
  const W = Wrecks.create(level, { damage: RaceWorld.damage, values: level.values });
  W.add({ kind: 'car', key: 'lexus', p: [-6, 0.88, 6], q: Wrecks.yawQ(Math.PI / 2), m: 1950, size: [4.86, 1.75, 1.92], value: 48000 });
  let t = -3, hitBy = 0;
  for (let i = 0; i < 240 * 40; i++) {
    const obstacles = W.bodies.map(b => ({ x: b.p[0], z: b.p[2], r: 2.2 }));
    tr.step(STEP, t, obstacles); w.step(STEP, () => ({})); t += STEP;
    if (i % 2) continue;
    const drivers = tr.vehicles.map(v => { const c = v.body.car, S = v.spec, off = S.xMin + S.length / 2 - c.cgX; return { x: c.x + Math.cos(c.h) * off, z: c.z + Math.sin(c.h) * off, y: c.y, h: c.h, hl: S.length / 2, hw: S.width / 2, height: S.height || 1.6, vx: c.vx, vz: c.vz, ref: v }; });
    const res = W.step(STEP * 2, drivers);
    for (const tch of res.touches) {
      const v = tch.driver.ref;
      if (!tr.vehicles.includes(v)) continue;
      hitBy++;
      const c = v.body.car, S = v.spec, H = S.height || 1.6, off = S.xMin + S.length / 2 - c.cgX;
      W.add({ kind: Traffic.HEAVY[v.type] ? v.type : 'car', key: v.type, p: [c.x + Math.cos(c.h) * off, c.y + H / 2, c.z + Math.sin(c.h) * off], q: Wrecks.yawQ(c.h), v: [c.vx, 0, c.vz], m: c.m, size: [S.length, H, S.width], value: 48000 });
      tr.release(v);
    }
  }
  check('pileup', hitBy >= 3, `a wreck across the eastbound lanes for 40 s: ${hitBy} vehicles ran into the pile (at least 3), ${W.bodies.length} wrecks, ${W.ledger.total.toLocaleString('en-US')} $ of damage`);
}

if (want('wrecks')) {
  const flat = (extra = []) => ({ groundAt: (x, z, o = {}) => { o.h = 0; o.gx = 0; o.gz = 0; return o; }, terrain: () => 0, collidersNear: () => extra });
  const car = (W, p, v, h = 0, o = {}) => W.add(Object.assign({ kind: 'car', key: 'lexus', p, q: Wrecks.yawQ(h), v, size: [4.86, 1.6, 1.92], m: 1950, value: 48000 }, o));
  const DT = 1 / 120;
  const energy = (W) => W.bodies.reduce((e, b) => e + 0.5 * b.m * (b.v[0] ** 2 + b.v[1] ** 2 + b.v[2] ** 2) + b.m * 9.81 * b.p[1], 0);
  const lowest = (W, b) => Math.min(...b.spheres.map(s => b.p[1] + Wrecks.rot(b.q, s)[1] - s[3]));
  // dropped from 3 m, tilted
  const W1 = Wrecks.create(flat()), d = car(W1, [0, 3, 0], [0, 0, 0]); d.q = Wrecks.qmul([Math.sin(0.15), 0, 0, Math.cos(0.15)], d.q);
  let rises = 0, prev = energy(W1), deepest = 0;
  for (let i = 0; i < 120 * 5; i++) { W1.step(DT); const e = energy(W1); if (e > prev + 50) rises++; prev = e; deepest = Math.min(deepest, lowest(W1, d)); }
  // a stack
  const W2 = Wrecks.create(flat()), lo = car(W2, [0, 0.8, 0], [0, 0, 0]), up = car(W2, [0.3, 2.6, 0.1], [0, 0, 0], 0.4);
  for (let i = 0; i < 120 * 6; i++) W2.step(DT);
  // a wall at 30 m/s
  const W3 = Wrecks.create(flat([{ box: true, x: 20, z: 0, hx: 1, hz: 10, angle: 0, height: 10 }])), wc = car(W3, [0, 0.8, 0], [30, 0, 0]);
  let far = 0; for (let i = 0; i < 120 * 2; i++) { W3.step(DT); far = Math.max(far, wc.p[0]); }
  // momentum in a T-bone (a short time: friction with the ground takes some)
  const W4 = Wrecks.create(flat()), ta = car(W4, [-6, 0.8, 0], [20, 0, 0]), tb = car(W4, [0, 0.8, 0], [0, 0, 8], Math.PI / 2, { m: 1890 });
  const mom = () => [0, 2].map(i => W4.bodies.reduce((s, x) => s + x.m * x.v[i], 0));
  const m0 = mom(); let contactAt = -1;
  for (let i = 0; i < 120 && contactAt < 0; i++) { W4.step(DT); if (ta.v[0] < 19.5) contactAt = i; }
  for (let i = 0; i < 4; i++) W4.step(DT);
  const m1 = mom(), dm = Math.hypot(m1[0] - m0[0], m1[1] - m0[1]) / Math.hypot(m0[0], m0[1]);
  // explosion falloff
  const W5 = Wrecks.create(flat()), n5 = car(W5, [4, 0.8, 0], [0, 0, 0]), m5 = car(W5, [10, 0.8, 8], [0, 0, 0]), f5 = car(W5, [30, 0.8, 0], [0, 0, 0]);
  W5.explode(0, 0.8, 0, 28, 26, 'tanker', null);
  const sp = (b) => Math.hypot(...b.v);
  // determinism
  const heap = () => { const W = Wrecks.create(flat(), { seed: 3 }); for (let i = 0; i < 12; i++) car(W, [(i % 4) * 3 - 5, 0.8 + Math.floor(i / 4) * 1.9, (i % 3) * 1.1], [Math.sin(i) * 4, 0, Math.cos(i) * 4], i * 0.7); for (let i = 0; i < 120 * 3; i++) W.step(DT); return W.bodies.map(b => b.p.map(v => v.toFixed(9)).join(',')).join(';'); };
  const ok = rises === 0 && deepest > -0.03 && Math.abs(up.p[1] - 2.4) < 0.15 && !lo.awake && !up.awake && far + 2.43 < 19.1 && dm < 0.08 && sp(n5) > sp(m5) && sp(m5) > 0 && sp(f5) === 0 && heap() === heap();
  check('wrecks', ok, `drop: sank ${(-deepest * 100).toFixed(1)} cm at most (< 3), energy rose ${rises} times (0); stacked: top at ${up.p[1].toFixed(2)} m (2.4), both asleep ${!lo.awake && !up.awake}; at a wall from 30 m/s: front got to ${(far + 2.43).toFixed(2)} m (wall at 19); T-bone momentum changed ${(dm * 100).toFixed(1)}% in the hit (< 8%); blast: ${sp(n5).toFixed(1)} m/s at 4 m, ${sp(m5).toFixed(1)} at 13 m, ${sp(f5)} at 30 m (out of reach); same run twice identical: ${heap() === heap()}`);
}

if (want('score')) {
  const flat = { groundAt: (x, z, o = {}) => { o.h = 0; o.gx = 0; o.gz = 0; return o; }, terrain: () => 0, collidersNear: () => [] };
  const W = Wrecks.create(flat, { damage: RaceWorld.damage, values: level.values });
  const a = W.add({ kind: 'car', key: 'lexus', p: [0, 0.8, 0], m: 1950, size: [4.86, 1.6, 1.92], value: 48000 });
  const tk = W.add({ kind: 'tanker', key: 'tanker', p: [30, 1.75, 0], m: 18000, size: [13, 3.5, 2.5], value: 300000 });
  let shown = 0;
  const collect = (evs) => { for (const e of evs.splice(0)) if (e.type === 'cash') shown += e.amount; };
  W.settle(a, 0.5, a.p); collect(W.events);
  const half = W.ledger.raw;
  W.settle(a, 1.4, a.p); collect(W.events);
  W.settle(tk, 0.35, tk.p); collect(W.events);
  const lit = tk.burn >= 0;
  W.pay(25000, 'BONUS', 0, 0, 0); collect(W.events);
  W.ledger.mult = 4;
  const raw = W.ledger.raw;
  check('score', Math.abs(shown - raw) < 1e-6 && Math.abs(half - 24000) < 1e-6 && Math.abs(raw - (48000 * 1.25 + 300000 * 0.35 + 25000)) < 1e-6 && W.ledger.total === Math.round(raw * 4) && lit && a.burn >= 0,
    `paid ${shown.toLocaleString('en-US')} = ledger ${raw.toLocaleString('en-US')}; a car at half damage $${half.toLocaleString('en-US')} (24,000), totalled $${(48000 * 1.25).toLocaleString('en-US')} with the bonus; ×4: ${W.ledger.total.toLocaleString('en-US')}; tanker alight at 35%: ${lit}, car alight when totalled: ${a.burn >= 0}`);
}

console.log(failures ? `\n${failures} check(s) with problems` : '\nall destruction checks passed');
process.exit(failures ? 1 : 0);
