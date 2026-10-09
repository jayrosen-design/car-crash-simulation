/* The Destruction mode's pile-up: wrecked vehicles as rigid bodies in 3D, their damage, the cash
 * it's worth, fire and explosions.
 *
 * Bodies. A wreck is a rigid body (position, orientation quaternion, velocity, angular velocity)
 * with the inertia of a box of its size. Its shape for contacts is a hull of spheres filling that
 * box's surface (a few rows along it, two across, one or two high): cheap to test, and a pile of
 * them stacks and slides like a pile of cars. Against the ground (hills and the ramp: groundAt),
 * the buildings and posts (collidersNear), each other, and the vehicles still driving (kinematic
 * boxes, given each step), contacts are solved by sequential impulses: restitution, Coulomb
 * friction, a little positional correction. A body that stays still goes to sleep until something
 * hits it. Kinematic bodies (the two cars inside the crash solver during the impact) push but are
 * not pushed.
 *
 * Damage. Each touch's approach speed along the contact normal (with the bounce, and against
 * another wreck the share of it this body takes, by mass) goes through the Race game's damage curve
 * (RaceWorld.damage) times DAMAGE_SCALE; only the worst touch within 0.15 s counts. At full damage
 * a vehicle is totalled: it catches fire, and after a fuse it explodes. A gas tanker goes up at a
 * third of that, quickly.
 *
 * Explosions push everything in their radius away from below (exaggerated: cars are thrown into
 * the air, spinning), and damage it, which can set off the next one.
 *
 * Cash (the ledger). A vehicle pays its value times its damage as it grows, a quarter more when
 * totalled; explosions pay a bonus; the game adds props and pickups. Multipliers scale the total.
 *
 * Deterministic (a seeded random number generator), at a fixed step.
 *
 * opts.vmax raises the speed cap (the Race game's rig crashes: a motorcycle at 73 m/s); bodies with
 * the same `clan` don't touch each other (a rider and the bike they're thrown from, at first).
 *
 * DOM-free: global DestructionWrecks in the browser, module.exports in Node.
 */
