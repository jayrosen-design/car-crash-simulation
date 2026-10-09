/* The Destruction mode's traffic: the junction's schedule driven along straight lanes.
 *
 * Each vehicle follows its lane at the speed the Intelligent Driver Model gives it (as the Race
 * game's traffic: free-road speed v0, a safe time gap, comfortable braking), behind the vehicle
 * ahead and, on red, behind the stop line. Wrecks in its lane (and the player's car, once it has
 * crashed) are noticed late: each driver sees them only within its own attention distance, and
 * brakes no harder than 5.5 m/s², so the traffic keeps piling into a crash, as in Burnout. The
 * vehicles are the world's kinematic bodies (world.js) until something hits them; then the game
 * takes them out of the traffic (release) and makes them wrecks.
 *
 * The same every attempt: reset() rebuilds the street from the schedule and runs it from the
 * schedule's warm-up time to the start of the countdown.
 *
 * Vehicle types: the two cars (the crash solver's Lexus and Mustang specs) and three heavy ones
 * (HEAVY: a city bus, a box truck, a gas tanker), with simple specs of their own.
 *
 * DOM-free: global DestructionTraffic in the browser, module.exports in Node.
 */
const DestructionTraffic = (() => {
  'use strict';
  const IDM = { a: 1.6, b: 3, s0: 3, T: 1.3 };
  const BRAKE_MAX = 5.5;        // m/s²: the hardest a driver brakes for a wreck it noticed late
  // the heavy vehicles: size (m), mass (kg); origin at the middle of the box
  const HEAVY = {
    bus: { length: 12, width: 2.55, height: 3.2, massKg: 12000, wheelRadius: 0.52, front: 2.3, rear: 3.3 },
    truck: { length: 8.4, width: 2.45, height: 3.5, massKg: 7500, wheelRadius: 0.48, front: 1.5, rear: 2.0 },
    tanker: { length: 13, width: 2.5, height: 3.5, massKg: 18000, wheelRadius: 0.52, front: 1.4, rear: 1.6 },
  };
  function heavySpec(key) {
    const H = HEAVY[key], L = H.length, W = H.width, r = H.wheelRadius, fx = L / 2 - H.front, rx = -L / 2 + H.rear, z = W / 2 - 0.3;
    return { key, label: key, length: L, width: W, height: H.height, xMin: -L / 2, massKg: H.massKg, wheelRadius: r,
      hubs: { FL: [fx, r, -z], FR: [fx, r, z], RL: [rx, r, -z], RR: [rx, r, z] } };
  }
  // the box centre's offset ahead of the model's origin
  const centreOff = (spec) => spec.xMin + spec.length / 2;

  /* level: junction.js; world: world.js; opts: { specs: { lexus, mustang } (CrashVehicles specs) }
   * -> { vehicles, reset(), step(dt, t, obstacles), release(v), spec(type), HEAVY } */
  function create(level, world, opts = {}) {
    const specs = Object.assign({}, opts.specs);
    for (const k in HEAVY) specs[k] = heavySpec(k);
    const lanes = {};
    for (const L of level.lanes) lanes[L.id] = L;
    const vehicles = [];
    let next = 0, t = level.warmup, serial = 0;
    const waiting = [];   // schedule entries due but not on the street yet

    // a driver's attention (m ahead it notices a wreck): from the schedule entry, the same every time
    const attention = (i) => { const u = ((i * 2654435761) >>> 0) / 4294967296; return u < 0.6 ? 6 + 12 * u : 18 + 16 * u; };

    function place(v) {
      const L = v.lane, p = L.at(v.s), c = Math.cos(L.h), s = Math.sin(L.h), off = centreOff(v.spec);
      v.body.car.setKinematic(p.x - c * off, p.z - s * off, L.h, v.v);
    }
    function spawn(e, idx) {
      const L = lanes[e.lane], spec = specs[e.type];
      const car = RaceCar.create(spec);
      const v = { id: serial++, type: e.type, key: e.type, heavy: !!HEAVY[e.type], lane: L, s: 0, v: e.v, v0: e.v, paint: e.paint, spec, len: spec.length, attention: attention(idx), entry: e };
      v.body = world.add(car, { kinematic: true, kind: 'traffic', height: spec.height || 1.45, user: v });
      v.body.traffic = v;
      return v;
    }
    function remove(v) {
      const i = world.bodies.indexOf(v.body);
      if (i >= 0) { world.bodies.splice(i, 1); world.bodies.forEach((b, k) => { b.id = k; }); }
      const j = vehicles.indexOf(v);
      if (j >= 0) vehicles.splice(j, 1);
    }

    // rebuild from the schedule and run to the start of the countdown (t = -3)
    function reset(until = -3) {
      for (const v of vehicles.slice()) remove(v);
      next = 0; t = level.warmup; serial = 0; waiting.length = 0;
      const sched = level.schedule;
      // queued at a red light: nose to tail behind the stop line
      const tail = {};
      while (next < sched.length && sched[next].queue) {
        const e = sched[next], v = spawn(e, next);
        const back = tail[e.lane] === undefined ? v.lane.stop - 1.5 : tail[e.lane] - 2.6;
        v.s = back - v.len / 2; v.v = 0;
        tail[e.lane] = v.s - v.len / 2;
        vehicles.push(v); place(v);
        next++;
      }
      while (t < until - 1e-9) step(Math.min(1 / 30, until - t), t, []);
    }

    // the gap (m, bumper to bumper) to what the vehicle must not run into ahead, and its speed
    function ahead(v, obstacles) {
      const L = v.lane;
      let gap = Infinity, vl = 0;
      for (const o of vehicles) {
        if (o === v || o.lane !== L || o.s <= v.s) continue;
        const g = o.s - v.s - (o.len + v.len) / 2;
        if (g < gap) { gap = g; vl = o.v; }
      }
      // the stop line, on red, if it can still stop for it
      const front = v.s + v.len / 2;
      if (level.signal(L.light, t) === 'red' && front <= L.stop + 0.5) { const g = L.stop - front; if (g < gap) { gap = Math.max(0.01, g); vl = 0; } }
      // wrecks and anything else in the lane, once noticed
      const c = Math.cos(L.h), s = Math.sin(L.h), p = L.at(v.s);
      for (const o of obstacles) {
        const dx = o.x - p.x, dz = o.z - p.z, along = dx * c + dz * s, across = Math.abs(-dx * s + dz * c);
        if (along <= 0 || across > o.r + 1.6) continue;
        const g = along - o.r - v.len / 2;
        if (g > v.attention) continue;
        if (g < gap) { gap = Math.max(0.01, g); vl = 0; }
      }
      return [gap, vl];
    }

    function step(dt, now, obstacles) {
      t = now + dt;
      // newcomers: due ones join the waiting list; each enters when its lane's entry is clear
      // (in schedule order within a lane)
      const sched = level.schedule;
      while (next < sched.length && sched[next].t <= t) { waiting.push(next); next++; }
      const held = new Set();
      for (let w = 0; w < waiting.length; w++) {
        const idx = waiting[w], e = sched[idx], L = lanes[e.lane];
        if (held.has(L) || vehicles.some(o => o.lane === L && o.s - o.len / 2 < specs[e.type].length + 4)) { held.add(L); continue; }
        const v = spawn(e, idx);
        v.s = v.len / 2;
        vehicles.push(v); place(v);
        waiting.splice(w--, 1);
      }
      for (const v of vehicles.slice()) {
        const [gap, vl] = ahead(v, obstacles || []);
        let a = IDM.a * (1 - Math.pow(v.v / v.v0, 4));
        if (gap < Infinity) {
          const sStar = IDM.s0 + Math.max(0, v.v * IDM.T + v.v * (v.v - vl) / (2 * Math.sqrt(IDM.a * IDM.b)));
          a -= IDM.a * Math.pow(sStar / Math.max(gap, 0.1), 2);
        }
        a = Math.max(-BRAKE_MAX, a);
        v.v = Math.max(0, v.v + a * dt);
        v.s += v.v * dt;
        if (v.s - v.len / 2 > v.lane.len) { remove(v); continue; }
        place(v);
      }
    }

    // take a vehicle out of the traffic (it's been hit: the game makes it a wreck). Its world body
    // is removed as well.
    function release(v) { remove(v); }

    return { vehicles, reset, step, release, spec: (type) => specs[type], get t() { return t; }, HEAVY };
  }

  return { create, HEAVY, heavySpec };
})();
if (typeof module === 'object' && module.exports) module.exports = DestructionTraffic;
