/* Pedestrian impact with automatic emergency braking (AEB). No dependencies: browser (global
 * CrashPedestrian) and Node.
 *
 * Approach: the car drives straight at a set speed; a pedestrian crosses from the right, timed so
 * that without braking the car's front centre meets them. The car's forward sensor (radar and
 * camera fused) sees within a cone of +-25 degrees and 60 m (45 m for a child), unless something
 * blocks the line of sight: the child steps out from in front of a parked car. A pedestrian seen
 * for 0.25 s is confirmed; if their path will cross the car's, the system warns at 1.8 s to
 * collision and brakes fully at 1.1 s (0.85 g, built up over 0.25 s after 0.1 s of latency).
 *
 * Impact: the pedestrian is a chain of masses (feet, knees, pelvis, chest, neck, head) seen from
 * the car's side, struck on the leg by the bumper and wrapped onto the hood and windshield. The
 * car's front is the vehicle's own side profile; its surfaces are elastic-plastic: the bumper
 * (rigid steel or energy-absorbing foam), the hood leading edge, the hood (it dents onto the
 * engine), the windshield (it cracks) and the roof edge. The car's motion is imposed (the
 * pedestrian is too light to change it). Reported: head HIC15, head, pelvis and upper-leg
 * accelerations, knee bending, the head's impact speed, surface and wrap-around distance, and the
 * throw distance. Illustrative, not a validated pedestrian model.
 */
