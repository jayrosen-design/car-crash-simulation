/* The Race game's props: things in the street that cars knock over instead of crashing into.
 *
 * Street lights and signal posts break off their bases and topple away from the car; cones, bins,
 * newspaper boxes, hydrants, benches, crates and barrels fly, tumble and roll. Each prop is a box
 * (its kind's half sizes, centre hy above its base) and a rigid body: position, velocity,
 * orientation (quaternion) and angular velocity, under gravity, at 120 Hz. Its corners meet the
 * ground (hills and ramps, level.groundAt) and the buildings, barriers and trees with impulses
 * (restitution, friction); props push each other apart as spheres. A prop at rest goes to sleep
 * and costs nothing until something hits it.
 *
 * A car hitting a prop: the two exchange momentum along the contact normal (the prop also gets a
 * kick upward and a spin), so a cone flies off at about the car's speed and a 140 kg street light
 * takes a few km/h off a 2 t car. No crash; step() reports the hits (for sound, sparks, boost, and
 * the change of speed, for damage).
 *
 * DOM-free: global RaceProps in the browser, module.exports in Node.
 */
const RaceProps = (() => {
  'use strict';
  const G = 9.81, DT = 1 / 120, CELL = 6;
  // half sizes (m) of each kind's collision box, mass (kg), restitution and friction on the ground
  const TYPES = {
    lamp: { hx: 0.14, hy: 4.0, hz: 0.14, m: 140, e: 0.05, mu: 0.6, pole: true, metal: true },
    signal: { hx: 0.15, hy: 3.0, hz: 0.15, m: 110, e: 0.05, mu: 0.6, pole: true, metal: true },
    cone: { hx: 0.21, hy: 0.36, hz: 0.21, m: 4, e: 0.35, mu: 0.7 },
    bin: { hx: 0.3, hy: 0.5, hz: 0.3, m: 28, e: 0.3, mu: 0.5, metal: true },
    newsbox: { hx: 0.26, hy: 0.55, hz: 0.24, m: 35, e: 0.25, mu: 0.5, metal: true },
    hydrant: { hx: 0.2, hy: 0.4, hz: 0.2, m: 90, e: 0.2, mu: 0.6, metal: true },
    bench: { hx: 0.9, hy: 0.42, hz: 0.3, m: 45, e: 0.25, mu: 0.6 },
    crate: { hx: 0.4, hy: 0.4, hz: 0.4, m: 16, e: 0.3, mu: 0.6 },
    barrel: { hx: 0.3, hy: 0.45, hz: 0.3, m: 24, e: 0.35, mu: 0.4, metal: true },
  };
  const CORNERS = [];
  for (const a of [-1, 1]) for (const b of [-1, 1]) for (const c of [-1, 1]) CORNERS.push([a, b, c]);

  // ---------------------------------------------------------------- small vector and quaternion maths
  // rotate v by the unit quaternion q = [x, y, z, w] into out
  function rot(q, v, out) {
    const [x, y, z, w] = q, [vx, vy, vz] = v;
    const tx = 2 * (y * vz - z * vy), ty = 2 * (z * vx - x * vz), tz = 2 * (x * vy - y * vx);
    out[0] = vx + w * tx + y * tz - z * ty; out[1] = vy + w * ty + z * tx - x * tz; out[2] = vz + w * tz + x * ty - y * tx;
    return out;
  }
  const conj = (q) => [-q[0], -q[1], -q[2], q[3]];
  const cross = (a, b) => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
  const dot = (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];

  function create(level, opts = {}) {
    const list = [];
    const grid = new Map(), key = (i, j) => i * 100003 + j;
    const cellOf = (pr) => key(Math.floor(pr.p[0] / CELL), Math.floor(pr.p[2] / CELL));
    function file(pr) {
      const k = cellOf(pr);
      if (k === pr.cell) return;
      if (pr.cell !== undefined) { const a = grid.get(pr.cell); a.splice(a.indexOf(pr), 1); }
      if (!grid.has(k)) grid.set(k, []);
      grid.get(k).push(pr); pr.cell = k;
    }
    const G0 = {};
    for (const o of level.props || []) {
      const T = TYPES[o.type];
      if (!T) continue;
      const base = level.groundAt ? level.groundAt(o.x, o.z, G0).h : 0, a = -o.h / 2;
      // inverse inertia of a box about its own axes
      const I = [3 / (T.m * (T.hy * T.hy + T.hz * T.hz)), 3 / (T.m * (T.hx * T.hx + T.hz * T.hz)), 3 / (T.m * (T.hx * T.hx + T.hy * T.hy))];
      const pr = { id: list.length, type: o.type, T, Iinv: I, p: [o.x, base + o.y + T.hy, o.z], q: [0, Math.sin(a), 0, Math.cos(a)], v: [0, 0, 0], w: [0, 0, 0],
        awake: false, still: 0, awakeT: 0, moved: false, dirty: true, hit: 0, cell: undefined };
      list.push(pr);
      file(pr);
    }
    function near(x, z, r, out) {
      out.length = 0;
      for (let i = Math.floor((x - r) / CELL); i <= Math.floor((x + r) / CELL); i++) for (let j = Math.floor((z - r) / CELL); j <= Math.floor((z + r) / CELL); j++) {
        const a = grid.get(key(i, j));
        if (a) for (const pr of a) out.push(pr);
      }
      return out;
    }
    // inverse inertia (world) applied to a vector
    const T1 = [0, 0, 0], T2 = [0, 0, 0];
    function invI(pr, v) {
      const qc = conj(pr.q);
      rot(qc, v, T1);
      T1[0] *= pr.Iinv[0]; T1[1] *= pr.Iinv[1]; T1[2] *= pr.Iinv[2];
      return rot(pr.q, T1, [0, 0, 0]);
    }
    // an impulse J (world vector) at offset r from the centre
    function impulse(pr, r, J) {
      const im = 1 / pr.T.m;
      pr.v[0] += J[0] * im; pr.v[1] += J[1] * im; pr.v[2] += J[2] * im;
      const dw = invI(pr, cross(r, J));
      pr.w[0] += dw[0]; pr.w[1] += dw[1]; pr.w[2] += dw[2];
    }
    function wake(pr) { if (!pr.awake) { pr.awake = true; pr.still = 0; pr.awakeT = 0; } pr.moved = true; }

    // ---------------------------------------------------------------- one step of the awake props
    const R = [0, 0, 0], GA = {}, NB = [];
    function integrate(pr, dt) {
      const T = pr.T, v = pr.v, w = pr.w;
      v[1] -= G * dt;
      pr.p[0] += v[0] * dt; pr.p[1] += v[1] * dt; pr.p[2] += v[2] * dt;
      // q += 1/2 (w, 0) q dt
      const [qx, qy, qz, qw] = pr.q, h = dt / 2;
      pr.q[0] = qx + h * (w[0] * qw + w[1] * qz - w[2] * qy);
      pr.q[1] = qy + h * (w[1] * qw + w[2] * qx - w[0] * qz);
      pr.q[2] = qz + h * (w[2] * qw + w[0] * qy - w[1] * qx);
      pr.q[3] = qw - h * (w[0] * qx + w[1] * qy + w[2] * qz);
      const n = Math.hypot(pr.q[0], pr.q[1], pr.q[2], pr.q[3]);
      pr.q[0] /= n; pr.q[1] /= n; pr.q[2] /= n; pr.q[3] /= n;
      // the ground: each corner below it gets an impulse (bounce and friction); the deepest pushes it out
      let deepest = 0, onGround = false;
      for (const c of CORNERS) {
        rot(pr.q, [c[0] * T.hx, c[1] * T.hy, c[2] * T.hz], R);
        const px = pr.p[0] + R[0], py = pr.p[1] + R[1], pz = pr.p[2] + R[2];
        const g = level.groundAt ? level.groundAt(px, pz, GA) : { h: 0, gx: 0, gz: 0 };
        const depth = g.h - py;
        if (depth <= 0) continue;
        onGround = true;
        deepest = Math.max(deepest, depth);
        const nl = Math.hypot(g.gx, 1, g.gz), nrm = [-g.gx / nl, 1 / nl, -g.gz / nl], r = [R[0], R[1], R[2]];
        const wr = cross(w, r), vc = [v[0] + wr[0], v[1] + wr[1], v[2] + wr[2]], vn = dot(vc, nrm);
        if (vn >= 0) continue;
        const rn = cross(r, nrm), k = 1 / T.m + dot(nrm, cross(invI(pr, rn), r));
        const J = -(1 + (vn < -1 ? T.e : 0)) * vn / k;
        impulse(pr, r, [nrm[0] * J, nrm[1] * J, nrm[2] * J]);
        // friction against what's left of the sliding
        const w2 = cross(w, r), vc2 = [v[0] + w2[0], v[1] + w2[1], v[2] + w2[2]], vn2 = dot(vc2, nrm);
        const vt = [vc2[0] - vn2 * nrm[0], vc2[1] - vn2 * nrm[1], vc2[2] - vn2 * nrm[2]], st = Math.hypot(vt[0], vt[1], vt[2]);
        if (st > 1e-4) {
          const t = [vt[0] / st, vt[1] / st, vt[2] / st], rt = cross(r, t), kt = 1 / T.m + dot(t, cross(invI(pr, rt), r));
          const Jt = Math.min(T.mu * J, st / kt);
          impulse(pr, r, [-t[0] * Jt, -t[1] * Jt, -t[2] * Jt]);
        }
      }
      if (deepest > 0) pr.p[1] += deepest * 0.8;
      // buildings, barriers and trees: corners pushed out sideways, the velocity into them reflected
      if (level.collidersNear) {
        const base = level.terrain ? level.terrain(pr.p[0], pr.p[2]) : 0;
        for (const o of level.collidersNear(pr.p[0], pr.p[2], T.hy + 1)) {
          for (const c of CORNERS) {
            rot(pr.q, [c[0] * T.hx, c[1] * T.hy, c[2] * T.hz], R);
            const px = pr.p[0] + R[0], py = pr.p[1] + R[1], pz = pr.p[2] + R[2];
            if (py - base > o.height) continue;
            let nx = 0, nz = 0, pen = 0;
            if (o.box) {
              const oc = Math.cos(o.angle), os = Math.sin(o.angle), dx = px - o.x, dz = pz - o.z, u = dx * oc + dz * os, ww = -dx * os + dz * oc;
              const pu = o.hx - Math.abs(u), pw = o.hz - Math.abs(ww);
              if (pu <= 0 || pw <= 0) continue;
              if (pu < pw) { pen = pu; nx = oc * Math.sign(u); nz = os * Math.sign(u); } else { pen = pw; nx = -os * Math.sign(ww); nz = oc * Math.sign(ww); }
            } else {
              const dx = px - o.x, dz = pz - o.z, d = Math.hypot(dx, dz);
              if (d >= o.r || d < 1e-6) continue;
              pen = o.r - d; nx = dx / d; nz = dz / d;
            }
            pr.p[0] += nx * pen; pr.p[2] += nz * pen;
            const vn = v[0] * nx + v[2] * nz;
            if (vn < 0) { v[0] -= 1.3 * vn * nx; v[2] -= 1.3 * vn * nz; w[0] *= 0.8; w[1] *= 0.8; w[2] *= 0.8; }
          }
        }
      }
      // air and rolling drag; asleep once it has stayed still for half a second on the ground
      const da = Math.exp(-(onGround ? 4 : 0.05) * dt), wa = Math.exp(-(onGround ? 4 : 0.3) * dt);
      if (onGround) { v[0] *= da; v[2] *= da; }
      w[0] *= wa; w[1] *= wa; w[2] *= wa;
      // (or after 8 s awake, crawling: settling against a wall it can jitter for ever)
      pr.awakeT += dt;
      const speed = Math.hypot(v[0], v[1], v[2]);
      if (onGround && speed < 0.15 && Math.hypot(w[0], w[1], w[2]) < 0.3) pr.still += dt;
      else pr.still = 0;
      if (pr.still > 0.5 || (pr.awakeT > 8 && speed < 0.6)) { pr.awake = false; v[0] = v[1] = v[2] = w[0] = w[1] = w[2] = 0; }
      pr.dirty = true;
      file(pr);
    }
    // props touching each other: pushed apart as spheres, a sleeping one woken by a hard knock
    function between(pr) {
      const r1 = Math.min(pr.T.hx, pr.T.hy, pr.T.hz) + 0.05;
      for (const o of near(pr.p[0], pr.p[2], 2, NB)) {
        if (o === pr) continue;
        const r2 = Math.min(o.T.hx, o.T.hy, o.T.hz) + 0.05;
        const dx = o.p[0] - pr.p[0], dy = o.p[1] - pr.p[1], dz = o.p[2] - pr.p[2], d = Math.hypot(dx, dy, dz);
        if (d >= r1 + r2 || d < 1e-6) continue;
        const n = [dx / d, dy / d, dz / d], pen = r1 + r2 - d, ma = pr.T.m, mb = o.T.m;
        const rv = (o.v[0] - pr.v[0]) * n[0] + (o.v[1] - pr.v[1]) * n[1] + (o.v[2] - pr.v[2]) * n[2];
        if (!o.awake && rv > -1) {   // a gentle touch on a sleeping prop (resting on it): only this one moves
          for (let i = 0; i < 3; i++) pr.p[i] -= n[i] * pen;
          const vn = pr.v[0] * n[0] + pr.v[1] * n[1] + pr.v[2] * n[2];
          if (vn > 0) for (let i = 0; i < 3; i++) pr.v[i] -= vn * n[i];
          continue;
        }
        if (!o.awake) wake(o);
        const sa = mb / (ma + mb), sb = ma / (ma + mb);
        for (let i = 0; i < 3; i++) { pr.p[i] -= n[i] * pen * sa; o.p[i] += n[i] * pen * sb; }
        if (rv < 0) { const J = -1.3 * rv / (1 / ma + 1 / mb); for (let i = 0; i < 3; i++) { pr.v[i] -= J * n[i] / ma; o.v[i] += J * n[i] / mb; } }
      }
    }

    // ---------------------------------------------------------------- cars hitting props
    const CB = {}, CANDS = [];
    // the car's box in the ground plane (as world.js)
    function carBox(c) {
      const s = c.spec, ch = Math.cos(c.h), sh = Math.sin(c.h), off = s.xMin + s.length / 2 - c.cgX;
      CB.x = c.x + ch * off; CB.z = c.z + sh * off; CB.ux = ch; CB.uz = sh; CB.hx = s.length / 2; CB.hz = s.width / 2;
      return CB;
    }
    // the prop's extent along a horizontal unit vector (u, w): its box projected
    function extent(pr, ux, uz) {
      let e = 0;
      for (const [ax, h] of [[[1, 0, 0], pr.T.hx], [[0, 1, 0], pr.T.hy], [[0, 0, 1], pr.T.hz]]) { rot(pr.q, ax, R); e += h * Math.abs(R[0] * ux + R[2] * uz); }
      return e;
    }
    // which of the prop's axes lies flattest (its long way on the ground, for a toppled pole)
    function mainAxis(pr) {
      let best = -1, bx = 1, bz = 0;
      for (const [ax, h] of [[[1, 0, 0], pr.T.hx], [[0, 1, 0], pr.T.hy], [[0, 0, 1], pr.T.hz]]) {
        rot(pr.q, ax, R);
        const l = Math.hypot(R[0], R[2]) * h;
        if (l > best) { best = l; const n = Math.hypot(R[0], R[2]) || 1; bx = R[0] / n; bz = R[2] / n; }
      }
      return [bx, bz];
    }
    function vsCar(b, pr, hits) {
      const c = b.car, A = carBox(c), T = pr.T;
      // heights: the car's body from a little off the ground to 1.5 m up
      const ey = extent3y(pr);
      if (pr.p[1] - ey > c.y + 1.5 || pr.p[1] + ey < c.y + 0.12) return;
      const [mx, mz] = mainAxis(pr);
      const axes = [[A.ux, A.uz], [-A.uz, A.ux], [mx, mz], [-mz, mx]], dx = pr.p[0] - A.x, dz = pr.p[2] - A.z;
      let best = Infinity, nx = 0, nz = 0;
      for (const [ux, uz] of axes) {
        const ra = A.hx * Math.abs(A.ux * ux + A.uz * uz) + A.hz * Math.abs(-A.uz * ux + A.ux * uz), rb = extent(pr, ux, uz);
        const d = dx * ux + dz * uz, pen = ra + rb - Math.abs(d);
        if (pen <= 0) return;
        if (pen < best) { best = pen; const sg = d < 0 ? -1 : 1; nx = ux * sg; nz = uz * sg; }   // from the car toward the prop
      }
      const vrel = (c.vx - pr.v[0]) * nx + (c.vz - pr.v[2]) * nz;
      pr.p[0] += nx * (best + 0.01); pr.p[2] += nz * (best + 0.01);
      wake(pr);
      if (vrel <= 0.3) return;
      // hits are never quite central: it goes off to the side it was struck on (else the car would
      // keep catching it and pushing it up the street)
      {
        const off = -dx * A.uz + dz * A.ux, side = Math.abs(off) > 0.05 ? Math.sign(off) : (pr.id % 2 ? 1 : -1);
        const fwd = Math.abs(nx * A.ux + nz * A.uz);
        nx += side * -A.uz * 0.6 * fwd; nz += side * A.ux * 0.6 * fwd;
        const n = Math.hypot(nx, nz); nx /= n; nz /= n;
      }
      const M = b.kinematic ? Infinity : c.m, m = T.m;
      let J;
      if (T.pole && pr.hit === 0) {
        // a street light or signal breaks off its base and topples away from the car
        const vb = 0.45 * vrel;
        pr.v[0] += nx * vb; pr.v[2] += nz * vb; pr.v[1] += 1.2;
        const ax = cross([0, 1, 0], [nx, 0, nz]), sp = Math.min(5, 0.28 * vrel / (T.hy / 4));
        pr.w[0] += ax[0] * sp; pr.w[1] += ax[1] * sp; pr.w[2] += ax[2] * sp;
        J = m * vb * 1.6;
      } else {
        J = (1 + 0.4) * vrel / (1 / M + 1 / m);
        // struck at bumper height on the near side: a push, a kick upward and a tumble
        const r = [-nx * Math.min(T.hx, T.hz), Math.max(-T.hy, Math.min(T.hy, c.y + 0.5 - pr.p[1])), -nz * Math.min(T.hx, T.hz)];
        impulse(pr, r, [nx * J, 0, nz * J]);
        pr.v[1] += Math.min(6, 0.3 * J / m);
        pr.w[1] += (pr.id % 2 ? 1 : -1) * Math.min(8, 0.15 * J / m);
      }
      limit(pr);
      pr.hit++; pr.awakeT = 0;
      if (M !== Infinity) c.applyImpulse(pr.p[0] - nx * extent(pr, nx, nz), pr.p[2] - nz * extent(pr, nx, nz), -nx * J, -nz * J);
      hits.push({ prop: pr, body: b, type: pr.type, x: pr.p[0], y: pr.p[1], z: pr.p[2], vrel, dv: M === Infinity ? 0 : J / M, first: pr.hit === 1 });
    }
    // no prop faster than 35 m/s or spinning faster than 12 rad/s (6 for the poles)
    function limit(pr) {
      const s = Math.hypot(pr.v[0], pr.v[1], pr.v[2]), wmax = pr.T.pole ? 6 : 12, ws = Math.hypot(pr.w[0], pr.w[1], pr.w[2]);
      if (s > 35) for (let i = 0; i < 3; i++) pr.v[i] *= 35 / s;
      if (ws > wmax) for (let i = 0; i < 3; i++) pr.w[i] *= wmax / ws;
    }
    function extent3y(pr) {
      let e = 0;
      for (const [ax, h] of [[[1, 0, 0], pr.T.hx], [[0, 1, 0], pr.T.hy], [[0, 0, 1], pr.T.hz]]) { rot(pr.q, ax, R); e += h * Math.abs(R[1]); }
      return e;
    }

    /* advance by dt (the world steps: whole 1/120 s steps are taken); bodies: the world's cars.
     * -> hits this call: [{ prop, body, type, x, y, z, vrel, dv (the car's change of speed), first }] */
    let acc = 0;
    function step(dt, bodies) {
      const hits = [];
      acc += dt;
      while (acc >= DT) {
        acc -= DT;
        for (const b of bodies) {
          if (b.frozen) continue;
          const c = b.car;
          if (Math.abs(c.vx) + Math.abs(c.vz) < 0.3) continue;
          for (const pr of near(c.x, c.z, 4, CANDS)) vsCar(b, pr, hits);
        }
        for (const pr of list) if (pr.awake) { integrate(pr, DT); between(pr); }
      }
      return hits;
    }
    return { list, step, TYPES, get awake() { return list.filter(p => p.awake).length; } };
  }

  return { create, TYPES };
})();
if (typeof module === 'object' && module.exports) module.exports = RaceProps;
