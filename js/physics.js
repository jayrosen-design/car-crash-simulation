/* Crash physics core. No dependencies: runs in the browser (classic script, global CrashPhysics)
 * and in Node (tools/headless-check.js).
 *
 * Vehicle: an XPBD lattice of point masses joined by distance constraints. Stiffness is physical
 *   (compliance = 1/k). A constraint strained past its yield strain flows plastically: its rest
 *   length moves, and the elastic energy that removes is booked as deformation work.
 * Barrier: a rigid half-space, or a brick wall whose bricks are rigid bodies joined by breakable
 *   mortar bonds (the connection graph). Bricks stay dormant until touched or loaded, and go back
 *   to sleep once they stop moving.
 * The impact runs at 0.1 ms steps (0.5 ms once the crash pulse is over) and is recorded for
 *   slow-motion playback. It is not meant to run in real time.
 * Destruction (imported cars): panels, mirrors and wheels ride on the lattice until the springs
 *   they are mounted on have yielded far enough (or, for a wheel, until it is shoved back); then
 *   they come off as rigid debris bodies that keep their crushed shape. Tyres burst when the rim
 *   meets an obstacle. Glass and lamps break in finalize(), from the recorded frames.
 */
(function (root) {
'use strict';

const G = 9.81;
const DT_FINE = 1e-4;        // s, while the crash pulse runs
const DT_COARSE = 5e-4;      // s, rebound and debris (1 ms gains energy with stiff bonded bricks)
const FINE_WINDOW = 0.30;    // s after first contact

// ------------------------------------------------------------------ vehicle
// Vehicle specs live in vehicles.js; CAR is the original procedural car (the baseline).
const VEHICLES = root.CrashVehicles || (typeof require === 'function' ? require('./vehicles.js') : null);
const CAR = VEHICLES.LAB;
const PROFILE = CAR.profile;

// Top-surface height (m) along the car; u = distance from the rear bumper.
function topHeight(u, spec) {
  const prof = (spec || CAR).profile;
  if (u <= prof[0][0]) return prof[0][1];
  for (let i = 1; i < prof.length; i++) {
    const u1 = prof[i][0];
    if (u <= u1) {
      const u0 = prof[i - 1][0], h0 = prof[i - 1][1], h1 = prof[i][1];
      const s = (u - u0) / (u1 - u0);
      return h0 + (h1 - h0) * s * s * (3 - 2 * s);
    }
  }
  return prof[prof.length - 1][1];
}

// Lattice column positions (car-local x): uniform for the lab car, axle-aligned for the others.
function columns(spec) {
  if (spec.colX) return spec.colX;
  const sx = 2 * spec.latHalfL / (spec.nx - 1), xs = [];
  for (let i = 0; i < spec.nx; i++) xs.push(-spec.latHalfL + i * sx);
  return xs;
}

const STIFFNESS = { soft: 0.6, standard: 1.0, stiff: 1.7 }; // front-structure scale
const K0 = 1.1e6;             // base spring stiffness (N/m)
const EY = 0.0115;            // base yield strain (low, so little elastic springback)
const ZETA = 0.08;            // structural damping ratio per constraint
const MIN_RATIO = 0.25, MAX_RATIO = 1.8; // plastic rest-length limits (crush bottoming)

const MU_TIRE = 0.8, MU_ROLL = 0.015, MU_BODY = 0.5, MU_WALL = 0.3, MU_BRICK = 0.5, MU_GROUND = 0.6;
const MU_CAR = 0.4;     // sheet metal on sheet metal (vehicle against vehicle)
const MU_SLED = 0.03;   // tyres on the low-friction carrier of a pole test, sideways

// Destruction. A part comes off when the mean plastic strain of the lattice springs it is mounted
// on passes its limit; Dramatic multiplies every limit (and the glass limits) by DAMAGE.dramatic.
// Realistic limits are set so that a 56 km/h full-width rigid-barrier test keeps its panels and
// wheels (as real cars do), the bumper, fenders and front wheels come off around 100 km/h and the
// hood by 150 km/h; doors stay on in frontal impacts.
const DAMAGE = { realistic: 1, dramatic: 0.3 };
const PART_RULES = [   // [name prefix, mass (kg), detach strain]
  ['DEFORM_BumperF', 9, 0.165], ['DEFORM_BumperR', 7, 0.15], ['DEFORM_Hood', 15, 0.25], ['DEFORM_Fender', 4, 0.18],
  ['DEFORM_DoorF', 24, 0.06], ['DEFORM_DoorR', 20, 0.06], ['DEFORM_Trunk', 14, 0.15], ['BREAKAWAY_Mirror', 1.5, 0.05],
];
const WHEEL_DETACH_STRAIN = 0.30;  // mean plastic strain of the springs at the wheel mount
const WHEEL_PUSH_DETACH = 0.45;    // m the hub is shoved back relative to the cabin
const WHEEL_PUSH_BURST = 0.20;
const TYRE_FLAT = 0.25;            // a burst tyre keeps this share of its sidewall height
// Glass and lamps: mean plastic strain of the structure around the pane (from the recorded strain)
const GLASS = { tempered: 0.06, roof: 0.12, laminated: 0.025, light: 0.10 };
const INACTIVE = 3;                // a debris body that has not come off yet

// Side structure (side-impact lab only): steel of the door ring (doors, B-pillar, sill and roof rail
// springs in the outer two node layers of the cabin) as [stiffness, yield strain] factors, and how
// much of the cabin interior is left between the floor and the roof. Without it the interior is
// solid lattice (a stiff average of floor, seats and cross-members), which is right for frontal
// loading but would stop a door from ever intruding.
const SIDE_STEEL = { mild: [0.6, 0.6], uhss: [1.4, 1.8] };
const HOLLOW_K = 0.12;
// Front corners of the cabin (overlap lab only): the toe pan and hinge pillar behind each front
// wheel, in the outer three node layers and the last `depth` metres before the firewall, are
// sheet-metal structure rather than safety-cell core, so a wheel driven back can push them in.
const FOOTWELL = { depth: 0.55, k: 1.1, ey: 1.0 };

function buildCar(massKg, stiffKey, spec, structure) {
  const C = spec || CAR;
  const nx = C.nx, ny = C.ny, nz = C.nz, xMin = C.xMin;
  const colX = columns(C);
  const sx = 2 * C.latHalfL / (nx - 1), sy = (C.yTop - C.yBottom) / (ny - 1), sz = 2 * C.latHalfW / (nz - 1);
  const grid = new Int32Array(nx * ny * nz).fill(-1);
  const pos = [], ghostL = [], ijkL = [];
  for (let i = 0; i < nx; i++) for (let j = 0; j < ny; j++) for (let k = 0; k < nz; k++) {
    const x = colX[i], y = C.yBottom + j * sy, z = -C.latHalfW + k * sz;
    const h = topHeight(x - xMin, C) + 0.06;
    if (y - sy > h) continue;                 // more than one row above the body
    grid[(i * ny + j) * nz + k] = pos.length / 3;
    // Nodes one row above the surface are light "ghost" nodes: they only carry the render mesh.
    pos.push(x, y, z); ghostL.push(y > h ? 1 : 0); ijkL.push(i, j, k);
  }
  const n = pos.length / 3;
  const rest = Float64Array.from(pos), ghost = Uint8Array.from(ghostL), ijk = Int32Array.from(ijkL);
  const engine = new Uint8Array(n), wheel = new Uint8Array(n);
  const E = C.engine;
  let nStruct = 0, nEngine = 0, nWheel = 0;
  for (let a = 0; a < n; a++) {
    if (ghost[a]) continue;
    nStruct++;
    const u = rest[3 * a] - xMin, y = rest[3 * a + 1], z = rest[3 * a + 2];
    if (u > E.u0 && u < E.u1 && y < E.yMax && Math.abs(z) < E.zHalf) { engine[a] = 1; nEngine++; }
    const i = ijk[3 * a], j = ijk[3 * a + 1], k = ijk[3 * a + 2];
    if (j === 0 && (i === C.wheelI[0] || i === C.wheelI[1]) && (k <= 1 || k >= nz - 2)) { wheel[a] = 1; nWheel++; }
  }
  const ghostMass = 0.25, engineMass = C.noEngine ? 0 : 0.12 * massKg, wheelMass = 4 * C.wheelCornerMass;
  const base = wheelMass > 0
    ? (massKg - engineMass - wheelMass - (n - nStruct) * ghostMass) / nStruct
    : (massKg - engineMass - (n - nStruct) * ghostMass) / nStruct;
  const mass = new Float64Array(n);
  for (let a = 0; a < n; a++) {
    mass[a] = ghost[a] ? ghostMass : base + (engine[a] ? engineMass / nEngine : 0);
    if (wheel[a] && wheelMass > 0) mass[a] += wheelMass / nWheel;
  }

  const OFF = [[1, 0, 0], [0, 1, 0], [0, 0, 1], [1, 1, 0], [1, -1, 0], [1, 0, 1], [1, 0, -1],
    [0, 1, 1], [0, 1, -1], [1, 1, 1], [1, 1, -1], [1, -1, 1], [1, -1, -1]];
  const s = STIFFNESS[stiffKey] || 1;
  const K = C.kScale === 1 ? K0 : K0 * C.kScale;
  const ca = [], cb = [], c0 = [], ck = [], cey = [];
  for (let a = 0; a < n; a++) {
    const i = ijk[3 * a], j = ijk[3 * a + 1], k = ijk[3 * a + 2];
    for (const o of OFF) {
      const i2 = i + o[0], j2 = j + o[1], k2 = k + o[2];
      if (i2 < 0 || i2 >= nx || j2 < 0 || j2 >= ny || k2 < 0 || k2 >= nz) continue;
      const b = grid[(i2 * ny + j2) * nz + k2];
      if (b < 0) continue;
      const dx = rest[3 * b] - rest[3 * a], dy = rest[3 * b + 1] - rest[3 * a + 1], dz = rest[3 * b + 2] - rest[3 * a + 2];
      const u = 0.5 * (rest[3 * a] + rest[3 * b]) - xMin;
      let kf, ey;
      if (ghost[a] || ghost[b]) { kf = 0.15; ey = EY; }
      else if (u >= C.firewallU) { kf = s; ey = EY; if (engine[a] && engine[b]) { kf *= 2.5; ey *= 2.5; } }
      else if (u >= C.rearU) { kf = 2.5; ey = 2.4 * EY; }   // passenger safety cell
      else { kf = 1.5; ey = 1.2 * EY; }
      if (C.zoneK && !(ghost[a] || ghost[b])) {   // per-zone [stiffness, yield] factors of a non-car spec
        const z = u >= C.firewallU ? C.zoneK.front : u >= C.rearU ? C.zoneK.cell : C.zoneK.rear;
        kf = z[0]; ey = z[1] * EY;
      }
      if (structure && structure.footwell && !(ghost[a] || ghost[b]) && u >= C.firewallU - FOOTWELL.depth && u < C.firewallU) {
        const k2 = ijk[3 * b + 2], j2 = ijk[3 * b + 1], outer = (q) => q <= 2 || q >= nz - 3;
        if (outer(k) && outer(k2) && j < C.cabin.topJ && j2 < C.cabin.topJ) { kf = FOOTWELL.k; ey = FOOTWELL.ey * EY; }
      }
      if (structure && structure.steel && !(ghost[a] || ghost[b]) && u >= C.cabin.u0 && u <= C.cabin.u1) {
        const j2 = ijk[3 * b + 1], k2 = ijk[3 * b + 2], outer = (q) => q <= 1 || q >= nz - 2;
        if (outer(k) && outer(k2) && j >= 1 && j2 >= 1) { const st = SIDE_STEEL[structure.steel] || SIDE_STEEL.mild; kf = st[0]; ey = st[1] * EY; }
        else if (o[2] !== 0 && j >= 1 && j2 >= 1 && j < C.cabin.topJ && j2 < C.cabin.topJ) { kf = HOLLOW_K; ey = EY; }
      }
      ca.push(a); cb.push(b); c0.push(Math.sqrt(dx * dx + dy * dy + dz * dz)); ck.push(K * kf); cey.push(ey);
    }
  }

  const g = { cabin: [], cabFront: [], cabRear: [], cabTop: [], cabBot: [], front: [], dash: [], seat: [] };
  const Z = C.cabin, D = C.dash, St = C.seat;
  for (let a = 0; a < n; a++) {
    if (ghost[a]) continue;
    const u = rest[3 * a] - xMin, y = rest[3 * a + 1], i = ijk[3 * a], j = ijk[3 * a + 1];
    if (u >= Z.u0 && u <= Z.u1) {
      g.cabin.push(a);
      if (u > Z.frontU) g.cabFront.push(a);
      if (u < Z.rearU) g.cabRear.push(a);
      if (j >= Z.topJ) g.cabTop.push(a);
      if (j === 0) g.cabBot.push(a);
    }
    if (i === nx - 1) g.front.push(a);
    if (u >= D.u0 && u <= D.u1 && y < D.yMax) g.dash.push(a);
    if (u >= St.u0 && u <= St.u1 && y < St.yMax) g.seat.push(a);
  }
  const groups = {};
  for (const key in g) groups[key] = Int32Array.from(g[key]);

  // Mass-weighted rest centroid of the cabin: origin of the cabin frame.
  let m = 0; const c = [0, 0, 0];
  for (const a of groups.cabin) { m += mass[a]; for (let d = 0; d < 3; d++) c[d] += mass[a] * rest[3 * a + d]; }
  for (let d = 0; d < 3; d++) c[d] /= m;
  const meanX = (arr) => { let sum = 0; for (const a of arr) sum += rest[3 * a]; return sum / arr.length; };

  return {
    n, rest, ghost, mass, wheel, engine, ijk, grid, sx, sy, sz, colX, massKg, spec: C,
    cons: { n: ca.length, a: Int32Array.from(ca), b: Int32Array.from(cb), len0: Float64Array.from(c0), k: Float64Array.from(ck), ey: Float64Array.from(cey) },
    groups,
    cabinRest: c,
    frontRestDist: meanX(groups.front) - c[0],
    dashSeatRestDist: meanX(groups.dash) - meanX(groups.seat),
  };
}

// Axle positions (car-local x) implied by the lattice columns that carry the wheels.
function axles(spec) {
  const C = spec || CAR, xs = columns(C);
  const rearX = xs[C.wheelI[0]], frontX = xs[C.wheelI[1]];
  return { rearX, frontX, wheelbase: frontX - rearX };
}

// Trilinear cell of a car-local point in the lattice: 8 corner nodes (c: bit 0 = x, bit 1 = y,
// bit 2 = z) and the local coordinates t. Points outside the lattice use the nearest complete cell
// (so they extrapolate). Also used by the renderer to skin the body.
function embedPoint(car, x, y, z, outIdx, o, outT, ot, outSize) {
  const C = car.spec, nx = C.nx, ny = C.ny, nz = C.nz, colX = car.colX;
  let i = 0;
  while (i < nx - 2 && x >= colX[i + 1]) i++;
  const sxc = colX[i + 1] - colX[i];
  const fi = i + (x - colX[i]) / sxc;
  const fj = (y - C.yBottom) / car.sy, fk = (z + C.latHalfW) / car.sz;
  const k = Math.max(0, Math.min(nz - 2, Math.floor(fk)));
  let j = Math.max(0, Math.min(ny - 2, Math.floor(fj)));
  const node = (a, b, c) => car.grid[(a * ny + b) * nz + c];
  for (; j >= 0; j--) {
    let ok = true;
    for (let c = 0; c < 8 && ok; c++) if (node(i + (c & 1), j + ((c >> 1) & 1), k + ((c >> 2) & 1)) < 0) ok = false;
    if (ok) break;
  }
  if (j < 0) j = 0;
  for (let c = 0; c < 8; c++) outIdx[o + c] = Math.max(0, node(i + (c & 1), j + ((c >> 1) & 1), k + ((c >> 2) & 1)));
  outT[ot] = fi - i; outT[ot + 1] = fj - j; outT[ot + 2] = fk - k;
  if (outSize) { outSize[0] = sxc; outSize[1] = car.sy; outSize[2] = car.sz; }
}
function cornerWeight(t, ot, c) {
  return ((c & 1) ? t[ot] : 1 - t[ot]) * ((c & 2) ? t[ot + 1] : 1 - t[ot + 1]) * ((c & 4) ? t[ot + 2] : 1 - t[ot + 2]);
}
// World position of an embedded point from node positions X.
function embeddedPos(X, idx, o, t, ot, out) {
  out[0] = out[1] = out[2] = 0;
  for (let c = 0; c < 8; c++) {
    const w = cornerWeight(t, ot, c), a = 3 * idx[o + c];
    out[0] += w * X[a]; out[1] += w * X[a + 1]; out[2] += w * X[a + 2];
  }
  return out;
}
function embedPoints(car, pts) {
  const m = pts.length, idx = new Int32Array(8 * m), t = new Float64Array(3 * m);
  for (let p = 0; p < m; p++) embedPoint(car, pts[p][0], pts[p][1], pts[p][2], idx, 8 * p, t, 3 * p, null);
  return { m, idx, t };
}

// Symmetric 3x3 eigen-decomposition (Jacobi): returns eigenvalues and a right-handed rotation whose
// columns are the eigenvectors. A = [a00, a01, a02, a11, a12, a22].
function eigSym3(A) {
  const a = [[A[0], A[1], A[2]], [A[1], A[3], A[4]], [A[2], A[4], A[5]]];
  const v = [[1, 0, 0], [0, 1, 0], [0, 0, 1]];
  for (let sweep = 0; sweep < 12; sweep++) {
    for (const [p, q] of [[0, 1], [0, 2], [1, 2]]) {
      if (Math.abs(a[p][q]) < 1e-14) continue;
      const th = 0.5 * Math.atan2(2 * a[p][q], a[q][q] - a[p][p]), c = Math.cos(th), s = Math.sin(th);
      for (let k = 0; k < 3; k++) { const akp = a[k][p], akq = a[k][q]; a[k][p] = c * akp - s * akq; a[k][q] = s * akp + c * akq; }
      for (let k = 0; k < 3; k++) { const apk = a[p][k], aqk = a[q][k]; a[p][k] = c * apk - s * aqk; a[q][k] = s * apk + c * aqk; }
      for (let k = 0; k < 3; k++) { const vkp = v[k][p], vkq = v[k][q]; v[k][p] = c * vkp - s * vkq; v[k][q] = s * vkp + c * vkq; }
    }
  }
  // right-handed
  const det = v[0][0] * (v[1][1] * v[2][2] - v[1][2] * v[2][1]) - v[0][1] * (v[1][0] * v[2][2] - v[1][2] * v[2][0]) + v[0][2] * (v[1][0] * v[2][1] - v[1][1] * v[2][0]);
  if (det < 0) for (let k = 0; k < 3; k++) v[k][2] = -v[k][2];
  return { val: [a[0][0], a[1][1], a[2][2]], vec: v };
}
// Quaternion [x, y, z, w] of a rotation matrix given as rows m[r][c].
function quatFromMatrix(m) {
  const tr = m[0][0] + m[1][1] + m[2][2];
  let x, y, z, w;
  if (tr > 0) { const S = Math.sqrt(tr + 1) * 2; w = 0.25 * S; x = (m[2][1] - m[1][2]) / S; y = (m[0][2] - m[2][0]) / S; z = (m[1][0] - m[0][1]) / S; }
  else if (m[0][0] > m[1][1] && m[0][0] > m[2][2]) { const S = Math.sqrt(1 + m[0][0] - m[1][1] - m[2][2]) * 2; w = (m[2][1] - m[1][2]) / S; x = 0.25 * S; y = (m[0][1] + m[1][0]) / S; z = (m[0][2] + m[2][0]) / S; }
  else if (m[1][1] > m[2][2]) { const S = Math.sqrt(1 + m[1][1] - m[0][0] - m[2][2]) * 2; w = (m[0][2] - m[2][0]) / S; x = (m[0][1] + m[1][0]) / S; y = 0.25 * S; z = (m[1][2] + m[2][1]) / S; }
  else { const S = Math.sqrt(1 + m[2][2] - m[0][0] - m[1][1]) * 2; w = (m[1][0] - m[0][1]) / S; x = (m[0][2] + m[2][0]) / S; y = (m[1][2] + m[2][1]) / S; z = 0.25 * S; }
  const l = Math.hypot(x, y, z, w);
  return [x / l, y / l, z / l, w / l];
}

// ------------------------------------------------------------------ brick wall
const WALL = { halfWidth: 6, rows: 12, brickL: 0.4, brickH: 0.2, thick: 0.25, density: 2000 };
const WALL_STRENGTH = { weak: 8e3, standard: 3e4, strong: 1.2e5 }; // mortar joint break force (N)
const BOND_COMPLIANCE = 2e-8;   // 1 / (5e7 N/m)
const BOND_FRICTION = 0.6;      // mortar shear capacity grows with compression (Coulomb)
const BRICK_SPHERE_R = 0.095;   // brick-brick contact spheres (2 per brick)
const WAKE_FORCE = 2000;        // N; contact force that wakes a resting brick
const MAX_SEPARATION = 1.0;     // m/s; a contact correction never makes a contact separate faster
// Vehicle against vehicle the crushed fronts interlock, and pushing a node out of one sphere pushes
// it into the next: those contacts only cancel the approach (plus a small allowance for drift).
const NODE_SEPARATION = 0.02;
const DORMANT = 0, AWAKE = 1, SLEEPING = 2;
const RIGID_BARRIER = { halfWidth: 9, height: 3, depth: 3 };

function buildWall(strengthKey) {
  const HW = WALL.halfWidth, BL = WALL.brickL, hx = WALL.thick / 2, hy = WALL.brickH / 2;
  const B = [];   // [x, y, z, hx, hy, hz, row]
  const rows = [];
  for (let r = 0; r < WALL.rows; r++) {
    const y = hy + r * WALL.brickH, start = B.length;
    if (r % 2 === 0) {
      for (let k = 0; k < Math.round(2 * HW / BL); k++) B.push([hx, y, -HW + BL / 2 + k * BL, hx, hy, BL / 2, r]);
    } else {
      B.push([hx, y, -HW + BL / 4, hx, hy, BL / 4, r]);
      for (let k = 0; k < Math.round(2 * HW / BL) - 1; k++) B.push([hx, y, -HW + BL + k * BL, hx, hy, BL / 2, r]);
      B.push([hx, y, HW - BL / 4, hx, hy, BL / 4, r]);
    }
    rows.push([start, B.length]);
  }
  const nb = B.length;
  const center = new Float64Array(3 * nb), half = new Float64Array(3 * nb), mass = new Float64Array(nb), invI = new Float64Array(3 * nb), row = new Int32Array(nb);
  for (let b = 0; b < nb; b++) {
    const e = B[b];
    center.set([e[0], e[1], e[2]], 3 * b); half.set([e[3], e[4], e[5]], 3 * b); row[b] = e[6];
    const Dx = 2 * e[3], Dy = 2 * e[4], Dz = 2 * e[5];
    const m = WALL.density * Dx * Dy * Dz;
    mass[b] = m;
    invI[3 * b] = 12 / (m * (Dy * Dy + Dz * Dz));
    invI[3 * b + 1] = 12 / (m * (Dx * Dx + Dz * Dz));
    invI[3 * b + 2] = 12 / (m * (Dx * Dx + Dy * Dy));
  }
  const S = WALL_STRENGTH[strengthKey] || WALL_STRENGTH.standard;
  // [a, b, px, py, pz, strength, joint normal from a toward b]; b = -1 means a fixed anchor.
  // Each mortar joint is two bond points, at the front and back of the wall, so joints carry
  // bending (single points would act as ball joints and the wall would topple).
  const bonds = [];
  const XS = [hx - 0.08, hx + 0.08];
  const joint = (a, b, py, pz, s, nrm) => { for (const px of XS) bonds.push([a, b, px, py, pz, s / 2, nrm]); };
  for (const [s0, s1] of rows) {
    for (let a = s0; a + 1 < s1; a++) joint(a, a + 1, B[a][1], B[a][2] + B[a][5], S, [0, 0, 1]);
  }
  for (let r = 0; r + 1 < rows.length; r++) {
    const [a0, a1] = rows[r], [b0, b1] = rows[r + 1];
    for (let a = a0; a < a1; a++) for (let b = b0; b < b1; b++) {
      const lo = Math.max(B[a][2] - B[a][5], B[b][2] - B[b][5]), hi = Math.min(B[a][2] + B[a][5], B[b][2] + B[b][5]);
      if (hi - lo > 0.01) joint(a, b, B[a][1] + hy, 0.5 * (lo + hi), S, [0, 1, 0]);
    }
  }
  // Anchors: footing under row 0, pillars at both ends.
  for (let a = rows[0][0]; a < rows[0][1]; a++) {
    joint(a, -1, 0, B[a][2] - B[a][5] / 2, 1.5 * S, [0, -1, 0]);
    joint(a, -1, 0, B[a][2] + B[a][5] / 2, 1.5 * S, [0, -1, 0]);
  }
  for (const [s0, s1] of rows) {
    joint(s0, -1, B[s0][1], -HW, 1.5 * S, [0, 0, -1]);
    joint(s1 - 1, -1, B[s1 - 1][1], HW, 1.5 * S, [0, 0, 1]);
  }
  const nbo = bonds.length;
  const bond = { n: nbo, a: new Int32Array(nbo), b: new Int32Array(nbo), ra: new Float64Array(3 * nbo), rb: new Float64Array(3 * nbo), fixed: new Float64Array(3 * nbo), strength: new Float64Array(nbo), normal: new Float64Array(3 * nbo) };
  bonds.forEach((e, k) => {
    const a = e[0], b = e[1];
    bond.a[k] = a; bond.b[k] = b; bond.strength[k] = e[5];
    bond.normal.set(e[6], 3 * k);
    for (let d = 0; d < 3; d++) {
      bond.ra[3 * k + d] = e[2 + d] - center[3 * a + d];
      if (b >= 0) bond.rb[3 * k + d] = e[2 + d] - center[3 * b + d];
      else bond.fixed[3 * k + d] = e[2 + d];
    }
  });
  return { nb, center, half, mass, invI, row, bond, strength: S };
}

// ------------------------------------------------------------------ static obstacles
// Offset barrier (the overlap lab): a rigid block covering part of the car's width, with an
// optional rounded inner edge and an optional crushable aluminium honeycomb face. Pole (the
// side-impact lab): a fixed vertical cylinder. Both are described in world coordinates.
const HONEYCOMB = {
  cell: 0.05,                            // m, crush grid on the face (y, z)
  main: { y0: 0.20, y1: 0.85, depth: 0.45, stress: 0.342e6 },     // Pa
  bumper: { y0: 0.28, y1: 0.61, depth: 0.09, stress: 1.711e6 },   // the stiffer strip in front
  solid: 0.06,                           // m left when a column is fully crushed (it bottoms out)
};
const POLE_RADIUS = 0.127;               // 254 mm pole

/* off: { zEdge, side (-1: the barrier lies at z < zEdge), width, height, edgeRadius, honeycomb } */
function buildOffset(off) {
  const o = Object.assign({ width: 1.0, height: 1.5, edgeRadius: 0, honeycomb: false, side: -1 }, off);
  if (!o.honeycomb) return o;
  const H = HONEYCOMB, h = H.cell, nzc = Math.round(o.width / h), nyc = Math.round((H.main.y1 - H.main.y0) / h);
  const depth = new Float32Array(nzc * nyc), crush = new Float32Array(nzc * nyc);
  for (let iy = 0; iy < nyc; iy++) {
    const y = H.main.y0 + (iy + 0.5) * h, bumper = y > H.bumper.y0 && y < H.bumper.y1;
    for (let iz = 0; iz < nzc; iz++) depth[iy * nzc + iz] = H.main.depth + (bumper ? H.bumper.depth : 0);
  }
  // cell (iz, iy): z from the barrier's inner edge outward, y from the bottom of the main block
  o.hc = { h, nzc, nyc, depth, crush, claim: new Int32Array(nzc * nyc), y0: H.main.y0 };
  return o;
}

/* World obstacles (the Race game): w = { boxes: [{ x, z, hx, hz, angle, height }], cyls: [{ x, z, r,
 * height }] } in world coordinates. A box's half-lengths hx and hz lie along its own axes, turned by
 * angle from +x toward +z (as a vehicle's heading). Upright shapes: horizontal normals, ground at y = 0.
 * Options for a box (the Destruction mode's buses and tankers): vx, vz (m/s) move it at a steady
 * speed from where it is at the start; top: true gives it a roof to land on. */
function buildWorld(w) {
  const shapes = [];
  let moving = false;
  for (const b of (w && w.boxes) || []) {
    const c = Math.cos(b.angle || 0), s = Math.sin(b.angle || 0);
    const ex = Math.abs(c) * b.hx + Math.abs(s) * b.hz, ez = Math.abs(s) * b.hx + Math.abs(c) * b.hz;
    const sh = { box: true, x: b.x, z: b.z, hx: b.hx, hz: b.hz, c, s, height: b.height || 3, x0: b.x - ex, x1: b.x + ex, z0: b.z - ez, z1: b.z + ez };
    if (b.vx || b.vz) { Object.assign(sh, { vx: b.vx || 0, vz: b.vz || 0, bx: b.x, bz: b.z, ex, ez }); moving = true; }
    if (b.top) sh.top = true;
    shapes.push(sh);
  }
  for (const q of (w && w.cyls) || []) shapes.push({ box: false, x: q.x, z: q.z, r: q.r, height: q.height || 3, x0: q.x - q.r, x1: q.x + q.r, z0: q.z - q.r, z1: q.z + q.r });
  shapes.forEach((s, i) => { s.i = i; });
  return { shapes, active: shapes.slice(), moving };
}
// the moving boxes where they are at time t
function placeWorld(world, t) {
  for (const s of world.shapes) if (s.vx !== undefined) {
    s.x = s.bx + s.vx * t; s.z = s.bz + s.vz * t;
    s.x0 = s.x - s.ex; s.x1 = s.x + s.ex; s.z0 = s.z - s.ez; s.z1 = s.z + s.ez;
  }
}
// Signed distance to the nearest shape of `list` (negative inside), its outward normal in G3. The
// nearest shape is left in worldHit (for a moving box's friction).
let worldHit = null;
function worldSDF(x, y, z, G3, list) {
  let best = Infinity;
  G3[0] = -1; G3[1] = 0; G3[2] = 0;
  for (let i = 0; i < list.length; i++) {
    const s = list[i];
    if (y > s.height && !(s.top && y < s.height + 0.5)) continue;
    let d, nx, nz, ny = 0;
    if (s.box) {
      const dx = x - s.x, dz = z - s.z, u = dx * s.c + dz * s.s, w = -dx * s.s + dz * s.c;
      const qu = Math.abs(u) - s.hx, qw = Math.abs(w) - s.hz, su = u < 0 ? -1 : 1, sw = w < 0 ? -1 : 1;
      let nu, nw;
      if (qu > 0 || qw > 0) { const ou = Math.max(qu, 0), ow = Math.max(qw, 0), l = Math.hypot(ou, ow) || 1e-9; d = l; nu = su * ou / l; nw = sw * ow / l; }
      else if (qu > qw) { d = qu; nu = su; nw = 0; }
      else { d = qw; nu = 0; nw = sw; }
      nx = nu * s.c - nw * s.s; nz = nu * s.s + nw * s.c;
      if (s.top) {
        // the roof: above it, the distance to the box (its top face, or its top edge); inside,
        // pushed up when the top is the nearest face
        const up = y - s.height;
        if (up > 0) { if (d > 0) { const l = Math.hypot(d, up); nx *= d / l; nz *= d / l; ny = up / l; d = l; } else { d = up; nx = 0; nz = 0; ny = 1; } }
        else if (d < 0 && -up < -d) { d = up; nx = 0; nz = 0; ny = 1; }
      }
    } else {
      const dx = x - s.x, dz = z - s.z, l = Math.hypot(dx, dz) || 1e-9;
      d = l - s.r; nx = dx / l; nz = dz / l;
    }
    if (d < best) { best = d; G3[0] = nx; G3[2] = nz; if (s.top) G3[1] = ny; else if (G3[1]) G3[1] = 0; worldHit = s; }
  }
  return best;
}

// Points of the structure where intrusion is measured (car-local), placed from the driver's
// H-point (left seat) and the body side: the steering column at the wheel hub, the brake pedal,
// the left toe pan, the instrument panel, the lower hinge pillar, the B-pillar at three heights
// and the driver's door at pelvis, chest and head (window) height.
function measurePoints(spec) {
  const H = spec.hPoint, zs = -spec.latHalfW, xb = H[0] - 0.25;
  return [
    ['column', [H[0] + 0.40, H[1] + 0.42, H[2]]],
    ['pedal', [H[0] + 0.95, H[1] - 0.15, H[2] + 0.10]],
    ['footwell', [H[0] + 1.12, H[1] - 0.25, H[2] - 0.12]],
    ['dash', [H[0] + 0.80, H[1] + 0.32, H[2]]],
    ['hinge', [H[0] + 1.05, H[1] + 0.05, zs]],
    ['bpillarLow', [xb, H[1] + 0.05, zs]], ['bpillarMid', [xb, H[1] + 0.35, zs]], ['bpillarHigh', [xb, H[1] + 0.62, zs]],
    ['doorPelvis', [H[0], H[1] + 0.05, zs]], ['doorThorax', [H[0] + 0.05, H[1] + 0.33, zs]], ['doorHead', [H[0] + 0.05, H[1] + 0.62, zs]],
  ];
}

// ------------------------------------------------------------------ impact simulation
/* cfg: { vehicle (a CrashVehicles spec; default the lab car), massKg, stiffness,
 *        barrier: 'rigid'|'brick'|'offset'|'pole'|'world'|'none', wallStrength, damage: 'realistic'|'dramatic',
 *        pose: { x, z, heading }, speed (m/s), yawRate (rad/s) }
 * Several vehicles (the multi-vehicle and side-impact labs): cfg.vehicles = [{ vehicle, massKg,
 *   stiffness, damage, pose, speed, yawRate, velocity: [vx, vz] (instead of speed along the
 *   heading), structure: { steel } (side structure, see buildCar), lift, vy, pitch, roll (a car
 *   that starts in the air: height of its ground point, vertical speed, nose-up and roll angles) }];
 *   they collide with each other.
 * offset: see buildOffset; pole: { x, z }; world: see buildWorld (the Race game's street furniture
 *   and buildings, CPU only); sled: true puts the cars on a low-friction carrier
 *   (they slide sideways into the pole); measure: true records intrusion at fixed points;
 *   duration: seconds after first contact; structure: { footwell } for a single vehicle (see
 *   buildCar).
 * Test hooks (tools/headless-check.js): wakeAll, dtScale, minDuration, checkSpawns. */
function createImpactSim(cfg) {
  const units = (cfg.vehicles || [{ vehicle: cfg.vehicle, massKg: cfg.massKg, stiffness: cfg.stiffness, damage: cfg.damage, pose: cfg.pose, speed: cfg.speed, yawRate: cfg.yawRate, structure: cfg.structure }])
    .map((u) => { const sp = u.vehicle || CAR; return { cfg: u, spec: sp, car: buildCar(u.massKg, u.stiffness, sp, u.structure), off: 0, n: 0 }; });
  const NU = units.length, multi = NU > 1;
  let n = 0, nc = 0;
  for (const U of units) { U.off = n; U.n = U.car.n; n += U.n; U.c0 = nc; U.nc = U.car.cons.n; nc += U.nc; }
  const spec = units[0].spec, car = units[0].car;
  // node and constraint arrays of all vehicles, one after the other (a single vehicle uses its own)
  const join = (key, Type) => { if (!multi) return units[0].car[key]; const out = new Type(n); for (const U of units) out.set(U.car[key], U.off); return out; };
  const mass = join('mass', Float64Array), ghost = join('ghost', Uint8Array), wheelNode = join('wheel', Uint8Array);
  const unitOf = new Uint8Array(n), clear = new Float64Array(n);
  units.forEach((U, u) => { unitOf.fill(u, U.off, U.off + U.n); clear.fill(U.spec.bodyClearance, U.off, U.off + U.n); });
  const X = new Float64Array(3 * n), P = new Float64Array(3 * n), V = new Float64Array(3 * n), W = new Float64Array(n);
  const y0 = new Float64Array(n);
  const ch = Math.cos(units[0].cfg.pose.heading), sh = Math.sin(units[0].cfg.pose.heading);
  for (const U of units) {
    const c = U.cfg, uch = Math.cos(c.pose.heading), ush = Math.sin(c.pose.heading), yaw = c.yawRate || 0;
    const vx0 = c.velocity ? c.velocity[0] : c.speed * uch, vz0 = c.velocity ? c.velocity[1] : c.speed * ush;
    if (c.lift || c.vy || c.pitch || c.roll) {
      // in the air (the Destruction mode's jumps): raised by lift, pitched nose-up by pitch and
      // rolled by roll (as the game draws it: pitch about the car's side, then roll about its
      // length, then the heading), falling or climbing at vy
      const cp = Math.cos(c.pitch || 0), sp = Math.sin(c.pitch || 0), cr = Math.cos(c.roll || 0), sr = Math.sin(c.roll || 0);
      for (let q = 0; q < U.n; q++) {
        const a = U.off + q;
        const lx = U.car.rest[3 * q], ly = U.car.rest[3 * q + 1], lz = U.car.rest[3 * q + 2];
        const px = lx * cp - ly * sp, py = lx * sp + ly * cp;
        const ry = py * cr - lz * sr, rz = py * sr + lz * cr;
        const wx = uch * px - ush * rz, wz = ush * px + uch * rz;
        X[3 * a] = c.pose.x + wx; X[3 * a + 1] = (c.lift || 0) + ry; X[3 * a + 2] = c.pose.z + wz;
        V[3 * a] = vx0 - yaw * wz; V[3 * a + 1] = c.vy || 0; V[3 * a + 2] = vz0 + yaw * wx;
        W[a] = 1 / mass[a]; y0[a] = X[3 * a + 1];   // height energy counted from where it starts
      }
      continue;
    }
    for (let q = 0; q < U.n; q++) {
      const a = U.off + q;
      const lx = U.car.rest[3 * q], ly = U.car.rest[3 * q + 1], lz = U.car.rest[3 * q + 2];
      const wx = uch * lx - ush * lz, wz = ush * lx + uch * lz;
      X[3 * a] = c.pose.x + wx; X[3 * a + 1] = ly; X[3 * a + 2] = c.pose.z + wz;
      V[3 * a] = vx0 - yaw * wz; V[3 * a + 1] = 0; V[3 * a + 2] = vz0 + yaw * wx;
      W[a] = 1 / mass[a]; y0[a] = ly;
    }
  }
  const barrierKind = cfg.barrier || 'rigid';
  const rigid = barrierKind === 'rigid', wallMode = barrierKind === 'brick';
  const offset = barrierKind === 'offset' ? buildOffset(cfg.offset) : null, hc = offset ? offset.hc : null;
  const pole = barrierKind === 'pole' ? { x: cfg.pole.x, z: cfg.pole.z, r: POLE_RADIUS, height: 3 } : null;
  const world = barrierKind === 'world' ? buildWorld(cfg.world) : null;
  const staticObs = !!(offset || pole || world);
  let backOff = 0;
  if (rigid || wallMode) {
    // Never start overlapping the barrier face (x = 0): a starting overlap would be resolved in one
    // step and fire nodes backwards at hundreds of m/s.
    let maxFront = -Infinity;
    for (let a = 0; a < n; a++) if (!ghost[a]) maxFront = Math.max(maxFront, X[3 * a] + spec.nodeRadius);
    if (maxFront > -0.002) for (let a = 0; a < n; a++) X[3 * a] -= maxFront + 0.002;
  } else if (world) {
    // world obstacles: move each vehicle out along the normal at its deepest node (normally nothing
    // to do: the game hands over its cars just before they touch)
    const G3 = [0, 0, 0];
    for (const U of units) {
      for (let it = 0; it < 20; it++) {
        let worst = 0, nx = 0, nz = 0;
        for (let a = U.off; a < U.off + U.n; a++) {
          if (ghost[a]) continue;
          const d = U.spec.nodeRadius + 0.002 - worldSDF(X[3 * a], X[3 * a + 1], X[3 * a + 2], G3, world.shapes);
          if (d > worst) { worst = d; nx = G3[0]; nz = G3[2]; }
        }
        if (worst <= 0) break;
        for (let a = U.off; a < U.off + U.n; a++) { X[3 * a] += nx * (worst + 0.001); X[3 * a + 2] += nz * (worst + 0.001); }
        backOff += worst + 0.001;
      }
    }
  } else if (staticObs) {
    // the same for the offset barrier and the pole: back each vehicle off along its velocity
    const G3 = [0, 0, 0];
    for (const U of units) {
      let vx = 0, vz = 0;
      for (let a = U.off; a < U.off + U.n; a++) { vx += V[3 * a]; vz += V[3 * a + 2]; }
      const vl = Math.hypot(vx, vz);
      if (vl < 1e-9) continue;
      vx /= vl; vz /= vl;
      for (let it = 0; it < 50; it++) {
        let worst = 0;
        for (let a = U.off; a < U.off + U.n; a++) {
          if (ghost[a]) continue;
          const d = U.spec.nodeRadius + 0.002 - obstacleSDF(X[3 * a], X[3 * a + 1], X[3 * a + 2], G3);
          if (d > worst) worst = d;
        }
        if (worst <= 0) break;
        for (let a = U.off; a < U.off + U.n; a++) { X[3 * a] -= vx * (worst + 0.001); X[3 * a + 2] -= vz * (worst + 0.001); }
      }
    }
  }
  let ca, cb, c0, ck, cey;
  if (!multi) { const C = car.cons; ca = C.a; cb = C.b; c0 = C.len0; ck = C.k; cey = C.ey; }
  else {
    ca = new Int32Array(nc); cb = new Int32Array(nc); c0 = new Float64Array(nc); ck = new Float64Array(nc); cey = new Float64Array(nc);
    for (const U of units) {
      const C = U.car.cons;
      for (let c = 0; c < U.nc; c++) { ca[U.c0 + c] = C.a[c] + U.off; cb[U.c0 + c] = C.b[c] + U.off; }
      c0.set(C.len0, U.c0); ck.set(C.k, U.c0); cey.set(C.ey, U.c0);
    }
  }
  const unitOfC = new Uint8Array(nc);
  units.forEach((U, u) => unitOfC.fill(u, U.c0, U.c0 + U.nc));
  const rest = Float64Array.from(c0), comp = new Float64Array(nc), plastic = new Float32Array(nc), damp = new Float64Array(nc);
  for (let c = 0; c < nc; c++) {
    comp[c] = 1 / ck[c];
    const ma = mass[ca[c]], mb = mass[cb[c]];
    damp[c] = ZETA * 2 * Math.sqrt(ck[c] * ma * mb / (ma + mb));   // N s/m
  }
  // Node -> incident constraints (CSR), for booking the elastic energy that contacts change.
  const incStart = new Int32Array(n + 1), incList = new Int32Array(2 * nc);
  for (let c = 0; c < nc; c++) { incStart[ca[c] + 1]++; incStart[cb[c] + 1]++; }
  for (let a = 0; a < n; a++) incStart[a + 1] += incStart[a];
  { const fill = incStart.slice(0, n); for (let c = 0; c < nc; c++) { incList[fill[ca[c]]++] = c; incList[fill[cb[c]]++] = c; } }
  const XS = new Float64Array(3 * n), stamp = new Int32Array(nc);
  let stampId = 0;
  // groups of each vehicle in the joined node numbering
  for (const U of units) {
    U.groups = {};
    for (const key in U.car.groups) U.groups[key] = U.off ? U.car.groups[key].map(a => a + U.off) : U.car.groups[key];
  }

  // Signed distance from a world point to the offset barrier or the pole (negative inside), and
  // the outward normal in G3. The barrier's honeycomb face is handled separately (honeycombContact).
  // World obstacles: the shapes near the vehicles this step, or all of them (all = true).
  function obstacleSDF(x, y, z, G3, all) {
    if (world) return worldSDF(x, y, z, G3, all ? world.shapes : world.active);
    if (pole) {
      const dx = x - pole.x, dz = z - pole.z, d = Math.hypot(dx, dz) || 1e-9;
      G3[0] = dx / d; G3[1] = 0; G3[2] = dz / d;
      return y > pole.height ? Infinity : d - pole.r;
    }
    if (!offset || y > offset.height) { G3[0] = -1; G3[1] = 0; G3[2] = 0; return Infinity; }
    // in the barrier's own frame: x into the block (its face at x = 0), w across its inner edge
    // (w > 0 beside the block, w < 0 behind the edge); the edge is rounded with radius rho
    const s = -offset.side, w = s * (z - offset.zEdge), rho = offset.edgeRadius;
    let d, nx, nw;
    if (x < rho && w > -rho) { const ex = x - rho, ew = w + rho, l = Math.hypot(ex, ew) || 1e-9; d = l - rho; nx = ex / l; nw = ew / l; }   // round edge
    else if (w > -rho) { d = w; nx = 0; nw = 1; }       // beside the block
    else if (x < rho || x < -w) { d = -x; nx = -1; nw = 0; }   // in front (or inside, nearer the face)
    else { d = w; nx = 0; nw = 1; }                     // inside, nearer the side
    if (-offset.width - w > d) { d = -offset.width - w; nx = 0; nw = -1; }   // beyond the far side
    G3[0] = nx; G3[1] = 0; G3[2] = s * nw;
    return d;
  }

  // --- rigid bodies: the wall's bricks [0, nb), then debris bodies [nb, NB) for the parts and
  //     wheels that can come off (inactive until they do)
  const wall = wallMode ? buildWall(cfg.wallStrength) : null;
  const nb = wall ? wall.nb : 0;
  const dmg = DAMAGE[cfg.damage] || 1;
  const parts = [], corners = [];
  const wheelFloor = new Float64Array(n), muRoll = new Float64Array(n).fill(MU_ROLL);
  for (const U of units) for (let a = U.off; a < U.off + U.n; a++) wheelFloor[a] = U.spec.wheelRadius;
  units.forEach((U, u) => {
    const sp = U.spec, uc = U.car, udmg = multi ? (DAMAGE[U.cfg.damage] || 1) : dmg;
    U.dmg = udmg; U.pushScale = udmg === 1 ? 1 : 0.55;
    U.IW = 0.4 * sp.wheelCornerMass * sp.wheelRadius * sp.wheelRadius;   // wheel spin inertia (kg m^2)
    if (sp.parts) {
      for (const p of sp.parts) {
        const rule = PART_RULES.find(r => p.name.startsWith(r[0]));
        if (!rule) continue;
        // where the part sits: its surface samples in the lattice, the share of the part's mass each
        // structural node carries, and the springs between those nodes (its mounts)
        const emb = embedPoints(uc, p.samples);
        if (U.off) for (let i = 0; i < emb.idx.length; i++) emb.idx[i] += U.off;
        const wsum = new Map();
        for (let q = 0; q < emb.m; q++) for (let c = 0; c < 8; c++) {
          const a = emb.idx[8 * q + c], w = Math.max(0, cornerWeight(emb.t, 3 * q, c));
          if (w > 0 && !ghost[a]) wsum.set(a, (wsum.get(a) || 0) + w);
        }
        let tot = 0;
        for (const w of wsum.values()) tot += w;
        const nodes = [], wts = [];
        for (const [a, w] of wsum) if (w / tot > 0.01) { nodes.push(a); wts.push(w); }
        const wt = wts.reduce((x, y) => x + y, 0);
        const set = new Set(nodes), anchors = [];
        for (let c = U.c0; c < U.c0 + U.nc; c++) if (set.has(ca[c]) && set.has(cb[c])) anchors.push(c);
        if (anchors.length < 4) for (let c = U.c0; c < U.c0 + U.nc; c++) if (set.has(ca[c]) !== set.has(cb[c])) anchors.push(c);
        parts.push({ name: p.name, unit: u, U, mass: rule[1], limit: rule[2] * udmg, breakaway: p.name.startsWith('BREAKAWAY'), emb,
          nodes: Int32Array.from(nodes), share: Float64Array.from(wts.map(w => w / wt)), anchors: Int32Array.from(anchors), body: -1, t: -1 });
      }
    }
    if (sp.wheelCornerMass > 0 && sp.hubs) {
      const ijk = uc.ijk;
      for (const key of ['RL', 'RR', 'FL', 'FR']) {
        const front = key[0] === 'F', right = key[1] === 'R', nodes = [];
        for (let q = 0; q < U.n; q++) {
          if (!wheelNode[U.off + q] || ijk[3 * q] !== sp.wheelI[front ? 1 : 0]) continue;
          const k = ijk[3 * q + 2];
          if (right ? k >= sp.nz - 2 : k <= 1) nodes.push(U.off + q);
        }
        const set = new Set(nodes), anchors = [];
        for (let c = U.c0; c < U.c0 + U.nc; c++) if (set.has(ca[c]) || set.has(cb[c])) anchors.push(c);
        const h = sp.hubs[key], emb = embedPoints(uc, [h]);
        if (U.off) for (let i = 0; i < emb.idx.length; i++) emb.idx[i] += U.off;
        corners.push({ key, unit: u, U, front, right, nodes: Int32Array.from(nodes), anchors: Int32Array.from(anchors), emb,
          restBack: h[0] - uc.cabinRest[0], burst: -1, body: -1, t: -1 });
      }
    }
  });
  const nd = parts.length + corners.length, NB = nb + nd;
  parts.forEach((p, q) => { p.bi = nb + q; });
  corners.forEach((cw, q) => { cw.bi = nb + parts.length + q; });
  const mass0 = Float64Array.from(mass);
  let bc, bq, bcp, bqp, bv, bw, binvM, binvI, bh, bm, bstate, bsleep, bsupp, by0, bdebrisT;
  const bkind = new Uint8Array(NB), bpts = new Array(NB).fill(null), bwheel = new Float64Array(2 * NB);   // wheel radius, half width
  if (NB) {
    bc = new Float64Array(3 * NB); bcp = new Float64Array(3 * NB); bv = new Float64Array(3 * NB); bw = new Float64Array(3 * NB);
    bq = new Float64Array(4 * NB); bqp = new Float64Array(4 * NB);
    for (let b = 0; b < NB; b++) bq[4 * b + 3] = 1;
    bm = new Float64Array(NB); binvM = new Float64Array(NB); binvI = new Float64Array(3 * NB);
    bstate = new Uint8Array(NB).fill(INACTIVE); bsleep = new Float64Array(NB); bsupp = new Uint8Array(NB).fill(1);
    by0 = new Float64Array(NB); bdebrisT = new Float64Array(NB).fill(-1);
  }
  let bondA, bondB, bondRa, bondRb, bondFix, bondS, bondN, bondBroken, adjStart, adjList, bondMark, activeBonds, bondStamp = 0;
  if (wall) {
    bc.set(wall.center);
    for (let b = 0; b < nb; b++) { bm[b] = wall.mass[b]; binvM[b] = 1 / bm[b]; bstate[b] = DORMANT; }
    binvI.set(wall.invI); bh = wall.half;
    for (let b = 0; b < nb; b++) by0[b] = bc[3 * b + 1];
    const bo = wall.bond;
    bondA = bo.a; bondB = bo.b; bondRa = bo.ra; bondRb = bo.rb; bondFix = bo.fixed; bondS = bo.strength; bondN = bo.normal;
    bondBroken = new Uint8Array(bo.n);
    bondMark = new Int32Array(bo.n); activeBonds = new Int32Array(bo.n);
    const cnt = new Int32Array(nb + 1);
    for (let k = 0; k < bo.n; k++) { cnt[bondA[k]]++; if (bondB[k] >= 0) cnt[bondB[k]]++; }
    adjStart = new Int32Array(nb + 1);
    for (let b = 0; b < nb; b++) adjStart[b + 1] = adjStart[b] + cnt[b];
    adjList = new Int32Array(adjStart[nb]);
    const fill = adjStart.slice(0, nb);
    for (let k = 0; k < bo.n; k++) { adjList[fill[bondA[k]]++] = k; if (bondB[k] >= 0) adjList[fill[bondB[k]]++] = k; }
  }

  // --- scratch
  const S1 = new Float64Array(3), S2 = new Float64Array(3), S3 = new Float64Array(3), S4 = new Float64Array(3), S5 = new Float64Array(3), S6 = new Float64Array(3);
  const S7 = new Float64Array(3), S8 = new Float64Array(3);

  function rot(b, x, y, z, out) {
    const o = 4 * b, qx = bq[o], qy = bq[o + 1], qz = bq[o + 2], qw = bq[o + 3];
    const tx = 2 * (qy * z - qz * y), ty = 2 * (qz * x - qx * z), tz = 2 * (qx * y - qy * x);
    out[0] = x + qw * tx + (qy * tz - qz * ty);
    out[1] = y + qw * ty + (qz * tx - qx * tz);
    out[2] = z + qw * tz + (qx * ty - qy * tx);
  }
  function rotInv(b, x, y, z, out) {
    const o = 4 * b, qx = -bq[o], qy = -bq[o + 1], qz = -bq[o + 2], qw = bq[o + 3];
    const tx = 2 * (qy * z - qz * y), ty = 2 * (qz * x - qx * z), tz = 2 * (qx * y - qy * x);
    out[0] = x + qw * tx + (qy * tz - qz * ty);
    out[1] = y + qw * ty + (qz * tx - qx * tz);
    out[2] = z + qw * tz + (qx * ty - qy * tx);
  }
  function genInvMass(b, rx, ry, rz, nx, ny, nz) {
    rotInv(b, ry * nz - rz * ny, rz * nx - rx * nz, rx * ny - ry * nx, S1);
    const i3 = 3 * b;
    return binvM[b] + binvI[i3] * S1[0] * S1[0] + binvI[i3 + 1] * S1[1] * S1[1] + binvI[i3 + 2] * S1[2] * S1[2];
  }
  function quatAddOmega(b, wx, wy, wz, s) {
    const o = 4 * b;
    let qx = bq[o], qy = bq[o + 1], qz = bq[o + 2], qw = bq[o + 3];
    const dx = wx * qw + wy * qz - wz * qy, dy = -wx * qz + wy * qw + wz * qx;
    const dz = wx * qy - wy * qx + wz * qw, dw = -wx * qx - wy * qy - wz * qz;
    qx += s * dx; qy += s * dy; qz += s * dz; qw += s * dw;
    const inv = 1 / Math.sqrt(qx * qx + qy * qy + qz * qz + qw * qw);
    bq[o] = qx * inv; bq[o + 1] = qy * inv; bq[o + 2] = qz * inv; bq[o + 3] = qw * inv;
  }
  // Positional impulse p applied at world offset r from the brick centre (Müller et al. 2020).
  function applyCorr(b, rx, ry, rz, px, py, pz) {
    const i3 = 3 * b, im = binvM[b];
    bc[i3] += px * im; bc[i3 + 1] += py * im; bc[i3 + 2] += pz * im;
    rotInv(b, ry * pz - rz * py, rz * px - rx * pz, rx * py - ry * px, S1);
    rot(b, S1[0] * binvI[i3], S1[1] * binvI[i3 + 1], S1[2] * binvI[i3 + 2], S2);
    quatAddOmega(b, S2[0], S2[1], S2[2], 0.5);
  }
  // Rotation over this step as a vector (rad), from q * conj(qPrev). Bricks use the small-angle
  // form; debris bodies (wheels spin at over 100 rad/s) use the exact angle, or their spin would
  // decay by about (w dt)^2 / 12 per step.
  function stepRotation(b, out) {
    const o = 4 * b;
    const ax = bq[o], ay = bq[o + 1], az = bq[o + 2], aw = bq[o + 3];
    const bx = -bqp[o], by = -bqp[o + 1], bz = -bqp[o + 2], bwq = bqp[o + 3];
    const x = aw * bx + ax * bwq + ay * bz - az * by;
    const y = aw * by - ax * bz + ay * bwq + az * bx;
    const z = aw * bz + ax * by - ay * bx + az * bwq;
    const w = aw * bwq - ax * bx - ay * by - az * bz;
    let s = w >= 0 ? 2 : -2;
    if (b >= nb) { const vn = Math.hypot(x, y, z); if (vn > 1e-12) s = (w >= 0 ? 2 : -2) * Math.atan2(vn, Math.abs(w)) / vn; }
    out[0] = s * x; out[1] = s * y; out[2] = s * z;
  }
  // Exact rotation by angular velocity w over dt (q <- exp(w dt / 2) q), for debris bodies.
  function quatExp(b, wx, wy, wz, dt) {
    const wn = Math.hypot(wx, wy, wz), th = wn * dt;
    if (th < 1e-12) return;
    const o = 4 * b, sn = Math.sin(0.5 * th) / wn, c = Math.cos(0.5 * th);
    const dx = wx * sn, dy = wy * sn, dz = wz * sn;
    const qx = bq[o], qy = bq[o + 1], qz = bq[o + 2], qw = bq[o + 3];
    let nx = c * qx + dx * qw + dy * qz - dz * qy, ny = c * qy - dx * qz + dy * qw + dz * qx;
    let nz = c * qz + dx * qy - dy * qx + dz * qw, nw = c * qw - dx * qx - dy * qy - dz * qz;
    const inv = 1 / Math.sqrt(nx * nx + ny * ny + nz * nz + nw * nw);
    bq[o] = nx * inv; bq[o + 1] = ny * inv; bq[o + 2] = nz * inv; bq[o + 3] = nw * inv;
  }
  function pointDisp(b, rx, ry, rz, out) {
    if (bstate[b] !== AWAKE) { out[0] = out[1] = out[2] = 0; return; }
    stepRotation(b, S6);
    const i3 = 3 * b;
    out[0] = bc[i3] - bcp[i3] + S6[1] * rz - S6[2] * ry;
    out[1] = bc[i3 + 1] - bcp[i3 + 1] + S6[2] * rx - S6[0] * rz;
    out[2] = bc[i3 + 2] - bcp[i3 + 2] + S6[0] * ry - S6[1] * rx;
  }
  function wake(b) {
    if (bstate[b] === AWAKE) return;
    bstate[b] = AWAKE; bsleep[b] = 0;
    for (let d = 0; d < 3; d++) { bcp[3 * b + d] = bc[3 * b + d]; bv[3 * b + d] = 0; bw[3 * b + d] = 0; }
    for (let d = 0; d < 4; d++) bqp[4 * b + d] = bq[4 * b + d];
  }
  function hasIntactBond(b) {
    for (let p = adjStart[b]; p < adjStart[b + 1]; p++) if (!bondBroken[adjList[p]]) return true;
    return false;
  }
  if (wall && cfg.wakeAll) for (let b = 0; b < nb; b++) wake(b);   // test hook: wall must stand on its own

  // --- spatial hash over brick centres
  const HCELL = 0.5, HSIZE = 4096;
  const hHead = new Int32Array(HSIZE), hNext = new Int32Array(Math.max(1, nb));
  const bbMin = [0, 0, 0], bbMax = [0, 0, 0];
  const hkey = (ix, iy, iz) => ((ix * 73856093) ^ (iy * 19349663) ^ (iz * 83492791)) & (HSIZE - 1);
  function buildHash() {
    hHead.fill(-1);
    bbMin[0] = bbMin[1] = bbMin[2] = Infinity; bbMax[0] = bbMax[1] = bbMax[2] = -Infinity;
    for (let b = 0; b < nb; b++) {
      const x = bc[3 * b], y = bc[3 * b + 1], z = bc[3 * b + 2];
      const key = hkey(Math.floor(x / HCELL), Math.floor(y / HCELL), Math.floor(z / HCELL));
      hNext[b] = hHead[key]; hHead[key] = b;
      if (x < bbMin[0]) bbMin[0] = x; if (y < bbMin[1]) bbMin[1] = y; if (z < bbMin[2]) bbMin[2] = z;
      if (x > bbMax[0]) bbMax[0] = x; if (y > bbMax[1]) bbMax[1] = y; if (z > bbMax[2]) bbMax[2] = z;
    }
  }

  // --- contacts
  // kinds up to KIND_NODE_SURF involve only lattice nodes; from KIND_NODE_BRICK on, a rigid body
  const KIND_GROUND = 1, KIND_BARRIER = 2, KIND_NODE_NODE = 3, KIND_NODE_SURF = 4;
  const KIND_NODE_BRICK = 5, KIND_BRICK_GROUND = 6, KIND_BRICK_BRICK = 7, KIND_BODY_BARRIER = 8, KIND_BODY_SURF = 9;
  const CMAX = 16384;
  const cKind = new Uint8Array(CMAX), cI = new Int32Array(CMAX), cJ = new Int32Array(CMAX);
  const cN = new Float64Array(3 * CMAX), cR1 = new Float64Array(3 * CMAX), cR2 = new Float64Array(3 * CMAX), cLam = new Float64Array(CMAX);
  const cVpre = new Float64Array(CMAX);   // normal relative velocity before the step (> 0 separating)
  let nC = 0;
  // Velocity of a point on body b at world offset r, from current bv/bw (0 if not awake).
  function pointVel(b, rx, ry, rz, out) {
    if (b < 0 || bstate[b] !== AWAKE) { out[0] = out[1] = out[2] = 0; return; }
    const i3 = 3 * b;
    out[0] = bv[i3] + bw[i3 + 1] * rz - bw[i3 + 2] * ry;
    out[1] = bv[i3 + 1] + bw[i3 + 2] * rx - bw[i3] * rz;
    out[2] = bv[i3 + 2] + bw[i3] * ry - bw[i3 + 1] * rx;
  }
  function relNormalVel(kind, i, j, nx, ny, nz, r1x, r1y, r1z, r2x, r2y, r2z) {
    if (kind === KIND_NODE_BRICK) {
      pointVel(j, r1x, r1y, r1z, S8);
      return (V[3 * i] - S8[0]) * nx + (V[3 * i + 1] - S8[1]) * ny + (V[3 * i + 2] - S8[2]) * nz;
    }
    if (kind === KIND_BRICK_GROUND) { pointVel(i, r1x, r1y, r1z, S8); return S8[1]; }
    if (kind === KIND_BODY_BARRIER) { pointVel(i, r1x, r1y, r1z, S8); return -S8[0]; }
    if (kind === KIND_BODY_SURF) { pointVel(i, r1x, r1y, r1z, S8); return S8[0] * nx + S8[1] * ny + S8[2] * nz; }
    pointVel(i, r1x, r1y, r1z, S8); const a0 = S8[0], a1 = S8[1], a2 = S8[2];
    pointVel(j, r2x, r2y, r2z, S8);
    return (a0 - S8[0]) * nx + (a1 - S8[1]) * ny + (a2 - S8[2]) * nz;
  }
  function addContact(kind, i, j, nx, ny, nz, lam, r1x, r1y, r1z, r2x, r2y, r2z) {
    if (nC >= CMAX) return;
    const k = nC++, k3 = 3 * k;
    cKind[k] = kind; cI[k] = i; cJ[k] = j; cLam[k] = lam;
    if (kind >= KIND_NODE_BRICK) cVpre[k] = relNormalVel(kind, i, j, nx, ny, nz, r1x || 0, r1y || 0, r1z || 0, r2x || 0, r2y || 0, r2z || 0);
    cN[k3] = nx; cN[k3 + 1] = ny; cN[k3 + 2] = nz;
    cR1[k3] = r1x || 0; cR1[k3 + 1] = r1y || 0; cR1[k3 + 2] = r1z || 0;
    cR2[k3] = r2x || 0; cR2[k3 + 1] = r2y || 0; cR2[k3 + 2] = r2z || 0;
  }

  // --- state, energy books, telemetry
  let t = 0, T0 = -1, done = false, cancelled = false, nextRecordT = 0;
  let Wp = 0, Wfrac = 0, Qf = 0, damageTick = 0;
  let Wmove = 0;   // work done on the cars by moving boxes
  const debris = [];   // { name, kind: 'part' | 'wheel', body, t, X (lattice at that moment) }
  let barrierForce = 0, impAcc = 0, impX = 0, impY = 0, impZ = 0, anyBreak = false;
  const pendingBreaks = [];
  const events = [];
  // per vehicle: cabin frame, telemetry and contact force with the other vehicles
  for (const U of units) {
    const c = Math.cos(U.cfg.pose.heading), s = Math.sin(U.cfg.pose.heading);
    U.h0 = [c, s];
    U.frame = { o: [0, 0, 0], f: [c, 0, s], u: [0, 1, 0], l: [-s, 0, c], v: [0, 0, 0] };
    U.tel = { t: [], vx: [], vy: [], vz: [], fx: [], fy: [], fz: [], ux: [], uy: [], uz: [], force: [] };
    U.force = 0; U.Wp = 0;
  }
  const frame = units[0].frame, tel = units[0].tel;
  const frames = { t: [], pos: [], strain: [], bricks: [], axes: [], crush: [], intrusion: [], energy: [] };
  if (multi) { frames.unitAxes = units.map(() => []); frames.unitCrush = units.map(() => []); }
  if (hc) frames.honeycomb = [];
  const nodeStrain = new Float32Array(n);
  const duration = cfg.duration || (wallMode ? spec.duration.brick : spec.duration.rigid);

  function meanPos(group, out) {
    let x = 0, y = 0, z = 0;
    for (let p = 0; p < group.length; p++) { const a3 = 3 * group[p]; x += X[a3]; y += X[a3 + 1]; z += X[a3 + 2]; }
    const inv = 1 / group.length;
    out[0] = x * inv; out[1] = y * inv; out[2] = z * inv;
  }
  const mF = [0, 0, 0], mR = [0, 0, 0], mT = [0, 0, 0], mB = [0, 0, 0];
  function computeFrame() { for (const U of units) unitFrame(U.frame, U.groups); }
  function unitFrame(frame, groups) {
    const cab = groups.cabin;
    let m = 0, ox = 0, oy = 0, oz = 0, vx = 0, vy = 0, vz = 0;
    for (let p = 0; p < cab.length; p++) {
      const a = cab[p], a3 = 3 * a, w = mass[a];
      m += w; ox += w * X[a3]; oy += w * X[a3 + 1]; oz += w * X[a3 + 2];
      vx += w * V[a3]; vy += w * V[a3 + 1]; vz += w * V[a3 + 2];
    }
    frame.o[0] = ox / m; frame.o[1] = oy / m; frame.o[2] = oz / m;
    frame.v[0] = vx / m; frame.v[1] = vy / m; frame.v[2] = vz / m;
    meanPos(groups.cabFront, mF); meanPos(groups.cabRear, mR);
    meanPos(groups.cabTop, mT); meanPos(groups.cabBot, mB);
    let fx = mF[0] - mR[0], fy = mF[1] - mR[1], fz = mF[2] - mR[2];
    let inv = 1 / Math.hypot(fx, fy, fz); fx *= inv; fy *= inv; fz *= inv;
    let ux = mT[0] - mB[0], uy = mT[1] - mB[1], uz = mT[2] - mB[2];
    const d = ux * fx + uy * fy + uz * fz; ux -= d * fx; uy -= d * fy; uz -= d * fz;
    inv = 1 / Math.hypot(ux, uy, uz); ux *= inv; uy *= inv; uz *= inv;
    frame.f[0] = fx; frame.f[1] = fy; frame.f[2] = fz;
    frame.u[0] = ux; frame.u[1] = uy; frame.u[2] = uz;
    frame.l[0] = fy * uz - fz * uy; frame.l[1] = fz * ux - fx * uz; frame.l[2] = fx * uy - fy * ux;
  }

  // Change in elastic + gravitational energy of the vehicle since the XS snapshot, counted only
  // over nodes that moved (contacts and friction touch few nodes).
  function nodeStageDelta() {
    stampId++;
    let dE = 0;
    for (let a = 0, a3 = 0; a < n; a++, a3 += 3) {
      if (X[a3] === XS[a3] && X[a3 + 1] === XS[a3 + 1] && X[a3 + 2] === XS[a3 + 2]) continue;
      dE += mass[a] * G * (X[a3 + 1] - XS[a3 + 1]);
      for (let p = incStart[a]; p < incStart[a + 1]; p++) {
        const c = incList[p];
        if (stamp[c] === stampId) continue;
        stamp[c] = stampId;
        const i3 = 3 * ca[c], j3 = 3 * cb[c];
        const ln = Math.hypot(X[j3] - X[i3], X[j3 + 1] - X[i3 + 1], X[j3 + 2] - X[i3 + 2]) - rest[c];
        const lo = Math.hypot(XS[j3] - XS[i3], XS[j3 + 1] - XS[i3 + 1], XS[j3 + 2] - XS[i3 + 2]) - rest[c];
        dE += 0.5 * ck[c] * (ln * ln - lo * lo);
      }
    }
    return dE;
  }
  // Gravitational energy (relative to start) of awake bricks plus elastic energy of bonds that
  // touch an awake brick.
  function brickStageEnergy() {
    let e = 0;
    for (let b = 0; b < NB; b++) if (bstate[b] === AWAKE) e += bm[b] * G * (bc[3 * b + 1] - by0[b]);
    return e + (wall ? bondEnergy() : 0);
  }
  function bondEnergy() {
    let e = 0;
    for (let k = 0; k < bondA.length; k++) {
      if (bondBroken[k]) continue;
      const a = bondA[k], b = bondB[k];
      if (bstate[a] !== AWAKE && !(b >= 0 && bstate[b] === AWAKE)) continue;
      const k3 = 3 * k;
      rot(a, bondRa[k3], bondRa[k3 + 1], bondRa[k3 + 2], S3);
      let px, py, pz;
      if (b >= 0) { rot(b, bondRb[k3], bondRb[k3 + 1], bondRb[k3 + 2], S4); px = bc[3 * b] + S4[0]; py = bc[3 * b + 1] + S4[1]; pz = bc[3 * b + 2] + S4[2]; }
      else { px = bondFix[k3]; py = bondFix[k3 + 1]; pz = bondFix[k3 + 2]; }
      const dx = bc[3 * a] + S3[0] - px, dy = bc[3 * a + 1] + S3[1] - py, dz = bc[3 * a + 2] + S3[2] - pz;
      e += 0.5 * (dx * dx + dy * dy + dz * dz) / BOND_COMPLIANCE;
    }
    return e;
  }

  function kinetic(dt) {
    const inv = 1 / (dt * dt);
    let e = 0;
    for (let a = 0, a3 = 0; a < n; a++, a3 += 3) {
      const dx = X[a3] - P[a3], dy = X[a3 + 1] - P[a3 + 1], dz = X[a3 + 2] - P[a3 + 2];
      e += mass[a] * (dx * dx + dy * dy + dz * dz);
    }
    e *= 0.5 * inv;
    for (let b = 0; b < NB; b++) {
      if (bstate[b] !== AWAKE) continue;
      const i3 = 3 * b;
      const dx = bc[i3] - bcp[i3], dy = bc[i3 + 1] - bcp[i3 + 1], dz = bc[i3 + 2] - bcp[i3 + 2];
      e += 0.5 * bm[b] * (dx * dx + dy * dy + dz * dz) * inv;
      stepRotation(b, S3); rotInv(b, S3[0], S3[1], S3[2], S4);
      e += 0.5 * (S4[0] * S4[0] / binvI[i3] + S4[1] * S4[1] / binvI[i3 + 1] + S4[2] * S4[2] / binvI[i3 + 2]) * inv;
    }
    return e;
  }

  // ---------------------------------------------------------------- one substep
  function substep(dt) {
    const dt2 = dt * dt;
    nC = 0; barrierForce = 0;
    if (multi) for (const U of units) U.force = 0;
    if (hc) hcStamp++;

    // 1. predict
    for (let a = 0, a3 = 0; a < n; a++, a3 += 3) {
      P[a3] = X[a3]; P[a3 + 1] = X[a3 + 1]; P[a3 + 2] = X[a3 + 2];
      V[a3 + 1] -= G * dt;
      X[a3] += V[a3] * dt; X[a3 + 1] += V[a3 + 1] * dt; X[a3 + 2] += V[a3 + 2] * dt;
    }
    for (let b = 0; b < NB; b++) {
      if (bstate[b] !== AWAKE) continue;
      const i3 = 3 * b, o = 4 * b;
      bcp[i3] = bc[i3]; bcp[i3 + 1] = bc[i3 + 1]; bcp[i3 + 2] = bc[i3 + 2];
      bqp[o] = bq[o]; bqp[o + 1] = bq[o + 1]; bqp[o + 2] = bq[o + 2]; bqp[o + 3] = bq[o + 3];
      bv[i3 + 1] -= G * dt;
      bc[i3] += bv[i3] * dt; bc[i3 + 1] += bv[i3 + 1] * dt; bc[i3 + 2] += bv[i3 + 2] * dt;
      // gyroscopic term (body frame): w += dt * I^-1 (-(w x I w)), keeps free spin energy-conserving
      rotInv(b, bw[i3], bw[i3 + 1], bw[i3 + 2], S3);
      const Ix = 1 / binvI[i3], Iy = 1 / binvI[i3 + 1], Iz = 1 / binvI[i3 + 2];
      const wx = S3[0], wy = S3[1], wz = S3[2];
      S3[0] -= dt * binvI[i3] * (wy * Iz * wz - wz * Iy * wy);
      S3[1] -= dt * binvI[i3 + 1] * (wz * Ix * wx - wx * Iz * wz);
      S3[2] -= dt * binvI[i3 + 2] * (wx * Iy * wy - wy * Ix * wx);
      rot(b, S3[0], S3[1], S3[2], S4);
      bw[i3] = S4[0]; bw[i3 + 1] = S4[1]; bw[i3 + 2] = S4[2];
      if (b < nb) quatAddOmega(b, bw[i3], bw[i3 + 1], bw[i3 + 2], 0.5 * dt);
      else quatExp(b, bw[i3], bw[i3 + 1], bw[i3 + 2], dt);
    }

    // 2. vehicle structure: XPBD distance constraints with damping (Macklin et al. 2016) and
    //    plastic yield
    for (let c = 0; c < nc; c++) {
      const a = ca[c], b = cb[c], a3 = 3 * a, b3 = 3 * b;
      const dx = X[b3] - X[a3], dy = X[b3 + 1] - X[a3 + 1], dz = X[b3 + 2] - X[a3 + 2];
      const len = Math.sqrt(dx * dx + dy * dy + dz * dz);
      if (len < 1e-9) continue;
      const wa = W[a], wb = W[b], wsum = wa + wb;
      // relative displacement this step along the constraint, and the damping weight gamma
      const vp = (dx * (X[b3] - P[b3] - X[a3] + P[a3]) + dy * (X[b3 + 1] - P[b3 + 1] - X[a3 + 1] + P[a3 + 1]) + dz * (X[b3 + 2] - P[b3 + 2] - X[a3 + 2] + P[a3 + 2])) / len;
      const gamma = damp[c] * comp[c] / dt;
      const dl = -(len - rest[c] + gamma * vp) / ((1 + gamma) * wsum + comp[c] / dt2);
      const s = dl / len;
      X[a3] -= wa * s * dx; X[a3 + 1] -= wa * s * dy; X[a3 + 2] -= wa * s * dz;
      X[b3] += wb * s * dx; X[b3 + 1] += wb * s * dy; X[b3 + 2] += wb * s * dz;
      const el = len + wsum * dl - rest[c], lim = cey[c] * c0[c];
      if (el > lim || el < -lim) {
        let nr = rest[c] + (el > 0 ? el - lim : el + lim);
        const lo = MIN_RATIO * c0[c], hi = MAX_RATIO * c0[c];
        if (nr < lo) nr = lo; else if (nr > hi) nr = hi;
        const dW = ck[c] * lim * Math.abs(nr - rest[c]);   // yield force x plastic flow
        Wp += dW;
        if (multi) units[unitOfC[c]].Wp += dW;
        plastic[c] += Math.abs(nr - rest[c]) / c0[c];
        rest[c] = nr;
      }
    }

    // 3. mortar bonds (only those touching an awake brick can change)
    if (wall) {
      bondStamp++;
      let na = 0;
      for (let b = 0; b < nb; b++) {
        if (bstate[b] !== AWAKE) continue;
        for (let p = adjStart[b]; p < adjStart[b + 1]; p++) {
          const k = adjList[p];
          if (bondMark[k] !== bondStamp && !bondBroken[k]) { bondMark[k] = bondStamp; activeBonds[na++] = k; }
        }
      }
      for (let q = 0; q < na; q++) {
        const k = activeBonds[q];
        if (bondBroken[k]) continue;
        const a = bondA[k], b = bondB[k];
        const aw = bstate[a] === AWAKE, bwk = b >= 0 && bstate[b] === AWAKE;
        if (!aw && !bwk) continue;
        const k3 = 3 * k;
        rot(a, bondRa[k3], bondRa[k3 + 1], bondRa[k3 + 2], S3);
        let pbx, pby, pbz;
        if (b >= 0) { rot(b, bondRb[k3], bondRb[k3 + 1], bondRb[k3 + 2], S4); pbx = bc[3 * b] + S4[0]; pby = bc[3 * b + 1] + S4[1]; pbz = bc[3 * b + 2] + S4[2]; }
        else { pbx = bondFix[k3]; pby = bondFix[k3 + 1]; pbz = bondFix[k3 + 2]; }
        const dx = bc[3 * a] + S3[0] - pbx, dy = bc[3 * a + 1] + S3[1] - pby, dz = bc[3 * a + 2] + S3[2] - pbz;
        const L = Math.sqrt(dx * dx + dy * dy + dz * dz);
        if (L < 1e-10) continue;
        const nx = dx / L, ny = dy / L, nz = dz / L;
        const ra0 = S3[0], ra1 = S3[1], ra2 = S3[2];
        const wa = aw ? genInvMass(a, ra0, ra1, ra2, nx, ny, nz) : 0;
        const wb = bwk ? genInvMass(b, S4[0], S4[1], S4[2], nx, ny, nz) : 0;
        const dl = -L / (wa + wb + BOND_COMPLIANCE / dt2);
        // Force on brick a, split into joint-normal and shear parts. Mortar fails in tension or
        // shear; compression is carried by the bricks, and raises the shear capacity.
        const f = -dl / dt2;
        rot(a, bondN[k3], bondN[k3 + 1], bondN[k3 + 2], S5);
        const fn = -f * (nx * S5[0] + ny * S5[1] + nz * S5[2]);     // > 0: tension
        const fs = Math.sqrt(Math.max(0, f * f - fn * fn));
        const ratio = fn > 0 ? Math.hypot(fn, fs) / bondS[k] : fs / (bondS[k] - BOND_FRICTION * fn);
        if (ratio > 1) {
          // the bond lets go: no correction this step, its stored energy is released
          bondBroken[k] = 1; anyBreak = true;
          Wfrac += 0.5 * L * L / BOND_COMPLIANCE;
          pendingBreaks.push([pbx, pby, pbz, f, bm[a] + (b >= 0 ? bm[b] : 0)]);
          continue;
        }
        if (aw) applyCorr(a, ra0, ra1, ra2, dl * nx, dl * ny, dl * nz);
        if (bwk) applyCorr(b, S4[0], S4[1], S4[2], -dl * nx, -dl * ny, -dl * nz);
        if (ratio > 0.4) {   // a bond nearing failure wakes the brick on its other side
          if (!aw) wake(a);
          if (b >= 0 && !bwk) wake(b);
        }
      }
    }

    // 4. contacts (normal direction). Their energy loss is not booked separately: in PBD a contact
    //    correction also loads the springs, and the damped solver later dissipates that, so
    //    contact, structural damping and solver losses only make sense together (the
    //    "contactSolver" residual).
    if (wall) buildHash();
    if (world) nearWorld();
    const r = spec.nodeRadius, QR = r + 0.27;
    for (let a = 0; a < n; a++) {
      if (ghost[a]) continue;
      const a3 = 3 * a;
      const floor = wheelNode[a] ? wheelFloor[a] : clear[a];
      if (X[a3 + 1] < floor) {
        const d = floor - X[a3 + 1];
        X[a3 + 1] = floor;
        addContact(KIND_GROUND, a, -1, 0, 1, 0, d);
      }
      if (rigid) {
        if (X[a3] + r > 0 && X[a3 + 1] < RIGID_BARRIER.height && Math.abs(X[a3 + 2]) < RIGID_BARRIER.halfWidth) {
          const d = X[a3] + r;
          X[a3] = -r;
          addContact(KIND_BARRIER, a, -1, -1, 0, 0, d);
          const f = mass[a] * d / dt2;
          barrierForce += f;
          impAcc += f * dt; impX += f * dt * X[a3]; impY += f * dt * X[a3 + 1]; impZ += f * dt * X[a3 + 2];
          if (T0 < 0) T0 = t;
        }
        continue;
      }
      if (staticObs) { staticContact(a, a3, r, dt, dt2); continue; }
      if (!wall) continue;
      if (X[a3] < bbMin[0] - QR || X[a3] > bbMax[0] + QR || X[a3 + 1] > bbMax[1] + QR || X[a3 + 2] < bbMin[2] - QR || X[a3 + 2] > bbMax[2] + QR) continue;
      const ix0 = Math.floor((X[a3] - QR) / HCELL), ix1 = Math.floor((X[a3] + QR) / HCELL);
      const iy0 = Math.floor((X[a3 + 1] - QR) / HCELL), iy1 = Math.floor((X[a3 + 1] + QR) / HCELL);
      const iz0 = Math.floor((X[a3 + 2] - QR) / HCELL), iz1 = Math.floor((X[a3 + 2] + QR) / HCELL);
      for (let ix = ix0; ix <= ix1; ix++) for (let iy = iy0; iy <= iy1; iy++) for (let iz = iz0; iz <= iz1; iz++) {
        for (let b = hHead[hkey(ix, iy, iz)]; b >= 0; b = hNext[b]) {
          const b3 = 3 * b;
          const ddx = X[a3] - bc[b3], ddy = X[a3 + 1] - bc[b3 + 1], ddz = X[a3 + 2] - bc[b3 + 2];
          if (ddx * ddx + ddy * ddy + ddz * ddz > (r + 0.26) * (r + 0.26)) continue;
          rotInv(b, ddx, ddy, ddz, S3);
          const hx = bh[b3], hy = bh[b3 + 1], hz = bh[b3 + 2];
          let px = Math.max(-hx, Math.min(hx, S3[0])), py = Math.max(-hy, Math.min(hy, S3[1])), pz = Math.max(-hz, Math.min(hz, S3[2]));
          const ex = S3[0] - px, ey = S3[1] - py, ez = S3[2] - pz, d2 = ex * ex + ey * ey + ez * ez;
          let nlx = 0, nly = 0, nlz = 0, pen;
          if (d2 > 1e-12) {
            if (d2 >= r * r) continue;
            const d = Math.sqrt(d2);
            nlx = ex / d; nly = ey / d; nlz = ez / d; pen = r - d;
          } else {
            const fx = hx - Math.abs(S3[0]), fy = hy - Math.abs(S3[1]), fz = hz - Math.abs(S3[2]);
            if (fx <= fy && fx <= fz) { nlx = S3[0] < 0 ? -1 : 1; pen = fx + r; px = nlx * hx; }
            else if (fy <= fz) { nly = S3[1] < 0 ? -1 : 1; pen = fy + r; py = nly * hy; }
            else { nlz = S3[2] < 0 ? -1 : 1; pen = fz + r; pz = nlz * hz; }
          }
          rot(b, nlx, nly, nlz, S4);
          rot(b, px, py, pz, S5);
          // cancel this step's approach fully, but never push the contact apart faster than MAX_SEPARATION
          pointDisp(b, S5[0], S5[1], S5[2], S7);
          const appr = -((X[a3] - P[a3] - S7[0]) * S4[0] + (X[a3 + 1] - P[a3 + 1] - S7[1]) * S4[1] + (X[a3 + 2] - P[a3 + 2] - S7[2]) * S4[2]);
          pen = Math.min(pen, Math.max(0, appr + MAX_SEPARATION * dt));
          if (pen <= 0) continue;
          const awake = bstate[b] === AWAKE;
          const wb = awake ? genInvMass(b, S5[0], S5[1], S5[2], S4[0], S4[1], S4[2]) : 0;
          const dl = pen / (W[a] + wb);
          X[a3] += W[a] * dl * S4[0]; X[a3 + 1] += W[a] * dl * S4[1]; X[a3 + 2] += W[a] * dl * S4[2];
          if (awake) applyCorr(b, S5[0], S5[1], S5[2], -dl * S4[0], -dl * S4[1], -dl * S4[2]);
          else if (bstate[b] === DORMANT || dl / dt2 > 30) wake(b);
          addContact(KIND_NODE_BRICK, a, b, S4[0], S4[1], S4[2], dl, S5[0], S5[1], S5[2]);
          const f = dl / dt2;
          barrierForce += f * Math.max(0, -S4[0]);
          impAcc += f * dt; impX += f * dt * X[a3]; impY += f * dt * X[a3 + 1]; impZ += f * dt * X[a3 + 2];
          if (T0 < 0) T0 = t;
        }
      }
    }
    if (multi) carCarContacts(dt, dt2);
    if (wall) brickContacts(dt, dt2);
    if (nd) debrisContacts(dt, dt2);

    // 5. friction: energy lost = kinetic energy removed, minus what went into springs and height
    const keB = kinetic(dt);
    const ebB = wall ? brickStageEnergy() : 0;
    XS.set(X);
    frictionPass(dt);
    const keC = kinetic(dt);
    const ebC = wall ? brickStageEnergy() : 0;
    Qf += keB - keC - nodeStageDelta() - (ebC - ebB);

    // 6. velocities
    const idt = 1 / dt;
    for (let i = 0; i < 3 * n; i++) V[i] = (X[i] - P[i]) * idt;
    if (NB) {
      for (let b = 0; b < NB; b++) {
        if (bstate[b] !== AWAKE) continue;
        const i3 = 3 * b;
        bv[i3] = (bc[i3] - bcp[i3]) * idt; bv[i3 + 1] = (bc[i3 + 1] - bcp[i3 + 1]) * idt; bv[i3 + 2] = (bc[i3 + 2] - bcp[i3 + 2]) * idt;
        stepRotation(b, S3);
        bw[i3] = S3[0] * idt; bw[i3 + 1] = S3[1] * idt; bw[i3 + 2] = S3[2] * idt;
      }
      contactVelocityPass();
      if (anyBreak) { updateSupport(); anyBreak = false; }
      for (let b = 0; b < NB; b++) {
        if (bstate[b] !== AWAKE) continue;
        const i3 = 3 * b;
        const v2 = bv[i3] * bv[i3] + bv[i3 + 1] * bv[i3 + 1] + bv[i3 + 2] * bv[i3 + 2];
        const w2 = bw[i3] * bw[i3] + bw[i3 + 1] * bw[i3 + 1] + bw[i3 + 2] * bw[i3 + 2];
        bsleep[b] = (v2 < 0.0064 && w2 < 0.25) ? bsleep[b] + dt : 0;
        if (bsleep[b] > 0.15) {
          bstate[b] = (b < nb && bsupp[b] && hasIntactBond(b)) ? DORMANT : SLEEPING;
          bv[i3] = bv[i3 + 1] = bv[i3 + 2] = bw[i3] = bw[i3 + 1] = bw[i3 + 2] = 0;
        }
      }
    }
    if (nd && ++damageTick % 5 === 0) damageChecks(dt);
  }

  // World obstacles: keep the shapes near the vehicles and the awake debris for this step's contacts
  function nearWorld() {
    if (world.moving) placeWorld(world, t);
    let x0 = Infinity, x1 = -Infinity, z0 = Infinity, z1 = -Infinity;
    for (let a = 0; a < n; a++) {
      if (ghost[a]) continue;
      const x = X[3 * a], z = X[3 * a + 2];
      if (x < x0) x0 = x; if (x > x1) x1 = x; if (z < z0) z0 = z; if (z > z1) z1 = z;
    }
    for (let b = nb; b < NB; b++) {
      if (bstate[b] !== AWAKE) continue;
      const x = bc[3 * b], z = bc[3 * b + 2];
      if (x < x0) x0 = x; if (x > x1) x1 = x; if (z < z0) z0 = z; if (z > z1) z1 = z;
    }
    const m = 2.5;   // node radius, a step's travel and a part's reach from its centre
    world.active.length = 0;
    for (const s of world.shapes) if (s.x1 > x0 - m && s.x0 < x1 + m && s.z1 > z0 - m && s.z0 < z1 + m) world.active.push(s);
  }

  // A lattice node against the offset barrier (and its honeycomb face) or the pole.
  const G3 = [0, 0, 0];
  function staticContact(a, a3, r, dt, dt2) {
    if (hc) honeycombContact(a, a3, r, dt, dt2);
    const d = obstacleSDF(X[a3], X[a3 + 1], X[a3 + 2], G3);
    if (d >= r) return;
    // cancel this step's approach fully, but never push the node out faster than MAX_SEPARATION
    let appr = -((X[a3] - P[a3]) * G3[0] + (X[a3 + 2] - P[a3 + 2]) * G3[2]);
    // a roof (its normal points up) and a moving box (the approach is relative to it)
    const ny = G3[1], mv = world && world.moving && worldHit.vx !== undefined ? worldHit : null;
    if (ny) appr -= (X[a3 + 1] - P[a3 + 1]) * ny;
    if (mv) appr += (mv.vx * G3[0] + mv.vz * G3[2]) * dt;
    const pen = Math.min(r - d, Math.max(0, appr + MAX_SEPARATION * dt));
    if (pen <= 0) return;
    X[a3] += pen * G3[0]; X[a3 + 2] += pen * G3[2];
    if (ny) X[a3 + 1] += pen * ny;
    addContact(KIND_NODE_SURF, a, mv ? mv.i : -1, G3[0], ny, G3[2], pen);
    const f = mass[a] * pen / dt2;
    if (mv) Wmove += f * (mv.vx * G3[0] + mv.vz * G3[2]) * dt;
    barrierForce += (pole || world) ? f : f * Math.max(0, -G3[0]);
    impAcc += f * dt; impX += f * dt * X[a3]; impY += f * dt * X[a3 + 1]; impZ += f * dt * X[a3 + 2];
    if (T0 < 0) T0 = t;
  }
  // Crushable honeycomb face (the overlap lab's deformable barrier). A node presses on the cells
  // under its share of the lattice face. If stopping it needs more force than those cells carry,
  // they crush at their crush stress (constant force, like real honeycomb) and the node only slows
  // by that much; the crush work is booked. A cell counts towards one node per step, so the face
  // never pushes back harder than its stress times its area. Crushed to the last few centimetres,
  // a cell bottoms out and becomes rigid.
  let hcStamp = 0, Whc = 0;
  function cellStress(i, c) { return c < HONEYCOMB.bumper.depth && hc.depth[i] > HONEYCOMB.main.depth + 1e-6 ? HONEYCOMB.bumper.stress : HONEYCOMB.main.stress; }
  function crushWork(i, c0, c1) {   // work to crush cell i from c0 to c1 (J)
    const A = hc.h * hc.h, b = hc.depth[i] > HONEYCOMB.main.depth + 1e-6 ? HONEYCOMB.bumper.depth : 0;
    const inB = Math.max(0, Math.min(c1, b) - c0), rest = (c1 - c0) - inB;
    return A * (inB * HONEYCOMB.bumper.stress + rest * HONEYCOMB.main.stress);
  }
  function honeycombContact(a, a3, r, dt, dt2) {
    const lat = units[unitOf[a]].car, padY = 0.5 * lat.sy, padZ = 0.5 * lat.sz, h = hc.h;
    const s = -offset.side, w = s * (X[a3 + 2] - offset.zEdge), y = X[a3 + 1];
    const iz0 = Math.max(0, Math.ceil((-w - padZ) / h - 0.5)), iz1 = Math.min(hc.nzc - 1, Math.floor((-w + padZ) / h - 0.5));
    const iy0 = Math.max(0, Math.ceil((y - padY - hc.y0) / h - 0.5)), iy1 = Math.min(hc.nyc - 1, Math.floor((y + padY - hc.y0) / h - 0.5));
    if (iz0 > iz1 || iy0 > iy1) return;
    let xf = 0, cnt = 0, cap = 0, solid = false;
    for (let iy = iy0; iy <= iy1; iy++) for (let iz = iz0; iz <= iz1; iz++) {
      const i = iy * hc.nzc + iz, c = hc.crush[i];
      xf += c - hc.depth[i]; cnt++;
      if (c >= hc.depth[i] - HONEYCOMB.solid - 1e-9) solid = true;
      else if (hc.claim[i] !== hcStamp) cap += cellStress(i, c) * h * h;
    }
    xf /= cnt;
    let pen = X[a3] + r - xf;
    if (pen <= 0) return;
    pen = Math.min(pen, Math.max(0, X[a3] - P[a3] + MAX_SEPARATION * dt));
    if (pen <= 0) return;
    const need = mass[a] * pen, have = cap * dt2;
    const dx = solid || need <= have ? pen : have / mass[a];
    X[a3] -= dx;
    if (!solid && need > have) {
      // cells crush to the node's front, but by no more than the node moved forward this step: a
      // node sliding sideways into fresh honeycomb is pushed back by it rather than cutting through
      const front = X[a3] + r, adv = Math.max(0, X[a3] - P[a3]);
      for (let iy = iy0; iy <= iy1; iy++) for (let iz = iz0; iz <= iz1; iz++) {
        const i = iy * hc.nzc + iz;
        if (hc.claim[i] === hcStamp) continue;
        const c = hc.crush[i], c1 = Math.min(hc.depth[i] - HONEYCOMB.solid, front + hc.depth[i], c + adv);
        if (c1 > c) { Whc += crushWork(i, c, c1); hc.crush[i] = c1; }
        hc.claim[i] = hcStamp;
      }
    }
    addContact(KIND_BARRIER, a, -1, -1, 0, 0, dx);
    const f = mass[a] * dx / dt2;
    barrierForce += f;
    impAcc += f * dt; impX += f * dt * X[a3]; impY += f * dt * X[a3 + 1]; impZ += f * dt * X[a3 + 2];
    if (T0 < 0) T0 = t;
  }
  // Vehicle against vehicle: node spheres of different vehicles, found through a hash of the nodes
  // inside the overlap of their bounding boxes (empty until they meet).
  const NHASH = 8192, nHead = new Int32Array(NHASH), nNext = new Int32Array(multi ? n : 1), ubox = new Float64Array(6 * NU);
  const nkey = (ix, iy, iz) => ((ix * 73856093) ^ (iy * 19349663) ^ (iz * 83492791)) & (NHASH - 1);
  function carCarContacts(dt, dt2) {
    const D = 2 * spec.nodeRadius, D2 = D * D;
    for (let u = 0; u < NU; u++) for (let d = 0; d < 3; d++) { ubox[6 * u + d] = Infinity; ubox[6 * u + 3 + d] = -Infinity; }
    for (let a = 0; a < n; a++) {
      if (ghost[a]) continue;
      const o = 6 * unitOf[a];
      for (let d = 0; d < 3; d++) { const v = X[3 * a + d]; if (v < ubox[o + d]) ubox[o + d] = v; if (v > ubox[o + 3 + d]) ubox[o + 3 + d] = v; }
    }
    for (let u = 0; u < NU; u++) for (let v = u + 1; v < NU; v++) {
      const lo = [0, 0, 0], hi = [0, 0, 0];
      let empty = false;
      for (let d = 0; d < 3; d++) {
        lo[d] = Math.max(ubox[6 * u + d], ubox[6 * v + d]) - D; hi[d] = Math.min(ubox[6 * u + 3 + d], ubox[6 * v + 3 + d]) + D;
        if (lo[d] > hi[d]) empty = true;
      }
      if (empty) continue;
      const inside = (a) => X[3 * a] >= lo[0] && X[3 * a] <= hi[0] && X[3 * a + 1] >= lo[1] && X[3 * a + 1] <= hi[1] && X[3 * a + 2] >= lo[2] && X[3 * a + 2] <= hi[2];
      nHead.fill(-1);
      const Uv = units[v], Uu = units[u];
      for (let b = Uv.off; b < Uv.off + Uv.n; b++) {
        if (ghost[b] || !inside(b)) continue;
        const key = nkey(Math.floor(X[3 * b] / D), Math.floor(X[3 * b + 1] / D), Math.floor(X[3 * b + 2] / D));
        nNext[b] = nHead[key]; nHead[key] = b;
      }
      for (let a = Uu.off; a < Uu.off + Uu.n; a++) {
        if (ghost[a] || !inside(a)) continue;
        const a3 = 3 * a, cx = Math.floor(X[a3] / D), cy = Math.floor(X[a3 + 1] / D), cz = Math.floor(X[a3 + 2] / D);
        for (let ix = cx - 1; ix <= cx + 1; ix++) for (let iy = cy - 1; iy <= cy + 1; iy++) for (let iz = cz - 1; iz <= cz + 1; iz++) {
          for (let b = nHead[nkey(ix, iy, iz)]; b >= 0; b = nNext[b]) {
            const b3 = 3 * b;
            const dx = X[a3] - X[b3], dy = X[a3 + 1] - X[b3 + 1], dz = X[a3 + 2] - X[b3 + 2], d2 = dx * dx + dy * dy + dz * dz;
            if (d2 >= D2 || d2 < 1e-18) continue;
            const d = Math.sqrt(d2), nx = dx / d, ny = dy / d, nz = dz / d;
            const appr = -((X[a3] - P[a3] - X[b3] + P[b3]) * nx + (X[a3 + 1] - P[a3 + 1] - X[b3 + 1] + P[b3 + 1]) * ny + (X[a3 + 2] - P[a3 + 2] - X[b3 + 2] + P[b3 + 2]) * nz);
            const pen = Math.min(D - d, Math.max(0, appr + NODE_SEPARATION * dt));
            if (pen <= 0) continue;
            const wa = W[a], wb = W[b], dl = pen / (wa + wb);
            X[a3] += wa * dl * nx; X[a3 + 1] += wa * dl * ny; X[a3 + 2] += wa * dl * nz;
            X[b3] -= wb * dl * nx; X[b3 + 1] -= wb * dl * ny; X[b3 + 2] -= wb * dl * nz;
            addContact(KIND_NODE_NODE, a, b, nx, ny, nz, dl);
            const f = dl / dt2;
            Uu.force += f; Uv.force += f;
            impAcc += f * dt; impX += f * dt * 0.5 * (X[a3] + X[b3]); impY += f * dt * 0.5 * (X[a3 + 1] + X[b3 + 1]); impZ += f * dt * 0.5 * (X[a3 + 2] + X[b3 + 2]);
            if (T0 < 0) T0 = t;
          }
        }
      }
    }
  }

  function brickContacts(dt, dt2) {
    const SR = BRICK_SPHERE_R, QB = 0.42;   // centres closer than 2 x 0.1 offset + 2 x SR can touch
    for (let b = 0; b < nb; b++) {
      if (bstate[b] !== AWAKE) continue;
      const b3 = 3 * b, hx = bh[b3], hy = bh[b3 + 1], hz = bh[b3 + 2];
      // ground: the eight corners
      const vy = (bc[b3 + 1] - bcp[b3 + 1]) / dt;
      let hitGround = false;
      for (let c = 0; c < 8; c++) {
        rot(b, (c & 1 ? 1 : -1) * hx, (c & 2 ? 1 : -1) * hy, (c & 4 ? 1 : -1) * hz, S5);
        const cy = bc[b3 + 1] + S5[1];
        if (cy >= 0) continue;
        hitGround = true;
        pointDisp(b, S5[0], S5[1], S5[2], S7);
        const pen = Math.min(-cy, Math.max(0, MAX_SEPARATION * dt - S7[1]));
        if (pen <= 0) continue;
        const w = genInvMass(b, S5[0], S5[1], S5[2], 0, 1, 0);
        const dl = pen / w;
        applyCorr(b, S5[0], S5[1], S5[2], 0, dl, 0);
        addContact(KIND_BRICK_GROUND, b, -1, 0, 1, 0, dl, S5[0], S5[1], S5[2]);
      }
      if (hitGround && vy < -1.5 && t - bdebrisT[b] > 0.05) {
        bdebrisT[b] = t;
        events.push({ t, type: 'debris', x: bc[b3], y: 0, z: bc[b3 + 2], mag: -vy, mass: bm[b] });
      }
      // other bricks: two contact spheres along each brick's length; neighbours found once per brick.
      // Bricks joined by mortar collide too: in the wall their spheres are 1 cm apart, and a joint is
      // a hinge (its two bond points lie on a line) or, with one point left, a ball joint, so a brick
      // held by its last joint turns about it, into its neighbour if nothing stops it.
      const off = hz - hy > 0.01 ? hz - hy : 0;
      const cx = bc[b3], cy = bc[b3 + 1], cz = bc[b3 + 2];
      const ix0 = Math.floor((cx - QB) / HCELL), ix1 = Math.floor((cx + QB) / HCELL);
      const iy0 = Math.floor((cy - QB) / HCELL), iy1 = Math.floor((cy + QB) / HCELL);
      const iz0 = Math.floor((cz - QB) / HCELL), iz1 = Math.floor((cz + QB) / HCELL);
      for (let ix = ix0; ix <= ix1; ix++) for (let iy = iy0; iy <= iy1; iy++) for (let iz = iz0; iz <= iz1; iz++) {
        for (let o = hHead[hkey(ix, iy, iz)]; o >= 0; o = hNext[o]) {
          if (o === b || (bstate[o] === AWAKE && o < b)) continue;
          const o3 = 3 * o;
          const cdx = cx - bc[o3], cdy = cy - bc[o3 + 1], cdz = cz - bc[o3 + 2];
          if (cdx * cdx + cdy * cdy + cdz * cdz > QB * QB) continue;
          const offo = bh[o3 + 2] - bh[o3 + 1] > 0.01 ? bh[o3 + 2] - bh[o3 + 1] : 0;
          for (let s = 0; s < (off ? 2 : 1); s++) {
            rot(b, 0, 0, s ? off : -off, S5);
            const sx = bc[b3] + S5[0], sy = bc[b3 + 1] + S5[1], sz = bc[b3 + 2] + S5[2];
            for (let so = 0; so < (offo ? 2 : 1); so++) {
              rot(o, 0, 0, so ? offo : -offo, S6);
              const ox = bc[o3] + S6[0], oy = bc[o3 + 1] + S6[1], oz = bc[o3 + 2] + S6[2];
              const dx = sx - ox, dy = sy - oy, dz = sz - oz, d2 = dx * dx + dy * dy + dz * dz;
              if (d2 >= 4 * SR * SR || d2 < 1e-12) continue;
              const d = Math.sqrt(d2), nx = dx / d, ny = dy / d, nz = dz / d;
              const mx = 0.5 * (sx + ox), my = 0.5 * (sy + oy), mz = 0.5 * (sz + oz);
              const r1x = mx - bc[b3], r1y = my - bc[b3 + 1], r1z = mz - bc[b3 + 2];
              const r2x = mx - bc[o3], r2y = my - bc[o3 + 1], r2z = mz - bc[o3 + 2];
              pointDisp(b, r1x, r1y, r1z, S7); pointDisp(o, r2x, r2y, r2z, S8);
              const appr = -((S7[0] - S8[0]) * nx + (S7[1] - S8[1]) * ny + (S7[2] - S8[2]) * nz);
              const pen = Math.min(2 * SR - d, Math.max(0, appr + MAX_SEPARATION * dt));
              if (pen <= 0) continue;
              const oAwake = bstate[o] === AWAKE;
              const w1 = genInvMass(b, r1x, r1y, r1z, nx, ny, nz);
              const w2 = oAwake ? genInvMass(o, r2x, r2y, r2z, nx, ny, nz) : 0;
              const dl = pen / (w1 + w2);
              applyCorr(b, r1x, r1y, r1z, dl * nx, dl * ny, dl * nz);
              if (oAwake) applyCorr(o, r2x, r2y, r2z, -dl * nx, -dl * ny, -dl * nz);
              else if (dl / dt2 > WAKE_FORCE) wake(o);
              addContact(KIND_BRICK_BRICK, b, o, nx, ny, nz, dl, r1x, r1y, r1z, r2x, r2y, r2z);
            }
          }
        }
      }
    }
  }

  const muLat = cfg.sled ? MU_SLED : MU_TIRE, rollDir = new Float64Array(2 * NU);
  function frictionPass(dt) {
    const fh = Math.hypot(frame.f[0], frame.f[2]) || 1;
    let fx = frame.f[0] / fh, fz = frame.f[2] / fh, lx = -fz, lz = fx;
    if (multi) units.forEach((U, u) => { const h = Math.hypot(U.frame.f[0], U.frame.f[2]) || 1; rollDir[2 * u] = U.frame.f[0] / h; rollDir[2 * u + 1] = U.frame.f[2] / h; });
    for (let k = 0; k < nC; k++) {
      const kind = cKind[k], i = cI[k], k3 = 3 * k, lam = cLam[k];
      if (kind === KIND_GROUND) {
        const i3 = 3 * i, dx = X[i3] - P[i3], dz = X[i3 + 2] - P[i3 + 2];
        if (wheelNode[i]) {
          if (multi) { const u = unitOf[i]; fx = rollDir[2 * u]; fz = rollDir[2 * u + 1]; lx = -fz; lz = fx; }
          const tf = dx * fx + dz * fz, tl = dx * lx + dz * lz;
          const limF = muRoll[i] * lam, limL = muLat * lam;
          const rf = Math.abs(tf) <= limF ? tf : Math.sign(tf) * limF;
          const rl = Math.abs(tl) <= limL ? tl : Math.sign(tl) * limL;
          X[i3] -= rf * fx + rl * lx; X[i3 + 2] -= rf * fz + rl * lz;
        } else {
          const len = Math.hypot(dx, dz), lim = MU_BODY * lam;
          const s = len <= lim ? 1 : lim / len;
          X[i3] -= s * dx; X[i3 + 2] -= s * dz;
        }
      } else if (kind === KIND_BARRIER) {
        const i3 = 3 * i, dy = X[i3 + 1] - P[i3 + 1], dz = X[i3 + 2] - P[i3 + 2];
        const len = Math.hypot(dy, dz), lim = MU_WALL * lam;
        const s = len <= lim ? 1 : lim / len;
        X[i3 + 1] -= s * dy; X[i3 + 2] -= s * dz;
      } else if (kind === KIND_NODE_SURF) {
        const i3 = 3 * i, nx = cN[k3], nz = cN[k3 + 2], ny = cN[k3 + 1];
        let tx = X[i3] - P[i3], ty = X[i3 + 1] - P[i3 + 1], tz = X[i3 + 2] - P[i3 + 2];
        if (cJ[k] >= 0) { const sh = world.shapes[cJ[k]]; tx -= sh.vx * dt; tz -= sh.vz * dt; }   // sliding relative to a moving box
        if (ny) { const dn = tx * nx + ty * ny + tz * nz; tx -= dn * nx; ty -= dn * ny; tz -= dn * nz; }
        else { const dn = tx * nx + tz * nz; tx -= dn * nx; tz -= dn * nz; }
        const len = Math.hypot(tx, ty, tz), lim = MU_WALL * lam;
        const s = len <= lim ? 1 : lim / len;
        X[i3] -= s * tx; X[i3 + 1] -= s * ty; X[i3 + 2] -= s * tz;
      } else if (kind === KIND_NODE_NODE) {
        const j = cJ[k], i3 = 3 * i, j3 = 3 * j, nx = cN[k3], ny = cN[k3 + 1], nz = cN[k3 + 2];
        let tx = X[i3] - P[i3] - X[j3] + P[j3], ty = X[i3 + 1] - P[i3 + 1] - X[j3 + 1] + P[j3 + 1], tz = X[i3 + 2] - P[i3 + 2] - X[j3 + 2] + P[j3 + 2];
        const dn = tx * nx + ty * ny + tz * nz; tx -= dn * nx; ty -= dn * ny; tz -= dn * nz;
        const len = Math.hypot(tx, ty, tz);
        if (len < 1e-12) continue;
        tx /= len; ty /= len; tz /= len;
        const wi = W[i], wj = W[j], lt = Math.min(len / (wi + wj), MU_CAR * lam);
        X[i3] -= wi * lt * tx; X[i3 + 1] -= wi * lt * ty; X[i3 + 2] -= wi * lt * tz;
        X[j3] += wj * lt * tx; X[j3 + 1] += wj * lt * ty; X[j3 + 2] += wj * lt * tz;
      } else if (kind === KIND_NODE_BRICK) {
        const i3 = 3 * i, b = cJ[k], nx = cN[k3], ny = cN[k3 + 1], nz = cN[k3 + 2];
        const rx = cR1[k3], ry = cR1[k3 + 1], rz = cR1[k3 + 2];
        pointDisp(b, rx, ry, rz, S3);
        let tx = X[i3] - P[i3] - S3[0], ty = X[i3 + 1] - P[i3 + 1] - S3[1], tz = X[i3 + 2] - P[i3 + 2] - S3[2];
        const dn = tx * nx + ty * ny + tz * nz; tx -= dn * nx; ty -= dn * ny; tz -= dn * nz;
        const len = Math.hypot(tx, ty, tz);
        if (len < 1e-12) continue;
        tx /= len; ty /= len; tz /= len;
        const awake = bstate[b] === AWAKE;
        const wn = W[i], wb = awake ? genInvMass(b, rx, ry, rz, tx, ty, tz) : 0;
        const lamN = lam;   // node-brick lambda is already a positional impulse
        const lt = Math.min(len / (wn + wb), MU_BRICK * lamN);
        X[i3] -= wn * lt * tx; X[i3 + 1] -= wn * lt * ty; X[i3 + 2] -= wn * lt * tz;
        if (awake) applyCorr(b, rx, ry, rz, lt * tx, lt * ty, lt * tz);
      } else if (kind === KIND_BRICK_GROUND) {
        const rx = cR1[k3], ry = cR1[k3 + 1], rz = cR1[k3 + 2];
        pointDisp(i, rx, ry, rz, S3);
        let tx = S3[0], tz = S3[2];
        const len = Math.hypot(tx, tz);
        if (len < 1e-12) continue;
        tx /= len; tz /= len;
        const w = genInvMass(i, rx, ry, rz, tx, 0, tz);
        const lt = Math.min(len / w, MU_GROUND * lam);
        applyCorr(i, rx, ry, rz, -lt * tx, 0, -lt * tz);
      } else if (kind === KIND_BODY_BARRIER) {
        const rx = cR1[k3], ry = cR1[k3 + 1], rz = cR1[k3 + 2];
        pointDisp(i, rx, ry, rz, S3);
        let ty = S3[1], tz = S3[2];
        const len = Math.hypot(ty, tz);
        if (len < 1e-12) continue;
        ty /= len; tz /= len;
        const w = genInvMass(i, rx, ry, rz, 0, ty, tz);
        const lt = Math.min(len / w, MU_WALL * lam);
        applyCorr(i, rx, ry, rz, 0, -lt * ty, -lt * tz);
      } else if (kind === KIND_BODY_SURF) {
        const rx = cR1[k3], ry = cR1[k3 + 1], rz = cR1[k3 + 2], nx = cN[k3], ny = cN[k3 + 1], nz = cN[k3 + 2];
        pointDisp(i, rx, ry, rz, S3);
        let tx = S3[0], ty = S3[1], tz = S3[2];
        const dn = tx * nx + ty * ny + tz * nz; tx -= dn * nx; ty -= dn * ny; tz -= dn * nz;
        const len = Math.hypot(tx, ty, tz);
        if (len < 1e-12) continue;
        tx /= len; ty /= len; tz /= len;
        const w = genInvMass(i, rx, ry, rz, tx, ty, tz);
        const lt = Math.min(len / w, MU_WALL * lam);
        applyCorr(i, rx, ry, rz, -lt * tx, -lt * ty, -lt * tz);
      } else if (kind === KIND_BRICK_BRICK) {
        const o = cJ[k], nx = cN[k3], ny = cN[k3 + 1], nz = cN[k3 + 2];
        const r1x = cR1[k3], r1y = cR1[k3 + 1], r1z = cR1[k3 + 2], r2x = cR2[k3], r2y = cR2[k3 + 1], r2z = cR2[k3 + 2];
        pointDisp(i, r1x, r1y, r1z, S3); pointDisp(o, r2x, r2y, r2z, S4);
        let tx = S3[0] - S4[0], ty = S3[1] - S4[1], tz = S3[2] - S4[2];
        const dn = tx * nx + ty * ny + tz * nz; tx -= dn * nx; ty -= dn * ny; tz -= dn * nz;
        const len = Math.hypot(tx, ty, tz);
        if (len < 1e-12) continue;
        tx /= len; ty /= len; tz /= len;
        const oAwake = bstate[o] === AWAKE;
        const w = genInvMass(i, r1x, r1y, r1z, tx, ty, tz) + (oAwake ? genInvMass(o, r2x, r2y, r2z, tx, ty, tz) : 0);
        const lt = Math.min(len / w, MU_BRICK * lam);
        applyCorr(i, r1x, r1y, r1z, -lt * tx, -lt * ty, -lt * tz);
        if (oAwake) applyCorr(o, r2x, r2y, r2z, lt * tx, lt * ty, lt * tz);
      }
    }
  }

  // Velocity pass (Müller et al. 2020): a position correction must not leave a contact separating
  // faster than it was moving before the step, or resting debris gets pumped with energy.
  function velImpulse(b, rx, ry, rz, px, py, pz) {
    const i3 = 3 * b, im = binvM[b];
    bv[i3] += px * im; bv[i3 + 1] += py * im; bv[i3 + 2] += pz * im;
    rotInv(b, ry * pz - rz * py, rz * px - rx * pz, rx * py - ry * px, S1);
    rot(b, S1[0] * binvI[i3], S1[1] * binvI[i3 + 1], S1[2] * binvI[i3 + 2], S2);
    bw[i3] += S2[0]; bw[i3 + 1] += S2[1]; bw[i3 + 2] += S2[2];
  }
  function contactVelocityPass() {
    for (let k = 0; k < nC; k++) {
      const kind = cKind[k];
      if (kind < KIND_NODE_BRICK) continue;
      const i = cI[k], j = cJ[k], k3 = 3 * k;
      const nx = cN[k3], ny = cN[k3 + 1], nz = cN[k3 + 2];
      const r1x = cR1[k3], r1y = cR1[k3 + 1], r1z = cR1[k3 + 2], r2x = cR2[k3], r2y = cR2[k3 + 1], r2z = cR2[k3 + 2];
      const vn = relNormalVel(kind, i, j, nx, ny, nz, r1x, r1y, r1z, r2x, r2y, r2z);
      const target = Math.max(0, cVpre[k]);
      if (vn <= target + 1e-6) continue;
      let w1, w2 = 0;
      if (kind === KIND_NODE_BRICK) { w1 = W[i]; if (bstate[j] === AWAKE) w2 = genInvMass(j, r1x, r1y, r1z, nx, ny, nz); }
      else if (kind === KIND_BRICK_GROUND || kind === KIND_BODY_BARRIER || kind === KIND_BODY_SURF) w1 = genInvMass(i, r1x, r1y, r1z, nx, ny, nz);
      else { w1 = genInvMass(i, r1x, r1y, r1z, nx, ny, nz); if (bstate[j] === AWAKE) w2 = genInvMass(j, r2x, r2y, r2z, nx, ny, nz); }
      const p = (target - vn) / (w1 + w2);
      if (kind === KIND_NODE_BRICK) {
        V[3 * i] += W[i] * p * nx; V[3 * i + 1] += W[i] * p * ny; V[3 * i + 2] += W[i] * p * nz;
        if (w2) velImpulse(j, r1x, r1y, r1z, -p * nx, -p * ny, -p * nz);
      } else if (kind === KIND_BRICK_GROUND || kind === KIND_BODY_BARRIER || kind === KIND_BODY_SURF) velImpulse(i, r1x, r1y, r1z, p * nx, p * ny, p * nz);
      else {
        velImpulse(i, r1x, r1y, r1z, p * nx, p * ny, p * nz);
        if (w2) velImpulse(j, r2x, r2y, r2z, -p * nx, -p * ny, -p * nz);
      }
    }
  }

  // Bricks with no bonded path to the footing or pillars fall (as connected clusters).
  function updateSupport() {
    bsupp.fill(0);
    const queue = [];
    for (let k = 0; k < bondA.length; k++) {
      if (!bondBroken[k] && bondB[k] < 0 && !bsupp[bondA[k]]) { bsupp[bondA[k]] = 1; queue.push(bondA[k]); }
    }
    for (let qi = 0; qi < queue.length; qi++) {
      const b = queue[qi];
      for (let p = adjStart[b]; p < adjStart[b + 1]; p++) {
        const k = adjList[p];
        if (bondBroken[k]) continue;
        const o = bondA[k] === b ? bondB[k] : bondA[k];
        if (o >= 0 && !bsupp[o]) { bsupp[o] = 1; queue.push(o); }
      }
    }
    for (let b = 0; b < nb; b++) if (!bsupp[b] && bstate[b] !== AWAKE) wake(b);
  }

  // ---------------------------------------------------------------- destruction
  // Spin energy of the attached wheels (they are lattice nodes, so their spin isn't simulated):
  // counted from the start so that a wheel coming off, already spinning, adds no energy.
  function wheelSpinEnergy() {
    let e = 0;
    for (const cw of corners) {
      if (cw.body >= 0) continue;
      let vx = 0, vz = 0;
      for (const a of cw.nodes) { vx += V[3 * a]; vz += V[3 * a + 2]; }
      const fr = cw.U.frame, w = (vx * fr.f[0] + vz * fr.f[2]) / cw.nodes.length / cw.U.spec.wheelRadius;
      e += 0.5 * cw.U.IW * w * w;
    }
    return e;
  }
  function meanPlastic(list) {
    let sum = 0;
    for (let q = 0; q < list.length; q++) sum += plastic[list[q]];
    return list.length ? sum / list.length : 0;
  }
  // Is a world point inside (or within d of) a brick?
  function brickNear(x, y, z, d) {
    if (!wall || x < bbMin[0] - 0.4 || x > bbMax[0] + 0.4 || y > bbMax[1] + 0.4 || z < bbMin[2] - 0.4 || z > bbMax[2] + 0.4) return false;
    const R = d + 0.3;
    for (let ix = Math.floor((x - R) / HCELL); ix <= Math.floor((x + R) / HCELL); ix++)
      for (let iy = Math.floor((y - R) / HCELL); iy <= Math.floor((y + R) / HCELL); iy++)
        for (let iz = Math.floor((z - R) / HCELL); iz <= Math.floor((z + R) / HCELL); iz++)
          for (let o = hHead[hkey(ix, iy, iz)]; o >= 0; o = hNext[o]) {
            const o3 = 3 * o;
            rotInv(o, x - bc[o3], y - bc[o3 + 1], z - bc[o3 + 2], S3);
            const ex = Math.max(0, Math.abs(S3[0]) - bh[o3]), ey = Math.max(0, Math.abs(S3[1]) - bh[o3 + 1]), ez = Math.max(0, Math.abs(S3[2]) - bh[o3 + 2]);
            if (ex * ex + ey * ey + ez * ez <= d * d) return true;
          }
    return false;
  }
  // A brick reaching the rim from the front or side (one lying under the tyre doesn't count).
  function brickAtRim(x, y, z, rim) {
    if (!wall || x < bbMin[0] - 0.6 || x > bbMax[0] + 0.6 || z < bbMin[2] - 0.6 || z > bbMax[2] + 0.6) return false;
    const Rq = rim + 0.3;
    for (let ix = Math.floor((x - Rq) / HCELL); ix <= Math.floor((x + Rq) / HCELL); ix++)
      for (let iy = Math.floor((y - Rq) / HCELL); iy <= Math.floor((y + Rq) / HCELL); iy++)
        for (let iz = Math.floor((z - Rq) / HCELL); iz <= Math.floor((z + Rq) / HCELL); iz++)
          for (let o = hHead[hkey(ix, iy, iz)]; o >= 0; o = hNext[o]) {
            const o3 = 3 * o;
            rotInv(o, x - bc[o3], y - bc[o3 + 1], z - bc[o3 + 2], S3);
            const px = Math.max(-bh[o3], Math.min(bh[o3], S3[0])), py = Math.max(-bh[o3 + 1], Math.min(bh[o3 + 1], S3[1])), pz = Math.max(-bh[o3 + 2], Math.min(bh[o3 + 2], S3[2]));
            const dx = S3[0] - px, dy = S3[1] - py, dz = S3[2] - pz;
            if (dx * dx + dy * dy + dz * dz > rim * rim) continue;
            rot(o, px, py, pz, S4);
            if (bc[o3 + 1] + S4[1] > y - 0.5 * rim) return true;
          }
    return false;
  }
  function sticksIntoObstacle(p) {
    const m = Math.min(16, p.emb.m);
    for (let q = 0; q < m; q++) {
      embeddedPos(X, p.emb.idx, 8 * q, p.emb.t, 3 * q, S2);
      if (rigid ? (S2[0] > 0.02 && S2[1] < RIGID_BARRIER.height && Math.abs(S2[2]) < RIGID_BARRIER.halfWidth) : staticObs ? obstacleSDF(S2[0], S2[1], S2[2], G3) < -0.02 : brickNear(S2[0], S2[1], S2[2], 0)) return true;
    }
    return false;
  }
  // how far a wheel hub has been shoved back towards the cabin (m)
  function hubBack(cw, hub) {
    embeddedPos(X, cw.emb.idx, 0, cw.emb.t, 0, hub);
    const fr = cw.U.frame;
    return cw.restBack - ((hub[0] - fr.o[0]) * fr.f[0] + (hub[1] - fr.o[1]) * fr.f[1] + (hub[2] - fr.o[2]) * fr.f[2]);
  }
  function damageChecks() {
    for (const p of parts) {
      if (p.body !== -1) continue;
      if (meanPlastic(p.anchors) > p.limit || (p.breakaway && sticksIntoObstacle(p))) checked(p.name, () => spawnPart(p));
    }
    for (const cw of corners) {
      if (cw.body >= 0) continue;
      const spec = cw.U.spec, pushScale = cw.U.pushScale, dmg = cw.U.dmg;
      const R = spec.wheelRadius, flat = spec.rimRadius + TYRE_FLAT * (R - spec.rimRadius);
      const back = hubBack(cw, S1);
      if (back > (cw.maxBack || 0)) cw.maxBack = back;
      if (cw.burst < 0) {
        const rimHit = rigid ? (S1[0] + spec.rimRadius > 0 && Math.abs(S1[2]) < RIGID_BARRIER.halfWidth)
          : staticObs ? obstacleSDF(S1[0], S1[1], S1[2], G3) < spec.rimRadius : brickAtRim(S1[0], S1[1], S1[2], spec.rimRadius);
        if (rimHit || back > WHEEL_PUSH_BURST * pushScale) {
          cw.burst = t;
          for (const a of cw.nodes) muRoll[a] = 0.3;
          events.push({ t, type: 'burst', x: S1[0], y: S1[1], z: S1[2], mag: 1, mass: spec.wheelCornerMass, part: 'Wheel' + cw.key });
        }
      }
      if (cw.burst >= 0) {   // the tyre goes flat over 50 ms
        const f = Math.min(1, (t - cw.burst) / 0.05);
        for (const a of cw.nodes) wheelFloor[a] = R - (R - flat) * f;
      }
      if (meanPlastic(cw.anchors) > WHEEL_DETACH_STRAIN * dmg || back > WHEEL_PUSH_DETACH * pushScale) checked('Wheel' + cw.key, () => spawnWheel(cw));
    }
  }
  function setNodeMass(a, m) {
    mass[a] = m; W[a] = 1 / m;
    for (let q = incStart[a]; q < incStart[a + 1]; q++) {
      const c = incList[q], ma = mass[ca[c]], mb = mass[cb[c]];
      damp[c] = ZETA * 2 * Math.sqrt(ck[c] * ma * mb / (ma + mb));
    }
  }
  // Start body b from removed point masses: position, orientation (principal axes), velocity and
  // spin from their momentum. Returns the kinetic energy lost (>= 0, booked as fracture).
  function startBody(b, M, cx, cy, cz, Px, Py, Pz, Lx, Ly, Lz, I6, keRemoved, peRemoved, isotropic) {
    let rows, inv;
    if (isotropic) { rows = null; inv = [1 / I6, 1 / I6, 1 / I6]; }
    else {
      const e = eigSym3(I6), floor = M * 0.02 * 0.02;
      rows = e.vec; inv = e.val.map(v => 1 / Math.max(floor, v));
    }
    const b3 = 3 * b, b4 = 4 * b;
    bc[b3] = cx; bc[b3 + 1] = cy; bc[b3 + 2] = cz;
    if (isotropic) { const q = isotropic; bq[b4] = q[0]; bq[b4 + 1] = q[1]; bq[b4 + 2] = q[2]; bq[b4 + 3] = q[3]; }
    else { const q = quatFromMatrix(rows); bq[b4] = q[0]; bq[b4 + 1] = q[1]; bq[b4 + 2] = q[2]; bq[b4 + 3] = q[3]; }
    for (let d = 0; d < 3; d++) { bcp[b3 + d] = bc[b3 + d]; binvI[b3 + d] = inv[d]; }
    for (let d = 0; d < 4; d++) bqp[b4 + d] = bq[b4 + d];
    bm[b] = M; binvM[b] = 1 / M;
    bv[b3] = Px / M; bv[b3 + 1] = Py / M; bv[b3 + 2] = Pz / M;
    // omega = I^-1 L (world), via the body frame
    rotInv(b, Lx, Ly, Lz, S3);
    rot(b, S3[0] * inv[0], S3[1] * inv[1], S3[2] * inv[2], S4);
    bw[b3] = S4[0]; bw[b3 + 1] = S4[1]; bw[b3 + 2] = S4[2];
    const keT = 0.5 * (Px * Px + Py * Py + Pz * Pz) / M;
    let keR = 0.5 * (S3[0] * S3[0] * inv[0] + S3[1] * S3[1] * inv[1] + S3[2] * S3[2] * inv[2]);
    if (keT + keR > keRemoved && keR > 0) {   // never more energy than the nodes gave up
      const f = Math.sqrt(Math.max(0, keRemoved - keT) / keR);
      bw[b3] *= f; bw[b3 + 1] *= f; bw[b3 + 2] *= f; keR *= f * f;
    }
    by0[b] = cy - peRemoved / (M * G);   // potential energy carries over exactly
    bstate[b] = AWAKE; bsleep[b] = 0;
    return Math.max(0, keRemoved - keT - keR);
  }
  const spawnChecks = [];
  function totals() {
    let px = 0, py = 0, pz = 0;
    for (let a = 0; a < n; a++) { px += mass[a] * V[3 * a]; py += mass[a] * V[3 * a + 1]; pz += mass[a] * V[3 * a + 2]; }
    for (let b = 0; b < NB; b++) if (bstate[b] === AWAKE) { px += bm[b] * bv[3 * b]; py += bm[b] * bv[3 * b + 1]; pz += bm[b] * bv[3 * b + 2]; }
    const e = energies();
    return { p: [px, py, pz], e: e.ekCar + e.eEl + e.peCar + e.ekB + e.peB + e.eBond + Wp + Wfrac + Qf + Whc };
  }
  function checked(name, fn) {
    if (!cfg.checkSpawns) { fn(); return; }
    const a = totals();
    fn();
    const b = totals();
    spawnChecks.push({ name, t, dP: Math.hypot(b.p[0] - a.p[0], b.p[1] - a.p[1], b.p[2] - a.p[2]), P: Math.hypot(a.p[0], a.p[1], a.p[2]), dE: b.e - a.e });
  }
  function spawnPart(p) {
    const b = p.bi;
    let M = 0;
    const take = new Float64Array(p.nodes.length);
    for (let q = 0; q < p.nodes.length; q++) {
      const a = p.nodes[q];
      take[q] = Math.max(0, Math.min(p.mass * p.share[q], mass[a] - 0.3 * mass0[a]));
      M += take[q];
    }
    if (M < 0.2) { p.body = -2; return; }   // nothing left to take: it stays on
    let cx = 0, cy = 0, cz = 0, Px = 0, Py = 0, Pz = 0, ke = 0, pe = 0;
    for (let q = 0; q < p.nodes.length; q++) {
      const a = p.nodes[q], m = take[q], a3 = 3 * a;
      cx += m * X[a3]; cy += m * X[a3 + 1]; cz += m * X[a3 + 2];
      Px += m * V[a3]; Py += m * V[a3 + 1]; Pz += m * V[a3 + 2];
      ke += 0.5 * m * (V[a3] * V[a3] + V[a3 + 1] * V[a3 + 1] + V[a3 + 2] * V[a3 + 2]);
      pe += m * G * (X[a3 + 1] - y0[a]);
    }
    cx /= M; cy /= M; cz /= M;
    // angular momentum and inertia of the removed point masses, plus the panel's own spread
    // (more inertia only lowers the spin, so the body never gains energy)
    let Lx = 0, Ly = 0, Lz = 0;
    const I6 = [0, 0, 0, 0, 0, 0];
    const addI = (m, rx, ry, rz) => {
      I6[0] += m * (ry * ry + rz * rz); I6[1] -= m * rx * ry; I6[2] -= m * rx * rz;
      I6[3] += m * (rx * rx + rz * rz); I6[4] -= m * ry * rz; I6[5] += m * (rx * rx + ry * ry);
    };
    for (let q = 0; q < p.nodes.length; q++) {
      const a = p.nodes[q], m = take[q], a3 = 3 * a;
      const rx = X[a3] - cx, ry = X[a3 + 1] - cy, rz = X[a3 + 2] - cz;
      Lx += m * (ry * V[a3 + 2] - rz * V[a3 + 1]); Ly += m * (rz * V[a3] - rx * V[a3 + 2]); Lz += m * (rx * V[a3 + 1] - ry * V[a3]);
      addI(m, rx, ry, rz);
    }
    const sw = 0.5 * M / p.emb.m, world = new Float64Array(3 * p.emb.m);
    for (let q = 0; q < p.emb.m; q++) {
      embeddedPos(X, p.emb.idx, 8 * q, p.emb.t, 3 * q, S2);
      world[3 * q] = S2[0]; world[3 * q + 1] = S2[1]; world[3 * q + 2] = S2[2];
      addI(sw, S2[0] - cx, S2[1] - cy, S2[2] - cz);
    }
    Wfrac += startBody(b, M, cx, cy, cz, Px, Py, Pz, Lx, Ly, Lz, I6, ke, pe, null);
    // contact points: the first 12 surface samples (farthest-point order: they span the part)
    const np = Math.min(12, p.emb.m), pts = new Float64Array(3 * np);
    for (let q = 0; q < np; q++) {
      rotInv(b, world[3 * q] - cx, world[3 * q + 1] - cy, world[3 * q + 2] - cz, S3);
      pts[3 * q] = S3[0]; pts[3 * q + 1] = S3[1]; pts[3 * q + 2] = S3[2];
    }
    bkind[b] = 1; bpts[b] = pts;
    for (let q = 0; q < p.nodes.length; q++) setNodeMass(p.nodes[q], mass[p.nodes[q]] - take[q]);
    p.body = b; p.t = t;
    debris.push({ name: p.name, kind: 'part', unit: p.unit, body: b, t, X: Float32Array.from(X), pos: [bc[3 * b], bc[3 * b + 1], bc[3 * b + 2]], quat: Array.from(bq.subarray(4 * b, 4 * b + 4)) });
    events.push({ t, type: 'detach', x: cx, y: cy, z: cz, mag: Math.hypot(Px, Py, Pz) / M, mass: M, part: p.name });
  }
  function spawnWheel(cw) {
    const spec = cw.U.spec, frame = cw.U.frame, IW = cw.U.IW;
    const b = cw.bi, M = spec.wheelCornerMass, m = M / cw.nodes.length;
    let Px = 0, Py = 0, Pz = 0, ke = 0, pe = 0;
    for (const a of cw.nodes) {
      const a3 = 3 * a;
      Px += m * V[a3]; Py += m * V[a3 + 1]; Pz += m * V[a3 + 2];
      ke += 0.5 * m * (V[a3] * V[a3] + V[a3 + 1] * V[a3 + 1] + V[a3 + 2] * V[a3 + 2]);
      pe += m * G * (X[a3 + 1] - y0[a]);
    }
    hubBack(cw, S1);
    // body frame: z along the axle, outboard; x along the car
    const s = cw.right ? 1 : -1;
    const ez = [s * frame.l[0], s * frame.l[1], s * frame.l[2]], ex = [frame.f[0], frame.f[1], frame.f[2]];
    const ey = [ez[1] * ex[2] - ez[2] * ex[1], ez[2] * ex[0] - ez[0] * ex[2], ez[0] * ex[1] - ez[1] * ex[0]];
    const q = quatFromMatrix([[ex[0], ey[0], ez[0]], [ex[1], ey[1], ez[1]], [ex[2], ey[2], ez[2]]]);
    // rolling spin about the axle, exactly the spin counted for it so far (see wheelSpinEnergy)
    const R = spec.wheelRadius, fh = Math.hypot(frame.f[0], frame.f[2]);
    const wl = (Px / M * frame.f[0] + Pz / M * frame.f[2]) / R;
    const Lx = IW * wl * frame.f[2] / fh, Lz = -IW * wl * frame.f[0] / fh;
    const keSpin = 0.5 * IW * wl * wl;
    Wfrac += startBody(b, M, S1[0], S1[1], S1[2], Px, Py, Pz, Lx, 0, Lz, IW, ke + keSpin, pe, q);
    const flat = spec.rimRadius + TYRE_FLAT * (R - spec.rimRadius);
    bkind[b] = 2; bwheel[2 * b] = cw.burst >= 0 ? flat : R; bwheel[2 * b + 1] = 0.5 * spec.tireWidth;
    for (const a of cw.nodes) { setNodeMass(a, mass[a] - m); wheelNode[a] = 0; muRoll[a] = MU_ROLL; }
    cw.body = b; cw.t = t;
    debris.push({ name: 'RIGID_Mech_Wheel', key: cw.key, kind: 'wheel', unit: cw.unit, body: b, t, burst: cw.burst, pos: [bc[3 * b], bc[3 * b + 1], bc[3 * b + 2]], quat: Array.from(bq.subarray(4 * b, 4 * b + 4)) });
    events.push({ t, type: 'detach', x: S1[0], y: S1[1], z: S1[2], mag: Math.hypot(Px, Py, Pz) / M, mass: M, part: 'Wheel' + cw.key });
  }
  // Contact points of a debris body, as world offsets from its centre. A wheel uses the lowest point
  // of each tread edge (so it rolls smoothly), the point of each edge nearest the barrier, and 8
  // points around each edge (so it can lie on its side).
  const PT = new Float64Array(3 * 24);
  function bodyPoints(b, out) {
    if (bkind[b] === 1) {
      const L = bpts[b], np = L.length / 3;
      for (let q = 0; q < np; q++) { rot(b, L[3 * q], L[3 * q + 1], L[3 * q + 2], S5); out[3 * q] = S5[0]; out[3 * q + 1] = S5[1]; out[3 * q + 2] = S5[2]; }
      return np;
    }
    const R = bwheel[2 * b], hw = bwheel[2 * b + 1];
    rot(b, 0, 0, 1, S6);
    const ax = S6[0], ay = S6[1], az = S6[2];
    let np = 0;
    const push = (x, y, z) => { out[3 * np] = x; out[3 * np + 1] = y; out[3 * np + 2] = z; np++; };
    for (const side of [-1, 1]) {
      let dx = ay * ax, dy = -1 + ay * ay, dz = ay * az, dl = Math.hypot(dx, dy, dz);
      if (dl > 0.15) push(side * hw * ax + R * dx / dl, side * hw * ay + R * dy / dl, side * hw * az + R * dz / dl);
      if (rigid) {
        dx = 1 - ax * ax; dy = -ax * ay; dz = -ax * az; dl = Math.hypot(dx, dy, dz);
        if (dl > 0.15) push(side * hw * ax + R * dx / dl, side * hw * ay + R * dy / dl, side * hw * az + R * dz / dl);
      }
      for (let k = 0; k < 8; k++) { rot(b, R * Math.cos(k * Math.PI / 4), R * Math.sin(k * Math.PI / 4), side * hw, S5); push(S5[0], S5[1], S5[2]); }
    }
    return np;
  }
  function debrisContacts(dt, dt2) {
    for (let b = nb; b < NB; b++) {
      if (bstate[b] !== AWAKE) continue;
      const np = bodyPoints(b, PT);
      for (let q = 0; q < np; q++) contactPoint(b, PT[3 * q], PT[3 * q + 1], PT[3 * q + 2], dt, dt2);
    }
  }
  const PR = 0.02;   // contact radius of a debris point against a brick
  function contactPoint(b, rx, ry, rz, dt, dt2) {
    const b3 = 3 * b, wx = bc[b3] + rx, wy = bc[b3 + 1] + ry, wz = bc[b3 + 2] + rz;
    if (wy < 0) {
      pointDisp(b, rx, ry, rz, S7);
      const pen = Math.min(-wy, Math.max(0, MAX_SEPARATION * dt - S7[1]));
      if (pen > 0) {
        const dl = pen / genInvMass(b, rx, ry, rz, 0, 1, 0);
        applyCorr(b, rx, ry, rz, 0, dl, 0);
        addContact(KIND_BRICK_GROUND, b, -1, 0, 1, 0, dl, rx, ry, rz);
      }
    }
    if (rigid) {
      if (wx > 0 && wy < RIGID_BARRIER.height && Math.abs(wz) < RIGID_BARRIER.halfWidth) {
        pointDisp(b, rx, ry, rz, S7);
        const pen = Math.min(wx, Math.max(0, MAX_SEPARATION * dt + S7[0]));
        if (pen > 0) {
          const dl = pen / genInvMass(b, rx, ry, rz, -1, 0, 0);
          applyCorr(b, rx, ry, rz, -dl, 0, 0);
          addContact(KIND_BODY_BARRIER, b, -1, -1, 0, 0, dl, rx, ry, rz);
        }
      }
      return;
    }
    if (staticObs) {
      const d = obstacleSDF(wx, wy, wz, G3);
      if (d < 0 && G3[1]) {
        // on a box's roof (a bus or tanker in the Destruction mode)
        pointDisp(b, rx, ry, rz, S7);
        const nx = G3[0], ny = G3[1], nz = G3[2], pen = Math.min(-d, Math.max(0, MAX_SEPARATION * dt - (S7[0] * nx + S7[1] * ny + S7[2] * nz)));
        if (pen > 0) {
          const dl = pen / genInvMass(b, rx, ry, rz, nx, ny, nz);
          applyCorr(b, rx, ry, rz, dl * nx, dl * ny, dl * nz);
          addContact(KIND_BODY_SURF, b, -1, nx, ny, nz, dl, rx, ry, rz);
        }
      } else if (d < 0) {
        pointDisp(b, rx, ry, rz, S7);
        const pen = Math.min(-d, Math.max(0, MAX_SEPARATION * dt - (S7[0] * G3[0] + S7[2] * G3[2])));
        if (pen > 0) {
          const nx = G3[0], nz = G3[2], dl = pen / genInvMass(b, rx, ry, rz, nx, 0, nz);
          applyCorr(b, rx, ry, rz, dl * nx, 0, dl * nz);
          addContact(KIND_BODY_SURF, b, -1, nx, 0, nz, dl, rx, ry, rz);
        }
      }
      return;
    }
    if (!wall) return;
    if (wx < bbMin[0] - 0.4 || wx > bbMax[0] + 0.4 || wy > bbMax[1] + 0.4 || wz < bbMin[2] - 0.4 || wz > bbMax[2] + 0.4) return;
    const QR2 = PR + 0.27;
    for (let ix = Math.floor((wx - QR2) / HCELL); ix <= Math.floor((wx + QR2) / HCELL); ix++)
      for (let iy = Math.floor((wy - QR2) / HCELL); iy <= Math.floor((wy + QR2) / HCELL); iy++)
        for (let iz = Math.floor((wz - QR2) / HCELL); iz <= Math.floor((wz + QR2) / HCELL); iz++)
          for (let o = hHead[hkey(ix, iy, iz)]; o >= 0; o = hNext[o]) {
            const o3 = 3 * o;
            const ddx = wx - bc[o3], ddy = wy - bc[o3 + 1], ddz = wz - bc[o3 + 2];
            if (ddx * ddx + ddy * ddy + ddz * ddz > (PR + 0.26) * (PR + 0.26)) continue;
            rotInv(o, ddx, ddy, ddz, S3);
            const hx = bh[o3], hy = bh[o3 + 1], hz = bh[o3 + 2];
            let px = Math.max(-hx, Math.min(hx, S3[0])), py = Math.max(-hy, Math.min(hy, S3[1])), pz = Math.max(-hz, Math.min(hz, S3[2]));
            const ex = S3[0] - px, ey = S3[1] - py, ez = S3[2] - pz, d2 = ex * ex + ey * ey + ez * ez;
            let nlx = 0, nly = 0, nlz = 0, pen;
            if (d2 > 1e-12) {
              if (d2 >= PR * PR) continue;
              const d = Math.sqrt(d2);
              nlx = ex / d; nly = ey / d; nlz = ez / d; pen = PR - d;
            } else {
              const fx = hx - Math.abs(S3[0]), fy = hy - Math.abs(S3[1]), fz = hz - Math.abs(S3[2]);
              if (fx <= fy && fx <= fz) { nlx = S3[0] < 0 ? -1 : 1; pen = fx + PR; px = nlx * hx; }
              else if (fy <= fz) { nly = S3[1] < 0 ? -1 : 1; pen = fy + PR; py = nly * hy; }
              else { nlz = S3[2] < 0 ? -1 : 1; pen = fz + PR; pz = nlz * hz; }
            }
            rot(o, nlx, nly, nlz, S4);
            rot(o, px, py, pz, S5);
            const nx = S4[0], ny = S4[1], nz = S4[2], r2x = S5[0], r2y = S5[1], r2z = S5[2];
            pointDisp(b, rx, ry, rz, S7); pointDisp(o, r2x, r2y, r2z, S8);
            const appr = -((S7[0] - S8[0]) * nx + (S7[1] - S8[1]) * ny + (S7[2] - S8[2]) * nz);
            pen = Math.min(pen, Math.max(0, appr + MAX_SEPARATION * dt));
            if (pen <= 0) continue;
            const oAwake = bstate[o] === AWAKE;
            const w1 = genInvMass(b, rx, ry, rz, nx, ny, nz), w2 = oAwake ? genInvMass(o, r2x, r2y, r2z, nx, ny, nz) : 0;
            const dl = pen / (w1 + w2);
            applyCorr(b, rx, ry, rz, dl * nx, dl * ny, dl * nz);
            if (oAwake) applyCorr(o, r2x, r2y, r2z, -dl * nx, -dl * ny, -dl * nz);
            else if (dl / dt2 > WAKE_FORCE) wake(o);
            addContact(KIND_BRICK_BRICK, b, o, nx, ny, nz, dl, rx, ry, rz, r2x, r2y, r2z);
          }
  }

  // Glass and lamps, from the recorded frames: a pane breaks when its frame racks (its diagonals
  // change length) past its limit, when it touches the barrier or a brick, or when the panel it
  // sits in comes off. The laminated windshield cracks instead of shattering.
  function glassBreaks() {
    const out = [];
    units.forEach((U, u) => unitGlass(U, u, out));
    events.sort((a, b) => a.t - b.t);
    return out;
  }
  function unitGlass(U, u, out) {
    if (!U.spec.parts) return;
    const detachT = {};
    for (const d of debris) if (d.kind === 'part' && d.unit === u) detachT[d.name] = d.t;
    // this vehicle's nodes in the recorded frames
    const F = !multi ? frames : { t: frames.t, bricks: frames.bricks,
      pos: frames.pos.map(f => f.subarray(3 * U.off, 3 * (U.off + U.n))), strain: frames.strain.map(f => f.subarray(U.off, U.off + U.n)) };
    for (const pn of unitPanes(U)) {
      const tHost = pn.host && detachT[pn.host.name] !== undefined ? detachT[pn.host.name] : Infinity;
      let k = -1, cause = '', origin = null;
      for (let f = 0; f < F.t.length && F.t[f] < tHost; f++) {
        const r = paneTest(pn, F, f, U.car);
        if (r) { k = f; cause = r.cause; origin = r.origin; break; }
      }
      let tb = k >= 0 ? F.t[k] : -1;
      if (tHost < Infinity && (tb < 0 || tHost < tb)) {
        tb = tHost; cause = 'panel'; origin = pn.c;
        k = 0; while (k < F.t.length - 1 && F.t[k] < tb) k++;
      }
      if (tb < 0) { out.push({ name: pn.p.name, unit: u, laminated: !!pn.p.laminated, lamp: pn.lamp, t: -1 }); continue; }
      const b = paneBreak(pn, U, u, F, k, tb, cause, origin);
      out.push(b.glass);
      events.push(b.event);
    }
  }
  // The panes and lamps of a vehicle, set up to be tested frame by frame
  function unitPanes(U) {
    const spec = U.spec, car = U.car, ghost = car.ghost, dmg = U.dmg;
    const hosts = spec.parts.filter(q => q.name.startsWith('DEFORM_'));
    const out = [];
    for (const p of spec.parts) {
      const glass = p.name.startsWith('BRITTLE_Glass'), lamp = p.name.startsWith('BRITTLE_Light');
      if (!glass && !lamp) continue;
      const pts = glass ? p.corners.concat([p.centre]) : p.samples.slice(0, 6);
      const emb = embedPoints(car, pts), m = pts.length;
      // the structural nodes around the pane, whose recorded plastic strain decides the break
      const ring = Array.from(new Set(Array.from(emb.idx))).filter(a => !ghost[a]);
      const limit = (glass ? (p.laminated ? GLASS.laminated : p.name === 'BRITTLE_GlassRoof' ? GLASS.roof : GLASS.tempered) : GLASS.light) * dmg;
      const c = pts[pts.length - 1];
      const host = hosts.find(h => c[0] > h.lo[0] - 0.03 && c[0] < h.hi[0] + 0.03 && c[1] > h.lo[1] - 0.03 && c[1] < h.hi[1] + 0.03 && c[2] > h.lo[2] - 0.03 && c[2] < h.hi[2] + 0.03);
      out.push({ p, glass, lamp, pts, emb, m, ring, limit, c, host, W: new Float64Array(3 * m), P3: [0, 0, 0] });
    }
    return out;
  }
  // Does pane pn break at frame f of F (its vehicle's frames)? null, or { cause, origin }
  function paneTest(pn, F, f, car) {
    const { pts, emb, m, ring, W, P3 } = pn;
    let st = 0, best = -1, bestS = -1;
    for (const a of ring) { const v = F.strain[f][a]; st += v; if (v > bestS) { bestS = v; best = a; } }
    st = ring.length ? st / ring.length / 255 * 0.5 : 0;
    for (let q = 0; q < m; q++) { embeddedPos(F.pos[f], emb.idx, 8 * q, emb.t, 3 * q, P3); W[3 * q] = P3[0]; W[3 * q + 1] = P3[1]; W[3 * q + 2] = P3[2]; }
    let hit = -1;
    const mvW = world && world.moving;   // moving boxes: where they were at that frame
    if (mvW) placeWorld(world, F.t[f]);
    for (let q = 0; q < m && hit < 0; q++) {
      if (rigid) { if (W[3 * q] > -0.005 && W[3 * q + 1] < RIGID_BARRIER.height) hit = q; }
      else if (staticObs) { if (obstacleSDF(W[3 * q], W[3 * q + 1], W[3 * q + 2], G3, true) < 0.005) hit = q; }
      else if (wall && F.bricks.length && nearBrickFrame(F.bricks[f], W[3 * q], W[3 * q + 1], W[3 * q + 2])) hit = q;
    }
    if (mvW) placeWorld(world, t);
    if (!(st > pn.limit || hit >= 0)) return null;
    // crack / shatter origin: the contact point, else the pane point nearest the most strained node
    if (hit >= 0) return { cause: 'contact', origin: pts[hit] };
    const r = car.rest;
    return { cause: 'frame', origin: pts.reduce((o, q) => Math.hypot(q[0] - r[3 * best], q[1] - r[3 * best + 1], q[2] - r[3 * best + 2]) < Math.hypot(o[0] - r[3 * best], o[1] - r[3 * best + 1], o[2] - r[3 * best + 2]) ? q : o, pts[0]) };
  }
  // The break of pane pn at frame k (time tb): its glass entry and event, with the pane's centre
  // position and velocity from the recorded frames
  function paneBreak(pn, U, u, F, k, tb, cause, origin) {
    const p = pn.p, c = pn.c;
    const k0 = Math.max(0, k - 1), k1 = Math.min(F.t.length - 1, k + 1);
    const ce = embedPoints(U.car, [c]);
    const A = embeddedPos(F.pos[k0], ce.idx, 0, ce.t, 0, [0, 0, 0]), B = embeddedPos(F.pos[k1], ce.idx, 0, ce.t, 0, [0, 0, 0]);
    const h = Math.max(1e-6, F.t[k1] - F.t[k0]);
    const at = embeddedPos(F.pos[k], ce.idx, 0, ce.t, 0, [0, 0, 0]);
    const vel = [(B[0] - A[0]) / h, (B[1] - A[1]) / h, (B[2] - A[2]) / h];
    return {
      glass: { name: p.name, unit: u, laminated: !!p.laminated, lamp: pn.lamp, t: tb, frame: k, cause, origin: origin.slice(), centre: at, vel },
      event: { t: tb, type: p.laminated ? 'crack' : 'glass', x: at[0], y: at[1], z: at[2], mag: Math.hypot(vel[0], vel[1], vel[2]), mass: p.area * (pn.glass ? 5 : 2), part: p.name },
    };
  }
  // Glass while the run goes on (the Race game's crash camera): the same tests as glassBreaks on
  // the frames recorded so far. A pane is published once the frame after its break exists (the
  // velocity needs it), so every break comes out as glassBreaks will find it at the end. Returns
  // the panes broken since the last call: { glass: [...], events: [...] }; final: the run is over.
  let liveGlass = null;
  function scanGlass(final) {
    if (!liveGlass) liveGlass = units.map((U, u) => ({ U, u, pos: [], strain: [], panes: U.spec.parts ? unitPanes(U).map(pn => ({ pn, f: 0, done: false })) : [] }));
    const found = { glass: [], events: [] }, nF = frames.t.length;
    for (const L of liveGlass) {
      const U = L.U, u = L.u;
      while (L.pos.length < nF) {
        const f = L.pos.length;
        L.pos.push(multi ? frames.pos[f].subarray(3 * U.off, 3 * (U.off + U.n)) : frames.pos[f]);
        L.strain.push(multi ? frames.strain[f].subarray(U.off, U.off + U.n) : frames.strain[f]);
      }
      const F = { t: frames.t, bricks: frames.bricks, pos: L.pos, strain: L.strain };
      for (const S of L.panes) {
        if (S.done) continue;
        const pn = S.pn;
        let tHost = Infinity;
        if (pn.host) for (const d of debris) if (d.kind === 'part' && d.unit === u && d.name === pn.host.name) tHost = d.t;
        while (S.f < nF && F.t[S.f] < tHost && (S.f + 1 < nF || final)) {
          const r = paneTest(pn, F, S.f, U.car);
          if (r) { const b = paneBreak(pn, U, u, F, S.f, F.t[S.f], r.cause, r.origin); found.glass.push(b.glass); found.events.push(b.event); S.done = true; break; }
          S.f++;
        }
        if (S.done || tHost === Infinity || S.f >= nF || F.t[S.f] < tHost) continue;
        // its panel came off first: the pane goes with it
        let k = 0; while (k < nF - 1 && F.t[k] < tHost) k++;
        if (k + 1 < nF || final) { const b = paneBreak(pn, U, u, F, k, tHost, 'panel', pn.c); found.glass.push(b.glass); found.events.push(b.event); S.done = true; }
      }
    }
    return found;
  }
  function nearBrickFrame(bp, x, y, z) {
    for (let o = 0; o < nb; o++) {
      const o7 = 7 * o, dx = x - bp[o7], dy = y - bp[o7 + 1], dz = z - bp[o7 + 2];
      if (dx * dx + dy * dy + dz * dz > 0.1) continue;
      // into the brick's frame (q conjugate)
      const qx = -bp[o7 + 3], qy = -bp[o7 + 4], qz = -bp[o7 + 5], qw = bp[o7 + 6];
      const tx = 2 * (qy * dz - qz * dy), ty = 2 * (qz * dx - qx * dz), tz = 2 * (qx * dy - qy * dx);
      const lx = dx + qw * tx + (qy * tz - qz * ty), ly = dy + qw * ty + (qz * tx - qx * tz), lz = dz + qw * tz + (qx * ty - qy * tx);
      if (Math.abs(lx) < bh[3 * o] + 0.01 && Math.abs(ly) < bh[3 * o + 1] + 0.01 && Math.abs(lz) < bh[3 * o + 2] + 0.01) return true;
    }
    return false;
  }

  // ---------------------------------------------------------------- recording
  const energy0 = { value: 0 };
  function energies() {
    let ekCar = 0, eEl = 0, peCar = 0;
    for (let a = 0, a3 = 0; a < n; a++, a3 += 3) {
      ekCar += 0.5 * mass[a] * (V[a3] * V[a3] + V[a3 + 1] * V[a3 + 1] + V[a3 + 2] * V[a3 + 2]);
      peCar += mass[a] * G * (X[a3 + 1] - y0[a]);
    }
    for (let c = 0; c < nc; c++) {
      const a3 = 3 * ca[c], b3 = 3 * cb[c];
      const dx = X[b3] - X[a3], dy = X[b3 + 1] - X[a3 + 1], dz = X[b3 + 2] - X[a3 + 2];
      const e = Math.sqrt(dx * dx + dy * dy + dz * dz) - rest[c];
      eEl += 0.5 * ck[c] * e * e;
    }
    let ekB = 0, peB = 0, eBond = 0;
    ekCar += wheelSpinEnergy();
    for (let b = 0; b < NB; b++) {
      const i3 = 3 * b;
      peB += bm[b] * G * (bc[i3 + 1] - by0[b]);
      if (bstate[b] !== AWAKE) continue;
      ekB += 0.5 * bm[b] * (bv[i3] * bv[i3] + bv[i3 + 1] * bv[i3 + 1] + bv[i3 + 2] * bv[i3 + 2]);
      rotInv(b, bw[i3], bw[i3 + 1], bw[i3 + 2], S3);
      ekB += 0.5 * (S3[0] * S3[0] / binvI[i3] + S3[1] * S3[1] / binvI[i3 + 1] + S3[2] * S3[2] / binvI[i3 + 2]);
    }
    if (wall) eBond = bondEnergy();
    return { ekCar, eEl, peCar, ekB, peB, eBond };
  }
  // kinetic energy and momentum of each vehicle's nodes (several vehicles only)
  function unitMotion() {
    const out = units.map(() => ({ ke: 0, px: 0, pz: 0 }));
    for (let a = 0, a3 = 0; a < n; a++, a3 += 3) {
      const o = out[unitOf[a]], m = mass[a];
      o.ke += 0.5 * m * (V[a3] * V[a3] + V[a3 + 1] * V[a3 + 1] + V[a3 + 2] * V[a3 + 2]);
      o.px += m * V[a3]; o.pz += m * V[a3 + 2];
    }
    return out;
  }

  // --- intrusion measurement: fixed points of the structure, followed relative to a reference
  //     frame fitted (least squares) to the undamaged rear right corner of the cabin
  if (cfg.measure) {
    for (const U of units) {
      if (!U.spec.hPoint) continue;
      const pts = measurePoints(U.spec), emb = embedPoints(U.car, pts.map(p => p[1]));
      if (U.off) for (let i = 0; i < emb.idx.length; i++) emb.idx[i] += U.off;
      const rq = [], latRest = U.car.rest;
      for (let q = 0; q < U.n; q++) {
        const u = latRest[3 * q] - U.spec.xMin;
        if (!U.car.ghost[q] && u >= U.spec.cabin.u0 && u < U.spec.cabin.rearU && latRest[3 * q + 2] > 0) rq.push(q);
      }
      let c0x = 0, c0y = 0, c0z = 0;
      for (const q of rq) { c0x += latRest[3 * q]; c0y += latRest[3 * q + 1]; c0z += latRest[3 * q + 2]; }
      c0x /= rq.length; c0y /= rq.length; c0z /= rq.length;
      const far = [];
      for (let q = 0; q < U.n; q++) if (!U.car.ghost[q] && latRest[3 * q + 2] > 0.1) far.push(q + U.off);
      U.meas = { names: pts.map(p => p[0]), rest: pts.map(p => p[1]), emb, ref: Int32Array.from(rq, q => q + U.off), refLocal: Int32Array.from(rq), c0: [c0x, c0y, c0z], frames: [], refFrames: [], far: Int32Array.from(far) };
    }
  }
  const RA = new Float64Array(9), RM = new Float64Array(9), RR = new Float64Array(9);
  function measureUnit(U) {
    const M = U.meas, L = U.car.rest;
    let cx = 0, cy = 0, cz = 0;
    for (const a of M.ref) { cx += X[3 * a]; cy += X[3 * a + 1]; cz += X[3 * a + 2]; }
    cx /= M.ref.length; cy /= M.ref.length; cz /= M.ref.length;
    RA.fill(0);
    for (let q = 0; q < M.ref.length; q++) {
      const a = M.ref[q], l = M.refLocal[q];
      const d = [X[3 * a] - cx, X[3 * a + 1] - cy, X[3 * a + 2] - cz], d0 = [L[3 * l] - M.c0[0], L[3 * l + 1] - M.c0[1], L[3 * l + 2] - M.c0[2]];
      for (let r = 0; r < 3; r++) for (let c = 0; c < 3; c++) RA[3 * r + c] += d[r] * d0[c];
    }
    // rotation R = A (A^T A)^(-1/2)
    for (let r = 0; r < 3; r++) for (let c = 0; c < 3; c++) { let v = 0; for (let k = 0; k < 3; k++) v += RA[3 * k + r] * RA[3 * k + c]; RM[3 * r + c] = v; }
    const e = eigSym3([RM[0], RM[1], RM[2], RM[4], RM[5], RM[8]]), V3 = e.vec;
    const is = e.val.map(v => 1 / Math.sqrt(Math.max(1e-12, v)));
    for (let r = 0; r < 3; r++) for (let c = 0; c < 3; c++) { let v = 0; for (let k = 0; k < 3; k++) v += V3[r][k] * is[k] * V3[c][k]; RM[3 * r + c] = v; }
    for (let r = 0; r < 3; r++) for (let c = 0; c < 3; c++) { let v = 0; for (let k = 0; k < 3; k++) v += RA[3 * r + k] * RM[3 * k + c]; RR[3 * r + c] = v; }
    const out = new Float32Array(3 * M.names.length), p = [0, 0, 0];
    for (let q = 0; q < M.names.length; q++) {
      embeddedPos(X, M.emb.idx, 8 * q, M.emb.t, 3 * q, p);
      const dx = p[0] - cx, dy = p[1] - cy, dz = p[2] - cz;
      for (let c = 0; c < 3; c++) out[3 * q + c] = (RR[c] * dx + RR[3 + c] * dy + RR[6 + c] * dz) - (M.rest[q][c] - M.c0[c]);
    }
    M.frames.push(out);
    M.refFrames.push(Float64Array.of(cx, cy, cz, RR[0], RR[1], RR[2], RR[3], RR[4], RR[5], RR[6], RR[7], RR[8]));
  }

  function record() {
    const pos = new Float32Array(3 * n);
    for (let i = 0; i < 3 * n; i++) pos[i] = X[i];
    nodeStrain.fill(0);
    for (let c = 0; c < nc; c++) {
      const s = plastic[c];
      if (s > nodeStrain[ca[c]]) nodeStrain[ca[c]] = s;
      if (s > nodeStrain[cb[c]]) nodeStrain[cb[c]] = s;
    }
    const strain = new Uint8Array(n);
    for (let a = 0; a < n; a++) strain[a] = Math.min(255, Math.round(nodeStrain[a] / 0.5 * 255));
    frames.t.push(t); frames.pos.push(pos); frames.strain.push(strain);
    frames.axes.push(Float32Array.of(frame.o[0], frame.o[1], frame.o[2], frame.f[0], frame.f[1], frame.f[2], frame.u[0], frame.u[1], frame.u[2]));
    if (NB) {
      const bp = new Float32Array(7 * NB);
      for (let b = 0; b < NB; b++) {
        bp[7 * b] = bc[3 * b]; bp[7 * b + 1] = bc[3 * b + 1]; bp[7 * b + 2] = bc[3 * b + 2];
        bp[7 * b + 3] = bq[4 * b]; bp[7 * b + 4] = bq[4 * b + 1]; bp[7 * b + 5] = bq[4 * b + 2]; bp[7 * b + 6] = bq[4 * b + 3];
      }
      frames.bricks.push(bp);
    }
    // crush: front face relative to the cabin, along the car's forward axis
    let fd = 0;
    for (const a of car.groups.front) fd += (X[3 * a] - frame.o[0]) * frame.f[0] + (X[3 * a + 1] - frame.o[1]) * frame.f[1] + (X[3 * a + 2] - frame.o[2]) * frame.f[2];
    frames.crush.push(car.frontRestDist - fd / car.groups.front.length);
    meanPos(car.groups.dash, mF); meanPos(car.groups.seat, mR);
    const ds = (mF[0] - mR[0]) * frame.f[0] + (mF[1] - mR[1]) * frame.f[1] + (mF[2] - mR[2]) * frame.f[2];
    frames.intrusion.push(car.dashSeatRestDist - ds);
    if (multi) {
      units.forEach((U, u) => {
        const fr = U.frame, g = U.groups.front;
        frames.unitAxes[u].push(Float32Array.of(fr.o[0], fr.o[1], fr.o[2], fr.f[0], fr.f[1], fr.f[2], fr.u[0], fr.u[1], fr.u[2]));
        let d = 0;
        for (const a of g) d += (X[3 * a] - fr.o[0]) * fr.f[0] + (X[3 * a + 1] - fr.o[1]) * fr.f[1] + (X[3 * a + 2] - fr.o[2]) * fr.f[2];
        frames.unitCrush[u].push(U.car.frontRestDist - d / g.length);
      });
    }
    for (const U of units) if (U.meas) measureUnit(U);
    if (hc) frames.honeycomb.push(Float32Array.from(hc.crush));
    const e = energies();
    const tracked = e.ekCar + e.eEl + e.peCar + e.ekB + e.peB + e.eBond + Wp + Wfrac + Qf + Whc;
    const entry = {
      carKinetic: e.ekCar, debrisKinetic: e.ekB, elastic: e.eEl + e.eBond, plastic: Wp, fracture: Wfrac,
      friction: Qf, potential: e.peCar + e.peB, contactSolver: (world && world.moving ? energy0.value + Wmove : energy0.value) - tracked,
    };
    if (world && world.moving) entry.pushed = Wmove;
    if (hc) entry.barrier = Whc;
    if (multi) {
      const um = unitMotion();
      entry.units = units.map((U, u) => ({ kinetic: um[u].ke, plastic: U.Wp, px: um[u].px, pz: um[u].pz }));
    }
    frames.energy.push(entry);
    // events: car contact impulse this frame, and mortar breaks merged within 0.1 m
    if (impAcc > 20) events.push({ t, type: 'contact', x: impX / impAcc, y: impY / impAcc, z: impZ / impAcc, mag: impAcc, mass: car.massKg });
    impAcc = impX = impY = impZ = 0;
    if (pendingBreaks.length) {
      const merged = new Map();
      for (const e of pendingBreaks) {
        const key = Math.floor(e[0] / 0.1) + ',' + Math.floor(e[1] / 0.1) + ',' + Math.floor(e[2] / 0.1);
        const m = merged.get(key);
        if (m) { m.count++; m.mag += e[3]; m.mass = Math.max(m.mass, e[4]); }
        else merged.set(key, { t, type: 'break', x: e[0], y: e[1], z: e[2], mag: e[3], mass: e[4], count: 1 });
      }
      for (const m of merged.values()) events.push(m);
      pendingBreaks.length = 0;
    }
  }

  function recordInterval() {
    const since = T0 < 0 ? 0 : t - T0;
    return since < 0.3 ? 0.001 : since < 1.0 ? 0.004 : 0.010;
  }

  function pushTel(t, first) {
    for (const U of units) {
      const tl = U.tel, fr = U.frame;
      tl.t.push(t); tl.vx.push(fr.v[0]); tl.vy.push(fr.v[1]); tl.vz.push(fr.v[2]);
      tl.fx.push(fr.f[0]); tl.fy.push(fr.f[1]); tl.fz.push(fr.f[2]);
      tl.ux.push(fr.u[0]); tl.uy.push(fr.u[1]); tl.uz.push(fr.u[2]);
      tl.force.push(first ? 0 : multi ? U.force : barrierForce);
      if (U.meas) {   // velocity of the car's undamaged far half (where the seats are mounted)
        let rvx = 0, rvz = 0, m = 0;
        for (const a of U.meas.far) { rvx += mass[a] * V[3 * a]; rvz += mass[a] * V[3 * a + 2]; m += mass[a]; }
        (tl.rvx = tl.rvx || []).push(rvx / m); (tl.rvz = tl.rvz || []).push(rvz / m);
      }
    }
  }
  function step() {
    const fine = T0 < 0 ? t < 0.6 : t < T0 + FINE_WINDOW;
    const dt = cfg.dtScale ? (fine ? DT_FINE : DT_COARSE) * cfg.dtScale : (fine ? DT_FINE : DT_COARSE);
    const hadContact = T0 >= 0;
    substep(dt);
    t += dt;
    if (!hadContact && T0 >= 0) events.push({ t: T0, type: 'first', x: impX / (impAcc || 1), y: impY / (impAcc || 1), z: impZ / (impAcc || 1), mag: 0, mass: car.massKg });
    computeFrame();
    pushTel(t, false);
    if (t >= nextRecordT - 1e-9) { record(); nextRecordT = t + recordInterval(); }
    if (T0 >= 0 ? t >= T0 + duration : t >= (cfg.minDuration || 0.8)) done = true;
  }

  computeFrame();
  energy0.value = energies().ekCar;
  pushTel(0, true);
  record(); nextRecordT = recordInterval();

  const now = (typeof performance !== 'undefined') ? () => performance.now() : () => Date.now();

  // ---------------------------------------------------------------- the GPU solver (opt-in)
  // cfg.gpu: a device from CrashGPU.init() (gpu-lattice.js). Every barrier but the brick wall, one or
  // several vehicles; parts don't come off nor tyres burst. The lattice steps run on the GPU in
  // batches, one recorded frame's worth at a time; the state comes back at every frame, where the
  // bookkeeping (telemetry, frames, energies) runs as for the CPU solver. Friction heat is not
  // tracked there: it stays in the "contact, damping & solver" share of the energy. If the GPU
  // can't take this set-up, the CPU solves it (gpuFallback says why).
  let gpu = null, gpuRunning = false, gpuMs = 0, gpuBatches = 0, gpuSteps = 0, gpuError = null, gpuFallback = null;
  if (cfg.gpu && wall) gpuFallback = 'the GPU solver has no brick wall';
  else if (cfg.gpu && world && world.shapes.length > 160) gpuFallback = 'too many world obstacles for the GPU solver';
  else if (cfg.gpu) {
    const floor = new Float64Array(n);
    for (let a = 0; a < n; a++) floor[a] = wheelNode[a] ? wheelFloor[a] : clear[a];
    const obstacle = rigid ? { kind: 'rigid', height: RIGID_BARRIER.height, halfWidth: RIGID_BARRIER.halfWidth }
      : offset ? { kind: 'offset', side: offset.side, zEdge: offset.zEdge, width: offset.width, height: offset.height, edgeRadius: offset.edgeRadius }
      : pole ? { kind: 'pole', x: pole.x, z: pole.z, r: pole.r, height: pole.height }
      // the world's shapes where they are at time 0 (a moving box from its start)
      : world ? { kind: 'world', shapes: world.shapes.map(q => q.box ? { box: true, x: q.vx !== undefined ? q.bx : q.x, z: q.vx !== undefined ? q.bz : q.z, c: q.c, s: q.s, hx: q.hx, hz: q.hz, height: q.height, top: !!q.top, vx: q.vx || 0, vz: q.vz || 0 }
        : { box: false, x: q.x, z: q.z, c: 1, s: 0, hx: q.r, hz: q.r, height: q.height }) } : { kind: 'none' };
    const honeycomb = hc ? { h: hc.h, nzc: hc.nzc, nyc: hc.nyc, y0: hc.y0, depth: hc.depth, crush: hc.crush, padY: 0.5 * car.sy, padZ: 0.5 * car.sz,
      solid: HONEYCOMB.solid, mainDepth: HONEYCOMB.main.depth, bumperDepth: HONEYCOMB.bumper.depth, mainStress: HONEYCOMB.main.stress, bumperStress: HONEYCOMB.bumper.stress,
      ijk: car.ijk, ny: spec.ny, nz: spec.nz } : null;
    try {
      gpu = root.CrashGPU.lattice(cfg.gpu, { n, nc, X, V, W, floor, ghost, wheel: wheelNode, muRoll, unitOf, units: NU, ca, cb, rest, c0, comp, damp, cey, ck,
        r: spec.nodeRadius, obstacle, honeycomb, G, MU_BODY, MU_WALL, MU_LAT: muLat, MU_CAR, MIN_RATIO, MAX_RATIO, MAX_SEPARATION, NODE_SEPARATION });
    } catch (e) { gpuFallback = e.message; }
  }
  async function gpuLoop() {
    gpuRunning = true;
    try {
      while (!done) {
        const dts = [];
        let tt = t;
        do {
          const fine = T0 < 0 ? tt < 0.6 : tt < T0 + FINE_WINDOW;
          dts.push((fine ? DT_FINE : DT_COARSE) * (cfg.dtScale || 1)); tt += dts[dts.length - 1];
        } while (tt < nextRecordT - 1e-9 && dts.length < gpu.maxSteps);
        const rolls = units.map(U => { const fh = Math.hypot(U.frame.f[0], U.frame.f[2]) || 1; return [U.frame.f[0] / fh, U.frame.f[2] / fh]; });
        const t1 = now();
        const st = await gpu.run(dts, rolls, gpuSteps, t);
        gpuMs += now() - t1; gpuBatches++;
        if (cancelled) break;
        X.set(st.X); V.set(st.V);
        for (let c = 0; c < nc; c++) { rest[c] = st.rest[c]; plastic[c] = st.plastic[c]; Wp += st.wp[c]; }
        if (hc) { hc.crush.set(st.crush); for (let i = 0; i < st.whc.length; i++) Whc += st.whc[i]; }
        // contact impulses: for the events (once per contact), the barrier's load cell, each vehicle
        let imp = 0, ix = 0, iy = 0, iz = 0, bimp = 0, first = 0xffffffff;
        for (const U of units) U.force = 0;
        for (let a = 0; a < n; a++) {
          const o = 8 * a;
          imp += st.imps[o]; ix += st.imps[o + 1]; iy += st.imps[o + 2]; iz += st.imps[o + 3];
          bimp += st.imps[o + 4]; units[unitOf[a]].force += st.imps[o + 5] / (tt - t);
          if (st.first[a] < first) first = st.first[a];
        }
        impAcc += imp; impX += ix; impY += iy; impZ += iz;
        barrierForce = bimp / (tt - t);   // the mean over the batch
        if (T0 < 0 && first !== 0xffffffff) {
          let tf = t;
          for (let k = 0; k < first - gpuSteps; k++) tf += dts[k];
          T0 = tf;
          events.push({ t: T0, type: 'first', x: ix / (imp || 1), y: iy / (imp || 1), z: iz / (imp || 1), mag: 0, mass: car.massKg });
        }
        gpuSteps += dts.length; t = tt;
        computeFrame();
        pushTel(t, false);
        record(); nextRecordT = t + recordInterval();
        if (T0 >= 0 ? t >= T0 + duration : t >= (cfg.minDuration || 0.8)) done = true;
      }
    } catch (e) {
      gpuError = e; cancelled = true; done = true;
    } finally {
      gpuRunning = false;
      if (done) gpu.destroy();
    }
  }

  let fin = null;
  const sim = {
    car, wall, n, nb, NB, X, frame, debris,
    frames, events,   // as recorded so far (glass events are added by finalize)
    units: units.map(U => ({ off: U.off, n: U.n, spec: U.spec, frame: U.frame, car: U.car })),
    honeycomb: hc ? hc.crush : null,
    get t() { return t; }, get T0() { return T0; }, get done() { return done; },
    brickPose(b, outPos, outQuat) {
      outPos[0] = bc[3 * b]; outPos[1] = bc[3 * b + 1]; outPos[2] = bc[3 * b + 2];
      outQuat[0] = bq[4 * b]; outQuat[1] = bq[4 * b + 1]; outQuat[2] = bq[4 * b + 2]; outQuat[3] = bq[4 * b + 3];
    },
    progress() { return done ? 1 : Math.min(0.999, t / ((T0 >= 0 ? T0 : 0.01) + duration)); },
    cancel() { cancelled = true; done = true; if (gpu && !gpuRunning) gpu.destroy(); },
    // the GPU solver, if in use: { name, colours, batches, steps, ms } so far; and why it stopped, if it failed
    get gpu() { return gpu ? { name: gpu.name, colours: gpu.colours, batches: gpuBatches, steps: gpuSteps, ms: gpuMs } : null; },
    get gpuFallback() { return gpuFallback; },
    get error() { return gpuError; },
    // Advance for up to budgetMs of wall-clock time; returns progress 0..1. With the GPU solver the
    // steps run in the background and this only reports progress.
    advance(budgetMs) {
      if (gpu) { if (!gpuRunning && !done) gpuLoop(); return sim.progress(); }
      const start = now();
      while (!done) {
        for (let k = 0; k < 10 && !done; k++) step();
        if (now() - start > budgetMs) break;
      }
      return sim.progress();
    },
    finalize() { return cancelled ? null : (fin || (fin = finalize())); },
    // the panes broken since the last call (see scanGlass); final: the run is over
    scanGlass(final) { return scanGlass(!!final); },
    // test hook: release wheel `key` now, then place it and set its velocity and spin
    testWheel(key, pos, vel, omega) {
      const cw = corners.find(c => c.key === key);
      spawnWheel(cw);
      const b = cw.bi, b3 = 3 * b;
      for (let d = 0; d < 3; d++) { bc[b3 + d] = bcp[b3 + d] = pos[d]; bv[b3 + d] = vel[d]; bw[b3 + d] = omega[d]; }
      by0[b] = bc[b3 + 1];
      return b;
    },
    bodyState(b) {
      const b3 = 3 * b;
      return { pos: [bc[b3], bc[b3 + 1], bc[b3 + 2]], vel: [bv[b3], bv[b3 + 1], bv[b3 + 2]], omega: [bw[b3], bw[b3 + 1], bw[b3 + 2]],
        inertia: 1 / binvI[b3], mass: bm[b], radius: bwheel[2 * b], state: bstate[b] };
    },
    // diagnostics for tuning the destruction limits
    damageState() {
      return { parts: parts.map(p => ({ name: p.name, plastic: meanPlastic(p.anchors), limit: p.limit, off: p.t })),
        wheels: corners.map(cw => ({ key: cw.key, plastic: meanPlastic(cw.anchors), maxBack: cw.maxBack || 0, burst: cw.burst, off: cw.t })) };
    },
  };

  // Crash pulse of one vehicle: cabin telemetry resampled onto a uniform 0.1 ms grid,
  // differentiated, rotated into the car frame and filtered (CFC 60).
  function unitPulse(U) {
    const tel = U.tel, dt = DT_FINE, N = Math.floor(t / dt) + 1;
    const keys = ['vx', 'vy', 'vz', 'fx', 'fy', 'fz', 'ux', 'uy', 'uz', 'force'];
    const S = {};
    for (const k of keys) S[k] = new Float64Array(N);
    let j = 0;
    for (let i = 0; i < N; i++) {
      const ti = i * dt;
      while (j < tel.t.length - 2 && tel.t[j + 1] < ti) j++;
      const ta = tel.t[j], tb = tel.t[j + 1], s = tb > ta ? Math.min(1, Math.max(0, (ti - ta) / (tb - ta))) : 0;
      for (const k of keys) S[k][i] = tel[k][j] + (tel[k][j + 1] - tel[k][j]) * s;
    }
    const ax = new Float64Array(N), ay = new Float64Array(N), az = new Float64Array(N);
    const gx = new Float64Array(N), gy = new Float64Array(N), gz = new Float64Array(N);
    const vLong = new Float64Array(N), vLat = new Float64Array(N);
    const f0 = [U.h0[0], 0, U.h0[1]];
    for (let i = 0; i < N; i++) {
      const i0 = Math.max(0, i - 1), i1 = Math.min(N - 1, i + 1), h = (i1 - i0) * dt;
      const awx = (S.vx[i1] - S.vx[i0]) / h, awy = (S.vy[i1] - S.vy[i0]) / h, awz = (S.vz[i1] - S.vz[i0]) / h;
      const fx = S.fx[i], fy = S.fy[i], fz = S.fz[i], ux = S.ux[i], uy = S.uy[i], uz = S.uz[i];
      const lx = fy * uz - fz * uy, ly = fz * ux - fx * uz, lz = fx * uy - fy * ux;
      ax[i] = awx * fx + awy * fy + awz * fz;
      ay[i] = awx * ux + awy * uy + awz * uz;
      az[i] = awx * lx + awy * ly + awz * lz;
      gx[i] = -G * fy; gy[i] = -G * uy; gz[i] = -G * ly;
      vLong[i] = S.vx[i] * f0[0] + S.vz[i] * f0[2];
      vLat[i] = -S.vx[i] * f0[2] + S.vz[i] * f0[0];
    }
    const cfc = root.CrashOccupant ? root.CrashOccupant.cfc : (typeof require === 'function' ? require('./occupant.js').cfc : null);
    const axF = cfc(ax, dt, 60), ayF = cfc(ay, dt, 60), azF = cfc(az, dt, 60), forceF = cfc(S.force, dt, 60);
    let azRef = null, dvRef = 0;
    if (tel.rvx) {   // lateral acceleration of the car's far half, in the car frame
      const rv = { x: new Float64Array(N), z: new Float64Array(N) };
      let jj = 0;
      for (let i = 0; i < N; i++) {
        const ti = i * dt;
        while (jj < tel.t.length - 2 && tel.t[jj + 1] < ti) jj++;
        const ta = tel.t[jj], tb = tel.t[jj + 1], s = tb > ta ? Math.min(1, Math.max(0, (ti - ta) / (tb - ta))) : 0;
        rv.x[i] = tel.rvx[jj] + (tel.rvx[jj + 1] - tel.rvx[jj]) * s; rv.z[i] = tel.rvz[jj] + (tel.rvz[jj + 1] - tel.rvz[jj]) * s;
      }
      const al = new Float64Array(N);
      for (let i = 0; i < N; i++) {
        const i0 = Math.max(0, i - 1), i1 = Math.min(N - 1, i + 1), h = (i1 - i0) * dt;
        const fx = S.fx[i], fz = S.fz[i], fl = Math.hypot(fx, fz) || 1;
        al[i] = ((rv.x[i1] - rv.x[i0]) / h) * (-fz / fl) + ((rv.z[i1] - rv.z[i0]) / h) * (fx / fl);
      }
      azRef = cfc(al, dt, 60);
      const i0r = T0 >= 0 ? Math.round(T0 / dt) : 0;
      for (let i = i0r; i < N; i++) dvRef = Math.max(dvRef, Math.hypot(rv.x[i] - rv.x[i0r], rv.z[i] - rv.z[i0r]));
    }
    const i0 = T0 >= 0 ? Math.round(T0 / dt) : 0;
    let peak = 0, vMin = Infinity, iZero = -1, dvMax = 0, latPeak = 0;
    for (let i = i0; i < N; i++) {
      if (-axF[i] > peak) peak = -axF[i];
      if (vLong[i] < vMin) vMin = vLong[i];
      if (iZero < 0 && vLong[i] <= 0) iZero = i;
      const dv = Math.hypot(vLong[i] - vLong[i0], vLat[i] - vLat[i0]);
      if (dv > dvMax) dvMax = dv;
      if (Math.abs(azF[i]) > latPeak) latPeak = Math.abs(azF[i]);
    }
    const v0 = vLong[i0], vEnd = vLong[N - 1];
    return {
      pulse: { dt, n: N, i0, ax: axF, ay: ayF, az: azF, gx, gy, gz, vLong, vLat, force: forceF, azRef },
      metrics: {
        impactSpeed: v0,
        deltaV: v0 - vMin,
        rebound: Math.max(0, -vMin),
        exitSpeed: Math.max(0, vEnd),
        peakDecelG: peak / G,
        timeToStop: iZero >= 0 ? (iZero - i0) * dt : -1,   // first contact to zero forward speed
        deltaVVector: dvMax,                               // largest change of the velocity vector
        peakLateralG: latPeak / G,
        deltaVFar: dvRef,                                  // the same for the car's undamaged far half (measure: true)
      },
    };
  }

  function finalize() {
    const P0 = unitPulse(units[0]);
    let maxCrush = 0;
    for (const c of frames.crush) if (c > maxCrush) maxCrush = c;
    let maxIntr = 0;
    for (const c of frames.intrusion) if (c > maxIntr) maxIntr = c;
    const glass = glassBreaks();
    const p0 = P0.pulse;
    const unitOut = units.map((U, u) => {
      const R = u === 0 ? P0 : unitPulse(U), crush = multi ? frames.unitCrush[u] : frames.crush;
      let mc = 0;
      for (const c of crush) if (c > mc) mc = c;
      R.metrics.maxCrush = mc;
      R.metrics.residualCrush = crush[crush.length - 1];
      return Object.assign(R, { key: U.spec.key, spec: U.spec, car: U.car, off: U.off, n: U.n, massKg: U.car.massKg, crush,
        axes: multi ? frames.unitAxes[u] : frames.axes,
        measure: U.meas ? { names: U.meas.names, rest: U.meas.rest, frames: U.meas.frames, refFrames: U.meas.refFrames, c0: U.meas.c0 } : null });
    });
    return {
      T0, tEnd: t, contact: T0 >= 0, events, frames, car, wall, barrier: barrierKind,
      vehicle: spec.key, damage: units[0].cfg.damage || cfg.damage || 'realistic', nbWall: nb, nBodies: NB, debris, glass,
      bursts: corners.map(cw => ({ key: cw.key, unit: cw.unit, t: cw.burst, off: cw.t })), spawnChecks,
      heading: units[0].cfg.pose.heading,
      pulse: { dt: p0.dt, n: p0.n, i0: p0.i0, ax: p0.ax, ay: p0.ay, az: p0.az, gx: p0.gx, gy: p0.gy, gz: p0.gz, vLong: p0.vLong, force: p0.force },
      metrics: Object.assign({
        impactSpeed: P0.metrics.impactSpeed,
        deltaV: P0.metrics.deltaV,
        rebound: P0.metrics.rebound,
        exitSpeed: P0.metrics.exitSpeed,
        peakDecelG: P0.metrics.peakDecelG,
        timeToStop: P0.metrics.timeToStop,
        maxCrush,
        residualCrush: frames.crush[frames.crush.length - 1],
        maxIntrusion: maxIntr,
        energyInitial: energy0.value,
      }),
      units: unitOut,
      offset: offset ? { zEdge: offset.zEdge, side: offset.side, width: offset.width, height: offset.height, edgeRadius: offset.edgeRadius,
        honeycomb: hc ? { cell: hc.h, nzc: hc.nzc, nyc: hc.nyc, y0: hc.y0, depth: hc.depth, frames: frames.honeycomb } : null } : null,
      pole: pole ? { x: pole.x, z: pole.z, r: pole.r } : null,
      world: world ? { boxes: (cfg.world && cfg.world.boxes) || [], cyls: (cfg.world && cfg.world.cyls) || [], backOff } : null,
      solver: sim.gpu ? Object.assign({ kind: 'gpu' }, sim.gpu) : { kind: 'cpu', fallback: gpuFallback },
    };
  }

  return sim;
}

// Input for the side-impact dummy (occupant.js simulateSide) from a side-impact result (the struck
// car is vehicle 0, struck on its left): on a 0.1 ms grid, the car's lateral acceleration at the
// undamaged far side of the cabin (CFC 60) and the distance from the driver's seat centreline to the
// door's inner surface at pelvis, chest and window height; plus what is outside the window (the
// pole, or the barrier face's top edge), all in the car's own frame.
const DOOR_TRIM = 0.20, WINDOW_INSET = 0.16;
function sideInput(res) {
  const U = res.units[0], M = U.measure, spec = U.spec, H = spec.hPoint, T = res.frames.t;
  const dt = DT_FINE, N = U.pulse.n, i0 = U.pulse.i0, zs = -spec.width / 2;
  const grid = (get) => {
    const out = new Float64Array(N);
    let j = 0;
    for (let i = 0; i < N; i++) {
      const ti = i * dt;
      while (j < T.length - 2 && T[j + 1] < ti) j++;
      const s = T[j + 1] > T[j] ? Math.min(1, Math.max(0, (ti - T[j]) / (T[j + 1] - T[j]))) : 0;
      out[i] = get(j) + (get(j + 1) - get(j)) * s;
    }
    return out;
  };
  const q = (nm) => M.names.indexOf(nm), RF = M.refFrames;
  const door = (nm, inset) => grid(k => H[2] - (zs + inset + M.frames[k][3 * q(nm) + 2]));
  // world point -> car-local z (through the fitted reference frame)
  const localZ = (k, wx, wy, wz) => { const f = RF[k], dx = wx - f[0], dy = wy - f[1], dz = wz - f[2]; return f[5] * dx + f[8] * dy + f[11] * dz + M.c0[2]; };
  const input = { dt, n: N, i0, a: U.pulse.azRef, door: { pelvis: door('doorPelvis', DOOR_TRIM), thorax: door('doorThorax', DOOR_TRIM), head: door('doorHead', WINDOW_INSET) }, striker: null };
  if (res.pole) {
    input.striker = { name: 'pole', y0: -2, y1: 3, s: grid(k => H[2] - (localZ(k, res.pole.x, 0, res.pole.z) + res.pole.r)) };
  } else if (res.units[1]) {
    const B = res.units[1], front = B.car.groups.front, top = B.spec.yTop + B.spec.nodeRadius;
    input.striker = { name: 'barrier', y0: -2, y1: top - H[1], s: grid(k => {
      const X = res.frames.pos[k];
      let z = -Infinity;
      for (const a2 of front) { const g = 3 * (a2 + B.off); z = Math.max(z, localZ(k, X[g], X[g + 1], X[g + 2])); }
      return H[2] - (z + B.spec.nodeRadius);
    }) };
  }
  return input;
}

// Input for the frontal dummy (occupant.js simulate, opts.cabin) from a crash result: where the
// parts of the cabin around the driver are at each recorded frame, as the structure deforms. The
// points (the steering wheel hub and a point down its column, the knee bolster, the toe pan, the
// windshield's bottom and top edge, the roof above the head, the A-pillar's foot and top, the door
// at chest and window height) are placed from the occupant's interior layout, embedded in the
// lattice like the body, and given in the H-point frame (x forward, y up, z toward the car's right),
// through the cabin frame the crash pulse is measured in. The toe pan is sampled where it meets the
// floor, at the footwell measurement point: that is where it is pushed in from, while the feet rest
// higher up on it.
function cabinInput(res, u) {
  const U = res.units[u || 0], spec = U.spec, H = spec.hPoint, F = res.frames;
  if (!H) return null;
  const Occ = root.CrashOccupant || require('./occupant.js');
  const I = Occ.interiorFor(spec.interior), zd = -spec.width / 2 + DOOR_TRIM - H[2];   // the door's inner surface, as in sideInput
  const pts = [
    ['hub', [I.hub[0], I.hub[1], 0]], ['colBase', [I.hub[0] - 0.3 * I.col[0], I.hub[1] - 0.3 * I.col[1], 0]],
    ['knee', [I.kneeX, 0.12, 0]], ['toe', measurePoints(spec).find(([nm]) => nm === 'footwell')[1].map((v, c) => v - H[c])],
    ['wsLow', [I.wsA[0], I.wsA[1], 0]], ['wsHigh', [I.wsB[0], I.wsB[1], 0]], ['roof', [0, I.roofY, 0]],
    ['aLow', [I.wsA[0], I.wsA[1], zd - 0.05]], ['aHigh', [I.wsB[0], I.wsB[1], zd - 0.05]],
    ['door', [0.05, 0.30, zd]], ['doorHead', [0.05, 0.62, zd]],
  ];
  const emb = embedPoints(U.car, pts.map(([, p]) => [p[0] + H[0], p[1] + H[1], p[2] + H[2]]));
  const off = res.units.length > 1 ? U.off : 0, cr = U.car.cabinRest, np = pts.length, nf = F.t.length;
  const out = new Float32Array(nf * np * 3), idx = Int32Array.from(emb.idx, q => q + off), p = [0, 0, 0];
  for (let k = 0; k < nf; k++) {
    const X = F.pos[k], A = U.axes[k];
    const f = [A[3], A[4], A[5]], up = [A[6], A[7], A[8]], l = [f[1] * up[2] - f[2] * up[1], f[2] * up[0] - f[0] * up[2], f[0] * up[1] - f[1] * up[0]];
    for (let q = 0; q < np; q++) {
      embeddedPos(X, idx, 8 * q, emb.t, 3 * q, p);
      const dx = p[0] - A[0], dy = p[1] - A[1], dz = p[2] - A[2], o = 3 * (k * np + q);
      out[o] = cr[0] + dx * f[0] + dy * f[1] + dz * f[2] - H[0];
      out[o + 1] = cr[1] + dx * up[0] + dy * up[1] + dz * up[2] - H[1];
      out[o + 2] = cr[2] + dx * l[0] + dy * l[1] + dz * l[2] - H[2];
    }
  }
  return { t: Float64Array.from(F.t), names: pts.map(([nm]) => nm), np, p: out };
}

const api = { G, CAR, VEHICLES, WALL, WALL_STRENGTH, STIFFNESS, RIGID_BARRIER, PROFILE, DAMAGE, HONEYCOMB, POLE_RADIUS, SIDE_STEEL, topHeight, columns, axles, buildCar, buildWall, buildOffset, measurePoints, sideInput, cabinInput, createImpactSim, embedPoint, embeddedPos, cornerWeight, DT_FINE };
root.CrashPhysics = api;
if (typeof module === 'object' && module.exports) module.exports = api;
})(typeof window !== 'undefined' ? window : globalThis);
