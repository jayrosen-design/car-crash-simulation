/* The Race game's world: cars on the level, their collisions, and when a hit is a crash.
 *
 * Each car is an oriented box of its length and width (the crash solver's lattice has exactly that
 * envelope). Against the level's boxes (buildings, barriers) and cylinders (trees), and against
 * each other, contacts are found by the separating-axis test and
 * resolved with impulses: restitution and Coulomb friction at the contact point, so a glancing hit
 * scrapes and turns the car and a square one stops it. Walls are slippery (as in Burnout), and a car
 * already spinning hard is not spun harder by a wall, so it grinds along it. A hit is a crash when
 * the approach speed along the contact normal passes a limit (CRASH), and on a wall only when the car
 * meets it nose or tail first (within 45 degrees of square): sliding into a wall sideways is a
 * bounce. Then the game hands the cars over to the full crash solver from their state one step
 * earlier, just before they touched (history()).
 *
 * Car against car, the push-out is shared by mass, and a driver steering into the other car shoves
 * it (a push on top of the impulse, growing with the steering). A wrecked car (body.wrecked) is
 * shoved out of the way by a driving car without slowing it.
 *
 * Cars are RaceCar bodies (vehicle.js). Traffic can be kinematic (set by its driver each step)
 * until something hits it; then it becomes a free body. Cars follow the level's hills and ramps and
 * can fly off them (vertical()); a car in the air clears low colliders and other cars.
 *
 * Rivals still crash at the CRASH limits; the player has a health bar instead (game.js), and
 * damage() turns a hit's change of speed into a share of it.
 *
 * DOM-free: global RaceWorld in the browser, module.exports in Node.
 */
