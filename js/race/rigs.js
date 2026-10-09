/* The garage's rigs: the Kestrel motorcycle, the Osprey drone and the Rampart tank (js/garage.js,
 * types 'bike', 'hover', 'tracked'). They aren't on the crash lattice: they crash as rigid bodies.
 *
 * spec(key): what RaceCar (vehicle.js), RaceWorld and the renderer need, from the model's data
 * (models/<key>.phys.js, window.RIG_PHYS, from tools/build-rig.py) and the garage entry: size, hubs,
 * mass (with the rider), tuning, armour, the parts (pivots, masses, the speed that breaks each off),
 * lamps, the hover height.
 *
 * crash(): the motorcycle's or the drone's crash as rigid bodies (wrecks.js), for the crash camera.
 *
 * DOM-free: global RaceRigs in the browser, module.exports in Node.
 */
const RaceRigs = (() => {
  'use strict';
  const root = typeof window !== 'undefined' ? window : globalThis;
  const node = typeof module === 'object' && module.exports && typeof require === 'function';
  const Garage = root.CrashGarage || (node ? require('../garage.js') : null);
  const physOf = (key) => {
    const P = root.RIG_PHYS || (root.RIG_PHYS = {});
    if (!P[key] && node) { try { P[key] = require(require('path').join(__dirname, '..', '..', 'models', key + '.phys.js')); } catch (e) { /* not built */ } }
    return P[key];
  };
  const cache = {};

  // the rig's spec (null if its model isn't loaded)
  function spec(key) {
    if (cache[key]) return cache[key];
    const G = Garage.get(key), d = physOf(key);
    if (!G || G.type === 'car' || !d) return null;
    // the height band that meets props and other cars (from its own base): the drone's body, the
    // bike from just off the ground to the rider's helmet, the tank's hull and turret
    const band = { bike: [0.1, 1.15], hover: [0, 0.7], tracked: [0.05, 2.0] }[G.type];
    return (cache[key] = {
      key, rig: G.type, title: G.name, short: G.name, note: G.kind.toLowerCase(),
      massKg: G.rig.massKg + (G.rig.riderKg || 0), riderKg: G.rig.riderKg || 0,
      length: d.length, width: d.width, height: d.height, xMin: d.xMin, lo: d.lo, hi: d.hi,
      hubs: d.hubs, wheelRadius: d.wheelRadius,
      tune: G.rig.tune, armour: G.rig.armour || null,
      parts: d.parts, lamps: d.lamps, hover: d.hover,
      profileTop: d.profileTop, profileBottom: d.profileBottom,
      bodyLo: band[0], bodyHi: band[1],
      credit: d.credit,
    });
  }
  const isRig = (key) => { const G = Garage.get(key); return !!G && G.type !== 'car'; };

  // ---------------------------------------------------------------- rigid crashes (the bike, the drone)
  /* crash({ level, car (the rig's RaceCar, at the moment before it touched), other: { x, z, hx, hz,
   *   angle, height } (the box of the car it hit, held still: a 285 kg bike hardly moves a car) or null,
   *   W (DestructionWrecks), seed }) -> a crash for the crash camera, worked out at once: 1.6 s of the
   * rig as rigid bodies (wrecks.js) against the ground, the buildings and that car. Its parts come off
   * at their break-off speeds (BREAK_, with what hangs on them), the rider is thrown at the first hit,
   * a motorcycle always goes over. Returns { mode: 'rigid', F (t, axes: the hull's position, forward,
   * up), T0 (first contact), events (first, contact, detach), debris, glass: [], done: true, lift: 0,
   * unitView(0): the pieces' poses for RigModels.play } */
  function crash(o) {
    const W = o.W, { level, car } = o, S = car.spec, pose = car.pose, DT = 1 / 120;
    const extra = o.other ? [Object.assign({ box: true }, o.other)] : [];
    const world = {
      groundAt: (x, z, out) => level.groundAt ? level.groundAt(x, z, out) : Object.assign(out, { h: 0, gx: 0, gz: 0 }),
      terrain: (x, z) => level.terrain ? level.terrain(x, z) : 0,
      collidersNear: (x, z, r) => level.collidersNear(x, z, r).concat(extra.filter(b => Math.hypot(b.x - x, b.z - z) < r + Math.hypot(b.hx, b.hz))),
    };
    let seed = (o.seed || 5) >>> 0;
    const rnd = () => { seed = (seed * 1664525 + 1013904223) >>> 0; return seed / 4294967296; };
    const sim = W.create(world, { vmax: 90, seed });
    // the pieces that can come off: a part and everything hanging on it (a rotor on its arm)
    const kids = (name) => S.parts.filter(p => p.parent === name).flatMap(p => [p, ...kids(p.name)]);
    const pieces = S.parts.filter(p => /^(BREAK_|RIDER_)/.test(p.name)).map(p => {
      const all = [p, ...kids(p.name)], lo = [0, 1, 2].map(i => Math.min(...all.map(q => q.lo[i]))), hi = [0, 1, 2].map(i => Math.max(...all.map(q => q.hi[i])));
      return { part: p, name: p.name, rider: p.name.startsWith('RIDER_'), mass: all.reduce((m, q) => m + q.mass, 0), lo, hi, body: null };
    });
    const loose = pieces.reduce((m, pc) => m + pc.mass, 0);
    const lean = S.rig === 'bike' ? -(car.lean || 0) : 0;
    const q0 = W.qmul(W.yawQ(pose.heading), [Math.sin(lean / 2), 0, 0, Math.cos(lean / 2)]);
    const hull = sim.add({ kind: 'chunk', key: S.key, p: [pose.x, car.y, pose.z], q: q0, v: [car.vx, car.vy || 0, car.vz], w: [0, -car.yaw, 0],
      m: S.massKg - loose, lo: S.lo, hi: S.hi, rMax: 0.3 });
    hull.clan = 1;
    const F = { t: [], axes: [], unitAxes: [[]] }, poses = [], events = [], debris = [];
    let T0 = -1, riderAt = -1;
    function detach(pc, t, dv) {
      const piv = pc.part.pivot, r = W.rot(hull.q, piv, [0, 0, 0]);
      const p = [hull.p[0] + r[0], hull.p[1] + r[1], hull.p[2] + r[2]];
      const wr = [hull.w[1] * r[2] - hull.w[2] * r[1], hull.w[2] * r[0] - hull.w[0] * r[2], hull.w[0] * r[1] - hull.w[1] * r[0]];
      const kick = pc.rider ? 0.15 : 0.5;   // pieces scatter; the rider carries on over the front
      const v = [hull.v[0] + wr[0] + (rnd() - 0.5) * 4 * kick, hull.v[1] + wr[1] + 1.5 + rnd() * 2, hull.v[2] + wr[2] + (rnd() - 0.5) * 4 * kick];
      pc.body = sim.add({ kind: 'chunk', key: pc.name, p, q: hull.q.slice(), v, w: [(rnd() - 0.5) * 8, (rnd() - 0.5) * 8, (rnd() - 0.5) * 8], m: Math.max(0.5, pc.mass),
        lo: pc.lo.map((x, i) => x - piv[i]), hi: pc.hi.map((x, i) => x - piv[i]), rMax: 0.2 });
      if (pc.rider) { pc.body.clan = 1; riderAt = t; }
      debris.push({ name: pc.name, kind: pc.rider ? 'rider' : 'part', t });
      events.push({ t, type: 'detach', x: p[0], y: p[1], z: p[2], mass: pc.mass, mag: dv * 300, part: pc.name });
    }
    for (let i = 0, t = 0; i <= 192; i++, t += DT) {
      if (i > 0) {
        const { events: ev } = sim.step(DT);
        for (const e of ev) {
          if (e.type !== 'hit' || e.body !== hull) continue;
          if (T0 < 0) {
            T0 = t;
            events.push({ t, type: 'first', x: e.x, y: e.y, z: e.z, mag: e.dv * 300 });
            if (S.rig === 'bike') {   // over it goes: a roll, and the nose pitched down
              const side = rnd() < 0.5 ? -1 : 1, f = W.rot(hull.q, [1, 0, 0], [0, 0, 0]);
              sim.applyImpulse(hull, [0, 0.7, 0], [-f[2] * side * hull.m * 3, hull.m * 1.5, f[0] * side * hull.m * 3]);
            }
          } else events.push({ t, type: 'contact', x: e.x, y: e.y, z: e.z, mag: e.dv * 300 });
          for (const pc of pieces) if (!pc.body && (pc.rider ? e.dv > 3 : e.dv >= (pc.part.breakDv || 99))) detach(pc, t, e.dv);
        }
        if (riderAt >= 0 && t - riderAt > 0.4) for (const pc of pieces) if (pc.rider && pc.body) pc.body.clan = 0;
      }
      const f = W.rot(hull.q, [1, 0, 0], [0, 0, 0]), u = W.rot(hull.q, [0, 1, 0], [0, 0, 0]);
      const ax = [hull.p[0], hull.p[1], hull.p[2], f[0], f[1], f[2], u[0], u[1], u[2]];
      F.t.push(t); F.axes.push(ax); F.unitAxes[0].push(ax);
      poses.push([hull.p.concat(hull.q)].concat(pieces.map(pc => pc.body ? pc.body.p.concat(pc.body.q) : null)));
    }
    const view = { rigid: true, frames: { t: F.t, axes: F.axes, poses }, pieces: pieces.map(pc => pc.name) };
    return { mode: 'rigid', F, T0: T0 < 0 ? 0 : T0, t: F.t[F.t.length - 1], events, debris, glass: [], done: true, result: null, lift: 0,
      cfg: { units: [{ key: S.key }] }, firstFrameMs: 0, tick() {}, stop() {}, unitView: () => view };
  }

  return { spec, isRig, crash };
})();
if (typeof module === 'object' && module.exports) module.exports = RaceRigs;