(function (root) {
'use strict';

const G = 9.81;
const LIMITS = { hic15: 1000, kneeDeg: 15, tibiaG: 170, pelvisG: 80 };
const SENSOR = { fov: 25 * Math.PI / 180, range: { adult: 60, child: 45 }, confirm: 0.25, warnTTC: 1.8, brakeTTC: 1.1, latency: 0.1, ramp: 0.25, decel: 0.85 * G };
const DRIVER = { reaction: 0.6, decel: 0.8 * G };   // without AEB the driver brakes after the impact
// Pedestrians, standing: heights of ankle, knee, hip, shoulder (T1), neck (C1) and head centre;
// masses and contact radii of the same points
const BODY = {
  adult: { label: 'Adult (1.75 m, 75 kg)', y: [0.08, 0.50, 0.93, 1.45, 1.57, 1.66], m: [5, 8, 24, 31, 1.5, 4.5], r: [0.05, 0.065, 0.15, 0.16, 0.05, 0.09], walk: 1.39, start: 3.5 },
  child: { label: 'Child (6 years, 1.17 m, 23 kg)', y: [0.06, 0.32, 0.60, 0.92, 1.0, 1.06], m: [1.4, 2.2, 7.4, 8.2, 0.6, 3.0], r: [0.04, 0.05, 0.11, 0.12, 0.04, 0.08], walk: 1.39, start: 3.0 },
};
const FOOT = 0, KNEE = 1, HIP = 2, CHEST = 3, NECK = 4, HEAD = 5, NP = 6;
// joint springs (N m/rad): knee (lateral bending: ligaments give way past 15 degrees), hip, spine, neck
const JOINTS = { adult: [[300, 60], [180, 20], [500, 40], [40, 3]], child: [[90, 18], [60, 6], [150, 12], [14, 1]] };
// car surfaces crush in two stages: [stiffness N/m, first plateau N, its stroke m, second plateau N
// (the structure behind: bumper beam, engine, glass frame), total stroke m]; rigid beyond
const SURF = {
  bumperSteel: [1.5e6, 12000, 0.02, 25000, 0.10], bumperFoam: [1.5e5, 4000, 0.10, 15000, 0.15],
  edge: [4e5, 6000, 0.05, 15000, 0.12], hood: [1.2e5, 5000, 0.10, 20000, 0.15], glass: [2.5e5, 4500, 0.06, 8000, 0.12], roof: [2e6, 30000, 0.01, 40000, 0.05],
};
const SURF_NAMES = { bumperSteel: 'bumper', bumperFoam: 'bumper', edge: 'hood leading edge', hood: 'hood', glass: 'windshield', roof: 'roof edge', ground: 'ground' };

// The car's side profile ahead of the windshield top, relative to its front (x <= 0), from the
// vehicle spec: a polyline from the bumper's lower edge up the front face and back over the hood,
// windshield and roof, each segment tagged with its surface.
function frontProfile(spec, bumper) {
  const L = spec.length, prof = spec.profile, top = (u) => {
    if (u <= prof[0][0]) return prof[0][1];
    for (let i = 1; i < prof.length; i++) if (u <= prof[i][0]) { const s = (u - prof[i - 1][0]) / (prof[i][0] - prof[i - 1][0]); return prof[i - 1][1] + (prof[i][1] - prof[i - 1][1]) * s * s * (3 - 2 * s); }
    return prof[prof.length - 1][1];
  };
  const bottom = Math.max(0.22, spec.yBottom - 0.08), front = top(L - 0.01);
  const bumperTop = Math.min(front - 0.05, bottom + 0.42);
  const pts = [[0, bottom, bumper], [0, bumperTop, 'edge']];
  // over the top: the hood rises to the windshield base, the glass to the roof
  let roofU = L - 2.6, wsU = L - 1.2;
  let maxSlope = 0;
  for (let u = L - 0.3; u > L - 2.6; u -= 0.05) { const s = (top(u) - top(u + 0.05)) / 0.05; if (s > maxSlope) { maxSlope = s; wsU = u + 0.1; } }
  for (let u = wsU; u > L - 3.2; u -= 0.05) if ((top(u) - top(u + 0.05)) / 0.05 < 0.15) { roofU = u; break; }
  for (let u = L; u >= roofU - 0.3; u -= 0.05) {
    const x = u - L, y = top(u);
    const tag = u > L - 0.15 ? 'edge' : u > wsU ? 'hood' : u > roofU + 0.05 ? 'glass' : 'roof';
    pts.push([x, y, tag]);
  }
  return { pts, bottom, bumperTop, wsX: wsU - L, roofX: roofU - L, length: L };
}

// --------------------------------------------------------------------- approach and AEB
/* opts: { kmh, target: 'adult'|'child', aeb, width, length } */
function plan(opts) {
  const B = BODY[opts.target], v0 = opts.kmh / 3.6, dt = 0.002, W = opts.width;
  const tc = B.start / B.walk;                  // the pedestrian reaches the car's centre line
  const x0 = -v0 * tc;                          // car front at the start; impact point at x = 0
  const parked = opts.target === 'child' ? { x0: -6.0, x1: -1.5, z0: 1.55, z1: 3.35 } : null;   // a parked car hides the child
  const range = SENSOR.range[opts.target];
  let x = x0, v = v0, a = 0, t = 0, seen = -1, confirmed = -1, warn = -1, brake = -1, impact = null, stopped = -1;
  const out = { dt, t: [], carX: [], carV: [], pedX: 0, pedZ: [], state: [], visible: [], parked, x0, v0, W, tc, range, body: B };
  const pedZ = (tt) => B.start - B.walk * tt;
  // does the line of sight from the sensor (sx, 0) to the pedestrian (px, pz) pass through the
  // parked car's footprint? (segment against rectangle, Liang-Barsky)
  const occluded = (sx, px, pz) => {
    if (!parked) return false;
    let t0 = 0, t1 = 1;
    const dx = px - sx, dz = pz;
    for (const [p, q] of [[-dx, sx - parked.x0], [dx, parked.x1 - sx], [-dz, 0 - parked.z0], [dz, parked.z1 - 0]]) {
      if (Math.abs(p) < 1e-12) { if (q < 0) return false; continue; }
      const r = q / p;
      if (p < 0) { if (r > t1) return false; if (r > t0) t0 = r; } else { if (r < t0) return false; if (r < t1) t1 = r; }
    }
    return t0 < t1;
  };
  const r0 = B.r[CHEST];
  for (let k = 0; t < tc + 4; k++) {
    t = k * dt;
    const pz = pedZ(t);
    // sensor
    const dx = 0 - x, ang = Math.atan2(pz, Math.max(1e-6, dx));
    const vis = dx > 0 && Math.hypot(dx, pz) < range && Math.abs(ang) < SENSOR.fov && !occluded(x, 0, pz);
    if (vis) { if (seen < 0) seen = t; } else if (confirmed < 0) seen = -1;
    if (seen >= 0 && confirmed < 0 && t - seen >= SENSOR.confirm) confirmed = t;
    let st = vis ? 1 : 0;
    if (confirmed >= 0 && !impact) {
      st = 2;
      const ttc = v > 0.1 ? (0 - x - r0) / v : Infinity;
      const zArrive = pz - B.walk * Math.max(0, ttc);
      const conflict = Math.abs(zArrive) < W / 2 + 0.6 || Math.abs(pz) < W / 2 + 0.3;
      if (opts.aeb && conflict && ttc < SENSOR.warnTTC && warn < 0) warn = t;
      if (opts.aeb && conflict && ttc < SENSOR.brakeTTC && brake < 0) brake = t;
      if (warn >= 0) st = 3;
    }
    if (brake >= 0 && !impact) st = 4;
    // longitudinal: AEB brake ramp, or the driver after an impact
    let target = 0;
    if (brake >= 0 && t > brake + SENSOR.latency) target = SENSOR.decel * Math.min(1, (t - brake - SENSOR.latency) / SENSOR.ramp);
    if (impact && !opts.aeb && t > impact.t + DRIVER.reaction) target = DRIVER.decel;
    if (impact && opts.aeb) target = Math.max(target, SENSOR.decel);
    a = target;
    v = Math.max(0, v - a * dt); x += v * dt;
    if (v === 0 && stopped < 0) stopped = t;
    out.t.push(t); out.carX.push(x); out.carV.push(v); out.pedZ.push(pz); out.state.push(impact ? 5 : st); out.visible.push(vis ? 1 : 0);
    // contact: the front reaches the pedestrian while they are in front of it
    if (!impact && x + 0.0 >= -r0 && Math.abs(pz) < W / 2 + r0 * 0.5) impact = { t, v, x, z: pz };
    if (stopped >= 0 && t > stopped + 0.6) break;
    if (impact && t > impact.t + 2.2) break;
  }
  Object.assign(out, { seen, confirmed, warn, brake, impact, stopped, distLeft: impact ? 0 : (0 - x - r0) });
  return out;
}

// --------------------------------------------------------------------- impact
function impact(opts, P, profile) {
  const B = BODY[opts.target], J = JOINTS[opts.target];
  const dt = 5e-5, Tend = 1.6, N = Math.round(Tend / dt);
  const x = new Float64Array(NP), y = new Float64Array(NP), vx = new Float64Array(NP), vy = new Float64Array(NP);
  const px = new Float64Array(NP), py = new Float64Array(NP), fx = new Float64Array(NP), fy = new Float64Array(NP), ovx = new Float64Array(NP), ovy = new Float64Array(NP);
  const xi = P.impact.x + B.r[KNEE];   // the pedestrian stands just ahead of the bumper
  for (let i = 0; i < NP; i++) { x[i] = xi; y[i] = B.y[i]; }
  const links = [[FOOT, KNEE], [KNEE, HIP], [HIP, CHEST], [CHEST, NECK], [NECK, HEAD]];
  const len = links.map(([a, b]) => Math.hypot(x[b] - x[a], y[b] - y[a]));
  const ang = (a, b) => Math.atan2(x[b] - x[a], y[b] - y[a]);
  const wrap = (v) => Math.atan2(Math.sin(v), Math.cos(v));
  const angVel = (a, b) => { const dx = x[b] - x[a], dy = y[b] - y[a]; return (dy * (vx[b] - vx[a]) - dx * (vy[b] - vy[a])) / (dx * dx + dy * dy); };
  function couple(a, b, tau) { const dx = x[b] - x[a], dy = y[b] - y[a], s = tau / (dx * dx + dy * dy); fx[b] += s * dy; fy[b] -= s * dx; fx[a] -= s * dy; fy[a] += s * dx; }
  // car motion after impact, from the plan
  const t0 = P.impact.t, carAt = (t) => {
    const k = Math.min(P.t.length - 1, Math.max(0, Math.round((t0 + t) / P.dt)));
    return [P.carX[k], P.carV[k]];
  };
  const pts = profile.pts, nseg = pts.length - 1;
  const segSet = Array.from({ length: nseg }, () => ({ set: 0 }));
  const kneeSet = { v: 0 };
  let knee = 0, headHit = null, glassCracked = false;
  const out = { dt, n: N, headA: new Float64Array(N), pelvisA: new Float64Array(N), kneeA: new Float64Array(N), kneeAng: new Float64Array(N), contactF: new Float64Array(N),
    poseEvery: 20, pose: null, events: [], carX: new Float64Array(N), headOn: new Uint8Array(N) };   // 1 car, 2 ground
  out.pose = new Float32Array(Math.ceil(N / out.poseEvery) * (2 * NP + 1));
  // contact of particle i (radius r) with the car profile: closest point over the segments
  function carContact(i, carX, carV, k) {
    const r = B.r[i], lx = x[i] - carX, ly = y[i];
    if (lx > 0.4 || lx < profile.roofX - 0.5 || ly > 2.4) return 0;
    let best = Infinity, bs = -1, bxp = 0, byp = 0;
    for (let s = 0; s < nseg; s++) {
      const ax = pts[s][0], ay = pts[s][1], ex = pts[s + 1][0] - ax, ey = pts[s + 1][1] - ay, L2 = ex * ex + ey * ey;
      const u = Math.max(0, Math.min(1, ((lx - ax) * ex + (ly - ay) * ey) / L2)), qx = ax + u * ex, qy = ay + u * ey;
      const d = Math.hypot(lx - qx, ly - qy);
      if (d < best) { best = d; bs = s; bxp = qx; byp = qy; }
    }
    // inside the car: behind the front face and below the top line
    const inside = lx < 0 && ly > profile.bottom && ly < topAt(lx);
    const dist = inside ? -best : best, pen = r - dist;
    if (pen <= 0) return 0;
    let nx = (lx - bxp) / (best || 1e-9), ny = (ly - byp) / (best || 1e-9);
    if (inside) { nx = -nx; ny = -ny; }
    const tag = bs === 0 ? pts[0][2] : pts[bs + 1][2];
    const M = SURF[tag], st = segSet[bs];
    let e = pen - st.set;
    const cap = st.set < M[2] ? (tag === 'glass' && glassCracked ? 2000 : M[1]) : M[3];
    if (e > cap / M[0] && st.set < M[4]) {
      st.set = Math.min(M[4], pen - cap / M[0]); e = pen - st.set;
      if (tag === 'glass' && !glassCracked) { glassCracked = true; out.events.push({ t: k * dt, type: 'crack', mag: 1 }); }
    }
    let F = e > 0 ? M[0] * e : 0;
    // damping and friction, relative to the moving car
    const rvx = vx[i] - carV, rvy = vy[i], vn = rvx * nx + rvy * ny;
    F = Math.max(0, F - (vn < 0 ? 400 * vn * (B.m[i] / 10) : 0));
    const tx = -ny, ty = nx, vt = rvx * tx + rvy * ty, Ff = 0.3 * F * Math.tanh(vt / 0.05);
    fx[i] += F * nx - Ff * tx; fy[i] += F * ny - Ff * ty;
    if (i === HEAD && F > 300) headCar = true;
    if (i === HEAD && F > 1500 && (!headHit || F > headHit.F)) {
      if (!headHit) headHit = { F, t: k * dt, surface: SURF_NAMES[tag], speed: Math.hypot(rvx, rvy), lx, ly, seg: bs };
      else headHit.F = F;
    }
    return F;
  }
  const topAt = (lx) => {
    for (let s = 1; s < nseg; s++) { const a = pts[s], b = pts[s + 1]; if (lx <= a[0] && lx >= b[0]) { const u = (a[0] - lx) / ((a[0] - b[0]) || 1e-9); return a[1] + (b[1] - a[1]) * u; } }
    return pts[1][1];
  };
  let headGround = false, headCar = false, groundHit = null;
  function forces(t, k) {
    const [carX, carV] = carAt(t);
    headGround = false; headCar = false;
    for (let i = 0; i < NP; i++) { fx[i] = 0; fy[i] = -B.m[i] * G; }
    // joints: knee, hip, spine, neck (lateral bending)
    const segs = [[FOOT, KNEE], [KNEE, HIP], [HIP, CHEST], [CHEST, NECK], [NECK, HEAD]];
    for (let j = 0; j < 4; j++) {
      const [a, b] = segs[j], [c, d] = segs[j + 1];
      const rel = wrap(ang(c, d) - ang(a, b)), w = angVel(c, d) - angVel(a, b);
      let tau;
      if (j === 0) {   // knee: elastic to 15 degrees, then the ligaments give way (plastic)
        const lim = 15 * Math.PI / 180, e = wrap(rel - kneeSet.v);
        if (Math.abs(e) > lim) kneeSet.v = wrap(rel - lim * Math.sign(e));
        tau = -J[0][0] * wrap(rel - kneeSet.v) - J[0][1] * 2 * w;
        if (Math.abs(rel) > 1.0) tau -= 20 * J[0][0] * (rel - 1.0 * Math.sign(rel));   // bones meet
        knee = Math.max(knee, Math.abs(rel));
      } else tau = -J[j][0] * rel - J[j][1] * 2 * w;
      if (j === 3 && Math.abs(rel) > 0.8) tau -= 20 * J[3][0] * (rel - 0.8 * Math.sign(rel));
      if (j === 1 && Math.abs(rel) > 1.4) tau -= 20 * J[1][0] * (rel - 1.4 * Math.sign(rel));   // the hip's range
      couple(c, d, tau); couple(a, b, -tau);
    }
    // ground
    for (let i = 0; i < NP; i++) {
      const pen = (i === FOOT ? B.y[FOOT] : B.r[i]) - y[i];
      if (pen > 0) {
        const Fn = Math.max(0, 1.5e5 * pen - 2 * Math.sqrt(1.5e5 * B.m[i]) * 0.5 * vy[i]);
        fy[i] += Fn; fx[i] -= 0.6 * Fn * Math.tanh(vx[i] / 0.05);
        if (i === HEAD && Fn > 300) { headGround = true; if (Fn > 1500 && !groundHit) { groundHit = { t: t, F: Fn }; } }
      }
    }
    let Fc = 0;
    for (let i = 0; i < NP; i++) Fc += carContact(i, carX, carV, k);
    return Fc;
  }
  function integrate(t, k) {
    const Fc = forces(t, k);
    for (let i = 0; i < NP; i++) {
      ovx[i] = vx[i]; ovy[i] = vy[i];
      vx[i] += fx[i] / B.m[i] * dt; vy[i] += fy[i] / B.m[i] * dt;
      px[i] = x[i]; py[i] = y[i];
      x[i] += vx[i] * dt; y[i] += vy[i] * dt;
    }
    for (let it = 0; it < 4; it++) for (let l = 0; l < links.length; l++) {
      const [a, b] = links[l], dx = x[b] - x[a], dy = y[b] - y[a], d = Math.hypot(dx, dy);
      const wa = 1 / B.m[a], wb = 1 / B.m[b], s = (d - len[l]) / (d * (wa + wb));
      x[a] += wa * s * dx; y[a] += wa * s * dy; x[b] -= wb * s * dx; y[b] -= wb * s * dy;
    }
    for (let i = 0; i < NP; i++) { vx[i] = (x[i] - px[i]) / dt; vy[i] = (y[i] - py[i]) / dt; }
    return Fc;
  }
  for (let k = 0; k < N; k++) {
    const t = k * dt, Fc = integrate(t, k);
    out.headA[k] = Math.hypot(vx[HEAD] - ovx[HEAD], vy[HEAD] - ovy[HEAD]) / dt;
    out.pelvisA[k] = Math.hypot(vx[HIP] - ovx[HIP], vy[HIP] - ovy[HIP]) / dt;
    out.kneeA[k] = Math.hypot(vx[KNEE] - ovx[KNEE], vy[KNEE] - ovy[KNEE]) / dt;
    out.kneeAng[k] = knee; out.contactF[k] = Fc; out.carX[k] = carAt(t)[0]; out.headOn[k] = headCar ? 1 : headGround ? 2 : 0;
    if (k % out.poseEvery === 0) {
      const o = (k / out.poseEvery) * (2 * NP + 1);
      for (let i = 0; i < NP; i++) { out.pose[o + 2 * i] = x[i]; out.pose[o + 2 * i + 1] = y[i]; }
      out.pose[o + 2 * NP] = out.carX[k];
    }
  }
  if (headHit) out.events.push({ t: headHit.t, type: 'headStrike', mag: headHit.F, surface: headHit.surface });
  if (groundHit) out.events.push({ t: groundHit.t, type: 'groundHit', mag: groundHit.F, surface: 'ground' });
  out.events.sort((a, b) => a.t - b.t);
  // wrap-around distance: along the profile from the ground to the head's contact point
  let wad = null;
  if (headHit && headHit.surface !== 'ground') {
    wad = profile.bottom;
    for (let s = 0; s < headHit.seg; s++) wad += Math.hypot(pts[s + 1][0] - pts[s][0], pts[s + 1][1] - pts[s][1]);
    const a = pts[headHit.seg];
    wad += Math.hypot(headHit.lx - a[0], headHit.ly - a[1]);
  }
  const finalX = x[HIP] - P.impact.x;
  out.headHit = headHit; out.wad = wad; out.throw = finalX; out.kneeMaxDeg = knee * 180 / Math.PI;
  out.metrics = score(out);
  return out;
}

function cfc(data, dt, cls) {
  const n = data.length, wd = 2 * Math.PI * cls * 2.0775, wa = Math.tan(wd * dt / 2), den = 1 + Math.SQRT2 * wa + wa * wa;
  const a0 = wa * wa / den, a1 = 2 * a0, a2 = a0, b1 = -2 * (wa * wa - 1) / den, b2 = (-1 + Math.SQRT2 * wa - wa * wa) / den;
  const pass = (x) => { const y = new Float64Array(n); y[0] = x[0]; y[1] = x[1]; for (let i = 2; i < n; i++) y[i] = a0 * x[i] + a1 * x[i - 1] + a2 * x[i - 2] + b1 * y[i - 1] + b2 * y[i - 2]; return y; };
  return pass(pass(data).reverse()).reverse();
}
function hic15(a, dt) {   // a in g
  const n = a.length, cum = new Float64Array(n), W = Math.round(0.015 / dt);
  for (let i = 1; i < n; i++) cum[i] = cum[i - 1] + 0.5 * (a[i] + a[i - 1]) * dt;
  let best = 0, t1 = 0, t2 = 0;
  const stride = Math.max(1, Math.round(0.0002 / dt));
  for (let p = 0; p < n; p += stride) for (let q = p + stride; q < Math.min(n, p + W); q += stride) {
    const T = (q - p) * dt, avg = (cum[q] - cum[p]) / T;
    if (avg > 0) { const h = T * Math.pow(avg, 2.5); if (h > best) { best = h; t1 = p * dt; t2 = q * dt; } }
  }
  return { value: best, t1, t2 };
}
function score(o) {
  const dt = o.dt;
  const head = Float64Array.from(cfc(o.headA, dt, 1000), v => Math.abs(v) / G);
  const pelvis = Float64Array.from(cfc(o.pelvisA, dt, 180), v => Math.abs(v) / G);
  const knee = Float64Array.from(cfc(o.kneeA, dt, 180), v => Math.abs(v) / G);
  // the impact with the car (as pedestrian tests rate it) until the body leaves the car; the fall
  // onto the road afterwards is scored on its own
  let leave = 0;
  for (let i = 0; i < o.n; i++) if (o.contactF[i] > 50) leave = i;
  leave = Math.min(o.n - 1, leave + Math.round(0.02 / dt));
  const h = hic15(head.subarray(0, leave + 1), dt), hr = hic15(head.subarray(leave), dt);
  hr.t1 += leave * dt; hr.t2 += leave * dt;
  let hm = 0, pm = 0, km = 0;
  for (let i = 0; i <= leave; i++) { hm = Math.max(hm, head[i]); pm = Math.max(pm, pelvis[i]); km = Math.max(km, knee[i]); }
  const hicSurface = o.headHit ? o.headHit.surface : 'none';
  return { hic15: h.value, hicT1: h.t1, hicT2: h.t2, hicSurface, hicRoad: hr.value, hicRoadT1: hr.t1, tLeave: leave * dt, headPeakG: hm, pelvisPeakG: pm, tibiaPeakG: km, kneeDeg: o.kneeMaxDeg,
    headImpactSpeed: o.headHit ? o.headHit.speed : 0, headSurface: o.headHit ? o.headHit.surface : 'none', wad: o.wad, throwM: o.throw,
    series: { head, pelvis, knee } };
}

/* opts: { kmh, target, aeb, bumper: 'steel'|'foam', vehicle (a CrashVehicles spec) } */
function simulate(opts) {
  const spec = opts.vehicle;
  const P = plan({ kmh: opts.kmh, target: opts.target, aeb: opts.aeb, width: spec.width, length: spec.length });
  const out = { plan: P, impact: null, compare: null, profile: null };
  if (!P.impact) return out;
  const prof = (b) => frontProfile(spec, b === 'foam' ? 'bumperFoam' : 'bumperSteel');
  out.profile = prof(opts.bumper);
  out.impact = impact(opts, P, out.profile);
  const other = opts.bumper === 'foam' ? 'steel' : 'foam';
  out.compare = { bumper: other, impact: impact(Object.assign({}, opts, { bumper: other }), P, prof(other)) };
  return out;
}

const api = { G, LIMITS, SENSOR, BODY, PARTS: { FOOT, KNEE, HIP, CHEST, NECK, HEAD, NP }, frontProfile, plan, impact, simulate };
root.CrashPedestrian = api;
if (typeof module === 'object' && module.exports) module.exports = api;
})(typeof window !== 'undefined' ? window : globalThis);
