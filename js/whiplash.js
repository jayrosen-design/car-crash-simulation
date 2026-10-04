/* Rear-impact sled test (whiplash). No dependencies: browser (global CrashWhiplash) and Node.
 *
 * A seat on a sled is pushed forward with the acceleration pulse of a stationary car struck from
 * behind (a triangular pulse of 91 ms whose speed change is half the striking car's speed). In the
 * seat sits a rear-impact dummy with an articulated spine of 24 vertebrae (5 lumbar, 12 thoracic,
 * 7 cervical) between the pelvis and the head, each joint a rotational spring and damper, in the
 * side-view plane. The torso presses into the seatback foam and the seatback rotates on its
 * recliner; the head, left behind by its own inertia, swings back until it meets the head
 * restraint, whose position (backset and height) is the test setting.
 *
 * Reported as in seat ratings for whiplash protection: the time until the head touches the head
 * restraint (70 ms or less is good) and the peak forward acceleration of the upper spine (T1,
 * 9.5 g or less), plus neck loads and the neck injury criterion NIC. Illustrative, not a validated
 * dummy.
 */
(function (root) {
'use strict';

const G = 9.81;
const LIMITS = { contactMs: 70, t1G: 9.5, nic: 15, shear: 340, tension: 475 };
const PULSE_T = 0.091;                 // s, sled pulse duration
// seatback 25 degrees from vertical, its surface 0.135 m behind the H-point; recliner stiffness
// (N m/rad) and the moment at which it yields; seat foam per contact point (N/m) and its depth (m)
const SEAT = { angle: 25 * Math.PI / 180, backOff: 0.135, hinge: [-0.15, -0.04], kBack: 12000, cBack: 120, yieldM: 2200, kFoam: 2100, foam: 0.12, hrLen: 0.24 };
const HEAD_R = 0.095;

// Dummy: pelvis, 24 vertebral joints from L5 up to C1, and the head's centre of mass.
const SEG = [];   // [length to the next joint, mass, region]
for (let i = 0; i < 5; i++) SEG.push([0.036, 1.6, 'L']);
for (let i = 0; i < 12; i++) SEG.push([0.025, 2.6, 'T']);
for (let i = 0; i < 7; i++) SEG.push([0.017, 0.3, 'C']);
const NV = SEG.length;                 // 24
const NP = NV + 2;                     // pelvis, vertebrae, head
const PEL = 0, T1 = 1 + 5 + 11, C1 = NV, HEAD = NV + 1;
const MASS = [15].concat(SEG.map(s => s[1]), [4.5]);
// joint stiffness (N m / rad) and damping per region; cervical joints have stops at +-0.25 rad
const JOINT = { L: [350, 3], T: [600, 4], C: [11, 0.06] };

function rot(v, a) { const c = Math.cos(a), s = Math.sin(a); return [c * v[0] - s * v[1], s * v[0] + c * v[1]]; }

// Rest posture in the seat frame (origin at the H-point, x forward, y up)
function restPose() {
  const x = new Float64Array(NP), y = new Float64Array(NP);
  x[PEL] = 0; y[PEL] = 0.06;
  let px = -0.07, py = 0.09;   // L5: the lumbar spine runs behind the hip joints
  const back = [-Math.sin(SEAT.angle), Math.cos(SEAT.angle)];
  for (let i = 0; i < NV; i++) {
    x[1 + i] = px; y[1 + i] = py;
    const len = SEG[i][0];
    // lumbar and thoracic along the seatback; the neck more upright
    const dir = SEG[i][2] === 'C' ? [-Math.sin(10 * Math.PI / 180), Math.cos(10 * Math.PI / 180)] : back;
    px += dir[0] * len; py += dir[1] * len;
  }
  x[HEAD] = px + 0.025; y[HEAD] = py + 0.05;
  return { x, y };
}

/* opts: { strikeMph (striking car speed, 20-30 mph), backset (m, from the back of the head to the
 *         head restraint), height (m, top of the head restraint relative to the top of the head) } */
function simulate(opts) {
  const dt = 1e-4, T = 0.30, N = Math.round(T / dt) + 1, t0 = 0.01;
  const dv = 0.5 * opts.strikeMph * 0.44704, aPeak = 2 * dv / PULSE_T;
  const sled = (t) => { const u = (t - t0) / PULSE_T; return u <= 0 || u >= 1 ? 0 : aPeak * (u < 0.5 ? 2 * u : 2 - 2 * u); };
  const pose = restPose(), x = pose.x, y = pose.y;
  const vx = new Float64Array(NP), vy = new Float64Array(NP), fx = new Float64Array(NP), fy = new Float64Array(NP);
  const px = new Float64Array(NP), py = new Float64Array(NP), ovx = new Float64Array(NP);
  const linkLen = [];
  for (let i = 0; i < NP - 1; i++) linkLen.push(Math.hypot(x[i + 1] - x[i], y[i + 1] - y[i]));
  const angRest = [];
  for (let i = 0; i < NP - 2; i++) angRest.push(segAng(i + 1) - segAng(i));
  function segAng(i) { return Math.atan2(x[i + 1] - x[i], y[i + 1] - y[i]); }   // from vertical, + leaning forward
  function segVel(i) { const dx = x[i + 1] - x[i], dy = y[i + 1] - y[i]; return (dy * (vx[i + 1] - vx[i]) - dx * (vy[i + 1] - vy[i])) / (dx * dx + dy * dy); }
  function couple(i, tau) {   // torque on segment i -> i+1
    const a = i, b = i + 1, dx = x[b] - x[a], dy = y[b] - y[a], s = tau / (dx * dx + dy * dy);
    fx[b] += s * dy; fy[b] -= s * dx; fx[a] -= s * dy; fy[a] += s * dx;
  }
  // seatback: rotates about the recliner hinge; its surface passes SEAT.backOff behind the H-point
  let sb = 0, sbv = 0;   // rotation of the seatback (rad, + rearward)
  const headTopY = y[HEAD] + HEAD_R, headBackX = x[HEAD] - HEAD_R;
  // head restraint front face in the seat frame at rest: a segment parallel to the seatback whose top
  // is `height` relative to the top of the head and whose front is `backset` behind the head
  const bdir = [-Math.sin(SEAT.angle), Math.cos(SEAT.angle)];
  const hrTop0 = [0, headTopY + opts.height];
  const hrAtHead = headBackX - opts.backset;   // x of the face at the head's height
  hrTop0[0] = hrAtHead + bdir[0] * ((hrTop0[1] - y[HEAD]) / bdir[1]);
  const hrBot0 = [hrTop0[0] - bdir[0] * SEAT.hrLen, hrTop0[1] - bdir[1] * SEAT.hrLen];
  const surf0 = [-SEAT.backOff * Math.cos(SEAT.angle), SEAT.backOff * Math.sin(SEAT.angle) * -1];   // a point on the seatback surface
  const H = SEAT.hinge;
  const onBack = (p) => { const r = rot([p[0] - H[0], p[1] - H[1]], sb); return [H[0] + r[0], H[1] + r[1]]; };   // rotate with the seatback (+ rearward)
  // the back of the spine: 0.09 m behind each lumbar and thoracic joint
  const BACK = 0.10;
  let hrF = 0, backF = 0, tContact = -1, hrX = 0, hrY = 0;
  function forces(t, as) {
    for (let i = 0; i < NP; i++) { fx[i] = -MASS[i] * as; fy[i] = -MASS[i] * G; }
    // joints
    for (let i = 0; i < NP - 2; i++) {
      const region = i === 0 ? 'L' : i - 1 < NV ? SEG[Math.min(NV - 1, i - 1)][2] : 'C';
      const J = i === NP - 3 ? [9, 0.25] : JOINT[region];   // C1-head joint
      const rel = segAng(i + 1) - segAng(i) - angRest[i];
      let tau = -J[0] * rel;   // the damping is applied after the step (dampJoints)
      if (region === 'C' && Math.abs(rel) > 0.25) tau -= 60 * (rel - 0.25 * Math.sign(rel));   // ligaments: a stiffer range past each joint's free play
      couple(i + 1, tau); couple(i, -tau);
    }
    // seat cushion and the pelvis against the seatback's lower part
    if (y[PEL] < 0.06) { fy[PEL] += 8e4 * (0.06 - y[PEL]) - 1500 * Math.min(0, vy[PEL]); fx[PEL] -= 0.4 * 9.81 * 60 * Math.tanh(vx[PEL] / 0.05); }
    // seatback surface (rotated): n = forward normal
    const sa = SEAT.angle + sb, n = [Math.cos(sa), Math.sin(sa)], s0 = onBack(surf0);
    backF = 0;
    const press = (i, ox, oy) => {
      const bx = x[i] + ox, by = y[i] + oy;
      const pen = -((bx - s0[0]) * n[0] + (by - s0[1]) * n[1]);
      if (pen <= 0) return;
      const vn = -(vx[i] * n[0] + vy[i] * n[1]);
      let F = SEAT.kFoam * pen + (vn > 0 ? 60 * vn : 0);
      if (pen > SEAT.foam) F += 1e5 * (pen - SEAT.foam);
      F = Math.max(0, F);
      fx[i] += F * n[0]; fy[i] += F * n[1];
      // friction along the seatback (the torso can ride up)
      const tv = vx[i] * -n[1] + vy[i] * n[0];
      const Ff = 0.3 * F * Math.tanh(tv / 0.05);
      fx[i] -= Ff * -n[1]; fy[i] -= Ff * n[0];
      backF += F;
    };
    for (let i = 1; i <= T1; i++) {
      const d = segAng(Math.min(i, NP - 2)), off = [-Math.cos(d) * BACK, Math.sin(d) * BACK];
      press(i, off[0], off[1]);
    }
    press(PEL, -0.13, 0.06);
    // head restraint (moves with the seatback)
    const a = onBack(hrBot0), b = onBack(hrTop0);
    const ex = b[0] - a[0], ey = b[1] - a[1], L2 = ex * ex + ey * ey;
    const u = Math.max(0, Math.min(1, ((x[HEAD] - a[0]) * ex + (y[HEAD] - a[1]) * ey) / L2));
    const cx = a[0] + u * ex, cy = a[1] + u * ey, dx = x[HEAD] - cx, dy = y[HEAD] - cy, d = Math.hypot(dx, dy);
    hrF = 0;
    if (d < HEAD_R && d > 1e-9) {
      const pen = HEAD_R - d, nx = dx / d, ny = dy / d, vn = vx[HEAD] * nx + vy[HEAD] * ny;
      let F = 8e3 * pen + (vn < 0 ? -60 * vn : 0);
      if (pen > 0.05) F += 1.5e5 * (pen - 0.05);
      F = Math.max(0, F);
      fx[HEAD] += F * nx; fy[HEAD] += F * ny;
      hrF = F; hrX = cx; hrY = cy;
      if (tContact < 0 && F > 10) tContact = t;
    }
    // the load on the seatback turns it about the recliner
    return backF;
  }
  // Joint damping, applied exactly to each joint's relative rotation rate (w' = -c w / I_eff), so it
  // stays stable on the short, light vertebrae where an explicit damping force would not.
  function dampJoints() {
    for (let i = 0; i < NP - 2; i++) {
      const region = i === 0 ? 'L' : SEG[Math.min(NV - 1, i - 1)][2], c = i === NP - 3 ? 0.25 : JOINT[region][1];
      const d0x = x[i + 1] - x[i], d0y = y[i + 1] - y[i], d1x = x[i + 2] - x[i + 1], d1y = y[i + 2] - y[i + 1];
      const L0 = d0x * d0x + d0y * d0y, L1 = d1x * d1x + d1y * d1y;
      const p0x = d0y / L0, p0y = -d0x / L0, p1x = d1y / L1, p1y = -d1x / L1;   // d(omega)/d(v) of each segment's tip
      const w = segVel(i + 1) - segVel(i);
      const ga = [p0x, p0y], gb = [-p1x - p0x, -p1y - p0y], gc = [p1x, p1y];
      const k = (ga[0] * ga[0] + ga[1] * ga[1]) / MASS[i] + (gb[0] * gb[0] + gb[1] * gb[1]) / MASS[i + 1] + (gc[0] * gc[0] + gc[1] * gc[1]) / MASS[i + 2];
      const lam = -w * (1 - Math.exp(-c * k * dt)) / k;
      vx[i] += lam * ga[0] / MASS[i]; vy[i] += lam * ga[1] / MASS[i];
      vx[i + 1] += lam * gb[0] / MASS[i + 1]; vy[i + 1] += lam * gb[1] / MASS[i + 1];
      vx[i + 2] += lam * gc[0] / MASS[i + 2]; vy[i + 2] += lam * gc[1] / MASS[i + 2];
    }
  }
  function integrate(t, as) {
    const load = forces(t, as);
    for (let i = 0; i < NP; i++) {
      ovx[i] = vx[i];
      vx[i] += fx[i] / MASS[i] * dt; vy[i] += fy[i] / MASS[i] * dt;
      px[i] = x[i]; py[i] = y[i];
      x[i] += vx[i] * dt; y[i] += vy[i] * dt;
    }
    for (let it = 0; it < 6; it++) {
      for (let l = 0; l < NP - 1; l++) {
        const a = l, b = l + 1, dx = x[b] - x[a], dy = y[b] - y[a], d = Math.hypot(dx, dy);
        const wa = 1 / MASS[a], wb = 1 / MASS[b], s = (d - linkLen[l]) / (d * (wa + wb));
        x[a] += wa * s * dx; y[a] += wa * s * dy; x[b] -= wb * s * dx; y[b] -= wb * s * dy;
      }
    }
    for (let i = 0; i < NP; i++) { vx[i] = (x[i] - px[i]) / dt; vy[i] = (y[i] - py[i]) / dt; }
    dampJoints();
    // seatback rotation: moment of the occupant's load about the hinge (lever ~0.35 m), yielding
    const Mload = load * 0.35;
    let Mres = SEAT.kBack * sb + SEAT.cBack * sbv;
    if (Mres > SEAT.yieldM + 900 * sb) Mres = SEAT.yieldM + 900 * sb;   // recliner yields
    const I = 2.0;
    sbv += (Mload - Mres) / I * dt; sb = Math.max(-0.02, sb + sbv * dt);
  }
  // settle
  for (let k = 0; k < 3000; k++) { integrate(0, 0); for (let i = 0; i < NP; i++) { vx[i] *= 0.98; vy[i] *= 0.98; } sbv *= 0.9; }
  for (let i = 0; i < NP; i++) vx[i] = vy[i] = 0;
  sbv = 0;
  tContact = -1;
  const sb0 = sb, seated = { x: Float64Array.from(x), y: Float64Array.from(y) };
  const out = {
    dt, n: N, t0, dv, aPeak, sled: new Float64Array(N), sledV: new Float64Array(N), t1Ax: new Float64Array(N), headAx: new Float64Array(N),
    hrF: new Float64Array(N), backF: new Float64Array(N), neckFx: new Float64Array(N), neckFz: new Float64Array(N), neckAngle: new Float64Array(N),
    relV: new Float64Array(N), relA: new Float64Array(N), seatback: new Float64Array(N),
    poseEvery: 5, pose: null, poseStride: 2 * NP + 1, seated,
    geometry: { hrTop0, hrBot0, hinge: SEAT.hinge, angle: SEAT.angle, backOff: SEAT.backOff, surf0, headR: HEAD_R, NP, PEL, T1, C1, HEAD, backset: opts.backset, height: opts.height },
  };
  out.pose = new Float32Array(Math.ceil(N / out.poseEvery) * out.poseStride);
  let v = 0;
  const neck0 = Math.atan2(x[HEAD] - x[C1], y[HEAD] - y[C1]) - Math.atan2(x[T1 + 1] - x[T1], y[T1 + 1] - y[T1]);
  for (let k = 0; k < N; k++) {
    const t = k * dt, as = sled(t), ovy = vy[HEAD];
    integrate(t, as);
    v += as * dt;
    out.sled[k] = as; out.sledV[k] = v;
    // absolute forward accelerations: relative + sled
    out.t1Ax[k] = (vx[T1] - ovx[T1]) / dt + as;
    out.headAx[k] = (vx[HEAD] - ovx[HEAD]) / dt + as;
    out.hrF[k] = hrF; out.backF[k] = backF; out.seatback[k] = sb - sb0;
    // upper neck load from the head's equation of motion: the force the neck puts on the head
    // (m a minus the head restraint's push minus gravity), seat axes; shear + forward, tension + up
    const d = Math.hypot(x[HEAD] - hrX, y[HEAD] - hrY) || 1, hay = (vy[HEAD] - ovy) / dt;
    out.neckFx[k] = MASS[HEAD] * out.headAx[k] - (hrF > 0 ? hrF * (x[HEAD] - hrX) / d : 0);
    out.neckFz[k] = MASS[HEAD] * (hay + G) - (hrF > 0 ? hrF * (y[HEAD] - hrY) / d : 0);
    out.neckAngle[k] = (Math.atan2(x[HEAD] - x[C1], y[HEAD] - y[C1]) - Math.atan2(x[T1 + 1] - x[T1], y[T1 + 1] - y[T1])) - neck0;
    out.relV[k] = vx[T1] - vx[HEAD];      // T1 relative to the head (forward)
    if (k % out.poseEvery === 0) {
      const o = (k / out.poseEvery) * out.poseStride;
      for (let i = 0; i < NP; i++) { out.pose[o + 2 * i] = x[i]; out.pose[o + 2 * i + 1] = y[i]; }
      out.pose[o + 2 * NP] = sb - sb0;
    }
  }
  for (let k = 1; k < N - 1; k++) out.relA[k] = (out.relV[k + 1] - out.relV[k - 1]) / (2 * dt);
  out.tContact = tContact >= 0 ? tContact - t0 : -1;
  out.metrics = score(out);
  return out;
}

// CFC filter (SAE J211), as in occupant.js
function cfc(data, dt, cls) {
  const n = data.length;
  const wd = 2 * Math.PI * cls * 2.0775, wa = Math.tan(wd * dt / 2), den = 1 + Math.SQRT2 * wa + wa * wa;
  const a0 = wa * wa / den, a1 = 2 * a0, a2 = a0, b1 = -2 * (wa * wa - 1) / den, b2 = (-1 + Math.SQRT2 * wa - wa * wa) / den;
  const pass = (x) => { const y = new Float64Array(n); y[0] = x[0]; y[1] = x[1]; for (let i = 2; i < n; i++) y[i] = a0 * x[i] + a1 * x[i - 1] + a2 * x[i - 2] + b1 * y[i - 1] + b2 * y[i - 2]; return y; };
  const f = pass(data), r = pass(Float64Array.from(f).reverse());
  return r.reverse();
}

function score(o) {
  const dt = o.dt, t1 = cfc(o.t1Ax, dt, 60), head = cfc(o.headAx, dt, 60), sled = cfc(o.sled, dt, 60);
  let t1Max = 0, hrMax = 0, nic = 0, nicT = 0, angMax = 0, shear = 0, tension = 0;
  const fx = cfc(o.neckFx, dt, 600), fz = cfc(o.neckFz, dt, 600);
  // NIC = 0.2 a_rel + v_rel^2 (T1 relative to the head), up to head restraint contact or 150 ms
  const iEnd = Math.round(((o.tContact >= 0 ? o.tContact : 0.15) + o.t0) / dt);
  for (let k = 0; k < o.n; k++) {
    t1Max = Math.max(t1Max, t1[k] / G); hrMax = Math.max(hrMax, o.hrF[k]);
    if (k <= iEnd) { const v = o.relV[k], ni = 0.2 * o.relA[k] + v * Math.abs(v); if (ni > nic) { nic = ni; nicT = k * dt; } }
    angMax = Math.max(angMax, -o.neckAngle[k]);
    shear = Math.max(shear, Math.abs(fx[k])); tension = Math.max(tension, fz[k]);
  }
  return {
    contactMs: o.tContact >= 0 ? o.tContact * 1000 : -1, t1PeakG: t1Max, nic, nicT, neckExtensionDeg: angMax * 180 / Math.PI,
    headRestraintForce: hrMax, neckShear: shear, neckTension: tension,
    series: { t1: Float64Array.from(t1, v => v / G), head: Float64Array.from(head, v => v / G), sled: Float64Array.from(sled, v => v / G) },
  };
}

const api = { G, LIMITS, PULSE_T, SEAT, HEAD_R, NP, PARTS: { PEL, T1, C1, HEAD, NV }, restPose, simulate };
root.CrashWhiplash = api;
if (typeof module === 'object' && module.exports) module.exports = api;
})(typeof window !== 'undefined' ? window : globalThis);