const DestructionWrecks = (() => {
  'use strict';
  const G = 9.81;
  const E_GROUND = 0.15, E_BODY = 0.18, MU_GROUND = 0.65, MU_BODY = 0.4;
  const ITER = 8, BAUMGARTE = 0.25, SLOP = 0.01, PUSH_MAX = 2;
  const SLEEP_V = 0.2, SLEEP_W = 0.25, SLEEP_T = 0.6;
  const VMAX = 50, WMAX = 10;
  const DAMAGE_SCALE = 1.6, HIT_WINDOW = 0.15;
  // explosions by what blows up: radius (m), and the speed (m/s) it gives a 1.5 t car at its middle
  const BLAST = { car: [9, 14], truck: [11, 16], bus: [12, 16], tanker: [28, 26], pump: [15, 20], crashbreaker: [12, 18] };

  // ---------------------------------------------------------------- vector and quaternion maths
  const dot = (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
  const cross = (a, b) => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
  function rot(q, v, out = [0, 0, 0]) {   // rotate v by unit quaternion q = [x, y, z, w]
    const [x, y, z, w] = q, [vx, vy, vz] = v;
    const tx = 2 * (y * vz - z * vy), ty = 2 * (z * vx - x * vz), tz = 2 * (x * vy - y * vx);
    out[0] = vx + w * tx + y * tz - z * ty; out[1] = vy + w * ty + z * tx - x * tz; out[2] = vz + w * tz + x * ty - y * tx;
    return out;
  }
  const conj = (q) => [-q[0], -q[1], -q[2], q[3]];
  function qmul(a, b) {
    return [a[3] * b[0] + a[0] * b[3] + a[1] * b[2] - a[2] * b[1], a[3] * b[1] - a[0] * b[2] + a[1] * b[3] + a[2] * b[0],
      a[3] * b[2] + a[0] * b[1] - a[1] * b[0] + a[2] * b[3], a[3] * b[3] - a[0] * b[0] - a[1] * b[1] - a[2] * b[2]];
  }
  // a quaternion from a rotation matrix's columns (x, y, z axes)
  function fromAxes(X, Y, Z) {
    const m00 = X[0], m10 = X[1], m20 = X[2], m01 = Y[0], m11 = Y[1], m21 = Y[2], m02 = Z[0], m12 = Z[1], m22 = Z[2], tr = m00 + m11 + m22;
    let q;
    if (tr > 0) { const s = 0.5 / Math.sqrt(tr + 1); q = [(m21 - m12) * s, (m02 - m20) * s, (m10 - m01) * s, 0.25 / s]; }
    else if (m00 > m11 && m00 > m22) { const s = 2 * Math.sqrt(1 + m00 - m11 - m22); q = [0.25 * s, (m01 + m10) / s, (m02 + m20) / s, (m21 - m12) / s]; }
    else if (m11 > m22) { const s = 2 * Math.sqrt(1 + m11 - m00 - m22); q = [(m01 + m10) / s, 0.25 * s, (m12 + m21) / s, (m02 - m20) / s]; }
    else { const s = 2 * Math.sqrt(1 + m22 - m00 - m11); q = [(m02 + m20) / s, (m12 + m21) / s, 0.25 * s, (m10 - m01) / s]; }
    const n = Math.hypot(...q); return q.map(v => v / n);
  }
  // heading h (x toward z) as a quaternion about y (three.js: a turn by -h)
  const yawQ = (h) => [0, Math.sin(-h / 2), 0, Math.cos(-h / 2)];

  // the hull: spheres filling the surface of the box lo..hi (body coordinates), radius r
  function hull(lo, hi, rMax) {
    const L = hi[0] - lo[0], H = hi[1] - lo[1], W = hi[2] - lo[2];
    const r = Math.max(0.12, Math.min(rMax, H * 0.36, W * 0.32));
    const nx = Math.max(1, Math.ceil((L - 2 * r) / (1.35 * r)) + 1), ny = H > 4.2 * r ? 2 : 1, nz = W > 2.8 * r ? 2 : 1;
    const xs = Array.from({ length: nx }, (_, i) => nx === 1 ? (lo[0] + hi[0]) / 2 : lo[0] + r + (L - 2 * r) * i / (nx - 1));
    const ys = ny === 1 ? [lo[1] + r] : [lo[1] + r, hi[1] - r];
    const zs = nz === 1 ? [(lo[2] + hi[2]) / 2] : [lo[2] + r, hi[2] - r];
    const out = [];
    for (const x of xs) for (const y of ys) for (const z of zs) out.push([x, y, z, r]);
    // a single layer low down: add the roof over the middle of it (flat enough to land on and stack)
    if (ny === 1 && H > 2.6 * r) for (const x of xs.filter((_, i) => i > 0 && i < nx - 1)) for (const z of zs) out.push([x, hi[1] - r, z, r]);
    return out;
  }

  /* level: junction.js (groundAt, terrain, collidersNear); opts: { seed, damage: RaceWorld.damage }
   * -> the pile-up (see the returned object) */
  function create(level, opts = {}) {
    const damageCurve = opts.damage || ((dv) => Math.max(0, dv - 2.5) ** 2 / 650);
    let seed = (opts.seed || 7) >>> 0;
    const rnd = () => { seed = (seed + 0x6D2B79F5) >>> 0; let t = seed; t = Math.imul(t ^ (t >>> 15), t | 1); t ^= t + Math.imul(t ^ (t >>> 7), t | 61); return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
    const bodies = [];
    const events = [];          // this step: { type: 'hit' | 'cash' | 'ignite' | 'explode' | 'wake', ... }
    let now = 0, serial = 0;
    const ledger = { raw: 0, mult: 1, wrecked: 0, explosions: 0, biggest: 0, items: [], get total() { return Math.round(ledger.raw * ledger.mult); } };
    function pay(amount, label, x, y, z, ref) {
      if (!(amount > 0.5) || ledger.frozen) return;   // (frozen: the attempt is being counted up)
      ledger.raw += amount;
      ledger.biggest = Math.max(ledger.biggest, amount);
      ledger.items.push(amount);
      events.push({ type: 'cash', amount, label, x, y, z, ref });
    }

    /* o: { kind ('car' | 'truck' | 'bus' | 'tanker' | 'player' | 'chunk'), key (model), p, q, v, w,
     *   m, lo, hi (the box in body coordinates; or size [L, H, W] about the middle), value, paint,
     *   explosive, kinematic, ref (the game's), rMax } */
    function add(o) {
      const lo = o.lo || [-o.size[0] / 2, -o.size[1] / 2, -o.size[2] / 2], hi = o.hi || [o.size[0] / 2, o.size[1] / 2, o.size[2] / 2];
      const L = hi[0] - lo[0], H = hi[1] - lo[1], W = hi[2] - lo[2], m = o.m;
      const b = {
        id: serial++, kind: o.kind, key: o.key, ref: o.ref || null, paint: o.paint,
        p: o.p.slice(), q: (o.q || [0, 0, 0, 1]).slice(), v: (o.v || [0, 0, 0]).slice(), w: (o.w || [0, 0, 0]).slice(),
        m, invM: o.kinematic ? 0 : 1 / m, Iinv: o.kinematic ? [0, 0, 0] : [12 / (m * (H * H + W * W)), 12 / (m * (L * L + W * W)), 12 / (m * (L * L + H * H))],
        lo, hi, spheres: hull(lo, hi, o.rMax || (o.kind === 'chunk' ? 0.3 : L > 7 ? 0.85 : 0.55)),
        kinematic: !!o.kinematic, awake: true, still: 0,
        value: o.value || 0, damage: o.damage || 0, paid: 0, totalled: false, explosive: !!o.explosive,
        hitUntil: -1, hitWorst: 0, burn: -1, fuse: 0, exploded: false, dents: [0, 0, 0, 0, 0],
      };
      b.rad = Math.max(...b.spheres.map(s => Math.hypot(s[0], s[1], s[2]) + s[3]));
      bodies.push(b);
      if (b.value) ledger.wrecked++;
      if (b.damage > 0) settle(b, b.damage, b.p);
      return b;
    }
    function remove(b) { const i = bodies.indexOf(b); if (i >= 0) bodies.splice(i, 1); }
    // held: moving on at its speed, pushing but not pushed (a bus or tanker the crash solver sees as
    // a moving box, until the solver is done); release: back to a free body
    function hold(b) { b.held = { invM: b.invM, Iinv: b.Iinv }; b.kinematic = true; b.invM = 0; b.Iinv = [0, 0, 0]; }
    function release(b) { if (!b.held) return; b.invM = b.held.invM; b.Iinv = b.held.Iinv; b.kinematic = false; b.held = null; b.awake = true; }
    function wake(b) { if (!b.awake) { b.awake = true; b.still = 0; events.push({ type: 'wake', body: b }); } }

    // inverse inertia (world) times a vector
    function invI(b, v) {
      const l = rot(conj(b.q), v);
      l[0] *= b.Iinv[0]; l[1] *= b.Iinv[1]; l[2] *= b.Iinv[2];
      return rot(b.q, l);
    }
    // (a sleeping body is pushed only once something wakes it: until then it's as good as fixed)
    function applyImpulse(b, r, J) {
      if (b.kinematic || !b.awake) return;
      b.v[0] += J[0] * b.invM; b.v[1] += J[1] * b.invM; b.v[2] += J[2] * b.invM;
      const dw = invI(b, cross(r, J));
      b.w[0] += dw[0]; b.w[1] += dw[1]; b.w[2] += dw[2];
    }
    const velAt = (b, r) => { const wr = cross(b.w, r); return [b.v[0] + wr[0], b.v[1] + wr[1], b.v[2] + wr[2]]; };

    // ---------------------------------------------------------------- damage and cash
    // a touch at approach speed vn (m/s, with the bounce and the mass share already in), at point P
    // (world), with normal n pointing into the body: the worst within HIT_WINDOW counts
    function touch(b, dv, P, n) {
      if (b.kinematic || !(dv > 2.5)) return;
      const d = damageCurve(dv) * DAMAGE_SCALE;
      if (now > b.hitUntil) { b.hitUntil = now + HIT_WINDOW; b.hitWorst = 0; }
      if (d <= b.hitWorst) return;
      const add = d - b.hitWorst;
      b.hitWorst = d;
      dent(b, P, add);
      settle(b, b.damage + add, P);
      events.push({ type: 'hit', body: b, dv, x: P[0], y: P[1], z: P[2] });
    }
    // where it's dented (for the drawing): front, rear, left, right, roof crush 0..1
    function dent(b, P, amount) {
      const l = rot(conj(b.q), [P[0] - b.p[0], P[1] - b.p[1], P[2] - b.p[2]]);
      const L = b.hi[0] - b.lo[0], W = b.hi[2] - b.lo[2], H = b.hi[1] - b.lo[1];
      const fx = (l[0] - (b.lo[0] + b.hi[0]) / 2) / (L / 2), fz = (l[2] - (b.lo[2] + b.hi[2]) / 2) / (W / 2), fy = (l[1] - (b.lo[1] + b.hi[1]) / 2) / (H / 2);
      const k = amount * 1.4;
      if (fy > 0.55) b.dents[4] = Math.min(1, b.dents[4] + k);
      else if (Math.abs(fx) * 0.9 > Math.abs(fz)) b.dents[fx > 0 ? 0 : 1] = Math.min(1, b.dents[fx > 0 ? 0 : 1] + k);
      else b.dents[fz < 0 ? 2 : 3] = Math.min(1, b.dents[fz < 0 ? 2 : 3] + k);
    }
    // the body's damage rises to d: pay for it; totalled: on fire, and a fuse
    function settle(b, d, P) {
      b.damage = d;
      if (b.value) {
        const owed = b.value * Math.min(1, d) - b.paid;
        if (owed > 0) { b.paid += owed; pay(owed, LABEL[b.kind] || b.kind, P[0], P[1], P[2], b); }
        if (d >= 1 && !b.totalled) { b.totalled = true; pay(b.value * 0.25, 'TOTALLED', P[0], P[1] + 1, P[2], b); }
      }
      const lit = b.kind === 'tanker' ? d >= 0.34 : d >= 1;
      if (lit && b.burn < 0 && b.kind !== 'chunk') {
        b.burn = 0;
        b.fuse = b.kind === 'tanker' ? 0.5 + 0.4 * rnd() : 2.2 + 2.6 * rnd();
        events.push({ type: 'ignite', body: b });
      }
    }
    const LABEL = { car: 'CAR', truck: 'TRUCK', bus: 'BUS', tanker: 'TANKER', player: 'YOUR CAR' };

    // ---------------------------------------------------------------- explosions
    /* at (x, y, z), radius R, push v0 (m/s to a 1.5 t car at its middle); kind: what blew up (for its
     * bonus and the event); source: the body (not pushed by its own blast). silent: only the push
     * (an explosion the game counts itself: a fuel pump, the Crashbreaker); only: push just that body */
    function explode(x, y, z, R, v0, kind, source, silent, only) {
      if (!silent) {
        ledger.explosions++;
        const bonus = (opts.values && opts.values.explode && opts.values.explode[kind]) || 0;
        if (bonus) pay(bonus, kind === 'tanker' ? 'TANKER BOOM' : 'EXPLOSION', x, y + 2, z, source);
        events.push({ type: 'explode', kind, x, y, z, r: R, v0, source });
      }
      for (const b of only ? [only] : bodies) {
        if (b === source || b.kinematic) continue;
        const dx = b.p[0] - x, dy = b.p[1] - (y - 1.2), dz = b.p[2] - z, d = Math.hypot(dx, dy, dz);
        if (d > R) continue;
        const f = (1 - d / R) ** 2;
        // away from a point below the blast, with a strong lift: a car goes up and over
        let nx = dx / (d || 1), ny = dy / (d || 1) + 0.9, nz = dz / (d || 1);
        const nl = Math.hypot(nx, ny, nz); nx /= nl; ny /= nl; nz /= nl;
        const J = v0 * f * 1500 * Math.pow(b.m / 1500, 0.35);   // heavy ones move, but less
        const r = [(rnd() - 0.5) * 0.8, -0.2 - 0.3 * rnd(), (rnd() - 0.5) * 0.8];   // a little off-centre: a spin
        wake(b);
        applyImpulse(b, rot(b.q, r), [nx * J, ny * J, nz * J]);
        clamp(b);
        if (b.value || b.kind === 'player') settle(b, b.damage + 1.3 * f, b.p);
      }
    }
    const vmax = opts.vmax || VMAX;
    function clamp(b) {
      const s = Math.hypot(...b.v), ws = Math.hypot(...b.w);
      if (s > vmax) for (let i = 0; i < 3; i++) b.v[i] *= vmax / s;
      if (ws > WMAX) for (let i = 0; i < 3; i++) b.w[i] *= WMAX / ws;
    }

    // ---------------------------------------------------------------- contacts
    const contacts = [];
    const GA = {}, SP = [0, 0, 0], SQ = [0, 0, 0];
    function sphereWorld(b, s, out) { rot(b.q, s, out); out[0] += b.p[0]; out[1] += b.p[1]; out[2] += b.p[2]; return out; }
    function addContact(a, bb, kin, n, P, pen, e, mu, dvShare) {
      const ra = [P[0] - a.p[0], P[1] - a.p[1], P[2] - a.p[2]], rb = bb ? [P[0] - bb.p[0], P[1] - bb.p[1], P[2] - bb.p[2]] : null;
      contacts.push({ a, b: bb, kin, n, ra, rb, P, pen, e, mu, jn: 0, jt: [0, 0, 0], bias: 0, k: 0, vn0: 0, dvShare });
    }
    // the ground and the level's colliders, for each sphere of an awake body
    function staticContacts(b) {
      const C = [0, 0, 0];
      for (const s of b.spheres) {
        sphereWorld(b, s, C);
        const r = s[3];
        const g = level.groundAt(C[0], C[2], GA), pen = g.h + r - C[1];
        if (pen > 0) {
          const nl = Math.hypot(g.gx, 1, g.gz), n = [-g.gx / nl, 1 / nl, -g.gz / nl];
          addContact(b, null, null, n, [C[0] - n[0] * r, C[1] - n[1] * r, C[2] - n[2] * r], pen * (1 / nl), E_GROUND, MU_GROUND, 1);
        }
      }
      const near = level.collidersNear(b.p[0], b.p[2], b.rad + 1);
      if (!near.length) return;
      const base = level.terrain(b.p[0], b.p[2]);
      for (const o of near) for (const s of b.spheres) {
        sphereWorld(b, s, C);
        const r = s[3], top = base + o.height;
        if (C[1] - r > top) continue;
        let n = null, pen = 0;
        if (o.box) {
          const c = Math.cos(o.angle), sn = Math.sin(o.angle), dx = C[0] - o.x, dz = C[2] - o.z, u = dx * c + dz * sn, w = -dx * sn + dz * c;
          const cu = Math.max(-o.hx, Math.min(o.hx, u)), cw = Math.max(-o.hz, Math.min(o.hz, w)), cy = Math.min(top, C[1]);
          const du = u - cu, dw = w - cw, dy = C[1] - cy, d = Math.hypot(du, dy, dw);
          if (d > 1e-6) { if (d >= r) continue; pen = r - d; const nu = du / d, nw = dw / d; n = [nu * c - nw * sn, dy / d, nu * sn + nw * c]; }
          else {   // the centre inside: out the nearest face (or the top)
            const pu = o.hx - Math.abs(u), pw = o.hz - Math.abs(w), pt = top - C[1];
            if (pt < pu && pt < pw) { pen = pt + r; n = [0, 1, 0]; }
            else if (pu < pw) { pen = pu + r; const su = Math.sign(u) || 1; n = [su * c, 0, su * sn]; }
            else { pen = pw + r; const sw = Math.sign(w) || 1; n = [-sw * sn, 0, sw * c]; }
          }
        } else {
          const dx = C[0] - o.x, dz = C[2] - o.z, d = Math.hypot(dx, dz);
          if (d >= o.r + r) continue;
          pen = o.r + r - d; n = d > 1e-6 ? [dx / d, 0, dz / d] : [1, 0, 0];
        }
        addContact(b, null, null, n, [C[0] - n[0] * r, C[1] - n[1] * r, C[2] - n[2] * r], pen, E_BODY, MU_BODY, 1);
      }
    }
    // two bodies' hulls
    function pairContacts(a, b) {
      const dx = a.p[0] - b.p[0], dy = a.p[1] - b.p[1], dz = a.p[2] - b.p[2];
      if (dx * dx + dy * dy + dz * dz > (a.rad + b.rad) ** 2) return;
      const CA = [0, 0, 0], CB = [0, 0, 0], ma = a.kinematic ? Infinity : a.m, mb = b.kinematic ? Infinity : b.m;
      const shareA = ma === Infinity ? 0 : mb === Infinity ? 1 : mb / (ma + mb);
      for (const sa of a.spheres) {
        sphereWorld(a, sa, CA);
        // early out: this sphere far from b
        const ex = CA[0] - b.p[0], ey = CA[1] - b.p[1], ez = CA[2] - b.p[2];
        if (ex * ex + ey * ey + ez * ez > (b.rad + sa[3]) ** 2) continue;
        for (const sb of b.spheres) {
          sphereWorld(b, sb, CB);
          const ux = CA[0] - CB[0], uy = CA[1] - CB[1], uz = CA[2] - CB[2], d = Math.hypot(ux, uy, uz), rr = sa[3] + sb[3];
          if (d >= rr || d < 1e-6) continue;
          const n = [ux / d, uy / d, uz / d];
          addContact(a, b, null, n, [CB[0] + n[0] * sb[3], CB[1] + n[1] * sb[3], CB[2] + n[2] * sb[3]], rr - d, E_BODY, MU_BODY, shareA);
        }
      }
    }
    // a body against a vehicle still driving (a kinematic box: { x, z (box centre), y (its ground),
    // h, hl, hw, height, vx, vz, ref }); returns the approach speed of the hardest touch
    function driverContacts(b, D) {
      let worst = 0;
      const C = [0, 0, 0], c = Math.cos(D.h), sn = Math.sin(D.h);
      for (const s of b.spheres) {
        sphereWorld(b, s, C);
        const r = s[3];
        const dx = C[0] - D.x, dz = C[2] - D.z, u = dx * c + dz * sn, w = -dx * sn + dz * c;
        const cu = Math.max(-D.hl, Math.min(D.hl, u)), cw = Math.max(-D.hw, Math.min(D.hw, w)), cy = Math.max(D.y, Math.min(D.y + D.height, C[1]));
        const du = u - cu, dw = w - cw, dy = C[1] - cy, d = Math.hypot(du, dy, dw);
        if (d >= r || d < 1e-6) continue;
        const nu = du / d, nw = dw / d, n = [nu * c - nw * sn, dy / d, nu * sn + nw * c];
        const P = [C[0] - n[0] * r, C[1] - n[1] * r, C[2] - n[2] * r];
        const va = velAt(b, [P[0] - b.p[0], P[1] - b.p[1], P[2] - b.p[2]]);
        const vn = (va[0] - D.vx) * n[0] + va[1] * n[1] + (va[2] - D.vz) * n[2];
        worst = Math.max(worst, -vn);
        addContact(b, null, [D.vx, 0, D.vz], n, P, r - d, E_BODY, MU_BODY, 1);
      }
      return worst;
    }

    // ---------------------------------------------------------------- the solver
    function prepare(c, dt) {
      const { a, b, n, ra, rb } = c;
      const kn = (body, r) => { if (!body || body.kinematic || !body.awake) return 0; const rn = cross(r, n); return body.invM + dot(n, cross(invI(body, rn), r)); };
      c.k = kn(a, ra) + kn(b, rb);
      const vrel = relVel(c);
      c.vn0 = dot(vrel, n);
      c.bias = Math.min(PUSH_MAX, BAUMGARTE * Math.max(0, c.pen - SLOP) / dt);
      c.restitution = c.vn0 < -1.2 ? -c.e * c.vn0 : 0;
    }
    function relVel(c) {
      const va = velAt(c.a, c.ra), vb = c.b ? velAt(c.b, c.rb) : (c.kin || [0, 0, 0]);
      return [va[0] - vb[0], va[1] - vb[1], va[2] - vb[2]];
    }
    function solve(c) {
      if (!(c.k > 0)) return;
      const { a, b, n } = c;
      let vrel = relVel(c);
      const vn = dot(vrel, n), target = Math.max(c.restitution, c.bias);
      let dj = (target - vn) / c.k;
      const jn0 = c.jn; c.jn = Math.max(0, jn0 + dj); dj = c.jn - jn0;
      if (dj) { const J = [n[0] * dj, n[1] * dj, n[2] * dj]; applyImpulse(a, c.ra, J); if (b) applyImpulse(b, c.rb, [-J[0], -J[1], -J[2]]); }
      // friction: against the sliding, up to mu times the normal impulse so far
      vrel = relVel(c);
      const vn2 = dot(vrel, n), vt = [vrel[0] - vn2 * n[0], vrel[1] - vn2 * n[1], vrel[2] - vn2 * n[2]], st = Math.hypot(vt[0], vt[1], vt[2]);
      if (st < 1e-6) return;
      const t = [vt[0] / st, vt[1] / st, vt[2] / st];
      const kt = (body, r) => { if (!body || body.kinematic || !body.awake) return 0; const rt = cross(r, t); return body.invM + dot(t, cross(invI(body, rt), r)); };
      const k = kt(a, c.ra) + kt(b, c.rb);
      if (!(k > 0)) return;
      const want = [c.jt[0] - t[0] * st / k, c.jt[1] - t[1] * st / k, c.jt[2] - t[2] * st / k], wl = Math.hypot(want[0], want[1], want[2]), lim = c.mu * c.jn;
      if (wl > lim) for (let i = 0; i < 3; i++) want[i] *= lim / wl;
      const J = [want[0] - c.jt[0], want[1] - c.jt[1], want[2] - c.jt[2]];
      c.jt = want;
      applyImpulse(a, c.ra, J); if (b) applyImpulse(b, c.rb, [-J[0], -J[1], -J[2]]);
    }
    function integrate(b, dt) {
      b.p[0] += b.v[0] * dt; b.p[1] += b.v[1] * dt; b.p[2] += b.v[2] * dt;
      const w = b.w, wl = Math.hypot(w[0], w[1], w[2]);
      if (wl > 1e-9) {
        const ha = wl * dt / 2, s = Math.sin(ha) / wl, dq = [w[0] * s, w[1] * s, w[2] * s, Math.cos(ha)];
        b.q = qmul(dq, b.q);
        const n = Math.hypot(...b.q); for (let i = 0; i < 4; i++) b.q[i] /= n;
      }
    }

    /* advance by dt. drivers: the vehicles still driving near the wrecks (kinematic boxes, see
     * driverContacts). -> events this step; also touches: [{ driver, body, vn }] (the game makes
     * those drivers wrecks) */
    function step(dt, drivers = []) {
      events.length = 0;
      contacts.length = 0;
      const touches = [];
      now += dt;
      for (const b of bodies) if (b.awake && !b.kinematic) { b.v[1] -= G * dt; }
      for (const b of bodies) if (b.awake && !b.kinematic) staticContacts(b);
      for (let i = 0; i < bodies.length; i++) for (let j = i + 1; j < bodies.length; j++) {
        const a = bodies[i], b = bodies[j];
        if ((a.kinematic && b.kinematic) || (!a.awake && !b.awake)) continue;
        if (a.clan && a.clan === b.clan) continue;
        const n0 = contacts.length;
        pairContacts(a, b);
        // a sleeper hit hard enough wakes
        if (contacts.length > n0) for (const body of [a, b]) if (!body.awake && !body.kinematic) {
          const other = body === a ? b : a, rv = Math.hypot(other.v[0] - body.v[0], other.v[1] - body.v[1], other.v[2] - body.v[2]);
          if (rv > 0.6) wake(body);
        }
      }
      for (const D of drivers) for (const b of bodies) {
        if (b.kinematic) continue;
        const dx = b.p[0] - D.x, dz = b.p[2] - D.z;
        if (dx * dx + dz * dz > (b.rad + Math.hypot(D.hl, D.hw) + 0.5) ** 2) continue;
        const n0 = contacts.length, vn = driverContacts(b, D);
        if (contacts.length > n0) { touches.push({ driver: D, body: b, vn }); if (vn > 0.5) wake(b); }
      }
      // only contacts involving something awake (or kinematic) get solved
      const live = contacts.filter(c => c.a.awake || (c.b && c.b.awake) || c.kin);
      for (const c of live) prepare(c, dt);
      // damage from this step's touches: the approach speed, with the bounce, this body's share
      for (const c of live) if (c.vn0 < -2.5) {
        const dv = -c.vn0 * (1 + c.e);
        touch(c.a, dv * c.dvShare, c.P, c.n);
        if (c.b) touch(c.b, dv * (1 - c.dvShare), c.P, c.n);
      }
      for (let it = 0; it < ITER; it++) for (const c of live) solve(c);
      for (const b of bodies) {
        if (b.held) { integrate(b, dt); continue; }   // held: steady on
        if (!b.awake || b.kinematic) continue;   // (the game moves the other kinematic ones)
        clamp(b);
        integrate(b, dt);
        // rolling and air drag; asleep after staying still a while
        const sp = Math.hypot(...b.v), ws = Math.hypot(...b.w);
        if (sp < SLEEP_V && ws < SLEEP_W) b.still += dt; else b.still = 0;
        if (b.still > SLEEP_T) { b.awake = false; b.v = [0, 0, 0]; b.w = [0, 0, 0]; }
      }
      // fires and fuses
      for (const b of bodies.slice()) {
        if (b.burn < 0) continue;
        b.burn += dt;
        if (!b.exploded && b.burn >= b.fuse) {
          b.exploded = true;
          const kind = b.kind === 'player' ? 'car' : b.kind === 'chunk' ? null : b.kind;
          if (kind) { const [R, v0] = BLAST[kind] || BLAST.car; explode(b.p[0], b.p[1], b.p[2], R, v0, kind, b); wake(b); applyImpulse(b, [0, 0, 0], [0, b.m * 4, 0]); }
        }
      }
      return { events, touches };
    }

    return {
      bodies, add, remove, hold, release, step, explode, wake, pay, ledger, events, BLAST,
      applyImpulse, settle: (b, d, P) => settle(b, d, P || b.p), get now() { return now; },
      yawQ, fromAxes, rot, qmul, conj,
    };
  }

  return { create, hull, yawQ, fromAxes, rot, qmul, conj, DAMAGE_SCALE, BLAST };
})();
if (typeof module === 'object' && module.exports) module.exports = DestructionWrecks;
