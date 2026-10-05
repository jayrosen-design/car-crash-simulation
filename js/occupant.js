/* Occupant model and injury criteria. No dependencies (global CrashOccupant / Node module).
 *
 * The frontal dummy sits in a seat that follows the cabin acceleration pulse from the vehicle
 * simulation. It is a 3D multibody of 15 particles (pelvis, torso, compliant sternum, neck, head,
 * legs) with joint springs, a 3-point belt with pretensioner and force limiter, a driver airbag,
 * and contacts with the steering wheel, windshield, roof, A-pillar, door, knee bolster and toe pan.
 * Those parts of the cabin move as the structure deforms (opts.cabin, from physics.js cabinInput),
 * so intrusion pushes into the dummy; the dummy's forces are not fed back into the car.
 *
 * Channels are filtered per SAE J211 and scored with FMVSS 208-style criteria (HIC15, chest 3 ms
 * clip, chest deflection, Nij, neck tension/compression, femur force). Illustrative, not a
 * validated dummy.
 */
(function (root) {
'use strict';

const G = 9.81;
const LIMITS = { hic15: 700, chest3ms: 60, chestDefl: 63, nij: 1.0, neckTension: 4170, neckCompression: 4000, femur: 10000 };

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

// ------------------------------------------------------------------ the frontal dummy
// A 3D dummy of 15 particles (a 50th-percentile adult male, 75 kg) in the car's frame: x forward,
// y up, z toward the car's right, origin at the H-point (the driver's door is on the left, -z).
// Pelvis: both hip joints and the sacrum. Torso: thorax, T1 (the base of the neck), both shoulders
// (with the arms' mass). The sternum sits on a compliant chest. Head: the occipital condyle (top of
// the neck) and the front and back of the skull. Knees and ankles. Distance constraints keep the
// segments rigid; the joints (lumbar spine at the sacrum, hips, knees, lower and upper neck) are
// springs with damping and stops.
const HL = 0, HR = 1, SAC = 2, THX = 3, T1 = 4, SHL = 5, SHR = 6, STN = 7, OC = 8, HF = 9, HB = 10, KL = 11, KR = 12, AL = 13, AR = 14, NP = 15;
const MASS = [6, 6, 6, 16, 8, 4, 4, 1.5, 0.5, 2.0, 2.0, 6, 6, 3.5, 3.5];
const HEAD_MASS = MASS[OC] + MASS[HF] + MASS[HB];
const PELVIS = [HL, HR, SAC], TORSO = [SAC, THX, T1, SHL, SHR], HEAD = [OC, HF, HB];
const pairs = (ids) => { const o = []; for (let a = 0; a < ids.length; a++) for (let b = a + 1; b < ids.length; b++) o.push([ids[a], ids[b]]); return o; };
const LINKS = [...pairs(PELVIS), ...pairs(TORSO), [T1, OC], ...pairs(HEAD), [HL, KL], [HR, KR], [KL, AL], [KR, AR]];
const FEMUR = [LINKS.findIndex(([a, b]) => a === HL && b === KL), LINKS.findIndex(([a, b]) => a === HR && b === KR)];
const STERNUM_A = 0.21, STERNUM_B = 0.165;   // sternum rest point along / ahead of the spine from the sacrum (m)
const HEAD_R = 0.10, CHEST_R = 0.09, KNEE_R = 0.06, FOOT_R = 0.07, FOOT_L = 0.13;
const TOE_PAN = 60 * Math.PI / 180;           // toe pan angle up from the floor
const BAG_K = 1.6e4, BAG_K3 = 3e5, BAG_C = 300;  // driver airbag on the head: pressure stiffness (linear, cubic), venting damping
const BAG_TORSO = 1.5;                         // the same on each chest and shoulder point, scaled for their larger contact
const SEAT_BACK = 22 * Math.PI / 180;        // seat back angle from vertical

// Interior, in the occupant frame. Matches the car body in physics.js: H-point at car-local
// (-0.25, 0.60). The windshield, roof and door move as the cabin deforms (simulate opts.cabin).
const INTERIOR = {
  hub: [0.40, 0.42], col: [-0.906, 0.423], rimDir: [0.423, 0.906], rimR: 0.19,
  bagOffset: 0.14, bagR: 0.24,
  wsA: [1.30, 0.40], wsB: [0.65, 0.85],
  roofY: 0.80,
  kneeX: 0.60,                                    // knee bolster face (12 cm ahead of the knees)
  floorY: -0.25, toeX: 0.95,                       // floor, and the toe pan's foot at the floor
  dRing: [-0.32, 0.64], buckle: [-0.05, -0.06], lapAnchor: [-0.10, -0.14],
  dRingZ: -0.26, buckleZ: 0.22, lapAnchorZ: -0.25,   // lateral (+ toward the car's right)
  doorZ: -0.34, consoleZ: 0.30,                    // door trim and centre console beside the seat
};

function interiorFor(over) {
  if (!over) return INTERIOR;
  const I = Object.assign({}, INTERIOR);
  for (const k in over) if (over[k] !== null && over[k] !== undefined) I[k] = over[k];
  return I;
}

// the seated pose before settling: [x, y, z] of each particle, one after the other
function restPose() {
  const P = new Float64Array(3 * NP), set = (i, x, y, z) => { P[3 * i] = x; P[3 * i + 1] = y; P[3 * i + 2] = z; };
  const d = [-Math.sin(SEAT_BACK), Math.cos(SEAT_BACK)], n = [Math.cos(SEAT_BACK), Math.sin(SEAT_BACK)];   // spine, and its forward normal
  const s = [-0.04, 0.06], sp = (a, b) => [s[0] + a * d[0] + b * n[0], s[1] + a * d[1] + b * n[1]];
  set(HL, 0, 0, -0.085); set(HR, 0, 0, 0.085); set(SAC, s[0], s[1], 0);
  let q = sp(0.25, 0.07); set(THX, q[0], q[1], 0);
  const t1 = sp(0.46, 0); set(T1, t1[0], t1[1], 0);
  q = sp(0.42, 0.03); set(SHL, q[0], q[1], -0.19); set(SHR, q[0], q[1], 0.19);
  q = sp(STERNUM_A, STERNUM_B); set(STN, q[0], q[1], 0);
  const tn = 8 * Math.PI / 180, oc = [t1[0] + 0.13 * Math.sin(tn), t1[1] + 0.13 * Math.cos(tn)];
  set(OC, oc[0], oc[1], 0);
  const th = 3 * Math.PI / 180, u = [Math.sin(th), Math.cos(th)], f = [Math.cos(th), -Math.sin(th)];
  const c = [oc[0] + 0.02 * f[0] + 0.05 * u[0], oc[1] + 0.02 * f[1] + 0.05 * u[1]];
  set(HF, c[0] + 0.065 * f[0], c[1] + 0.065 * f[1], 0); set(HB, c[0] - 0.065 * f[0], c[1] - 0.065 * f[1], 0);
  const tf = 12 * Math.PI / 180, kx = 0.43 * Math.cos(tf), ky = 0.43 * Math.sin(tf), ts = 50 * Math.PI / 180;
  set(KL, kx, ky, -0.11); set(KR, kx, ky, 0.11);
  set(AL, kx + 0.42 * Math.sin(ts), ky - 0.42 * Math.cos(ts), -0.12); set(AR, kx + 0.42 * Math.sin(ts), ky - 0.42 * Math.cos(ts), 0.12);
  return P;
}

// small vector helpers on [x, y, z] arrays
const dot = (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const cross = (a, b) => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
const unit = (a) => { const l = Math.hypot(a[0], a[1], a[2]) || 1; return [a[0] / l, a[1] / l, a[2] / l]; };
const lerp3 = (a, b, s) => [a[0] + (b[0] - a[0]) * s, a[1] + (b[1] - a[1]) * s, a[2] + (b[2] - a[2]) * s];
// rotation vector (axis x angle) of the rotation that takes the rest relative orientation R0 to R
// (3x3 row-major: rows are the axes of one frame in the other's coordinates)
function rotVec(R, R0) {
  const D = new Array(9);
  for (let r = 0; r < 3; r++) for (let c = 0; c < 3; c++) D[3 * r + c] = R[3 * r] * R0[3 * c] + R[3 * r + 1] * R0[3 * c + 1] + R[3 * r + 2] * R0[3 * c + 2];
  const v = [0.5 * (D[7] - D[5]), 0.5 * (D[2] - D[6]), 0.5 * (D[3] - D[1])], s = Math.hypot(v[0], v[1], v[2]);
  if (s < 1e-12) return [0, 0, 0];
  const ang = Math.atan2(s, Math.max(-1, Math.min(1, (D[0] + D[4] + D[8] - 1) / 2)));
  return [v[0] / s * ang, v[1] / s * ang, v[2] / s * ang];
}
// B's axes in A's coordinates (frames as { f, u, l })
const relFrame = (A, B) => [dot(A.f, B.f), dot(A.f, B.u), dot(A.f, B.l), dot(A.u, B.f), dot(A.u, B.u), dot(A.u, B.l), dot(A.l, B.f), dot(A.l, B.u), dot(A.l, B.l)];
const toWorld = (A, v) => [A.f[0] * v[0] + A.u[0] * v[1] + A.l[0] * v[2], A.f[1] * v[0] + A.u[1] * v[1] + A.l[1] * v[2], A.f[2] * v[0] + A.u[2] * v[1] + A.l[2] * v[2]];
// rotation vector taking unit vector a to unit vector b
function turn(a, b) {
  const c = cross(a, b), s = Math.hypot(c[0], c[1], c[2]);
  if (s < 1e-12) return [0, 0, 0];
  const ang = Math.atan2(s, dot(a, b));
  return [c[0] / s * ang, c[1] / s * ang, c[2] / s * ang];
}

// Belts: the shoulder belt runs from the D-ring on the B-pillar over the collarbone (40% of the way
// from the neck to the outboard, left shoulder) and the sternum to the buckle; the lap belt from its
// outboard anchor across the front of the pelvis to the buckle. Where they bear on the body is
// [[particle, share], ...] plus an offset.
const SHOULDER_HOLD = [[[T1, 0.6], [SHL, 0.4]], [[STN, 1]]], SHOULDER_OFF = [[0, 0.03, 0], [0, 0, 0]];
const LAP_HOLD = [[[HL, 1]], [[HR, 1]]], LAP_OFF = [[0.08, 0.04, 0], [0.08, 0.04, 0]];
// the belts' paths for particle positions P (H-point frame), anchor to buckle
function beltPaths(P, I) {
  const at = (h, off) => { const p = off.slice(); for (const [i, w] of h) for (let c = 0; c < 3; c++) p[c] += w * P[3 * i + c]; return p; };
  const BK = [I.buckle[0], I.buckle[1], I.buckleZ];
  return {
    shoulder: [[I.dRing[0], I.dRing[1], I.dRingZ], at(SHOULDER_HOLD[0], SHOULDER_OFF[0]), at(SHOULDER_HOLD[1], SHOULDER_OFF[1]), BK],
    lap: [[I.lapAnchor[0], I.lapAnchor[1], I.lapAnchorZ], at(LAP_HOLD[0], LAP_OFF[0]), at(LAP_HOLD[1], LAP_OFF[1]), BK],
  };
}

/* pulse: { dt, n, i0, ax, ay, az, gx, gy, gz } cabin acceleration and gravity in car axes (m/s^2)
 * opts:  { belt, airbag, interior, pretensioner, loadLimiter, cabin }  interior: per-vehicle
 *        overrides of INTERIOR (wsA, wsB, roofY); pretensioner and loadLimiter default to on (a plain
 *        belt has neither); cabin: physics.js cabinInput(), so the steering column, knee bolster, toe
 *        pan, windshield, roof, A-pillar and door move as the cabin deforms (without it they stay
 *        put) */
function simulate(pulse, opts) {
  const belt = !!opts.belt, airbag = !!opts.airbag;
  const pretensioner = opts.pretensioner !== false, loadLimiter = opts.loadLimiter !== false;
  const dt = pulse.dt, N = pulse.n, I = interiorFor(opts.interior), cab = opts.cabin || null;
  const P = restPose(), V = new Float64Array(3 * NP), Pp = new Float64Array(3 * NP), OV = new Float64Array(3 * NP), Fo = new Float64Array(3 * NP);
  const P0 = Float64Array.from(P);
  const pt = (i) => [P[3 * i], P[3 * i + 1], P[3 * i + 2]], vel = (i) => [V[3 * i], V[3 * i + 1], V[3 * i + 2]];
  const add = (i, f, s = 1) => { Fo[3 * i] += s * f[0]; Fo[3 * i + 1] += s * f[1]; Fo[3 * i + 2] += s * f[2]; };
  const linkLen = LINKS.map(([a, b]) => Math.hypot(P[3 * b] - P[3 * a], P[3 * b + 1] - P[3 * a + 1], P[3 * b + 2] - P[3 * a + 2]));
  const linkF = new Float64Array(LINKS.length);   // constraint force this step (compression +)

  // ---- segment frames
  function pelvisFrame() {
    const l = unit([P[3 * HR] - P[3 * HL], P[3 * HR + 1] - P[3 * HL + 1], P[3 * HR + 2] - P[3 * HL + 2]]);
    const b = [P[3 * SAC] - 0.5 * (P[3 * HL] + P[3 * HR]), P[3 * SAC + 1] - 0.5 * (P[3 * HL + 1] + P[3 * HR + 1]), P[3 * SAC + 2] - 0.5 * (P[3 * HL + 2] + P[3 * HR + 2])];
    const bl = dot(b, l), u = unit([b[0] - bl * l[0], b[1] - bl * l[1], b[2] - bl * l[2]]);
    return { f: cross(u, l), u, l };
  }
  function torsoFrame() {
    const u = unit([P[3 * T1] - P[3 * SAC], P[3 * T1 + 1] - P[3 * SAC + 1], P[3 * T1 + 2] - P[3 * SAC + 2]]);
    const s = [P[3 * SHR] - P[3 * SHL], P[3 * SHR + 1] - P[3 * SHL + 1], P[3 * SHR + 2] - P[3 * SHL + 2]], su = dot(s, u);
    const l = unit([s[0] - su * u[0], s[1] - su * u[1], s[2] - su * u[2]]);
    return { f: cross(u, l), u, l };
  }
  function headFrame() {
    const f = unit([P[3 * HF] - P[3 * HB], P[3 * HF + 1] - P[3 * HB + 1], P[3 * HF + 2] - P[3 * HB + 2]]);
    const c = [0.5 * (P[3 * HF] + P[3 * HB]) - P[3 * OC], 0.5 * (P[3 * HF + 1] + P[3 * HB + 1]) - P[3 * OC + 1], 0.5 * (P[3 * HF + 2] + P[3 * HB + 2]) - P[3 * OC + 2]];
    const cf = dot(c, f), u = unit([c[0] - cf * f[0], c[1] - cf * f[1], c[2] - cf * f[2]]);
    return { f, u, l: cross(f, u) };
  }
  function neckFrame(T) {   // along the neck, with the torso's lateral axis
    const u = unit([P[3 * OC] - P[3 * T1], P[3 * OC + 1] - P[3 * T1 + 1], P[3 * OC + 2] - P[3 * T1 + 2]]);
    const lu = dot(T.l, u), l = unit([T.l[0] - lu * u[0], T.l[1] - lu * u[1], T.l[2] - lu * u[2]]);
    return { f: cross(u, l), u, l };
  }
  const centroid = (ids) => { let m = 0; const c = [0, 0, 0]; for (const i of ids) { m += MASS[i]; for (let d = 0; d < 3; d++) c[d] += MASS[i] * P[3 * i + d]; } return [c[0] / m, c[1] / m, c[2] / m]; };
  // a torque on a rigid segment: forces m_i (alpha x r_i), alpha = I^-1 tau, which add up to tau
  // about the centre of mass and to no net force
  function bodyTorque(ids, tau) {
    const c = centroid(ids), J = [1e-4, 0, 0, 0, 1e-4, 0, 0, 0, 1e-4];
    for (const i of ids) {
      const r = [P[3 * i] - c[0], P[3 * i + 1] - c[1], P[3 * i + 2] - c[2]], m = MASS[i], r2 = dot(r, r);
      for (let a = 0; a < 3; a++) for (let b = 0; b < 3; b++) J[3 * a + b] += m * ((a === b ? r2 : 0) - r[a] * r[b]);
    }
    const det = J[0] * (J[4] * J[8] - J[5] * J[7]) - J[1] * (J[3] * J[8] - J[5] * J[6]) + J[2] * (J[3] * J[7] - J[4] * J[6]);
    const al = [
      (tau[0] * (J[4] * J[8] - J[5] * J[7]) - J[1] * (tau[1] * J[8] - J[5] * tau[2]) + J[2] * (tau[1] * J[7] - J[4] * tau[2])) / det,
      (J[0] * (tau[1] * J[8] - J[5] * tau[2]) - tau[0] * (J[3] * J[8] - J[5] * J[6]) + J[2] * (J[3] * tau[2] - tau[1] * J[6])) / det,
      (J[0] * (J[4] * tau[2] - tau[1] * J[7]) - J[1] * (J[3] * tau[2] - tau[1] * J[6]) + tau[0] * (J[3] * J[7] - J[4] * J[6])) / det];
    for (const i of ids) { const r = [P[3 * i] - c[0], P[3 * i + 1] - c[1], P[3 * i + 2] - c[2]]; add(i, cross(al, r), MASS[i]); }
  }
  // a torque on a two-particle segment a->b (its component across the segment), as a couple
  function linkTorque(a, b, tau) {
    const d = [P[3 * b] - P[3 * a], P[3 * b + 1] - P[3 * a + 1], P[3 * b + 2] - P[3 * a + 2]], d2 = dot(d, d);
    const F = cross(tau, d);
    add(b, F, 1 / d2); add(a, F, -1 / d2);
  }
  // seat foam pressed in by pen (m) at speed vOut (+ coming back out): firm going in, damped, and
  // giving back only a quarter of its force on the way out
  const foam = (k, pen, vOut, c) => Math.max(0, (vOut > 0 ? 0.25 : 1) * k * pen - c * vOut);
  function joint(rel, rate, k, beta, c, limLo, limHi, kLim) {
    let tau = -k * rel * (1 + beta * rel * rel) - c * rate;
    if (rel > limHi) tau -= kLim * (rel - limHi);
    if (rel < limLo) tau -= kLim * (rel - limLo);
    return tau;
  }
  // Elastic-plastic penalty contact: force rises with stiffness k up to `cap`, then the part yields
  // (column collapses, rim bends, glass cracks, padding crushes) for up to `stroke` metres of
  // permanent set, then stiffens. Unloading is elastic, so the yield work is absorbed.
  function plasticContact(st, pen, k, cap, stroke) {
    let e = pen - st.set;
    if (e > cap / k && st.set < stroke) { st.set = Math.min(stroke, pen - cap / k); e = pen - st.set; }
    return e > 0 ? k * e : 0;
  }
  const PC = { headWheel: { set: 0 }, stnWheel: { set: 0 }, thxWheel: { set: 0 }, t1Wheel: { set: 0 }, ws: { set: 0 }, roof: { set: 0 }, pillar: { set: 0 }, kneeL: { set: 0 }, kneeR: { set: 0 } };

  // ---- the cabin around the dummy: rest layout, moved by the deforming structure (opts.cabin)
  const REST = {
    hub: [I.hub[0], I.hub[1], 0], colBase: [I.hub[0] - 0.3 * I.col[0], I.hub[1] - 0.3 * I.col[1], 0],
    knee: [I.kneeX, 0.12, 0], toe: [I.toeX, I.floorY + 0.12, 0],
    wsLow: [I.wsA[0], I.wsA[1], 0], wsHigh: [I.wsB[0], I.wsB[1], 0], roof: [0, I.roofY, 0],
    aLow: [I.wsA[0], I.wsA[1], I.doorZ - 0.05], aHigh: [I.wsB[0], I.wsB[1], I.doorZ - 0.05],
    door: [0.05, 0.30, I.doorZ], doorHead: [0.05, 0.62, I.doorZ],
  };
  const cabIdx = {};
  if (cab) {
    cab.names.forEach((nm, q) => { cabIdx[nm] = q; });
    // the door and A-pillar's sideways position come from the car; the rest from the layout above
    for (const nm of ['aLow', 'aHigh', 'door', 'doorHead']) if (nm in cabIdx) REST[nm][2] = cab.p[3 * cabIdx[nm] + 2];
  }
  let cabK = 0;
  const S = {};   // surfaces now: point -> { p, v }
  function cabinAt(t) {
    let s = 0, k0 = 0, k1 = 0, h = 1;
    if (cab) {
      const T = cab.t;
      while (cabK < T.length - 2 && T[cabK + 1] <= t) cabK++;
      k0 = cabK; k1 = Math.min(T.length - 1, cabK + 1); h = Math.max(1e-6, T[k1] - T[k0]);
      s = Math.max(0, Math.min(1, (t - T[k0]) / h));
    }
    for (const nm in REST) {
      const r = REST[nm];
      if (!cab || !(nm in cabIdx)) { S[nm] = { p: r, v: [0, 0, 0] }; continue; }
      const q = cabIdx[nm], np = cab.np, a = 3 * (k0 * np + q), b = 3 * (k1 * np + q), z = 3 * q, p = cab.p;
      const d = [0, 1, 2].map(c => p[a + c] + (p[b + c] - p[a + c]) * s - p[z + c]);
      S[nm] = { p: [r[0] + d[0], r[1] + d[1], r[2] + d[2]], v: [0, 1, 2].map(c => (p[b + c] - p[a + c]) / h) };
    }
    const col = unit([S.hub.p[0] - S.colBase.p[0], S.hub.p[1] - S.colBase.p[1], S.hub.p[2] - S.colBase.p[2]]);
    const yu = col[1], rimUp = unit([-yu * col[0], 1 - yu * col[1], -yu * col[2]]);
    S.col = col; S.rimUp = rimUp;
  }
  cabinAt(0);

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

  const SB_K = 9e4, SB_C = 800, LAP_K = 1.0e5, LAP_C = 800, LOAD_LIMIT = 4500, PRE_FORCE = 1500;
  const holdVel = (h) => { const v = [0, 0, 0]; for (const [i, w] of h) for (let c = 0; c < 3; c++) v[c] += w * V[3 * i + c]; return v; };
  const pathLen = (pts) => { let L = 0; for (let i = 1; i < pts.length; i++) L += Math.hypot(pts[i][0] - pts[i - 1][0], pts[i][1] - pts[i - 1][1], pts[i][2] - pts[i - 1][2]); return L; };
  const shoulderPath = () => beltPaths(P, I).shoulder, lapPath = () => beltPaths(P, I).lap;
  // a belt's tension on what it wraps: each bearing point pulled along its two neighbouring segments
  function beltForce(path, holds, T) {
    for (let j = 1; j < path.length - 1; j++) {
      const a = unit([path[j - 1][0] - path[j][0], path[j - 1][1] - path[j][1], path[j - 1][2] - path[j][2]]);
      const b = unit([path[j + 1][0] - path[j][0], path[j + 1][1] - path[j][1], path[j + 1][2] - path[j][2]]);
      for (const [i, w] of holds[j - 1]) add(i, [T * (a[0] + b[0]), T * (a[1] + b[1]), T * (a[2] + b[2])], w);
    }
  }
  const pathRate = (path, holds) => {   // rate of change of the belt's length
    let r = 0;
    for (let j = 1; j < path.length - 1; j++) {
      const vj = holdVel(holds[j - 1]);
      const a = unit([path[j][0] - path[j - 1][0], path[j][1] - path[j - 1][1], path[j][2] - path[j - 1][2]]);
      const b = unit([path[j + 1][0] - path[j][0], path[j + 1][1] - path[j][1], path[j + 1][2] - path[j][2]]);
      r += dot(vj, a) - dot(vj, b);
    }
    return r;
  };
  let sbL0 = 0, lapL0 = 0, prePulled = 0;

  // joint rest geometry, from the rest pose
  const PF0 = pelvisFrame(), TF0 = torsoFrame(), HF0 = headFrame(), NF0 = neckFrame(TF0);
  const lumbar0 = relFrame(PF0, TF0), upper0 = relFrame(NF0, HF0);
  const neck0 = [dot(sub(OC, T1), TF0.f), dot(sub(OC, T1), TF0.u), dot(sub(OC, T1), TF0.l)].map(v => v / linkLen[LINKS.findIndex(([a, b]) => a === T1 && b === OC)]);
  const femur0 = [[HL, KL], [HR, KR]].map(([h, k]) => { const d = unit(sub(k, h)); return [dot(d, PF0.f), dot(d, PF0.u), dot(d, PF0.l)]; });
  const knee0 = [[HL, KL, AL], [HR, KR, AR]].map(([h, k, a]) => Math.acos(dot(unit(sub(k, h)), unit(sub(a, k)))));
  function sub(b, a) { return [P[3 * b] - P[3 * a], P[3 * b + 1] - P[3 * a + 1], P[3 * b + 2] - P[3 * a + 2]]; }
  const sb = [Math.cos(SEAT_BACK), Math.sin(SEAT_BACK), 0];   // seat back normal (forward and up)
  const sbD0 = TORSO.map(i => dot(pt(i), sb)), hrD0 = dot(pt(HB), sb) - 0.06;   // seat back, and the head restraint 6 cm behind the head
  const prev = {};   // joint angles last step, for the damping rates
  const rate = (key, v) => { const r = key in prev ? (v - prev[key]) / dt : 0; prev[key] = v; return r; };

  // force evaluation
  let headExt = [0, 0, 0], sbT = 0, lapT = 0, defl = 0, myUpper = 0, headHit = 0, hitSurf = '', hitP = null, intF = 0, kneeF = [0, 0];
  function forces(t, ac, gv, settling) {
    for (let i = 0; i < NP; i++) for (let d = 0; d < 3; d++) Fo[3 * i + d] = MASS[i] * (gv[d] - ac[d]);
    headExt = [0, 0, 0]; headHit = 0; intF = 0; kneeF = [0, 0];
    const PF = pelvisFrame(), TF = torsoFrame(), HFm = headFrame(), NF = neckFrame(TF);

    // lumbar spine: the torso against the pelvis, stiffening toward its stops (forward bending is
    // the softest; leaning back is the seat back's job)
    {
      const th = rotVec(relFrame(PF, TF), lumbar0), flex = -th[2];
      const tl = [joint(th[0], rate('lb', th[0]), 1500, 2, 50, -0.4, 0.4, 3000), joint(th[1], rate('lt', th[1]), 600, 2, 30, -0.4, 0.4, 2000),
        -joint(flex, rate('lf', flex), 150, 3, 8, -0.25, 0.6, 1500)];
      const tw = toWorld(PF, tl);
      bodyTorque(TORSO, tw); bodyTorque(PELVIS, [-tw[0], -tw[1], -tw[2]]);
    }
    // lower neck: the neck's direction against the torso
    const iNeck = LINKS.findIndex(([a, b]) => a === T1 && b === OC);
    {
      const n0 = unit(toWorld(TF, neck0)), nd = unit(sub(OC, T1)), th = turn(n0, nd);
      const flex = -dot(th, TF.l), side = dot(th, TF.f);
      const tF = joint(flex, rate('nf', flex), 120, 4, 3, -0.8, 0.8, 2000), tS = joint(side, rate('ns', side), 120, 4, 3, -0.8, 0.8, 2000);
      const tw = [-TF.l[0] * tF + TF.f[0] * tS, -TF.l[1] * tF + TF.f[1] * tS, -TF.l[2] * tF + TF.f[2] * tS];
      linkTorque(T1, OC, tw); bodyTorque(TORSO, [-tw[0], -tw[1], -tw[2]]);
    }
    // upper neck: the head against the neck; its flexion torque is the upper neck moment My
    {
      const th = rotVec(relFrame(NF, HFm), upper0);
      const flex = -th[2], side = th[0], twist = th[1];
      const tF = joint(flex, rate('hf', flex), 60, 6, 1.5, -0.6, 0.5, 2000);
      const tS = joint(side, rate('hs', side), 60, 6, 1.5, -0.5, 0.5, 2000);
      const tT = joint(twist, rate('ht', twist), 20, 4, 0.5, -0.8, 0.8, 1000);
      const tw = toWorld(NF, [tS, tT, -tF]);
      bodyTorque(HEAD, tw);
      const along = dot(tw, NF.u), across = [tw[0] - along * NF.u[0], tw[1] - along * NF.u[1], tw[2] - along * NF.u[2]];
      linkTorque(T1, OC, [-across[0], -across[1], -across[2]]);
      bodyTorque(TORSO, [-along * NF.u[0], -along * NF.u[1], -along * NF.u[2]]);
      myUpper = -tF;   // flexion positive
    }
    // hips (weak) and knees
    [[HL, KL, AL], [HR, KR, AR]].forEach(([h, k, a], s) => {
      const d0 = unit(toWorld(PF, femur0[s])), d = unit(sub(k, h)), th = turn(d0, d);
      const thr = [rate('hx' + s, th[0]), rate('hy' + s, th[1]), rate('hz' + s, th[2])];
      const tw = [-30 * th[0] - 2 * thr[0], -30 * th[1] - 2 * thr[1], -30 * th[2] - 2 * thr[2]];
      linkTorque(h, k, tw); bodyTorque(PELVIS, [-tw[0], -tw[1], -tw[2]]);
      const ds = unit(sub(a, k)), ax = cross(d, ds), al = Math.hypot(ax[0], ax[1], ax[2]);
      if (al > 1e-9) {
        const phi = Math.acos(Math.max(-1, Math.min(1, dot(d, ds)))), rel = phi - knee0[s];
        let tk = -30 * rel - 3 * rate('k' + s, phi);
        if (phi < 0.15) tk += 400 * (0.15 - phi);   // the knee straightens no further
        const tv = [ax[0] / al * tk, ax[1] / al * tk, ax[2] / al * tk];
        linkTorque(k, a, tv); linkTorque(h, k, [-tv[0], -tv[1], -tv[2]]);
      }
    });

    // chest: the sternum on a spring-damper ahead of the spine
    {
      const rest = [P[3 * SAC] + STERNUM_A * TF.u[0] + STERNUM_B * TF.f[0], P[3 * SAC + 1] + STERNUM_A * TF.u[1] + STERNUM_B * TF.f[1], P[3 * SAC + 2] + STERNUM_A * TF.u[2] + STERNUM_B * TF.f[2]];
      const wA = STERNUM_A / Math.hypot(...sub(T1, SAC));
      const sv = [0, 1, 2].map(c => V[3 * SAC + c] * (1 - wA) + V[3 * T1 + c] * wA);
      const e = [P[3 * STN] - rest[0], P[3 * STN + 1] - rest[1], P[3 * STN + 2] - rest[2]];
      defl = -dot(e, TF.f);
      const rv = [V[3 * STN] - sv[0], V[3 * STN + 1] - sv[1], V[3 * STN + 2] - sv[2]], ddot = -dot(rv, TF.f);
      let Fn = defl > 0 ? 1.2e5 * defl + 2e7 * defl * defl * defl + 800 * ddot : 2e5 * defl + 800 * ddot;
      if (defl > 0.085) Fn += 2e6 * (defl - 0.085);
      const eu = dot(e, TF.u), el = dot(e, TF.l), vu = dot(rv, TF.u), vl = dot(rv, TF.l);
      const Fv = [0, 1, 2].map(c => Fn * TF.f[c] - (2e5 * eu + 200 * vu) * TF.u[c] - (2e5 * el + 200 * vl) * TF.l[c]);
      add(STN, Fv); add(SAC, Fv, -(1 - wA)); add(T1, Fv, -wA);
    }

    // seat: cushion under the pelvis and thighs (with friction), seat back behind the torso
    for (const i of [HL, HR]) {
      const dz = P[3 * i + 2] - P0[3 * i + 2];   // side bolsters
      if (Math.abs(dz) > 0.03) Fo[3 * i + 2] -= 3e4 * (dz - 0.03 * Math.sign(dz)) + 300 * V[3 * i + 2];
      const pen = -P[3 * i + 1];
      if (pen > 0) {
        const Fy = foam(3e4, pen, V[3 * i + 1], 750);
        Fo[3 * i + 1] += Fy;
        const vh = Math.hypot(V[3 * i], V[3 * i + 2]), fr = 0.35 * Fy * Math.tanh(vh / 0.05) / (vh || 1);
        Fo[3 * i] -= fr * V[3 * i]; Fo[3 * i + 2] -= fr * V[3 * i + 2];
      }
    }
    if (P[3 * SAC] < P0[3 * SAC] - 0.03) Fo[3 * SAC] += 1e5 * (P0[3 * SAC] - 0.03 - P[3 * SAC]) - 1000 * Math.min(0, V[3 * SAC]);
    { const pen = P0[3 * SAC + 1] - P[3 * SAC + 1]; if (pen > 0) Fo[3 * SAC + 1] += foam(3e4, pen, V[3 * SAC + 1], 750); }   // buttocks on the cushion
    for (const k of [KL, KR]) {
      const pen = P0[3 * k + 1] - 0.005 - P[3 * k + 1];
      if (pen > 0) Fo[3 * k + 1] += foam(5e4, pen, V[3 * k + 1], 300);
    }
    TORSO.forEach((i, j) => {   // seat back, with friction along it
      const pen = sbD0[j] - dot(pt(i), sb);
      if (pen > 0) {
        const v = vel(i), vn = dot(v, sb), Fn = foam(4e4, pen, vn, 400);
        add(i, sb, Fn);
        const vt = [v[0] - vn * sb[0], v[1] - vn * sb[1], v[2] - vn * sb[2]], vtl = Math.hypot(vt[0], vt[1], vt[2]);
        if (vtl > 1e-6) add(i, vt, -0.3 * Fn * Math.tanh(vtl / 0.05) / vtl);
      }
    });
    // knees on the knee bolster (padding crushes), feet on the floor and the toe pan
    [[KL, PC.kneeL], [KR, PC.kneeR]].forEach(([k, st], s) => {
      const pen = P[3 * k] + KNEE_R - S.knee.p[0];
      if (pen > 0) {
        const vn = V[3 * k] - S.knee.v[0];
        const F = Math.max(0, plasticContact(st, pen, 1.5e5, 6000, 0.08) + (vn > 0 ? 1500 * vn : 0));
        Fo[3 * k] -= F; intF += F; kneeF[s] = F;
      }
    });
    const tn = [-Math.sin(TOE_PAN), Math.cos(TOE_PAN), 0], tt = [Math.cos(TOE_PAN), Math.sin(TOE_PAN), 0];   // toe pan normal, and up its slope
    for (const a of [AL, AR]) {
      const penF = I.floorY + FOOT_R - P[3 * a + 1];
      if (penF > 0) {
        const Fy = Math.max(0, 8e4 * penF - 600 * V[3 * a + 1]);
        Fo[3 * a + 1] += Fy;
        Fo[3 * a] -= 0.5 * Fy * Math.tanh(V[3 * a] / 0.05); Fo[3 * a + 2] -= 0.5 * Fy * Math.tanh(V[3 * a + 2] / 0.05);
      }
      // the foot (ankle to the ball of the foot) against the toe pan, with friction along it
      const r = [P[3 * a] - S.toe.p[0], P[3 * a + 1] - S.toe.p[1], 0], penT = FOOT_L - dot(r, tn);
      if (penT > 0) {
        const vr = [V[3 * a] - S.toe.v[0], V[3 * a + 1] - S.toe.v[1], 0], vn = dot(vr, tn), vt = dot(vr, tt);
        const F = Math.max(0, 1.5e5 * penT - (vn < 0 ? 1500 * vn : 0));
        add(a, tn, F); add(a, tt, -0.6 * F * Math.tanh(vt / 0.05)); intF += F;
      }
    }
    // door and B-pillar beside the pelvis, chest and shoulder; the centre console on the other side
    const doorAt = (y) => S.door.p[2] + (S.doorHead.p[2] - S.door.p[2]) * Math.max(0, Math.min(1, (y - 0.30) / 0.32));
    for (const [i, half] of [[HL, 0.10], [SHL, 0.08], [THX, 0.17]]) {
      const pen = doorAt(P[3 * i + 1]) - (P[3 * i + 2] - half);
      if (pen > 0) { const F = Math.max(0, 1.5e5 * pen - (V[3 * i + 2] < S.door.v[2] ? 800 * (V[3 * i + 2] - S.door.v[2]) : 0)); Fo[3 * i + 2] += F; intF += F; }
    }
    for (const [i, half] of [[HR, 0.10], [KR, KNEE_R]]) {
      const pen = P[3 * i + 2] + half - I.consoleZ;
      if (pen > 0) Fo[3 * i + 2] -= Math.max(0, 5e4 * pen + (V[3 * i + 2] > 0 ? 500 * V[3 * i + 2] : 0));
    }
    if (settling) return;

    // belts
    sbT = 0; lapT = 0;
    if (belt) {
      const sp = shoulderPath(), L = pathLen(sp);
      // pretensioner: reel in slack for 8 ms after firing
      if (pretensioner && tFire >= 0 && t > tFire + 0.001 && t < tFire + 0.009 && prePulled < 0.08 && SB_K * (L - sbL0) < PRE_FORCE) {
        sbL0 -= 8 * dt; prePulled += 8 * dt;
      }
      let e1 = SB_K * (L - sbL0);
      if (loadLimiter && e1 > LOAD_LIMIT) { sbL0 = L - LOAD_LIMIT / SB_K; e1 = LOAD_LIMIT; }   // the force limiter pays out webbing
      if (e1 > 0) {
        const Ld = pathRate(sp, SHOULDER_HOLD);
        sbT = Math.max(0, e1 + (Ld > 0 ? SB_C * Ld : 0));
        if (loadLimiter) sbT = Math.min(LOAD_LIMIT, sbT);   // the limiter caps the webbing's tension
        beltForce(sp, SHOULDER_HOLD, sbT);
      }
      const lp = lapPath(), ll = pathLen(lp);
      if (ll > lapL0) {
        const Ld = pathRate(lp, LAP_HOLD);
        lapT = Math.max(0, LAP_K * (ll - lapL0) + (Ld > 0 ? LAP_C * Ld : 0));
        beltForce(lp, LAP_HOLD, lapT);
      }
    }

    // head and chest contacts
    const hc = centroid([HF, HB]), hv = [0, 1, 2].map(c => 0.5 * (V[3 * HF + c] + V[3 * HB + c]));
    const strike = (F, surf, p) => { if (F > 1000 && F > headHit) { headHit = F; hitSurf = surf; hitP = p; } };
    // airbag: a flattened ellipsoid growing out of the hub along the column (as drawn: half-axes
    // 0.75 R along the column, 1.05 R up the wheel, 1.15 R across)
    const R = bagRadius(t), ks = bagStiffScale(t);
    const bagC = [S.hub.p[0] + I.bagOffset * S.col[0], S.hub.p[1] + I.bagOffset * S.col[1], S.hub.p[2] + I.bagOffset * S.col[2]];
    const bagL = cross(S.col, S.rimUp), ax = [0.75 * R, 1.05 * R, 1.15 * R];
    function bag(c, v, r, sc) {
      if (R <= 0) return [0, 0, 0];
      const d = [c[0] - bagC[0], c[1] - bagC[1], c[2] - bagC[2]], dl = Math.hypot(d[0], d[1], d[2]);
      if (dl < 1e-9) return [0, 0, 0];
      const q = [dot(d, S.col) / ax[0], dot(d, S.rimUp) / ax[1], dot(d, bagL) / ax[2]], rho = Math.hypot(q[0], q[1], q[2]);
      const pen = dl / rho - dl + r;   // the ellipsoid's radius toward the point, less the distance, plus the body's
      if (pen <= 0) return [0, 0, 0];
      const gl = [q[0] / ax[0], q[1] / ax[1], q[2] / ax[2]], n = unit([0, 1, 2].map(k => gl[0] * S.col[k] + gl[1] * S.rimUp[k] + gl[2] * bagL[k]));
      const vn = dot([v[0] - S.hub.v[0], v[1] - S.hub.v[1], v[2] - S.hub.v[2]], n);
      const F = sc * Math.max(0, ks * (BAG_K * pen + BAG_K3 * pen * pen * pen) + (vn < 0 ? -BAG_C * Math.min(1, pen / 0.03) * vn : 0));   // venting grows with the contact patch
      intF += F;
      return [F * n[0], F * n[1], F * n[2]];
    }
    const hb = bag(hc, hv, HEAD_R, 1); for (let c = 0; c < 3; c++) headExt[c] += hb[c];
    for (const [i, r] of [[STN, CHEST_R], [THX, 0.12], [SHL, 0.08], [SHR, 0.08]]) add(i, bag(pt(i), vel(i), r, BAG_TORSO));   // the bag also takes the chest and shoulders
    // steering wheel: a disc across the rim (normal toward the driver) and the rim tube round it;
    // one-sided, so a body pressed hard into it is pushed back, never through
    const RIM_T = 0.02;
    function wheel(st, c, v, r, k, damp, cap, stroke) {
      const rel = [c[0] - S.hub.p[0], c[1] - S.hub.p[1], c[2] - S.hub.p[2]], sd = dot(rel, S.col);
      if (sd < -(r + 0.15)) return [0, 0, 0];   // already beyond the wheel (went over the top)
      const inPlane = [rel[0] - sd * S.col[0], rel[1] - sd * S.col[1], rel[2] - sd * S.col[2]], rho = Math.hypot(inPlane[0], inPlane[1], inPlane[2]);
      let n, pen;
      if (rho <= I.rimR) { n = S.col; pen = r + RIM_T - sd; }
      else {
        const e = [S.hub.p[0] + inPlane[0] / rho * I.rimR, S.hub.p[1] + inPlane[1] / rho * I.rimR, S.hub.p[2] + inPlane[2] / rho * I.rimR];
        const d = [c[0] - e[0], c[1] - e[1], c[2] - e[2]], dl = Math.hypot(d[0], d[1], d[2]);
        if (dl < 1e-9) return [0, 0, 0];
        n = [d[0] / dl, d[1] / dl, d[2] / dl]; pen = r + RIM_T - dl;
      }
      if (pen <= 0) return [0, 0, 0];
      const vn = dot([v[0] - S.hub.v[0], v[1] - S.hub.v[1], v[2] - S.hub.v[2]], n);
      const F = Math.max(0, plasticContact(st, pen, k, cap, stroke) + (vn < 0 ? -damp * vn : 0));
      intF += F;
      return [F * n[0], F * n[1], F * n[2]];
    }
    const hw = wheel(PC.headWheel, hc, hv, HEAD_R, 1.5e5, 300, 6000, 0.06);
    for (let c = 0; c < 3; c++) headExt[c] += hw[c];
    strike(Math.hypot(...hw), 'wheel', hc);
    for (const [i, rad, st] of [[STN, CHEST_R, PC.stnWheel], [THX, 0.13, PC.thxWheel], [T1, 0.12, PC.t1Wheel]]) add(i, wheel(st, pt(i), vel(i), rad, 2.5e5, 1000, 7000, 0.10));
    // chin on chest
    {
      const d = [hc[0] - P[3 * STN], hc[1] - P[3 * STN + 1], hc[2] - P[3 * STN + 2]], dl = Math.hypot(d[0], d[1], d[2]), pen = HEAD_R + CHEST_R - dl;
      if (pen > 0 && dl > 1e-9) {
        const n = [d[0] / dl, d[1] / dl, d[2] / dl], vn = dot([hv[0] - V[3 * STN], hv[1] - V[3 * STN + 1], hv[2] - V[3 * STN + 2]], n);
        const F = Math.max(0, 1e5 * pen + (vn < 0 ? -300 * vn : 0));
        for (let c = 0; c < 3; c++) headExt[c] += F * n[c];
        add(STN, n, -F);
      }
    }
    // windshield (the glass cracks), roof, A-pillar
    {
      const a = S.wsLow.p, b = S.wsHigh.p;
      let n = unit([-(b[1] - a[1]), b[0] - a[0], 0]);
      if (dot([P0[3 * HF] - a[0], P0[3 * HF + 1] - a[1], 0], n) < 0) n = [-n[0], -n[1], 0];
      const sd = dot([hc[0] - a[0], hc[1] - a[1], 0], n), pw = HEAD_R - sd;
      if (pw > 0) {
        const vs = lerp3(S.wsLow.v, S.wsHigh.v, 0.5), vn = dot([hv[0] - vs[0], hv[1] - vs[1], 0], n);
        const F = Math.max(0, plasticContact(PC.ws, pw, 1.2e5, 9000, 0.08) + (vn < 0 ? -300 * vn : 0));
        for (let c = 0; c < 3; c++) headExt[c] += F * n[c];
        intF += F;
        strike(F, 'windshield', [hc[0] - HEAD_R * n[0], hc[1] - HEAD_R * n[1], hc[2]]);
      }
    }
    {
      const pr = hc[1] + HEAD_R - S.roof.p[1];
      if (pr > 0) {
        const F = Math.max(0, plasticContact(PC.roof, pr, 2e5, 12000, 0.05) + 300 * Math.max(0, hv[1] - S.roof.v[1]));
        headExt[1] -= F; intF += F; strike(F, 'roof', [hc[0], hc[1] + HEAD_R, hc[2]]);
      }
    }
    {
      const a = S.aLow.p, b = S.aHigh.p, ab = [b[0] - a[0], b[1] - a[1], b[2] - a[2]];
      const s = Math.max(0, Math.min(1, dot([hc[0] - a[0], hc[1] - a[1], hc[2] - a[2]], ab) / dot(ab, ab)));
      const q = lerp3(a, b, s), d = [hc[0] - q[0], hc[1] - q[1], hc[2] - q[2]], dl = Math.hypot(d[0], d[1], d[2]), pen = HEAD_R + 0.06 - dl;
      if (pen > 0 && dl > 1e-9) {
        const n = [d[0] / dl, d[1] / dl, d[2] / dl], vq = lerp3(S.aLow.v, S.aHigh.v, s), vn = dot([hv[0] - vq[0], hv[1] - vq[1], hv[2] - vq[2]], n);
        const F = Math.max(0, plasticContact(PC.pillar, pen, 2.5e5, 10000, 0.02) + (vn < 0 ? -400 * vn : 0));
        for (let c = 0; c < 3; c++) headExt[c] += F * n[c];
        intF += F; strike(F, 'A-pillar', q);
      }
    }
    // door window beside the head; the head restraint behind it (on the rebound)
    {
      const pen = S.doorHead.p[2] - (hc[2] - HEAD_R);
      if (pen > 0) { const F = Math.max(0, 1.5e5 * pen - (hv[2] < S.doorHead.v[2] ? 400 * (hv[2] - S.doorHead.v[2]) : 0)); headExt[2] += F; intF += F; strike(F, 'side window', [hc[0], hc[1], hc[2] - HEAD_R]); }
      const ph = hrD0 - dot(pt(HB), sb);
      if (ph > 0) { const F = Math.max(0, 5e4 * ph - 300 * dot(vel(HB), sb)); for (let c = 0; c < 3; c++) headExt[c] += F * sb[c]; }
    }
    // the head's external load, shared by its particles in proportion to mass
    for (const i of HEAD) add(i, headExt, MASS[i] / HEAD_MASS);
  }

  function integrate(t, ac, gv, settling, damp) {
    forces(t, ac, gv, settling);
    for (let i = 0; i < 3 * NP; i++) {
      OV[i] = V[i];
      V[i] += Fo[i] / MASS[Math.floor(i / 3)] * dt;
      if (damp) V[i] *= 1 - damp * dt;
      Pp[i] = P[i];
      P[i] += V[i] * dt;
    }
    linkF.fill(0);
    for (let it = 0; it < 8; it++) {
      for (let l = 0; l < LINKS.length; l++) {
        const a = LINKS[l][0], b = LINKS[l][1];
        const dx = P[3 * b] - P[3 * a], dy = P[3 * b + 1] - P[3 * a + 1], dz = P[3 * b + 2] - P[3 * a + 2], d = Math.hypot(dx, dy, dz);
        const wa = 1 / MASS[a], wb = 1 / MASS[b], C = d - linkLen[l], s = C / (d * (wa + wb));
        P[3 * a] += wa * s * dx; P[3 * a + 1] += wa * s * dy; P[3 * a + 2] += wa * s * dz;
        P[3 * b] -= wb * s * dx; P[3 * b + 1] -= wb * s * dy; P[3 * b + 2] -= wb * s * dz;
        linkF[l] -= C / ((wa + wb) * dt * dt);
      }
    }
    for (let i = 0; i < 3 * NP; i++) V[i] = (P[i] - Pp[i]) / dt;
  }

  // Settle into the seat under gravity before the run.
  const g0 = [pulse.gx[0], pulse.gy[0], pulse.gz[0]];
  for (let k = 0; k < Math.round(0.4 / dt); k++) integrate(0, [0, 0, 0], g0, true, 30);
  V.fill(0);
  for (const key in prev) delete prev[key];
  sbL0 = pathLen(shoulderPath()) + 0.02;
  lapL0 = pathLen(lapPath()) + 0.01;
  const seated = Float64Array.from(P);

  // run
  const out = {
    dt, n: N, i0: pulse.i0, tFire: airbag || belt ? tFire : -1, airbag, belt,
    headAx: new Float64Array(N), headAy: new Float64Array(N), headAz: new Float64Array(N),
    chestAx: new Float64Array(N), chestAy: new Float64Array(N), chestAz: new Float64Array(N),
    pelvisAx: new Float64Array(N), pelvisAy: new Float64Array(N), pelvisAz: new Float64Array(N),
    chestDefl: new Float64Array(N), neckFz: new Float64Array(N), neckFx: new Float64Array(N), neckMy: new Float64Array(N),
    femurL: new Float64Array(N), femurR: new Float64Array(N), kneeL: new Float64Array(N), kneeR: new Float64Array(N),
    beltT: new Float64Array(N), lapT: new Float64Array(N), bagR: new Float64Array(N), interiorF: new Float64Array(N),
    poseEvery: 5, pose: null, events: [],
  };
  // pose: the particles, the airbag radius, the steering wheel hub's move and the column direction
  const PSTRIDE = 3 * NP + 7;
  out.pose = new Float32Array(Math.ceil(N / out.poseEvery) * PSTRIDE);
  out.poseStride = PSTRIDE;
  const acc = (i, ac) => [(V[3 * i] - OV[3 * i]) / dt + ac[0], (V[3 * i + 1] - OV[3 * i + 1]) / dt + ac[1], (V[3 * i + 2] - OV[3 * i + 2]) / dt + ac[2]];
  let lastHit = -1;
  for (let k = 0; k < N; k++) {
    const t = k * dt, ac = [pulse.ax[k], pulse.ay[k], pulse.az[k]], gv = [pulse.gx[k], pulse.gy[k], pulse.gz[k]];
    cabinAt(t);
    integrate(t, ac, gv, false, 0);
    // sensors (kinematic acceleration = relative + cabin), at the head's and chest's centres of mass
    const ah = [0, 1, 2].map(c => HEAD.reduce((s, i) => s + MASS[i] * ((V[3 * i + c] - OV[3 * i + c]) / dt), 0) / HEAD_MASS + ac[c]);
    out.headAx[k] = ah[0]; out.headAy[k] = ah[1]; out.headAz[k] = ah[2];
    const at = acc(THX, ac); out.chestAx[k] = at[0]; out.chestAy[k] = at[1]; out.chestAz[k] = at[2];
    const ap = [0, 1, 2].map(c => PELVIS.reduce((s, i) => s + (V[3 * i + c] - OV[3 * i + c]) / dt, 0) / 3 + ac[c]);
    out.pelvisAx[k] = ap[0]; out.pelvisAy[k] = ap[1]; out.pelvisAz[k] = ap[2];
    out.chestDefl[k] = defl;
    // upper neck load: Newton on the head (force from the neck = m a - external - gravity), in head axes
    const Fn = [0, 1, 2].map(c => HEAD_MASS * ah[c] - headExt[c] - HEAD_MASS * gv[c]);
    const Hd = headFrame();
    out.neckFz[k] = -dot(Fn, Hd.u);   // tension positive
    out.neckFx[k] = dot(Fn, Hd.f);
    out.neckMy[k] = myUpper;
    out.femurL[k] = linkF[FEMUR[0]]; out.femurR[k] = linkF[FEMUR[1]];
    out.kneeL[k] = kneeF[0]; out.kneeR[k] = kneeF[1];
    out.beltT[k] = sbT; out.lapT[k] = lapT; out.bagR[k] = bagRadius(t); out.interiorF[k] = intF;
    if (headHit > 0 && (lastHit < 0 || t - lastHit > 0.03)) { out.events.push({ t, type: 'headStrike', mag: headHit, surface: hitSurf, hx: hitP[0], hy: hitP[1], hz: hitP[2] }); lastHit = t; }
    if (k % out.poseEvery === 0) {
      const o = (k / out.poseEvery) * PSTRIDE;
      for (let i = 0; i < 3 * NP; i++) out.pose[o + i] = P[i];
      out.pose[o + 3 * NP] = out.bagR[k];
      for (let c = 0; c < 3; c++) { out.pose[o + 3 * NP + 1 + c] = S.hub.p[c] - REST.hub[c]; out.pose[o + 3 * NP + 4 + c] = S.col[c]; }
    }
  }
  if (airbag && tFire >= 0) out.events.push({ t: tFire + bagDelay, type: 'airbag', mag: 1 });
  out.seated = seated;
  out.rest = P0;
  out.metrics = score(out);
  return out;
}

// the dummy's pose at time t of a run: particles, airbag radius, the steering wheel hub's move and
// the column's direction (for the renderer: scene.js setDummy)
function poseAt(o, t) {
  const pi = Math.max(0, Math.min(Math.ceil(o.n / o.poseEvery) - 1, Math.round(t / (o.dt * o.poseEvery)))), b = pi * o.poseStride;
  return { p3: o.pose.subarray(b, b + 3 * NP), bagR: o.pose[b + 3 * NP], hub: o.pose.subarray(b + 3 * NP + 1, b + 3 * NP + 4), col: o.pose.subarray(b + 3 * NP + 4, b + 3 * NP + 7), belt: o.belt };
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
  const femL = cfc(o.femurL, dt, 600), femR = cfc(o.femurR, dt, 600);
  const i0 = Math.max(0, o.i0 - Math.round(0.005 / dt)), i1 = Math.min(N - 1, o.i0 + Math.round(0.3 / dt));
  const h = hic(head.r, dt, i0, i1, 0.015);
  const nij = new Float64Array(N);
  let nijMax = 0, nijMode = '', tens = 0, compr = 0, deflMax = 0, pelvisMax = 0, headMax = 0, femMax = 0, femSide = '';
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
    if (femL[i] > femMax) { femMax = femL[i]; femSide = 'left'; }
    if (femR[i] > femMax) { femMax = femR[i]; femSide = 'right'; }
  }
  return {
    hic15: h.value, hicT1: h.i1 * dt, hicT2: h.i2 * dt,
    headPeakG: headMax,
    chest3ms: clip3ms(chest.r, dt, i0, i1),
    chestDeflMm: deflMax * 1000,
    pelvisPeakG: pelvisMax,
    nij: nijMax, nijMode,
    neckTension: tens, neckCompression: compr,
    femur: femMax, femurSide: femSide,
    series: { head, chest, pelvis, defl, fz, my, nij, femL, femR },
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

const api = { G, LIMITS, SIDE_LIMITS, INTERIOR, interiorFor, MASS, PARTICLES: { HL, HR, SAC, THX, T1, SHL, SHR, STN, OC, HF, HB, KL, KR, AL, AR, NP }, SIDE_PARTICLES, cfc, hic, clip3ms, restPose, beltPaths, poseAt, simulate, organs, simulateSide };
root.CrashOccupant = api;
if (typeof module === 'object' && module.exports) module.exports = api;
})(typeof window !== 'undefined' ? window : globalThis);
