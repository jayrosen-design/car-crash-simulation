/* The Race game's level: a city around a closed street circuit, generated from a seed.
 *
 * The circuit is a polygon of street corners, each rounded with its own radius (tight city corners,
 * one sweeping bend), sampled every metre. Along it: a four-lane two-way street (two lanes each
 * way), pavements with guard rails along their outer edge, side streets closed off with barriers,
 * street lights, trees and traffic lights,
 * buildings set back from the pavement, and more buildings filling the blocks behind them. Rolling
 * hills on some straights (terrain), jump ramps across the street (groundAt adds them), and props to
 * knock over (props.js). The crash solver works on flat ground: the game runs a crash at the local
 * ground height (see game.js).
 *
 * Conventions (as js/physics.js): x and z on the ground, y up; a heading h points along
 * (cos h, sin h); a lateral offset l is measured to the right of the circuit's direction, along
 * (-sin h, cos h). Curvature k = dh/ds, positive turning right.
 *
 * DOM-free: global CrashLevel in the browser, module.exports in Node.
 */
const CrashLevel = (() => {
  'use strict';

  const LANE_W = 3.5;
  const LANES = [-5.25, -1.75, 1.75, 5.25];   // lateral offsets: < 0 oncoming, > 0 with the race
  const ROAD_HALF = 7.5;                       // kerb line
  const WALK_OUT = 12;                         // outer edge of the pavement
  const DS = 1;                                // m between circuit samples

  function rng(seed) {
    let a = seed >>> 0;
    return () => { a = (a + 0x6D2B79F5) >>> 0; let t = a; t = Math.imul(t ^ (t >>> 15), t | 1); t ^= t + Math.imul(t ^ (t >>> 7), t | 61); return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
  }

  // ---------------------------------------------------------------- the circuit
  // corners: [x, z, radius]; the loop runs through them in order and back to the first
  function buildCircuit(corners) {
    const nC = corners.length, segs = [];
    for (let i = 0; i < nC; i++) {
      const A = corners[(i - 1 + nC) % nC], B = corners[i], C = corners[(i + 1) % nC];
      const din = norm(B[0] - A[0], B[1] - A[1]), dout = norm(C[0] - B[0], C[1] - B[1]);
      const cross = din[0] * dout[1] - din[1] * dout[0], dot = din[0] * dout[0] + din[1] * dout[1];
      const th = Math.atan2(cross, dot);              // > 0: turning right (toward +z from +x)
      const r = B[2], t = r * Math.tan(Math.abs(th) / 2);
      segs.push({ B, din, dout, th, r, t });
    }
    // check the fillets fit on their edges
    for (let i = 0; i < nC; i++) {
      const a = segs[i], b = segs[(i + 1) % nC], L = Math.hypot(b.B[0] - a.B[0], b.B[1] - a.B[1]);
      if (a.t + b.t > L - 1) throw new Error(`circuit corners ${i} and ${(i + 1) % nC} overlap`);
    }
    // walk: arc at each corner, then the straight to the next corner's arc
    const xs = [], zs = [], hs = [], ks = [];
    const push = (x, z, h, k) => { xs.push(x); zs.push(z); hs.push(h); ks.push(k); };
    let carry = 0;   // distance already covered toward the next sample
    function straight(x0, z0, h, len) {
      const c = Math.cos(h), s = Math.sin(h);
      let d = carry;
      for (; d < len; d += DS) push(x0 + c * d, z0 + s * d, h, 0);
      carry = d - len;
    }
    function arc(cx, cz, r, h0, th) {
      const len = r * Math.abs(th), dir = Math.sign(th);
      let d = carry;
      for (; d < len; d += DS) {
        const h = h0 + dir * d / r;
        // centre to point: the left normal for a right turn (centre is on the right)
        push(cx + Math.sin(h) * r * dir, cz - Math.cos(h) * r * dir, h, dir / r);
      }
      carry = d - len;
    }
    for (let i = 0; i < nC; i++) {
      const g = segs[i], h0 = Math.atan2(g.din[1], g.din[0]);
      const sx = g.B[0] - g.din[0] * g.t, sz = g.B[1] - g.din[1] * g.t;
      const dir = Math.sign(g.th) || 1;
      // the centre lies on the turning side: right of the direction for a right turn
      const cx = sx + (-g.din[1]) * g.r * dir, cz = sz + g.din[0] * g.r * dir;
      if (Math.abs(g.th) > 1e-6) arc(cx, cz, g.r, h0, g.th);
      const n = segs[(i + 1) % nC];
      const ex = g.B[0] + g.dout[0] * g.t, ez = g.B[1] + g.dout[1] * g.t;
      const nx = n.B[0] - n.din[0] * n.t, nz = n.B[1] - n.din[1] * n.t;
      straight(ex, ez, Math.atan2(g.dout[1], g.dout[0]), Math.hypot(nx - ex, nz - ez));
    }
    const N = xs.length, length = N * DS;
    // unwrap the headings so they change smoothly round the loop
    for (let i = 1; i < N; i++) { while (hs[i] - hs[i - 1] > Math.PI) hs[i] -= 2 * Math.PI; while (hs[i] - hs[i - 1] < -Math.PI) hs[i] += 2 * Math.PI; }
    return { N, length, x: Float64Array.from(xs), z: Float64Array.from(zs), h: Float64Array.from(hs), k: Float64Array.from(ks) };
  }
  function norm(x, z) { const l = Math.hypot(x, z) || 1; return [x / l, z / l]; }

  // ---------------------------------------------------------------- the level
  /* opts: { seed } -> the level (see the return value at the end) */
  function build(opts = {}) {
    const R = rng(opts.seed || 20261007);
    // the street corners (m) and their radii, in race order; the start is on the first straight
    // (a lap of about 1.47 km: three laps take about 3 minutes at race pace)
    const corners = [
      [0, 0, 34], [480, 0, 30], [480, 215, 58], [338, 364, 140], [158, 364, 46], [0, 205, 60],
    ];
    const C = buildCircuit(corners);
    const L = C.length;
    // grid of circuit samples, for nearest-point queries
    const CELL = 24, cells = new Map(), key = (i, j) => i * 100003 + j;
    for (let i = 0; i < C.N; i++) {
      const k = key(Math.floor(C.x[i] / CELL), Math.floor(C.z[i] / CELL));
      if (!cells.has(k)) cells.set(k, []);
      cells.get(k).push(i);
    }
    // nearest circuit sample to (x, z), searched near index `hint` when given (cheap), else the grid
    function nearest(x, z, hint) {
      let best = -1, bd = Infinity;
      if (hint !== undefined && hint >= 0) {
        for (let d = -40; d <= 40; d++) {
          const i = ((hint + d) % C.N + C.N) % C.N, dd = (C.x[i] - x) ** 2 + (C.z[i] - z) ** 2;
          if (dd < bd) { bd = dd; best = i; }
        }
        if (bd < 400) return frameAt(best, x, z);
      }
      const ci = Math.floor(x / CELL), cj = Math.floor(z / CELL);
      for (let r = 0; r < 12 && (best < 0 || r < 2); r++)
        for (let di = -r; di <= r; di++) for (let dj = -r; dj <= r; dj++) {
          if (Math.max(Math.abs(di), Math.abs(dj)) !== r) continue;
          const list = cells.get(key(ci + di, cj + dj));
          if (list) for (const i of list) { const dd = (C.x[i] - x) ** 2 + (C.z[i] - z) ** 2; if (dd < bd) { bd = dd; best = i; } }
        }
      return frameAt(best, x, z);
    }
    // { i, s, l (lateral, right +), h (circuit heading), k } of a point near sample i
    function frameAt(i, x, z) {
      const h = C.h[i], tx = Math.cos(h), tz = Math.sin(h), dx = x - C.x[i], dz = z - C.z[i];
      const along = dx * tx + dz * tz, l = -dx * tz + dz * tx;
      return { i, s: ((i * DS + along) % L + L) % L, l, h, k: C.k[i] };
    }
    // world pose at circuit distance s and lateral offset l
    function poseAt(s, l) {
      const u = ((s % L) + L) % L / DS, i = Math.floor(u) % C.N, j = (i + 1) % C.N, f = u - Math.floor(u);
      let h0 = C.h[i], h1 = C.h[j];
      while (h1 - h0 > Math.PI) h1 -= 2 * Math.PI; while (h1 - h0 < -Math.PI) h1 += 2 * Math.PI;
      const h = h0 + (h1 - h0) * f, x = C.x[i] + (C.x[j] - C.x[i]) * f, z = C.z[i] + (C.z[j] - C.z[i]) * f;
      return { x: x - Math.sin(h) * l, z: z + Math.cos(h) * l, h, k: C.k[i] };
    }
    const sampleAt = (s) => Math.floor((((s % L) + L) % L) / DS) % C.N;

    // ------------------------------------------------ the lie of the land
    // Rolling hills: smooth bumps on the second and last straights and over the sweeping bend; the
    // first straight, its start and grid stay flat. Everything stands on this ground (street,
    // pavements, buildings, props); the height is never below 0. [x, z, height, spread] (m)
    const HILLS = [[480, 112, 6, 36], [416, 300, 4, 40], [0, 112, 5, 34]];
    // Jump ramps across the street on three straights (the first, the bottom one and the long
    // diagonal; none on a hill): from s, up `up` m to `height`, a short top, down `down` m.
    const ramps = [];
    for (const [s0, up, top, down, height] of [[215, 12, 2, 8, 1.4], [998, 11, 2, 8, 1.3], [1215, 12, 2, 8, 1.5]]) {
      const p = poseAt(s0, 0), len = up + top + down;
      ramps.push({ s: s0, up, top, down, height, len, x: p.x, z: p.z, h: p.h, cx: p.x + Math.cos(p.h) * len / 2, cz: p.z + Math.sin(p.h) * len / 2, rad: Math.hypot(len / 2, ROAD_HALF) + 1 });
    }
    // a ramp's surface height and its slope along the street, u m past its start
    function rampProfile(r, u) {
      if (u < 0 || u >= r.len) return [0, 0];
      if (u < r.up) return [r.height * u / r.up, r.height / r.up];
      if (u < r.up + r.top) return [r.height, 0];
      return [r.height * (1 - (u - r.up - r.top) / r.down), -r.height / r.down];
    }
    // the ground's height (hills only, without the ramps) at (x, z)
    function terrain(x, z) {
      let h = 0;
      for (const [cx, cz, A, sg] of HILLS) h += A * Math.exp(-((x - cx) ** 2 + (z - cz) ** 2) / (2 * sg * sg));
      return h;
    }
    // the surface cars and props stand on: hills plus the ramps on the street -> out { h, gx, gz }
    // (height and its gradient)
    function groundAt(x, z, out = {}) {
      let h = 0, gx = 0, gz = 0;
      for (const [cx, cz, A, sg] of HILLS) {
        const dx = x - cx, dz = z - cz, e = A * Math.exp(-(dx * dx + dz * dz) / (2 * sg * sg));
        h += e; gx -= e * dx / (sg * sg); gz -= e * dz / (sg * sg);
      }
      for (const r of ramps) {
        if ((x - r.cx) ** 2 + (z - r.cz) ** 2 > r.rad * r.rad) continue;
        const c = Math.cos(r.h), s = Math.sin(r.h), dx = x - r.x, dz = z - r.z;
        const u = dx * c + dz * s, l = -dx * s + dz * c;
        if (Math.abs(l) > ROAD_HALF) continue;
        const [rh, sl] = rampProfile(r, u);
        h += rh; gx += sl * c; gz += sl * s;
      }
      out.h = h; out.gx = gx; out.gz = gz;
      return out;
    }

    // ------------------------------------------------ side streets, buildings, street furniture
    const boxes = [], cyls = [];           // colliders (as the crash solver takes them)
    const buildings = [], sideStreets = [], lamps = [], trees = [], signals = [], barriers = [], stops = [];
    const START_S = 140;                   // the start line, on the first straight (the grid behind it too)
    // side streets every 130-200 m, away from the corners and the start
    for (let s = START_S + 120; s < L - 60;) {
      const i = sampleAt(s);
      let curvy = false;
      for (let d = -40; d <= 40; d += 4) if (Math.abs(C.k[sampleAt(s + d)]) > 1e-4) curvy = true;
      if (!curvy) {
        const side = R() < 0.5 ? -1 : 1;
        sideStreets.push({ s, side, i, width: 13 });
        if (R() < 0.45) sideStreets.push({ s: s + (R() - 0.5) * 6, side: -side, i, width: 13 });
      }
      s += 130 + R() * 70;
    }
    const nearSide = (s, side, margin) => sideStreets.some(q => q.side === side && Math.abs(wrapDiff(q.s, s)) < q.width / 2 + margin);
    function wrapDiff(a, b) { let d = a - b; if (d > L / 2) d -= L; if (d < -L / 2) d += L; return d; }

    // district: how tall the buildings grow (downtown along the second and third streets)
    const downtown = [440, 185];
    const heightAt = (x, z) => {
      const d = Math.hypot(x - downtown[0], z - downtown[1]);
      const tall = Math.max(0, 1 - d / 520);
      const r = R();
      return 9 + r * 14 + tall * tall * (40 + R() * 95) + (r > 0.93 ? 30 : 0);
    };
    // buildings as oriented boxes; reject overlaps with a coarse grid of their bounding circles
    const BCELL = 40, bgrid = new Map();
    const bkey = (i, j) => i * 100003 + j;
    function overlaps(b) {
      const ci = Math.floor(b.x / BCELL), cj = Math.floor(b.z / BCELL), rb = Math.hypot(b.hx, b.hz);
      for (let di = -2; di <= 2; di++) for (let dj = -2; dj <= 2; dj++) {
        const list = bgrid.get(bkey(ci + di, cj + dj));
        if (list) for (const o of list) if (Math.hypot(o.x - b.x, o.z - b.z) < rb + Math.hypot(o.hx, o.hz) && obbOverlap(o, b, 0.6)) return true;
      }
      return false;
    }
    function addBuilding(b) {
      if (overlaps(b)) return false;
      // every corner and the middle of every side must stay off the street and pavement
      const c = Math.cos(b.angle), s = Math.sin(b.angle);
      for (const [u, w] of [[1, 1], [1, -1], [-1, 1], [-1, -1], [1, 0], [-1, 0], [0, 1], [0, -1], [0, 0]]) {
        const x = b.x + c * u * b.hx - s * w * b.hz, z = b.z + s * u * b.hx + c * w * b.hz;
        const f = nearest(x, z), p = poseAt(f.s, 0);
        if (Math.hypot(x - p.x, z - p.z) < WALK_OUT + 0.5) return false;
      }
      for (const q of sideStreets) {   // nor into a side street
        const p = poseAt(q.s, q.side * (ROAD_HALF + 20)), dx = b.x - p.x, dz = b.z - p.z;
        const ax = -Math.sin(p.h) * q.side, az = Math.cos(p.h) * q.side;     // along the side street
        const along = dx * ax + dz * az, across = Math.abs(-dx * az + dz * ax);
        if (along > -40 && along < 60 && across < q.width / 2 + Math.hypot(b.hx, b.hz)) return false;
      }
      const k = bkey(Math.floor(b.x / BCELL), Math.floor(b.z / BCELL));
      if (!bgrid.has(k)) bgrid.set(k, []);
      bgrid.get(k).push(b);
      buildings.push(b);
      boxes.push({ x: b.x, z: b.z, hx: b.hx, hz: b.hz, angle: b.angle, height: Math.min(b.height, 12) });
      return true;
    }
    // frontage: along both sides of the circuit, facing the street
    for (const side of [-1, 1]) {
      for (let s = 0; s < L;) {
        const w = 14 + R() * 26, d = 14 + R() * 18, mid = s + w / 2;
        if (!nearSide(mid, side, w / 2 + 2)) {
          const set = WALK_OUT + 1 + R() * 2.5, p = poseAt(mid, side * (set + d / 2));
          const b = { x: p.x, z: p.z, hx: w / 2, hz: d / 2, angle: p.h, height: heightAt(p.x, p.z), style: Math.floor(R() * 4), front: side };
          addBuilding(b);
        }
        s += w + 1 + R() * 3;
      }
    }
    // blocks behind: a grid of lots inside and around the loop, some left open as plazas
    let x0 = Infinity, x1 = -Infinity, z0 = Infinity, z1 = -Infinity;
    for (let i = 0; i < C.N; i++) { x0 = Math.min(x0, C.x[i]); x1 = Math.max(x1, C.x[i]); z0 = Math.min(z0, C.z[i]); z1 = Math.max(z1, C.z[i]); }
    const M = 220;
    for (let gx = x0 - M; gx <= x1 + M; gx += 46) for (let gz = z0 - M; gz <= z1 + M; gz += 46) {
      if (R() < 0.12) continue;
      const w = 18 + R() * 22, d = 18 + R() * 22, x = gx + (R() - 0.5) * 10, z = gz + (R() - 0.5) * 10;
      const f = nearest(x, z), p = poseAt(f.s, 0);
      if (Math.hypot(x - p.x, z - p.z) < 36) continue;
      addBuilding({ x, z, hx: w / 2, hz: d / 2, angle: (R() < 0.8 ? 0 : (R() - 0.5) * 0.3), height: heightAt(x, z), style: Math.floor(R() * 4), front: 0 });
    }
    // distant skyline (no colliders): a ring of towers beyond the blocks
    const skyline = [];
    for (let a = 0; a < 2 * Math.PI; a += 0.06) {
      const rr = 820 + R() * 380, cx = (x0 + x1) / 2 + Math.cos(a) * rr, cz = (z0 + z1) / 2 + Math.sin(a) * rr * 0.8;
      skyline.push({ x: cx, z: cz, hx: 15 + R() * 25, hz: 15 + R() * 25, angle: R() * 0.4, height: 30 + R() * R() * 160, style: Math.floor(R() * 4) });
    }

    // street furniture along the pavements (colliders: tree trunks; the street lights are props that
    // break off their bases when hit, see below)
    for (const side of [-1, 1]) {
      for (let s = 12; s < L - 6; s += 32) {
        if (nearSide(s, side, 4)) continue;
        const p = poseAt(s, side * (ROAD_HALF + 0.7));
        lamps.push({ x: p.x, z: p.z, h: p.h + (side > 0 ? -Math.PI / 2 : Math.PI / 2), side, s });
        const ts = s + 16;
        if (!nearSide(ts, side, 5) && Math.abs(C.k[sampleAt(ts)]) < 0.012) {
          const q = poseAt(ts, side * (ROAD_HALF + 2.2));
          trees.push({ x: q.x, z: q.z, size: 0.8 + R() * 0.5, seed: Math.floor(R() * 1e6) });
          cyls.push({ x: q.x, z: q.z, r: 0.22, height: 4 });
        }
      }
    }
    // side streets: a stub of road, barriers across it, signals at the corners
    for (const q of sideStreets) {
      const p0 = poseAt(q.s, q.side * ROAD_HALF), hs = p0.h + (q.side > 0 ? Math.PI / 2 : -Math.PI / 2);
      const bx = p0.x + Math.cos(hs) * 9, bz = p0.z + Math.sin(hs) * 9;
      barriers.push({ x: bx, z: bz, angle: hs + Math.PI / 2, len: q.width });
      boxes.push({ x: bx, z: bz, hx: q.width / 2, hz: 0.35, angle: hs + Math.PI / 2, height: 1.1 });
      for (const e of [-1, 1]) {
        const c = poseAt(q.s + e * (q.width / 2 + 1.2), q.side * (ROAD_HALF + 0.9));
        signals.push({ x: c.x, z: c.z, h: c.h + (q.side > 0 ? -Math.PI / 2 : Math.PI / 2), arm: e < 0 });
      }
    }
    // guard rails along the outer edge of both pavements, all the way round (open at the side
    // streets, which their barriers close): the blocks behind them are out of bounds. Straight
    // pieces about 4 m long, as colliders 0.85 m high
    const rails = [];
    const RAIL_L = WALK_OUT - 0.35;
    for (const side of [-1, 1]) {
      const seg = (L / Math.round(L / 4));
      for (let s0 = 0; s0 < L - 1e-6; s0 += seg) {
        const sm = s0 + seg / 2;
        if (nearSide(sm, side, seg / 2 + 0.5)) continue;
        const a = poseAt(s0, side * RAIL_L), b = poseAt(Math.min(L, s0 + seg), side * RAIL_L);
        const len = Math.hypot(b.x - a.x, b.z - a.z), angle = Math.atan2(b.z - a.z, b.x - a.x);
        rails.push({ x0: a.x, z0: a.z, x1: b.x, z1: b.z, side });
        boxes.push({ x: (a.x + b.x) / 2, z: (a.z + b.z) / 2, hx: len / 2 + 0.05, hz: 0.12, angle, height: 0.85, rail: true });
      }
    }

    // ------------------------------------------------ things to knock over (props.js moves them)
    // { type, x, z, h (yaw), y (stacked on another, m) }. The street lights and signal posts; along
    // the outer pavement bins, newspaper boxes, hydrants and benches; cones and barrels at roadworks
    // by the kerb (clear of the outer lane's traffic); crates and barrels in front of the side
    // streets' barriers. Kept clear of the ramps.
    const props = [];
    const nearRamp = (s, m) => ramps.some(r => { const u = wrapDiff(s, r.s); return u > -m && u < r.len + m; });
    for (const o of lamps) props.push({ type: 'lamp', x: o.x, z: o.z, h: o.h, y: 0 });
    for (const o of signals) props.push({ type: 'signal', x: o.x, z: o.z, h: o.h, y: 0 });
    const KINDS = [['bin', 0.3], ['newsbox', 0.2], ['hydrant', 0.2], ['bench', 0.3]];
    for (const side of [-1, 1]) {
      for (let s = 20; s < L - 10; s += 22 + R() * 12) {
        let u = R(), type = KINDS[0][0];
        for (const [k, w] of KINDS) { if (u < w) { type = k; break; } u -= w; }
        if (nearSide(s, side, 6) || Math.abs(C.k[sampleAt(s)]) > 0.02) continue;
        if (lamps.some(o => o.side === side && Math.abs(wrapDiff(o.s, s)) < 2.5)) continue;
        const l = type === 'hydrant' ? ROAD_HALF + 1.0 : type === 'bench' ? ROAD_HALF + 3.4 : ROAD_HALF + 3.6;
        const p = poseAt(s, side * l);
        props.push({ type, x: p.x, z: p.z, h: type === 'bench' ? p.h + (side > 0 ? 0 : Math.PI) : p.h + R() * 6.28, y: 0 });
      }
    }
    // roadworks: a row of cones along the kerb, a barrel at each end
    for (const f of [0.3, 0.45, 0.66, 0.93]) {
      const s0 = f * L, side = R() < 0.5 ? -1 : 1;
      if (nearRamp(s0, 30) || nearSide(s0 + 12, side, 20) || Math.abs(wrapDiff(s0, START_S)) < 80) continue;
      for (let i = 0; i <= 8; i++) {
        const p = poseAt(s0 + i * 3.2, side * 6.95);
        props.push({ type: i === 0 || i === 8 ? 'barrel' : 'cone', x: p.x, z: p.z, h: R() * 6.28, y: 0 });
      }
    }
    // the side streets: crates (some stacked) and barrels in front of the barriers
    for (const q of sideStreets) {
      const p0 = poseAt(q.s, q.side * ROAD_HALF), hs = p0.h + (q.side > 0 ? Math.PI / 2 : -Math.PI / 2), c = Math.cos(hs), s = Math.sin(hs);
      const at = (along, across) => ({ x: p0.x + c * along - s * across, z: p0.z + s * along + c * across });
      for (const [along, across, type, y] of [[6.2, -2.4, 'crate', 0], [6.2, -1.5, 'crate', 0], [6.2, -1.95, 'crate', 0.8], [7.0, 2.2, 'barrel', 0], [6.4, 2.9, 'barrel', 0], [6.6, -3.4, 'crate', 0]]) {
        const p = at(along, across);
        props.push({ type, x: p.x, z: p.z, h: hs + (R() - 0.5) * 0.3, y });
      }
    }

    // grid of colliders for queries (the game's own collisions and the crash hand-over)
    const GCELL = 20, cgrid = new Map();
    const addTo = (o, x0, x1, z0, z1) => { for (let i = Math.floor(x0 / GCELL); i <= Math.floor(x1 / GCELL); i++) for (let j = Math.floor(z0 / GCELL); j <= Math.floor(z1 / GCELL); j++) { const k = key(i, j); if (!cgrid.has(k)) cgrid.set(k, []); cgrid.get(k).push(o); } };
    for (const b of boxes) { const c = Math.cos(b.angle), s = Math.sin(b.angle), ex = Math.abs(c) * b.hx + Math.abs(s) * b.hz, ez = Math.abs(s) * b.hx + Math.abs(c) * b.hz; b.box = true; addTo(b, b.x - ex, b.x + ex, b.z - ez, b.z + ez); }
    for (const q of cyls) { q.box = false; addTo(q, q.x - q.r, q.x + q.r, q.z - q.r, q.z + q.r); }
    function collidersNear(x, z, r) {
      const out = new Set();
      for (let i = Math.floor((x - r) / GCELL); i <= Math.floor((x + r) / GCELL); i++) for (let j = Math.floor((z - r) / GCELL); j <= Math.floor((z + r) / GCELL); j++) {
        const list = cgrid.get(key(i, j));
        if (list) for (const o of list) out.add(o);
      }
      return Array.from(out);
    }

    return {
      seed: opts.seed || 20261007, circuit: C, length: L, laps: 3, lanes: LANES, laneWidth: LANE_W, roadHalf: ROAD_HALF, walkOut: WALK_OUT,
      start: { s: START_S }, corners,
      buildings, skyline, sideStreets, lamps, trees, signals, barriers, rails, stops, props, ramps, hills: HILLS,
      colliders: { boxes, cyls }, collidersNear, nearest, poseAt, sampleAt, wrapDiff, terrain, groundAt, rampProfile,
      bounds: { x0, x1, z0, z1 },
    };
  }

  // do two oriented boxes overlap (with a margin)?
  function obbOverlap(a, b, margin) {
    const axes = [[Math.cos(a.angle), Math.sin(a.angle)], [-Math.sin(a.angle), Math.cos(a.angle)], [Math.cos(b.angle), Math.sin(b.angle)], [-Math.sin(b.angle), Math.cos(b.angle)]];
    const dx = b.x - a.x, dz = b.z - a.z;
    for (const [ux, uz] of axes) {
      const ra = a.hx * Math.abs(Math.cos(a.angle) * ux + Math.sin(a.angle) * uz) + a.hz * Math.abs(-Math.sin(a.angle) * ux + Math.cos(a.angle) * uz);
      const rb = b.hx * Math.abs(Math.cos(b.angle) * ux + Math.sin(b.angle) * uz) + b.hz * Math.abs(-Math.sin(b.angle) * ux + Math.cos(b.angle) * uz);
      if (Math.abs(dx * ux + dz * uz) > ra + rb + margin) return false;
    }
    return true;
  }

  return { build, buildCircuit, rng, obbOverlap, LANES, LANE_W, ROAD_HALF, WALK_OUT };
})();
if (typeof module === 'object' && module.exports) module.exports = CrashLevel;