const RaceWorld = (() => {
  'use strict';
  // m/s of approach along the contact normal that wrecks a car; rivals jostling each other (pack) take more
  const CRASH = { wall: 13, car: 13.5, pack: 20 };
  const E_WALL = 0.12, E_CAR = 0.2, MU_WALL = 0.15, MU_CAR = 0.3;
  const SQUARE = 0.7;       // |cos| of the angle between the car's heading and a wall's normal: nose or tail first
  const SHOVE = 12;         // m/s² of push from a car steering fully into another (times its mass)
  const HISTORY = 12;                       // steps kept for the crash hand-over
  const G = 9.81, FLAT = { h: 0, gx: 0, gz: 0 };
  // the player's damage (a share of the health bar) from a hit that changes the car's speed by dv
  // m/s: nothing for scrapes and nudges under 2.5 m/s, about a fifth for a square hit on a wall at
  // 13 m/s (47 km/h), all of it from about 25 m/s (90 km/h)
  const damage = (dv) => Math.max(0, dv - 2.5) ** 2 / 650;
  // ... from a contact event, at its first touch: the approach speed along the normal, with the
  // bounce; against another car, the share of the change of speed this car takes (by mass); against
  // a wall, full nose or tail first, down to 0.4 of it sliding in sideways
  function hitDamage(e, b) {
    if (e.kind === 'land') return 0;
    let dv = e.vn * (e.kind === 'car' ? 1 + E_CAR : 1 + E_WALL);
    if (e.kind === 'car') { const o = e.a === b ? e.b : e.a; dv *= o.car.m / (o.car.m + b.car.m); }
    if (e.kind === 'wall') dv *= 0.4 + 0.6 * Math.min(1, e.sq / SQUARE);
    return damage(dv);
  }

  function create(level) {
    const bodies = [];
    const events = [];        // contacts this step: { a, b (body or null), kind: 'wall'|'post'|'car'|'land', vn, x, z, nx, nz, crash, J; walls: sq; cars: ua, ub }
    const hist = [];          // ring of snapshots
    let tick = 0;

    // opts.height: how tall it is (a bus or tanker in the Destruction mode; cars: 1.2 m for
    // telling one flying over another)
    function add(car, opts = {}) {
      const b = { car, kind: opts.kind || 'racer', kinematic: !!opts.kinematic, id: bodies.length, ghost: 0, wrecked: false, user: opts.user || null };
      // how far its box reaches from its centre of gravity (for the broad phase)
      const s = car.spec;
      b.reach = Math.abs(s.xMin + s.length / 2 - car.cgX) + Math.hypot(s.length / 2, s.width / 2);
      if (opts.height) b.top = opts.height;
      bodies.push(b);
      return b;
    }
    // the car's box: centre, axes, half sizes
    function box(b, out) {
      const c = b.car, s = c.spec, ch = Math.cos(c.h), sh = Math.sin(c.h);
      const off = s.xMin + s.length / 2 - c.cgX;     // box centre ahead of the centre of gravity
      out.x = c.x + ch * off; out.z = c.z + sh * off; out.ux = ch; out.uz = sh; out.hx = s.length / 2; out.hz = s.width / 2;
      return out;
    }
    const BA = {}, BB = {};

    // ---------------------------------------------------------------- static contacts
    function vsBox(b, A, o) {
      // separating axes: the car's two and the box's two
      const oc = Math.cos(o.angle), os = Math.sin(o.angle);
      const axes = [[A.ux, A.uz], [-A.uz, A.ux], [oc, os], [-os, oc]];
      const dx = A.x - o.x, dz = A.z - o.z;
      let best = Infinity, nx = 0, nz = 0;
      for (const [ux, uz] of axes) {
        const ra = A.hx * Math.abs(A.ux * ux + A.uz * uz) + A.hz * Math.abs(-A.uz * ux + A.ux * uz);
        const rb = o.hx * Math.abs(oc * ux + os * uz) + o.hz * Math.abs(-os * ux + oc * uz);
        const d = dx * ux + dz * uz, pen = ra + rb - Math.abs(d);
        if (pen <= 0) return null;
        if (pen < best) { best = pen; const sg = d < 0 ? -1 : 1; nx = ux * sg; nz = uz * sg; }   // normal from the box toward the car
      }
      const P = deepest(A, { x: o.x, z: o.z, ux: oc, uz: os, hx: o.hx, hz: o.hz });
      return { nx, nz, depth: best, px: P[0], pz: P[1] };
    }
    // signed distance of a point to a box (negative inside)
    function boxDist(X, px, pz) {
      const dx = px - X.x, dz = pz - X.z;
      return Math.max(Math.abs(dx * X.ux + dz * X.uz) - X.hx, Math.abs(-dx * X.uz + dz * X.ux) - X.hz);
    }
    // the contact point of two overlapping boxes: the corner of either lying deepest inside the other,
    // or the middle of the corners within 2 cm of that (a side flat against a wall: its middle, not
    // one end or the other from step to step)
    const CORNERS = [[1, 1], [1, -1], [-1, 1], [-1, -1]], PT = [0, 0], CD = new Float64Array(24);
    function deepest(A, B) {
      let best = Infinity, n = 0;
      for (const [X, Y] of [[A, B], [B, A]]) for (const [u, w] of CORNERS) {
        const x = X.x + X.ux * u * X.hx - X.uz * w * X.hz, z = X.z + X.uz * u * X.hx + X.ux * w * X.hz, d = boxDist(Y, x, z);
        CD[n++] = x; CD[n++] = z; CD[n++] = d;
        if (d < best) best = d;
      }
      let sx = 0, sz = 0, k = 0;
      for (let i = 0; i < n; i += 3) if (CD[i + 2] < best + 0.02) { sx += CD[i]; sz += CD[i + 1]; k++; }
      PT[0] = sx / k; PT[1] = sz / k;
      return PT;
    }
    function vsCyl(b, A, q) {
      // nearest point of the car's box to the post's centre
      const dx = q.x - A.x, dz = q.z - A.z, u = Math.max(-A.hx, Math.min(A.hx, dx * A.ux + dz * A.uz)), w = Math.max(-A.hz, Math.min(A.hz, -dx * A.uz + dz * A.ux));
      const px = A.x + A.ux * u - A.uz * w, pz = A.z + A.uz * u + A.ux * w;
      let ex = px - q.x, ez = pz - q.z, d = Math.hypot(ex, ez);
      if (d >= q.r) return null;
      if (d < 1e-6) { ex = A.x - q.x; ez = A.z - q.z; d = Math.hypot(ex, ez) || 1; return { nx: ex / d, nz: ez / d, depth: q.r, px, pz }; }
      return { nx: ex / d, nz: ez / d, depth: q.r - d, px, pz };
    }
    function resolveStatic(b, hit, kind) {
      const c = b.car, rx = hit.px - c.x, rz = hit.pz - c.z;
      // push out, then cancel the approach (impulse with restitution and friction)
      c.x += hit.nx * (hit.depth + 0.002); c.z += hit.nz * (hit.depth + 0.002);
      const vx = c.vx - c.yaw * rz, vz = c.vz + c.yaw * rx, vn = vx * hit.nx + vz * hit.nz;
      if (vn >= 0) return;
      const rn = rx * hit.nz - rz * hit.nx, kn = 1 / c.m + rn * rn / c.Izz;
      const J = -(1 + E_WALL) * vn / kn;
      const tx = -hit.nz, tz = hit.nx, vt = vx * tx + vz * tz, rt = rx * tz - rz * tx, kt = 1 / c.m + rt * rt / c.Izz;
      const Jt = Math.max(-MU_WALL * J, Math.min(MU_WALL * J, -vt / kt));
      const jx = J * hit.nx + Jt * tx, jz = J * hit.nz + Jt * tz;
      // a car already spinning hard is not spun harder: the impulse at its centre of gravity instead
      const spinUp = (rx * jz - rz * jx) * c.yaw > 0 && Math.abs(c.yaw) > 2.5;
      c.applyImpulse(spinUp ? c.x : hit.px, spinUp ? c.z : hit.pz, jx, jz);
      const sq = Math.abs(Math.cos(c.h) * hit.nx + Math.sin(c.h) * hit.nz);
      events.push({ a: b, b: null, kind, vn: -vn, x: hit.px, z: hit.pz, nx: hit.nx, nz: hit.nz, sq, crash: -vn > CRASH.wall && (kind !== 'wall' || sq > SQUARE) && !b.ghost, J });
    }

    // ---------------------------------------------------------------- car against car
    function vsCar(A, B) {
      const axes = [[A.ux, A.uz], [-A.uz, A.ux], [B.ux, B.uz], [-B.uz, B.ux]];
      const dx = A.x - B.x, dz = A.z - B.z;
      let best = Infinity, nx = 0, nz = 0;
      for (const [ux, uz] of axes) {
        const ra = A.hx * Math.abs(A.ux * ux + A.uz * uz) + A.hz * Math.abs(-A.uz * ux + A.ux * uz);
        const rb = B.hx * Math.abs(B.ux * ux + B.uz * uz) + B.hz * Math.abs(-B.uz * ux + B.ux * uz);
        const d = dx * ux + dz * uz, pen = ra + rb - Math.abs(d);
        if (pen <= 0) return null;
        if (pen < best) { best = pen; const sg = d < 0 ? -1 : 1; nx = ux * sg; nz = uz * sg; }   // from B toward A
      }
      const P = deepest(A, B);
      return { nx, nz, depth: best, px: P[0], pz: P[1] };
    }
    // how far a car is steering toward the side where point (x, z) lies: 0..1 (its lock narrows with speed)
    function steerToward(c, x, z) {
      const side = (x - c.x) * -Math.sin(c.h) + (z - c.z) * Math.cos(c.h);
      const lock = c.tune ? c.tune.steer / (1 + Math.abs(c.forward) / 14) + 0.035 : 0.5;
      return Math.max(0, Math.min(1, Math.sign(side) * c.steer / lock));
    }
    function resolveCars(a, b, hit, dt) {
      // a driving car meets a wreck as if it couldn't be moved: the wreck takes the push and the impulse
      const fixA = a.kinematic || (b.wrecked && !a.wrecked), fixB = b.kinematic || (a.wrecked && !b.wrecked);
      const A = a.car, B = b.car, ma = fixA ? Infinity : A.m, mb = fixB ? Infinity : B.m;
      const wa = fixA ? 0 : 1, wb = fixB ? 0 : 1;
      // the push-out shared by mass: the lighter car moves more
      const sa = !wa ? 0 : !wb ? 1 : B.m / (A.m + B.m), sb = !wb ? 0 : !wa ? 1 : A.m / (A.m + B.m);
      A.x += hit.nx * (hit.depth + 0.002) * sa; A.z += hit.nz * (hit.depth + 0.002) * sa;
      B.x -= hit.nx * (hit.depth + 0.002) * sb; B.z -= hit.nz * (hit.depth + 0.002) * sb;
      // a driver steering into the other car shoves it, for as long as it presses on it
      const fa = wb && !a.wrecked ? steerToward(A, B.x, B.z) : 0, fb = wa && !b.wrecked ? steerToward(B, A.x, A.z) : 0;
      if (fa > 0) B.applyImpulse(hit.px, hit.pz, -hit.nx * SHOVE * fa * A.m * dt, -hit.nz * SHOVE * fa * A.m * dt);
      if (fb > 0) A.applyImpulse(hit.px, hit.pz, hit.nx * SHOVE * fb * B.m * dt, hit.nz * SHOVE * fb * B.m * dt);
      const rax = hit.px - A.x, raz = hit.pz - A.z, rbx = hit.px - B.x, rbz = hit.pz - B.z;
      const vax = A.vx - A.yaw * raz, vaz = A.vz + A.yaw * rax, vbx = B.vx - B.yaw * rbz, vbz = B.vz + B.yaw * rbx;
      const rvx = vax - vbx, rvz = vaz - vbz, vn = rvx * hit.nx + rvz * hit.nz;
      if (vn >= 0) return;
      const ran = rax * hit.nz - raz * hit.nx, rbn = rbx * hit.nz - rbz * hit.nx;
      const kn = (wa ? 1 / ma + ran * ran / A.Izz : 0) + (wb ? 1 / mb + rbn * rbn / B.Izz : 0);
      if (kn <= 0) return;
      const J = -(1 + E_CAR) * vn / kn;
      const tx = -hit.nz, tz = hit.nx, vt = rvx * tx + rvz * tz;
      const rat = rax * tz - raz * tx, rbt = rbx * tz - rbz * tx;
      const kt = (wa ? 1 / ma + rat * rat / A.Izz : 0) + (wb ? 1 / mb + rbt * rbt / B.Izz : 0);
      const Jt = Math.max(-MU_CAR * J, Math.min(MU_CAR * J, -vt / kt));
      const jx = J * hit.nx + Jt * tx, jz = J * hit.nz + Jt * tz;
      if (wa) A.applyImpulse(hit.px, hit.pz, jx, jz);
      if (wb) B.applyImpulse(hit.px, hit.pz, -jx, -jz);
      const lim = a.kind === 'rival' && b.kind === 'rival' && !a.wrecked && !b.wrecked ? CRASH.pack : CRASH.car;
      // ua, ub: how fast each car was moving toward the other before the hit (who drove into whom)
      events.push({ a, b, kind: 'car', vn: -vn, x: hit.px, z: hit.pz, nx: hit.nx, nz: hit.nz, ua: -(vax * hit.nx + vaz * hit.nz), ub: vbx * hit.nx + vbz * hit.nz, crash: -vn > lim && !a.ghost && !b.ghost, J });
    }

    // ---------------------------------------------------------------- over hills and ramps
    // A car follows the ground under its centre of gravity until the ground falls away faster than
    // gravity can pull it down (a ramp's lip, a crest taken fast); then it flies, without grip
    // (vehicle.js), and lands. On the ground gravity pulls it along the slope. Kinematic traffic
    // keeps to the ground.
    const GR = {};
    function vertical(b, dt) {
      const c = b.car, g = level.groundAt ? level.groundAt(c.x, c.z, GR) : FLAT;
      if (c.snap || b.kinematic) { c.y = g.h; c.vy = 0; c.air = false; c.snap = false; }
      else if (!c.air) {
        c.vx -= G * g.gx * dt; c.vz -= G * g.gz * dt;
        // the vertical speed the ground asks for: how far it rose this step, but no more than its slope
        // gives (2 m/s either way). Driving onto a ramp from the side, the ground jumps up by the
        // ramp's height in one step: the car climbs onto it, but isn't fired upward at hundreds of m/s
        const vyS = g.gx * c.vx + g.gz * c.vz, vyG = Math.max(vyS - 2, Math.min(vyS + 2, (g.h - c.y) / dt));
        if ((c.vy - vyG) / dt > G * 1.05) { c.air = true; c.vy -= G * dt; c.y += c.vy * dt; }   // takes off
        else { c.vy = vyG; c.y = g.h; }
      } else {
        c.vy -= G * dt; c.y += c.vy * dt;
        if (c.y <= g.h) {
          const vyG = g.gx * c.vx + g.gz * c.vz, impact = vyG - c.vy;   // how fast it meets the ground
          c.y = g.h; c.vy = vyG; c.air = false;
          events.push({ a: b, b: null, kind: 'land', vn: impact, x: c.x, z: c.z, nx: 0, nz: 0, crash: false, J: 0 });
        }
      }
      // pitch and roll to draw: the ground's; in the air, the nose along the flight path
      const ch = Math.cos(c.h), sh = Math.sin(c.h);
      let tp = 0, tr = 0;
      if (c.air) tp = Math.max(-0.45, Math.min(0.45, Math.atan2(c.vy, Math.max(5, Math.abs(c.vx * ch + c.vz * sh)))));
      else { tp = Math.atan(g.gx * ch + g.gz * sh); tr = -Math.atan(-g.gx * sh + g.gz * ch); }
      const k = 1 - Math.exp(-dt * (c.air ? 3 : 14));
      c.gPitch += (tp - c.gPitch) * k; c.gRoll += (tr - c.gRoll) * k;
    }
    // how high a car is above the ground it would hit a collider on (terrain only: no ramps there)
    const above = (c) => c.y - (level.terrain ? level.terrain(c.x, c.z) : 0);

    // ---------------------------------------------------------------- the step
    /* inputs(body) -> the driving input for a non-kinematic body this step */
    function step(dt, inputs) {
      events.length = 0;
      snapshot();
      for (const b of bodies) {
        if (b.frozen) continue;
        if (!b.kinematic) b.car.step(dt, inputs(b) || {});
        vertical(b, dt);
        if (b.ghost > 0) b.ghost = Math.max(0, b.ghost - dt);
      }
      // static contacts (twice: a corner can be pushed into a neighbouring shape); a car in the air
      // clears the low ones
      for (const b of bodies) {
        if (b.kinematic || b.frozen) continue;
        for (let pass = 0; pass < 2; pass++) {
          const A = box(b, BA);
          for (const o of level.collidersNear(A.x, A.z, A.hx + 1)) {
            if (b.car.air && above(b.car) > o.height - 0.3) continue;
            const hit = o.box ? vsBox(b, A, o) : vsCyl(b, A, o);
            if (hit) { resolveStatic(b, hit, o.box ? 'wall' : 'post'); box(b, A); }
          }
        }
      }
      // cars against each other: broad phase by distance (7 m, or more for a bus or truck)
      for (let i = 0; i < bodies.length; i++) {
        const a = bodies[i];
        if (a.frozen) continue;
        for (let j = i + 1; j < bodies.length; j++) {
          const b = bodies[j];
          if (b.frozen || (a.kinematic && b.kinematic)) continue;
          if (a.ghost || b.ghost) continue;
          const dx = a.car.x - b.car.x, dz = a.car.z - b.car.z, r = a.reach + b.reach;
          if (dx * dx + dz * dz > (r * r > 49 ? r * r : 49)) continue;
          const dy = a.car.y - b.car.y;
          if (dy > (b.top || 1.2) || -dy > (a.top || 1.2)) continue;   // one flying over the other
          const A = box(a, BA), B = box(b, BB), hit = vsCar(A, B);
          if (!hit) continue;
          // a hit traffic car becomes a free body
          if (a.kinematic) a.kinematic = false;
          if (b.kinematic) b.kinematic = false;
          resolveCars(a, b, hit, dt);
        }
      }
      tick++;
      return events;
    }

    // ---------------------------------------------------------------- history for the hand-over
    const FIELDS = ['x', 'z', 'h', 'vx', 'vz', 'yaw', 'steer', 'ax', 'ay', 'pitch', 'roll', 'y', 'vy', 'air', 'gPitch', 'gRoll'];   // (height and flight too: a crash in the air)
    function snapshot() {
      const snap = { tick, cars: bodies.map(b => { const o = { kinematic: b.kinematic }; for (const f of FIELDS) o[f] = b.car[f]; return o; }) };
      hist.push(snap);
      if (hist.length > HISTORY) hist.shift();
    }
    // the state of body b `back` steps ago (1 = at the start of this step: before the contact)
    function history(b, back = 1) {
      const s = hist[hist.length - back];
      return s && s.cars[b.id];
    }
    function restore(b, back = 1) {
      const st = history(b, back);
      if (!st) return false;
      for (const f of FIELDS) b.car[f] = st[f];
      return true;
    }

    return { bodies, add, step, events, box: (b) => box(b, {}), history, restore, CRASH, get tick() { return tick; } };
  }

  // the box of a car spec at a pose (for spawning clear of other cars)
  return { create, CRASH, damage, hitDamage };
})();
if (typeof module === 'object' && module.exports) module.exports = RaceWorld;
