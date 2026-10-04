/* Occupant model and injury criteria. No dependencies (global CrashOccupant / Node module).
 *
 * Sled-test approach: the dummy sits in a seat that follows the cabin acceleration pulse from the
 * vehicle simulation (one-way coupling). The dummy is a 2D side-view multibody (pelvis, torso,
 * compliant sternum, neck, head) with joint springs, a 3-point belt with pretensioner and load
 * limiter, a driver airbag, and steering wheel / windshield / roof / knee-bolster contacts.
 * Lateral motion is a simple two-pendulum sway model.
 *
 * Channels are filtered per SAE J211 and scored with FMVSS 208-style criteria (HIC15, chest 3 ms
 * clip, chest deflection, Nij, neck tension/compression). Illustrative, not a validated dummy.
 */
(function (root) {
'use strict';

const G = 9.81;
const LIMITS = { hic15: 700, chest3ms: 60, chestDefl: 63, nij: 1.0, neckTension: 4170, neckCompression: 4000 };

// SAE J211-1 channel frequency class filter: 2-pole Butterworth run forward then backward
// (phaseless, 4-pole). Ends are padded with an odd reflection to limit start-up transients.
function cfc(data, dt, cfcClass) {
  const n = data.length;
  if (n < 4) return Float64Array.from(data);
  const wd = 2 * Math.PI * cfcClass * 2.0775;
  const wa = Math.tan(wd * dt / 2);
  const den = 1 + Math.SQRT2 * wa + wa * wa;
  const a0 = wa * wa / den, a1 = 2 * a0, a2 = a0;
  const b1 = -2 * (wa * wa - 1) / den, b2 = (-1 + Math.SQRT2 * wa - wa * wa) / den;
  const pad = Math.min(n - 2, 200), m = n + 2 * pad;
  const x = new Float64Array(m);
  for (let i = 0; i < pad; i++) x[i] = 2 * data[0] - data[pad - i];
  for (let i = 0; i < n; i++) x[pad + i] = data[i];
  for (let i = 0; i < pad; i++) x[pad + n + i] = 2 * data[n - 1] - data[n - 2 - i];
  const y = new Float64Array(m);
  y[0] = x[0]; y[1] = x[1];
  for (let i = 2; i < m; i++) y[i] = a0 * x[i] + a1 * x[i - 1] + a2 * x[i - 2] + b1 * y[i - 1] + b2 * y[i - 2];
  const z = new Float64Array(m);
  z[m - 1] = y[m - 1]; z[m - 2] = y[m - 2];
  for (let i = m - 3; i >= 0; i--) z[i] = a0 * y[i] + a1 * y[i + 1] + a2 * y[i + 2] + b1 * z[i + 1] + b2 * z[i + 2];
  return z.slice(pad, pad + n);
}

// HIC with window capped at maxWin (s). a = resultant acceleration in g.
function hic(a, dt, i0, i1, maxWin) {
  i0 = Math.max(0, i0); i1 = Math.min(a.length - 1, i1);
  const cum = new Float64Array(i1 - i0 + 1);
  for (let i = i0 + 1; i <= i1; i++) cum[i - i0] = cum[i - i0 - 1] + 0.5 * (a[i] + a[i - 1]) * dt;
  const W = Math.round(maxWin / dt);
  let best = 0, t1 = i0, t2 = i0;
  for (let p = 0; p < cum.length; p++) {
    const end = Math.min(cum.length - 1, p + W);
    for (let q = p + 1; q <= end; q++) {
      const T = (q - p) * dt, avg = (cum[q] - cum[p]) / T;
      if (avg <= 0) continue;
      const h = T * Math.pow(avg, 2.5);
      if (h > best) { best = h; t1 = p + i0; t2 = q + i0; }
    }
  }
  return { value: best, i1: t1, i2: t2 };
}

// Highest level exceeded for a cumulative 3 ms.
function clip3ms(a, dt, i0, i1) {
  const vals = Array.from(a.slice(Math.max(0, i0), Math.min(a.length, i1 + 1))).sort((p, q) => q - p);
  const k = Math.max(0, Math.round(0.003 / dt) - 1);
  return vals.length > k ? vals[k] : (vals[vals.length - 1] || 0);
}

// ------------------------------------------------------------------ dummy definition
// Particles: pelvis, thorax CoM, T1 (shoulders), sternum, occipital condyle, head front, head back.
const PEL = 0, THX = 1, T1 = 2, STN = 3, OC = 4, HF = 5, HB = 6, NP = 7;
const MASS = [28, 18, 10, 1.5, 1.2, 2.25, 2.25];
const HEAD_MASS = MASS[HF] + MASS[HB];
const STERNUM_A = 0.28, STERNUM_B = 0.15;   // sternum rest point along / ahead of the spine (m)
const HEAD_R = 0.10, CHEST_R = 0.09;

// Interior, in the occupant frame (origin at the H-point, x forward, y up). Matches the car body
// in physics.js: H-point at car-local (-0.25, 0.60).
const INTERIOR = {
  hub: [0.40, 0.42], col: [-0.906, 0.423], rimDir: [0.423, 0.906], rimR: 0.19,
  bagOffset: 0.14, bagR: 0.24,
  wsA: [1.30, 0.40], wsB: [0.65, 0.85],
  roofY: 0.80,
  kneeGap: 0.12,
  dRing: [-0.32, 0.64], buckle: [-0.05, -0.06], lapAnchor: [-0.10, -0.14],
  doorRoll: -0.18,
};

function interiorFor(over) {
  if (!over) return INTERIOR;
  const I = Object.assign({}, INTERIOR);
  for (const k in over) if (over[k] !== null && over[k] !== undefined) I[k] = over[k];
  return I;
}

function restPose() {
  const x = new Float64Array(NP), y = new Float64Array(NP);
  const th = -22 * Math.PI / 180;
  const dx = Math.sin(th), dy = Math.cos(th), nx = Math.cos(th), ny = -Math.sin(th);
  x[PEL] = 0; y[PEL] = 0;
  x[T1] = 0.50 * dx; y[T1] = 0.50 * dy;
  x[THX] = 0.28 * dx + 0.05 * nx; y[THX] = 0.28 * dy + 0.05 * ny;
  x[STN] = STERNUM_A * dx + STERNUM_B * nx; y[STN] = STERNUM_A * dy + STERNUM_B * ny;
  const tn = 8 * Math.PI / 180;
  x[OC] = x[T1] + 0.13 * Math.sin(tn); y[OC] = y[T1] + 0.13 * Math.cos(tn);
  const thh = 3 * Math.PI / 180, ux = Math.sin(thh), uy = Math.cos(thh), fx = Math.cos(thh), fy = -Math.sin(thh);
  const cx = x[OC] + 0.02 * fx + 0.05 * ux, cy = y[OC] + 0.02 * fy + 0.05 * uy;
  x[HF] = cx + 0.065 * fx; y[HF] = cy + 0.065 * fy;
  x[HB] = cx - 0.065 * fx; y[HB] = cy - 0.065 * fy;
  return { x, y };
}

const LINKS = [[PEL, THX], [THX, T1], [PEL, T1], [T1, OC], [OC, HF], [OC, HB], [HF, HB]];

/* pulse: { dt, n, i0, ax, ay, az, gx, gy, gz } cabin acceleration and gravity in car axes (m/s^2)
 * opts:  { belt, airbag, interior, pretensioner, loadLimiter }  interior: per-vehicle overrides of
 *        INTERIOR (wsA, wsB, roofY); pretensioner and loadLimiter default to on (a plain belt has
 *        neither) */
function simulate(pulse, opts) {
  const belt = !!opts.belt, airbag = !!opts.airbag;
  const pretensioner = opts.pretensioner !== false, loadLimiter = opts.loadLimiter !== false;
  const dt = pulse.dt, N = pulse.n, I = interiorFor(opts.interior);
  const pose = restPose();
  const x = pose.x, y = pose.y;
  const vx = new Float64Array(NP), vy = new Float64Array(NP), px = new Float64Array(NP), py = new Float64Array(NP);
  const fx = new Float64Array(NP), fy = new Float64Array(NP), ovx = new Float64Array(NP), ovy = new Float64Array(NP);
  const linkLen = LINKS.map(([a, b]) => Math.hypot(x[b] - x[a], y[b] - y[a]));
  const x0 = Float64Array.from(x), y0 = Float64Array.from(y);

  const ang = (a, b) => Math.atan2(x[b] - x[a], y[b] - y[a]);
  const angVel = (a, b) => {
    const dx = x[b] - x[a], dy = y[b] - y[a];
    return (dy * (vx[b] - vx[a]) - dx * (vy[b] - vy[a])) / (dx * dx + dy * dy);
  };
  const headAng = () => ang(HB, HF) - Math.PI / 2;   // angle of the head's up axis
  const thT0 = ang(PEL, T1), thN0 = ang(T1, OC) - thT0, thH0 = headAng() - ang(T1, OC);

  // Couple of torque tau (positive = forward rotation) on segment a->b.
  function couple(a, b, tau) {
    const dx = x[b] - x[a], dy = y[b] - y[a], L2 = dx * dx + dy * dy;
    const s = tau / L2;
    fx[b] += s * dy; fy[b] -= s * dx;
    fx[a] -= s * dy; fy[a] += s * dx;
  }
  function joint(rel, rate, k, beta, c, limLo, limHi, kLim) {
    let tau = -k * rel * (1 + beta * rel * rel) - c * rate;
    if (rel > limHi) tau -= kLim * (rel - limHi);
    if (rel < limLo) tau -= kLim * (rel - limLo);
    return tau;
  }
  // Elastic-plastic penalty contact: force rises with stiffness k up to `cap`, then the part yields
  // (column collapses, rim bends, glass cracks) for up to `stroke` metres of permanent set, then
  // stiffens. Unloading is elastic, so the yield work is absorbed rather than returned.
  function plasticContact(st, pen, k, cap, stroke) {
    let e = pen - st.set;
    if (e > cap / k && st.set < stroke) { st.set = Math.min(stroke, pen - cap / k); e = pen - st.set; }
    return e > 0 ? k * e : 0;
  }
  const PC = { headWheel: { set: 0 }, stnWheel: { set: 0 }, thxWheel: { set: 0 }, t1Wheel: { set: 0 }, ws: { set: 0 }, roof: { set: 0 } };
  const wrap = (a) => Math.atan2(Math.sin(a), Math.cos(a));
  // Steering wheel seen from the side: a one-sided plane through the hub (normal toward the
  // driver) across the rim diameter, plus the rim tube at its top and bottom edges. One-sided so a
  // body pressed hard into it is pushed back, never through.
  const RIM_T = 0.02;
  function wheelContact(st, cxp, cyp, cvx, cvy, r, k, c, cap, stroke, out) {
    const rx = cxp - I.hub[0], ry = cyp - I.hub[1];
    const s = rx * I.rimDir[0] + ry * I.rimDir[1];
    const sd = rx * I.col[0] + ry * I.col[1];
    if (sd < -(r + 0.15)) return 0;                 // already beyond the wheel (went over the top)
    let nx, ny, pen;
    if (Math.abs(s) <= I.rimR) { nx = I.col[0]; ny = I.col[1]; pen = r + RIM_T - sd; }
    else {
      const ex = I.hub[0] + Math.sign(s) * I.rimR * I.rimDir[0], ey = I.hub[1] + Math.sign(s) * I.rimR * I.rimDir[1];
      const dx = cxp - ex, dy = cyp - ey, d = Math.hypot(dx, dy);
      if (d < 1e-9) return 0;
      nx = dx / d; ny = dy / d; pen = r + RIM_T - d;
    }
    if (pen <= 0) return 0;
    const vn = cvx * nx + cvy * ny;
    const F = Math.max(0, plasticContact(st, pen, k, cap, stroke) + (vn < 0 ? -c * vn : 0));
    out.fx += F * nx; out.fy += F * ny;
    return F;
  }

  // Airbag and pretensioner fire when cabin delta-v reaches the threshold soon after first contact.
  let tFire = -1, dv = 0;
  for (let i = pulse.i0; i < N && (i - pulse.i0) * dt <= 0.045; i++) {
    dv -= pulse.ax[i] * dt;
    if (dv >= 2.0) { tFire = i * dt; break; }
  }
  const bagFull = 0.026, bagDelay = 0.004;
  function bagRadius(t) {
    if (!airbag || tFire < 0 || t < tFire + bagDelay) return 0;
    const s = Math.min(1, (t - tFire - bagDelay) / bagFull);
    return I.bagR * s * s * (3 - 2 * s);
  }
  function bagStiffScale(t) {
    const tv = tFire + bagDelay + bagFull + 0.08;
    return t > tv ? Math.max(0.25, 1 - (t - tv) / 0.12) : 1;
  }
  const bagC = [I.hub[0] + I.bagOffset * I.col[0], I.hub[1] + I.bagOffset * I.col[1]];
  let wsNx = -(I.wsB[1] - I.wsA[1]), wsNy = I.wsB[0] - I.wsA[0];
  { const L = Math.hypot(wsNx, wsNy); wsNx /= L; wsNy /= L; if ((x[HF] - I.wsA[0]) * wsNx + (y[HF] - I.wsA[1]) * wsNy < 0) { wsNx = -wsNx; wsNy = -wsNy; } }

  // belts
  const SB_K = 9e4, SB_C = 800, LAP_K = 1.0e5, LAP_C = 800, LOAD_LIMIT = 4500, PRE_FORCE = 1500;
  function shoulderPath() {
    const shx = x[T1] + 0.06 * Math.cos(ang(PEL, T1)), shy = y[T1] - 0.06 * Math.sin(ang(PEL, T1));
    const d1 = Math.hypot(shx - I.dRing[0], shy - I.dRing[1]);
    const d2 = Math.hypot(x[STN] - shx, y[STN] - shy);
    const d3 = Math.hypot(I.buckle[0] - x[STN], I.buckle[1] - y[STN]);
    return { shx, shy, L: d1 + d2 + d3 };
  }
  const lapLen = () => 2 * Math.hypot(x[PEL] - I.lapAnchor[0], y[PEL] - I.lapAnchor[1]);
  let sbL0 = 0, lapL0 = 0, prePulled = 0;

  // lateral sway (torso roll about the hip, head roll on the neck)
  let phT = 0, phTd = 0, phH = 0, phHd = 0;
  const IT = 4.0, MT = 30, HT = 0.35, IH = 0.13, HH = 0.17;
  const kT = belt ? 900 : 300;

  // force evaluation; sets fx/fy and returns contact info
  const ext = { vx: 0, vy: 0, fx: 0, fy: 0 };
  let headExtX = 0, headExtY = 0, sbT = 0, lapT = 0, defl = 0, myUpper = 0, headHit = 0, hitSurf = '', hitX = 0, hitY = 0;
  let intF = 0;   // contact force from the airbag, wheel, windshield, roof and knee bolster (the "second collision")
  function forces(t, acx, acy, gxl, gyl, settling) {
    for (let i = 0; i < NP; i++) { fx[i] = MASS[i] * (gxl - acx); fy[i] = MASS[i] * (gyl - acy); }
    headExtX = 0; headExtY = 0; headHit = 0; intF = 0;

    // joints
    const thT = ang(PEL, T1), wT = angVel(PEL, T1);
    let tauHip = -40 * (thT - thT0) - 5 * wT;
    if (thT < thT0 - 0.01) tauHip += -2500 * (thT - thT0 + 0.01) - 150 * wT;  // seat back
    couple(PEL, T1, tauHip);
    const thN = ang(T1, OC), wN = angVel(T1, OC);
    const tauN = joint(wrap(thN - thT - thN0), wN - wT, 120, 4, 3, -0.8, 0.8, 2000);
    couple(T1, OC, tauN); couple(PEL, T1, -tauN);
    const thH = headAng(), wH = angVel(HB, HF);
    const tauH = joint(wrap(thH - thN - thH0), wH - wN, 60, 6, 1.5, -0.6, 0.5, 2000);
    couple(HB, HF, tauH); couple(T1, OC, -tauH);
    myUpper = -tauH;   // flexion positive

    // chest: sternum on a spring-damper ahead of the spine
    {
      const tx = x[T1] - x[PEL], ty = y[T1] - y[PEL], Lt = Math.hypot(tx, ty);
      const dxs = tx / Lt, dys = ty / Lt, nxs = dys, nys = -dxs;
      const wA = STERNUM_A / Lt;
      const srx = x[PEL] + STERNUM_A * dxs + STERNUM_B * nxs, sry = y[PEL] + STERNUM_A * dys + STERNUM_B * nys;
      const svx = vx[PEL] * (1 - wA) + vx[T1] * wA, svy = vy[PEL] * (1 - wA) + vy[T1] * wA;
      const ex = x[STN] - srx, ey = y[STN] - sry;
      defl = -(ex * nxs + ey * nys);
      const tang = ex * dxs + ey * dys;
      const rvx = vx[STN] - svx, rvy = vy[STN] - svy;
      const ddot = -(rvx * nxs + rvy * nys), tdot = rvx * dxs + rvy * dys;
      let Fn = defl > 0 ? 1.2e5 * defl + 2e7 * defl * defl * defl + 800 * ddot : 2e5 * defl + 800 * ddot;
      if (defl > 0.085) Fn += 2e6 * (defl - 0.085);
      const Ft = -2e5 * tang - 200 * tdot;
      const Fx = Fn * nxs + Ft * dxs, Fy = Fn * nys + Ft * dys;
      fx[STN] += Fx; fy[STN] += Fy;
      fx[PEL] -= Fx * (1 - wA); fy[PEL] -= Fy * (1 - wA);
      fx[T1] -= Fx * wA; fy[T1] -= Fy * wA;
    }

    // seat pan, seat back, thigh hold-down, knee bolster
    {
      const pen = -y[PEL];
      if (pen > 0) {
        const Fy = Math.max(0, 6e4 * pen - 1500 * vy[PEL]);
        fy[PEL] += Fy;
        fx[PEL] -= 0.35 * Fy * Math.tanh(vx[PEL] / 0.05);
      }
      if (x[PEL] < -0.03) fx[PEL] += 1e5 * (-0.03 - x[PEL]) - 1000 * Math.min(0, vx[PEL]);
      if (y[PEL] > 0.03) fy[PEL] -= 3e5 * (y[PEL] - 0.03) + 2000 * Math.max(0, vy[PEL]);   // thighs under the dash
      const kp = x[PEL] - I.kneeGap;
      if (kp > 0) { const Fk = Math.max(0, 1.5e5 * kp + 1500 * vx[PEL]); fx[PEL] -= Fk; intF += Fk; }
    }
    if (settling) return;

    // belts
    sbT = 0; lapT = 0;
    if (belt) {
      const sp = shoulderPath();
      // pretensioner: reel in slack for 8 ms after firing
      if (pretensioner && tFire >= 0 && t > tFire + 0.001 && t < tFire + 0.009 && prePulled < 0.08 && SB_K * (sp.L - sbL0) < PRE_FORCE) {
        sbL0 -= 8 * dt; prePulled += 8 * dt;
      }
      let ext1 = SB_K * (sp.L - sbL0);
      if (loadLimiter && ext1 > LOAD_LIMIT) { sbL0 = sp.L - LOAD_LIMIT / SB_K; ext1 = LOAD_LIMIT; }   // load limiter pays out
      if (ext1 > 0) {
        const u1x = (sp.shx - I.dRing[0]), u1y = (sp.shy - I.dRing[1]), l1 = Math.hypot(u1x, u1y);
        const u2x = (x[STN] - sp.shx), u2y = (y[STN] - sp.shy), l2 = Math.hypot(u2x, u2y);
        const u3x = (I.buckle[0] - x[STN]), u3y = (I.buckle[1] - y[STN]), l3 = Math.hypot(u3x, u3y);
        const Ld = (u1x * vx[T1] + u1y * vy[T1]) / l1 + (u2x * (vx[STN] - vx[T1]) + u2y * (vy[STN] - vy[T1])) / l2 - (u3x * vx[STN] + u3y * vy[STN]) / l3;
        const T = Math.max(0, ext1 + (Ld > 0 ? SB_C * Ld : 0));
        sbT = T;
        fx[T1] += T * (-u1x / l1 + u2x / l2); fy[T1] += T * (-u1y / l1 + u2y / l2);
        fx[STN] += T * (-u2x / l2 + u3x / l3); fy[STN] += T * (-u2y / l2 + u3y / l3);
      }
      const ll = lapLen();
      if (ll > lapL0) {
        const dx = x[PEL] - I.lapAnchor[0], dy = y[PEL] - I.lapAnchor[1], d = Math.hypot(dx, dy);
        const Ld = 2 * (dx * vx[PEL] + dy * vy[PEL]) / d;
        const T = Math.max(0, LAP_K * (ll - lapL0) + (Ld > 0 ? LAP_C * Ld : 0));
        lapT = T;
        fx[PEL] -= 2 * T * dx / d; fy[PEL] -= 2 * T * dy / d;
      }
    }

    // head and chest contacts
    const hcx = 0.5 * (x[HF] + x[HB]), hcy = 0.5 * (y[HF] + y[HB]);
    const hvx = 0.5 * (vx[HF] + vx[HB]), hvy = 0.5 * (vy[HF] + vy[HB]);
    const R = bagRadius(t), ks = bagStiffScale(t);
    function bag(cxp, cyp, cvx, cvy, r) {
      if (R <= 0) return [0, 0];
      const dx = cxp - bagC[0], dy = cyp - bagC[1], d = Math.hypot(dx, dy), pen = R + r - d;
      if (pen <= 0) return [0, 0];
      const nx = dx / d, ny = dy / d, vn = cvx * nx + cvy * ny;
      const F = Math.max(0, ks * (1.6e4 * pen + 3e5 * pen * pen * pen) + (vn < 0 ? -300 * vn : 0));
      return [F * nx, F * ny];
    }
    let hf = bag(hcx, hcy, hvx, hvy, HEAD_R);
    headExtX += hf[0]; headExtY += hf[1];
    const cf = bag(x[STN], y[STN], vx[STN], vy[STN], CHEST_R);
    fx[STN] += cf[0]; fy[STN] += cf[1];
    intF += Math.hypot(hf[0], hf[1]) + Math.hypot(cf[0], cf[1]);
    // steering wheel: rim bends for the head; column strokes for the chest and upper torso
    ext.vx = hvx; ext.vy = hvy; ext.fx = 0; ext.fy = 0;
    const Fh = wheelContact(PC.headWheel, hcx, hcy, hvx, hvy, HEAD_R, 1.5e5, 300, 6000, 0.06, ext);
    intF += Fh;
    headExtX += ext.fx; headExtY += ext.fy;
    if (Fh > 1000 && Fh > headHit) { headHit = Fh; hitSurf = 'wheel'; hitX = hcx; hitY = hcy; }
    for (const [p, rad, st] of [[STN, CHEST_R, PC.stnWheel], [THX, 0.13, PC.thxWheel], [T1, 0.12, PC.t1Wheel]]) {
      ext.vx = vx[p]; ext.vy = vy[p]; ext.fx = 0; ext.fy = 0;
      intF += wheelContact(st, x[p], y[p], vx[p], vy[p], rad, 2.5e5, 1000, 7000, 0.10, ext);
      fx[p] += ext.fx; fy[p] += ext.fy;
    }
    // chin on chest
    {
      const dx = hcx - x[STN], dy = hcy - y[STN], d = Math.hypot(dx, dy), pen = HEAD_R + CHEST_R - d;
      if (pen > 0 && d > 1e-9) {
        const nx = dx / d, ny = dy / d, vn = (hvx - vx[STN]) * nx + (hvy - vy[STN]) * ny;
        const F = Math.max(0, 1e5 * pen + (vn < 0 ? -300 * vn : 0));
        headExtX += F * nx; headExtY += F * ny;
        fx[STN] -= F * nx; fy[STN] -= F * ny;
      }
    }
    // windshield (glass cracks) and roof
    const sd = (hcx - I.wsA[0]) * wsNx + (hcy - I.wsA[1]) * wsNy, pw = HEAD_R - sd;
    if (pw > 0) {
      const vn = hvx * wsNx + hvy * wsNy, F = Math.max(0, plasticContact(PC.ws, pw, 1.2e5, 9000, 0.08) + (vn < 0 ? -300 * vn : 0));
      headExtX += F * wsNx; headExtY += F * wsNy;
      intF += F;
      if (F > 1000 && F > headHit) { headHit = F; hitSurf = 'windshield'; hitX = hcx - HEAD_R * wsNx; hitY = hcy - HEAD_R * wsNy; }
    }
    const pr = hcy + HEAD_R - I.roofY;
    if (pr > 0) { const F = Math.max(0, plasticContact(PC.roof, pr, 2e5, 12000, 0.05) + 300 * Math.max(0, hvy)); headExtY -= F; intF += F; if (F > 1000 && F > headHit) { headHit = F; hitSurf = 'roof'; hitX = hcx; hitY = hcy + HEAD_R; } }
    fx[HF] += 0.5 * headExtX; fy[HF] += 0.5 * headExtY;
    fx[HB] += 0.5 * headExtX; fy[HB] += 0.5 * headExtY;
  }

  function integrate(t, acx, acy, gxl, gyl, settling, damp) {
    forces(t, acx, acy, gxl, gyl, settling);
    for (let i = 0; i < NP; i++) {
      ovx[i] = vx[i]; ovy[i] = vy[i];
      vx[i] += fx[i] / MASS[i] * dt; vy[i] += fy[i] / MASS[i] * dt;
      if (damp) { vx[i] *= 1 - damp * dt; vy[i] *= 1 - damp * dt; }
      px[i] = x[i]; py[i] = y[i];
      x[i] += vx[i] * dt; y[i] += vy[i] * dt;
    }
    for (let it = 0; it < 4; it++) {
      for (let l = 0; l < LINKS.length; l++) {
        const a = LINKS[l][0], b = LINKS[l][1];
        const dx = x[b] - x[a], dy = y[b] - y[a], d = Math.hypot(dx, dy);
        const wa = 1 / MASS[a], wb = 1 / MASS[b];
        const s = (d - linkLen[l]) / (d * (wa + wb));
        x[a] += wa * s * dx; y[a] += wa * s * dy;
        x[b] -= wb * s * dx; y[b] -= wb * s * dy;
      }
    }
    for (let i = 0; i < NP; i++) { vx[i] = (x[i] - px[i]) / dt; vy[i] = (y[i] - py[i]) / dt; }
  }

  // Settle into the seat under gravity before the run.
  for (let k = 0; k < Math.round(0.4 / dt); k++) integrate(0, 0, 0, pulse.gx[0], pulse.gy[0], true, 30);
  for (let i = 0; i < NP; i++) { vx[i] = vy[i] = 0; }
  sbL0 = shoulderPath().L + 0.02;
  lapL0 = lapLen() + 0.01;
  const seated = { x: Float64Array.from(x), y: Float64Array.from(y) };

  // run
  const out = {
    dt, n: N, i0: pulse.i0, tFire: airbag || belt ? tFire : -1, airbag, belt,
    headAx: new Float64Array(N), headAy: new Float64Array(N), headAz: new Float64Array(N),
    chestAx: new Float64Array(N), chestAy: new Float64Array(N), chestAz: new Float64Array(N),
    pelvisAx: new Float64Array(N), pelvisAy: new Float64Array(N), pelvisAz: new Float64Array(N),
    chestDefl: new Float64Array(N), neckFz: new Float64Array(N), neckFx: new Float64Array(N), neckMy: new Float64Array(N),
    beltT: new Float64Array(N), lapT: new Float64Array(N), bagR: new Float64Array(N), interiorF: new Float64Array(N),
    poseEvery: 5, pose: null, events: [],
  };
  const PSTRIDE = 2 * NP + 3;
  const nPose = Math.ceil(N / out.poseEvery);
  out.pose = new Float32Array(nPose * PSTRIDE);
  out.poseStride = PSTRIDE;
  let zHeadPrev = 0, zHeadPrev2 = 0, lastHit = -1;
  for (let k = 0; k < N; k++) {
    const t = k * dt, acx = pulse.ax[k], acy = pulse.ay[k], acz = pulse.az[k];
    integrate(t, acx, acy, pulse.gx[k], pulse.gy[k], false, 0);

    // lateral sway: fictitious lateral load on torso and head
    const aLat = pulse.gz[k] - acz;
    const kTl = kT + (phT < I.doorRoll ? 8000 : 0);
    const phTdd = (MT * HT * aLat * Math.cos(phT) + MT * G * HT * Math.sin(phT) - kTl * phT - 40 * phTd + (phT < I.doorRoll ? 8000 * I.doorRoll : 0)) / IT;
    const phHdd = (HEAD_MASS * HH * (aLat - 0.5 * phTdd) - 60 * phH * (1 + 4 * phH * phH) - 1.5 * phHd) / IH;
    phTd += phTdd * dt; phT += phTd * dt; phHd += phHdd * dt; phH += phHd * dt;
    const zHead = 0.55 * Math.sin(phT) + HH * Math.sin(phT + phH);

    // sensors (kinematic acceleration = relative + cabin)
    const ahx = 0.5 * ((vx[HF] - ovx[HF]) + (vx[HB] - ovx[HB])) / dt + acx;
    const ahy = 0.5 * ((vy[HF] - ovy[HF]) + (vy[HB] - ovy[HB])) / dt + acy;
    const ahz = (k >= 2 ? (zHead - 2 * zHeadPrev + zHeadPrev2) / (dt * dt) : 0) + acz;
    zHeadPrev2 = zHeadPrev; zHeadPrev = zHead;
    out.headAx[k] = ahx; out.headAy[k] = ahy; out.headAz[k] = ahz;
    out.chestAx[k] = (vx[THX] - ovx[THX]) / dt + acx; out.chestAy[k] = (vy[THX] - ovy[THX]) / dt + acy; out.chestAz[k] = acz + 0.3 * HT * phTdd;
    out.pelvisAx[k] = (vx[PEL] - ovx[PEL]) / dt + acx; out.pelvisAy[k] = (vy[PEL] - ovy[PEL]) / dt + acy; out.pelvisAz[k] = acz;
    out.chestDefl[k] = defl;
    // upper neck load: Newton on the head (force from neck = m a - external - gravity), in head axes
    const Fnx = HEAD_MASS * ahx - headExtX - HEAD_MASS * pulse.gx[k];
    const Fny = HEAD_MASS * ahy - headExtY - HEAD_MASS * pulse.gy[k];
    const hfx = x[HF] - x[HB], hfy = y[HF] - y[HB], hl = Math.hypot(hfx, hfy);
    const fhx = hfx / hl, fhy = hfy / hl, uhx = -fhy, uhy = fhx;
    out.neckFz[k] = -(Fnx * uhx + Fny * uhy);   // tension positive
    out.neckFx[k] = Fnx * fhx + Fny * fhy;
    out.neckMy[k] = myUpper;
    out.beltT[k] = sbT; out.lapT[k] = lapT; out.bagR[k] = bagRadius(t); out.interiorF[k] = intF;
    if (headHit > 0 && (lastHit < 0 || t - lastHit > 0.03)) { out.events.push({ t, type: 'headStrike', mag: headHit, surface: hitSurf, hx: hitX, hy: hitY }); lastHit = t; }
    if (k % out.poseEvery === 0) {
      const o = (k / out.poseEvery) * PSTRIDE;
      for (let i = 0; i < NP; i++) { out.pose[o + 2 * i] = x[i]; out.pose[o + 2 * i + 1] = y[i]; }
      out.pose[o + 2 * NP] = phT; out.pose[o + 2 * NP + 1] = phH; out.pose[o + 2 * NP + 2] = out.bagR[k];
    }
  }
  if (airbag && tFire >= 0) out.events.push({ t: tFire + bagDelay, type: 'airbag', mag: 1 });
  out.seated = seated;
  out.rest = { x: x0, y: y0 };
  out.metrics = score(out);
  return out;
}

function score(o) {
  const dt = o.dt, N = o.n;
  const resultant = (ax, ay, az, cls) => {
    const fxs = cfc(ax, dt, cls), fys = cfc(ay, dt, cls), fzs = cfc(az, dt, cls);
    const r = new Float64Array(N);
    for (let i = 0; i < N; i++) r[i] = Math.hypot(fxs[i], fys[i], fzs[i]) / G;
    return { x: fxs, y: fys, z: fzs, r };
  };
  const head = resultant(o.headAx, o.headAy, o.headAz, 1000);
  const chest = resultant(o.chestAx, o.chestAy, o.chestAz, 180);
  const pelvis = resultant(o.pelvisAx, o.pelvisAy, o.pelvisAz, 1000);
  const defl = cfc(o.chestDefl, dt, 180);
  const fz = cfc(o.neckFz, dt, 600), my = cfc(o.neckMy, dt, 600);
  const i0 = Math.max(0, o.i0 - Math.round(0.005 / dt)), i1 = Math.min(N - 1, o.i0 + Math.round(0.3 / dt));
  const h = hic(head.r, dt, i0, i1, 0.015);
  const nij = new Float64Array(N);
  let nijMax = 0, nijMode = '', tens = 0, compr = 0, deflMax = 0, pelvisMax = 0, headMax = 0;
  for (let i = i0; i <= i1; i++) {
    const F = fz[i], M = my[i];
    const v = Math.abs(F) / (F >= 0 ? 6806 : 6160) + Math.abs(M) / (M >= 0 ? 310 : 135);
    nij[i] = v;
    if (v > nijMax) { nijMax = v; nijMode = (F >= 0 ? 'tension' : 'compression') + '-' + (M >= 0 ? 'flexion' : 'extension'); }
    if (F > tens) tens = F;
    if (-F > compr) compr = -F;
    if (defl[i] > deflMax) deflMax = defl[i];
    if (pelvis.r[i] > pelvisMax) pelvisMax = pelvis.r[i];
    if (head.r[i] > headMax) headMax = head.r[i];
  }
  return {
    hic15: h.value, hicT1: h.i1 * dt, hicT2: h.i2 * dt,
    headPeakG: headMax,
    chest3ms: clip3ms(chest.r, dt, i0, i1),
    chestDeflMm: deflMax * 1000,
    pelvisPeakG: pelvisMax,
    nij: nijMax, nijMode,
    neckTension: tens, neckCompression: compr,
    series: { head, chest, pelvis, defl, fz, my, nij },
  };
}

// ------------------------------------------------------------------ the third collision
// Organs move inside the body after the body itself stops: the brain inside the skull, the heart
// and aorta inside the chest. Each is a damped mass on a spring driven by the acceleration of its
// cavity (head and chest, filtered), so its movement and peak acceleration show the "third
// collision" that follows the occupant's contact with the belt, airbag or interior.
const ORGANS = { brain: { f: 50, zeta: 0.3 }, heart: { f: 25, zeta: 0.25 } };
function organMotion(ax, ay, dt, spec) {
  const w = 2 * Math.PI * spec.f, n = ax.length;
  const disp = new Float64Array(n), acc = new Float64Array(n);
  let ux = 0, vx = 0, uy = 0, vy = 0;
  for (let i = 0; i < n; i++) {
    // relative motion u'' = -a - 2 zeta w u' - w^2 u (semi-implicit Euler)
    const rx = -ax[i] - 2 * spec.zeta * w * vx - w * w * ux, ry = -ay[i] - 2 * spec.zeta * w * vy - w * w * uy;
    vx += rx * dt; vy += ry * dt; ux += vx * dt; uy += vy * dt;
    disp[i] = Math.hypot(ux, uy);
    acc[i] = Math.hypot(ax[i] + rx, ay[i] + ry) / G;   // the organ's own acceleration
  }
  return { disp, acc };
}
/* o: the result of simulate(). Returns organ movement (m) and acceleration (g), and the three
 * collision phases (s): vehicle (first contact to the cabin's stop, from the pulse), occupant
 * (restraint and interior contact) and organs (until their movement settles). */
function organs(o, pulse) {
  const S = o.metrics.series, dt = o.dt, n = o.n;
  const brain = organMotion(S.head.x, S.head.y, dt, ORGANS.brain), heart = organMotion(S.chest.x, S.chest.y, dt, ORGANS.heart);
  const i0 = pulse.i0;
  let iStop = -1;
  for (let i = i0; i < n; i++) if (pulse.vLong[i] <= 0) { iStop = i; break; }
  if (iStop < 0) { let best = i0; for (let i = i0; i < n; i++) if (pulse.vLong[i] < pulse.vLong[best]) best = i; iStop = best; }
  // occupant: restraint or interior force above a fifth of its peak (and at least 1 kN)
  let a2 = -1, b2 = -1, peak2 = 0, tPeak2 = 0;
  const load = (i) => o.interiorF[i] + o.beltT[i] + o.lapT[i];
  for (let i = i0; i < n; i++) { const F = load(i); if (F > peak2) { peak2 = F; tPeak2 = i; } }
  const thr = Math.max(1000, 0.2 * peak2);
  for (let i = i0; i < n; i++) if (load(i) > thr) { if (a2 < 0) a2 = i; b2 = i; }
  // organs: from the moment the occupant is stopped by its restraints until the organs have
  // moved and come back (their movement drops to a fifth of its peak)
  let pk = i0, mx = 0;
  for (let i = i0; i < n; i++) { const d = Math.max(brain.disp[i] / 0.004, heart.disp[i] / 0.02); if (d > mx) { mx = d; pk = i; } }
  let a3 = a2 >= 0 ? tPeak2 : pk, b3 = pk;
  for (let i = pk; i < n; i++) { b3 = i; if (Math.max(brain.disp[i] / 0.004, heart.disp[i] / 0.02) < 0.2 * mx) break; }
  if (a3 > pk) a3 = Math.max(i0, pk - Math.round(0.01 / dt));
  let bMax = 0, hMax = 0, baMax = 0, haMax = 0;
  for (let i = i0; i < n; i++) { bMax = Math.max(bMax, brain.disp[i]); hMax = Math.max(hMax, heart.disp[i]); baMax = Math.max(baMax, brain.acc[i]); haMax = Math.max(haMax, heart.acc[i]); }
  return {
    brain, heart, brainMaxMm: bMax * 1000, heartMaxMm: hMax * 1000, brainPeakG: baMax, heartPeakG: haMax,
    phases: [
      { name: 'vehicle', t0: i0 * dt, t1: iStop * dt },
      { name: 'occupant', t0: a2 >= 0 ? a2 * dt : -1, t1: b2 >= 0 ? b2 * dt : -1, peakF: peak2 },
      { name: 'organs', t0: a3 * dt, t1: b3 * dt, tPeak: pk * dt },
    ],
  };
}

// ------------------------------------------------------------------ side-impact dummy
// A seated side-impact dummy (50th-percentile male) in the frontal plane: pelvis, thorax, the
// struck-side ribs (their deflection is what the chest potentiometer measures), shoulders, neck and
// head, with lateral joint springs. It sits in the car's frame: the car's lateral acceleration acts
// on it as an inertial load, and the door's inner surface, taken from the vehicle simulation at
// pelvis, chest and window height, moves in and loads it. A curtain airbag can cushion the head
// against the window and whatever comes through it.
// Coordinates: s = lateral distance from the seat centreline toward the struck door, y up from the
// H-point.
const S_PEL = 0, S_THX = 1, S_T1 = 2, S_OC = 3, S_HD = 4, S_RIB = 5, S_NP = 6;
const SIDE_PARTICLES = { PEL: S_PEL, THX: S_THX, T1: S_T1, OC: S_OC, HD: S_HD, RIB: S_RIB, NP: S_NP };
const S_MASS = [14, 20, 8, 1.2, 4.6, 1.2];   // the legs stay on the seat and are left out
const S_REST = [[0, 0.05], [0, 0.30], [0, 0.52], [0, 0.64], [0, 0.74], [0.15, 0.30]];
const S_LINKS = [[S_PEL, S_THX], [S_THX, S_T1], [S_T1, S_OC], [S_OC, S_HD]];
const SIDE_LIMITS = { hic36: 1000, ribDefl: 44, pelvisForce: 6000 };
const HALF = { pelvis: 0.19, shoulder: 0.22, head: 0.085 };
const CURTAIN = { thick: 0.12, delay: 0.006, fill: 0.018 };

/* input: { dt, n, i0, a (car lateral acceleration, + away from the struck side, m/s^2),
 *          door: { pelvis, thorax, head } (distance from the seat centreline to the door's inner
 *          surface at those heights, m), striker: { y0, y1, s } or null (whatever is outside the
 *          window: the barrier face's top edge or the pole; s = its distance, y range from the
 *          H-point) }
 * opts:  { curtain } */
function simulateSide(input, opts) {
  const dt = input.dt, N = input.n, curtain = !!opts.curtain;
  const x = new Float64Array(S_NP), y = new Float64Array(S_NP), vx = new Float64Array(S_NP), vy = new Float64Array(S_NP);
  const px = new Float64Array(S_NP), py = new Float64Array(S_NP), fx = new Float64Array(S_NP), fy = new Float64Array(S_NP), ovx = new Float64Array(S_NP);
  for (let i = 0; i < S_NP; i++) { x[i] = S_REST[i][0]; y[i] = S_REST[i][1]; }
  const linkLen = S_LINKS.map(([a, b]) => Math.hypot(x[b] - x[a], y[b] - y[a]));
  const ribRest = x[S_RIB] - x[S_THX];
  const ang = (a, b) => Math.atan2(x[b] - x[a], y[b] - y[a]);   // lean toward the door, from vertical
  const angVel = (a, b) => { const dx = x[b] - x[a], dy = y[b] - y[a]; return (dy * (vx[b] - vx[a]) - dx * (vy[b] - vy[a])) / (dx * dx + dy * dy); };
  function couple(a, b, tau) {
    const dx = x[b] - x[a], dy = y[b] - y[a], s = tau / (dx * dx + dy * dy);
    fx[b] += s * dy; fy[b] -= s * dx; fx[a] -= s * dy; fy[a] += s * dx;
  }
  // curtain airbag: fires when the car's lateral speed change reaches 1 m/s within 30 ms
  let tFire = -1, dv = 0;
  for (let i = input.i0; i < N && (i - input.i0) * dt <= 0.03; i++) { dv += input.a[i] * dt; if (dv >= 1.0) { tFire = i * dt; break; } }
  const inflate = (t) => (!curtain || tFire < 0 || t < tFire + CURTAIN.delay) ? 0 : Math.min(1, (t - tFire - CURTAIN.delay) / CURTAIN.fill);
  const doorAt = (h, k) => {   // door surface at height h (m above the H-point), step k
    const D = input.door;
    if (h <= 0.33) { const s = Math.max(0, Math.min(1, (h - 0.05) / 0.28)); return D.pelvis[k] + (D.thorax[k] - D.pelvis[k]) * s; }
    const s = Math.max(0, Math.min(1, (h - 0.33) / 0.29)); return D.thorax[k] + (D.head[k] - D.thorax[k]) * s;
  };
  let glassBroken = false, pelvisF = 0, ribF = 0, headF = 0, bagF = 0, headSurf = '';
  function plasticContact(st, pen, k, cap, stroke) {
    let e = pen - st.set;
    if (e > cap / k && st.set < stroke) { st.set = Math.min(stroke, pen - cap / k); e = pen - st.set; }
    return e > 0 ? k * e : 0;
  }
  const PCS = { pelvis: { set: 0 }, rib: { set: 0 }, shoulder: { set: 0 } };
  const glassMax = 4000;
  function forces(t, k, a) {
    for (let i = 0; i < S_NP; i++) { fx[i] = S_MASS[i] * a; fy[i] = -S_MASS[i] * G; }
    pelvisF = 0; ribF = 0; headF = 0; bagF = 0; headSurf = '';
    // seat: cushion under the pelvis, friction and bolster sideways, lap belt
    const pen = S_REST[S_PEL][1] - y[S_PEL];
    if (pen > 0) fy[S_PEL] += Math.max(0, 8e4 * pen - 1500 * vy[S_PEL]);
    const W = 9.81 * 49;
    fx[S_PEL] -= 0.4 * W * Math.tanh(vx[S_PEL] / 0.05) + 3e3 * x[S_PEL] + (Math.abs(x[S_PEL]) > 0.05 ? 3e4 * (x[S_PEL] - 0.05 * Math.sign(x[S_PEL])) : 0);
    fy[S_PEL] -= y[S_PEL] > 0.08 ? 2e4 * (y[S_PEL] - 0.08) : 0;
    // spine lateral bending (lumbar, thoracic), neck and head, seat back friction on the thorax
    const aT = ang(S_PEL, S_THX), aU = ang(S_THX, S_T1), aN = ang(S_T1, S_OC), aH = ang(S_OC, S_HD);
    const wT = angVel(S_PEL, S_THX), wU = angVel(S_THX, S_T1), wN = angVel(S_T1, S_OC), wH = angVel(S_OC, S_HD);
    couple(S_PEL, S_THX, -900 * aT - 30 * wT);
    const tU = -2500 * (aU - aT) - 40 * (wU - wT); couple(S_THX, S_T1, tU); couple(S_PEL, S_THX, -tU);
    let rn = aN - aU, tN = -80 * rn * (1 + 3 * rn * rn) - 3 * (wN - wU);
    if (Math.abs(rn) > 0.7) tN -= 1500 * (rn - 0.7 * Math.sign(rn));
    couple(S_T1, S_OC, tN); couple(S_THX, S_T1, -tN);
    let rh = aH - aN, tH = -40 * rh - 1.5 * (wH - wN);
    if (Math.abs(rh) > 0.5) tH -= 1500 * (rh - 0.5 * Math.sign(rh));
    couple(S_OC, S_HD, tH); couple(S_T1, S_OC, -tH);
    fx[S_THX] -= 300 * vx[S_THX] * 0.5;
    // ribs: spring and damper to the spine, hard stop at 60 mm
    const defl = ribRest - (x[S_RIB] - x[S_THX]), dd = -(vx[S_RIB] - vx[S_THX]);
    let Fr = 8e4 * defl + 300 * dd;
    if (defl > 0.06) Fr += 3e6 * (defl - 0.06);
    if (defl < 0) Fr = 4e5 * defl + 300 * dd;
    fx[S_RIB] += Fr; fx[S_THX] -= Fr;
    const Fry = -2e5 * ((y[S_RIB] - y[S_THX]) - (S_REST[S_RIB][1] - S_REST[S_THX][1])) - 200 * (vy[S_RIB] - vy[S_THX]);
    fy[S_RIB] += Fry; fy[S_THX] -= Fry;
    // door: pelvis (armrest and door panel), ribs, shoulder. The trim, padding and the dummy's flesh
    // crush at a plateau force over a few centimetres (elastic-plastic, like the frontal contacts),
    // then the door bottoms out.
    const contact = (i, half, surf, st, k1, cap, stroke, c) => {
      const p = x[i] + half - surf;
      if (p <= 0) return 0;
      let F = plasticContact(st, p, k1, cap, stroke);
      if (p - st.set > cap / k1 && st.set >= stroke) F += 2 * k1 * (p - st.set - cap / k1);   // bottomed out
      F = Math.max(0, F + (vx[i] > 0 ? c * vx[i] : 0));
      fx[i] -= F;
      return F;
    };
    pelvisF = contact(S_PEL, HALF.pelvis, doorAt(0.05, k), PCS.pelvis, 1.5e5, 4000, 0.08, 200);
    ribF = contact(S_RIB, 0, doorAt(0.30, k), PCS.rib, 1.2e5, 2500, 0.05, 150);
    contact(S_T1, HALF.shoulder, doorAt(y[S_T1], k), PCS.shoulder, 0.8e5, 2000, 0.08, 150);
    // head: the hard surface beside it is the window glass until it breaks (head load, or the pole
    // or barrier pushing in through it), then whatever is outside; a deployed curtain airbag lies
    // between that surface and the head
    const win = doorAt(Math.min(0.62, y[S_HD]), k), st = input.striker;
    const stIn = st && y[S_HD] > st.y0 && y[S_HD] < st.y1;
    if (!glassBroken && stIn && st.s[k] < win + 0.01) glassBroken = true;
    let hard = glassBroken ? (stIn ? st.s[k] : Infinity) : (stIn ? Math.min(win, st.s[k]) : win);
    const hardIsGlass = !glassBroken && !(stIn && st.s[k] < win);
    const infl = inflate(t);
    if (infl > 0 && hard < Infinity) {
      const room = CURTAIN.thick * infl, p = x[S_HD] + HALF.head - (hard - room);
      if (p > 0) {
        // a vented cushion: its force levels off as it vents
        const pc = Math.min(p, room);
        bagF = Math.max(0, infl * Math.min(1200, 2.5e4 * pc) + (vx[S_HD] > 0 ? 100 * vx[S_HD] : 0));
        fx[S_HD] -= bagF;
      }
    }
    if (hard < Infinity) {
      const p = x[S_HD] + HALF.head - hard;
      if (p > 0) {
        const F = Math.max(0, (hardIsGlass ? 1.5e5 : 3e5) * p + (vx[S_HD] > 0 ? (hardIsGlass ? 400 : 800) * vx[S_HD] : 0));
        if (hardIsGlass && F > glassMax) glassBroken = true;
        else { fx[S_HD] -= F; headF = F; headSurf = hardIsGlass ? 'window' : st.name || 'striker'; }
      }
    }
  }
  function integrate(t, k, a) {
    forces(t, k, a);
    for (let i = 0; i < S_NP; i++) {
      ovx[i] = vx[i];
      vx[i] += fx[i] / S_MASS[i] * dt; vy[i] += fy[i] / S_MASS[i] * dt;
      px[i] = x[i]; py[i] = y[i];
      x[i] += vx[i] * dt; y[i] += vy[i] * dt;
    }
    for (let it = 0; it < 4; it++) {
      for (let l = 0; l < S_LINKS.length; l++) {
        const a2 = S_LINKS[l][0], b = S_LINKS[l][1];
        const dx = x[b] - x[a2], dy = y[b] - y[a2], d = Math.hypot(dx, dy);
        const wa = 1 / S_MASS[a2], wb = 1 / S_MASS[b], s = (d - linkLen[l]) / (d * (wa + wb));
        x[a2] += wa * s * dx; y[a2] += wa * s * dy; x[b] -= wb * s * dx; y[b] -= wb * s * dy;
      }
    }
    for (let i = 0; i < S_NP; i++) { vx[i] = (x[i] - px[i]) / dt; vy[i] = (y[i] - py[i]) / dt; }
  }
  // settle under gravity
  for (let k = 0; k < Math.round(0.3 / dt); k++) { integrate(0, 0, 0); for (let i = 0; i < S_NP; i++) { vx[i] *= 0.97; vy[i] *= 0.97; } }
  for (let i = 0; i < S_NP; i++) { vx[i] = vy[i] = 0; }
  const out = {
    dt, n: N, i0: input.i0, tFire: curtain ? tFire : -1, curtain,
    headA: new Float64Array(N), headAy: new Float64Array(N), ribDefl: new Float64Array(N), pelvisF: new Float64Array(N), t1A: new Float64Array(N),
    bag: new Float64Array(N), headF: new Float64Array(N), poseEvery: 5, pose: null, events: [],
  };
  const PST = 2 * S_NP + 1;
  out.pose = new Float32Array(Math.ceil(N / out.poseEvery) * PST);
  out.poseStride = PST;
  let lastHit = -1, glassWas = false;
  for (let k = 0; k < N; k++) {
    const t = k * dt, a = input.a[k];
    integrate(t, k, a);
    // sensor accelerations in the car-fixed frame plus the car's own (toward the door positive)
    out.headA[k] = (vx[S_HD] - ovx[S_HD]) / dt - a;
    out.headAy[k] = 0;
    out.t1A[k] = (vx[S_T1] - ovx[S_T1]) / dt - a;
    out.ribDefl[k] = ribRest - (x[S_RIB] - x[S_THX]);
    out.pelvisF[k] = pelvisF; out.headF[k] = Math.max(headF, bagF); out.bag[k] = inflate(t);
    if (headF > 1000 && (lastHit < 0 || t - lastHit > 0.03)) { out.events.push({ t, type: 'headStrike', mag: headF, surface: headSurf }); lastHit = t; }
    if (glassBroken && !glassWas) { out.events.push({ t, type: 'sideGlass', mag: glassMax }); glassWas = true; }
    if (k % out.poseEvery === 0) {
      const o = (k / out.poseEvery) * PST;
      for (let i = 0; i < S_NP; i++) { out.pose[o + 2 * i] = x[i]; out.pose[o + 2 * i + 1] = y[i]; }
      out.pose[o + 2 * S_NP] = out.bag[k];
    }
  }
  if (curtain && tFire >= 0) out.events.push({ t: tFire + CURTAIN.delay, type: 'curtain', mag: 1 });
  out.events.sort((p, q) => p.t - q.t);
  // scoring: head HIC36 (CFC 1000), rib deflection (CFC 180), pelvis force (CFC 600), T1 (CFC 180)
  const head = cfc(out.headA, dt, 1000), headG = Float64Array.from(head, v => Math.abs(v) / G);
  const rib = cfc(out.ribDefl, dt, 180), pel = cfc(out.pelvisF, dt, 600), t1 = cfc(out.t1A, dt, 180);
  const i0 = Math.max(0, input.i0 - Math.round(0.005 / dt)), i1 = Math.min(N - 1, input.i0 + Math.round(0.3 / dt));
  const h = hic(headG, dt, i0, i1, 0.036);
  let ribMax = 0, pelMax = 0, t1Max = 0, headMax = 0;
  for (let i = i0; i <= i1; i++) { ribMax = Math.max(ribMax, rib[i]); pelMax = Math.max(pelMax, pel[i]); t1Max = Math.max(t1Max, Math.abs(t1[i]) / G); headMax = Math.max(headMax, headG[i]); }
  out.metrics = { hic36: h.value, hicT1: h.i1 * dt, hicT2: h.i2 * dt, ribDeflMm: ribMax * 1000, pelvisForce: pelMax, t1PeakG: t1Max, headPeakG: headMax,
    series: { head: headG, rib: Float64Array.from(rib, v => v * 1000), pelvis: pel, t1: Float64Array.from(t1, v => v / G) } };
  return out;
}

const api = { G, LIMITS, SIDE_LIMITS, INTERIOR, interiorFor, MASS, PARTICLES: { PEL, THX, T1, STN, OC, HF, HB, NP }, SIDE_PARTICLES, cfc, hic, clip3ms, restPose, simulate, organs, simulateSide };
root.CrashOccupant = api;
if (typeof module === 'object' && module.exports) module.exports = api;
})(typeof window !== 'undefined' ? window : globalThis);
