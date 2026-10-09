/* The car lattice on the GPU (WebGPU compute, WGSL): an opt-in alternative to the inner loop of
 * physics.js createImpactSim (cfg.gpu). It covers the rigid barrier, the offset barrier with or
 * without its honeycomb face, the pole, the game modes' world of boxes and posts (boxes can move
 * at a steady speed and have a roof to land on), and several cars colliding with each other; not
 * the brick wall, and parts don't come off.
 *
 * Each step runs the same equations as the CPU solver: predict; the lattice's distance constraints
 * (XPBD with damping, plastic yield and its rest-length limits); contacts with the ground, the
 * barrier or obstacle, the honeycomb and the other cars; Coulomb friction (rolling along the car for
 * the wheel nodes); velocities. Two things differ:
 * - the order. The CPU projects the constraints one after the other (Gauss-Seidel); here they are
 *   split into colour groups, no two in a group sharing a node, projected in parallel group by group.
 *   Car-against-car contacts are gathered per node from the same positions (Jacobi) instead of one
 *   after the other. The honeycomb is crushed lane by lane (the nodes one behind the other), in the
 *   CPU's order within a lane;
 * - 32-bit floats (the CPU uses 64-bit).
 * So results differ slightly from the CPU's.
 *
 * run(dts, rolls, base) does a batch of steps (one recorded frame's worth) and resolves to the
 * state read back from the GPU, for the CPU's bookkeeping (telemetry, energies, frames).
 * Browser only: needs navigator.gpu (a secure context: https, localhost or file://). */
const CrashGPU = (() => {
  'use strict';
  const STEP_STRIDE = 256;   // uniform buffer offset alignment
  const STEP_SIZE = 80;      // the Step struct
  const WG = 64;
  const PAIRS = 6;           // car-to-car contacts kept per node for friction

  let devicePromise = null;
  // the GPU device, requested once; rejects with a readable message if there is none
  function init() {
    if (!devicePromise) devicePromise = (async () => {
      if (typeof navigator === 'undefined' || !navigator.gpu) throw new Error('this browser has no WebGPU');
      const adapter = await navigator.gpu.requestAdapter({ powerPreference: 'high-performance' });
      if (!adapter) throw new Error('no WebGPU adapter (GPU) available');
      const maxStorage = Math.min(16, adapter.limits.maxStorageBuffersPerShaderStage);
      const device = await adapter.requestDevice({ requiredLimits: { maxStorageBuffersPerShaderStage: maxStorage } });
      const info = adapter.info || {};
      device.lost.then((e) => { devicePromise = null; console.warn('WebGPU device lost:', e.message); });
      return { device, maxStorage, name: [info.vendor, info.architecture].filter(Boolean).join(' ') || 'GPU' };
    })().catch((e) => { devicePromise = null; throw e; });
    return devicePromise;
  }

  // Greedy colouring: each constraint takes the lowest colour not used by another at either node.
  function colour(ca, cb, n) {
    const nc = ca.length, col = new Uint8Array(nc), used = new Uint8Array(n * 64);
    let ncol = 0;
    for (let c = 0; c < nc; c++) {
      const a = ca[c] * 64, b = cb[c] * 64;
      let k = 0;
      while (used[a + k] || used[b + k]) k++;
      if (k >= 64) throw new Error('lattice needs more than 64 colours');
      col[c] = k; used[a + k] = 1; used[b + k] = 1;
      if (k + 1 > ncol) ncol = k + 1;
    }
    // constraint order on the GPU: by colour; ranges[k] = [offset, count]
    const order = new Int32Array(nc), counts = new Int32Array(ncol);
    for (let c = 0; c < nc; c++) counts[col[c]]++;
    const start = new Int32Array(ncol);
    for (let k = 1; k < ncol; k++) start[k] = start[k - 1] + counts[k - 1];
    const fill = start.slice();
    for (let c = 0; c < nc; c++) order[fill[col[c]]++] = c;
    return { ncol, order, ranges: Array.from({ length: ncol }, (_, k) => [start[k], counts[k]]) };
  }

  const f = (v) => { const s = String(+v); return /[.e]/.test(s) ? s : s + '.0'; };
  const STEP = 'struct Step { dt: f32, idx: u32, p0: u32, p1: u32, roll: array<vec4<f32>, 4> };\n@group(1) @binding(0) var<uniform> S: Step;\n';
  const store = (bindings) => bindings.map(([name, type, rw], i) => `@group(0) @binding(${i}) var<storage, ${rw ? 'read_write' : 'read'}> ${name}: ${type};`).join('\n') + '\n';

  // The kernels, for this simulation's set-up (obstacle, honeycomb, several cars)
  function shaders(d) {
    const head = `const N: u32 = ${d.n}u;\nconst G: f32 = ${f(d.G)};\nconst R: f32 = ${f(d.r)};\nconst MAXSEP: f32 = ${f(d.MAX_SEPARATION)};\n` + STEP;
    const ob = d.obstacle, hc = d.honeycomb;
    const out = {};
    out.predict = head + store([['X', 'array<f32>', 1], ['P', 'array<f32>', 1], ['V', 'array<f32>', 1]]) + `
@compute @workgroup_size(${WG}) fn main(@builtin(global_invocation_id) g: vec3<u32>) {
  let a = g.x;
  if (a >= N) { return; }
  let i = 3u * a;
  P[i] = X[i]; P[i + 1u] = X[i + 1u]; P[i + 2u] = X[i + 2u];
  V[i + 1u] = V[i + 1u] - G * S.dt;
  X[i] = X[i] + V[i] * S.dt; X[i + 1u] = X[i + 1u] + V[i + 1u] * S.dt; X[i + 2u] = X[i + 2u] + V[i + 2u] * S.dt;
}`;
    out.solve = STEP + `
const MIN_RATIO: f32 = ${f(d.MIN_RATIO)};
const MAX_RATIO: f32 = ${f(d.MAX_RATIO)};
struct Con { a: u32, b: u32, c0: f32, comp: f32, damp: f32, cey: f32, ck: f32, pad: f32 };
struct Range { off: u32, cnt: u32, pad0: u32, pad1: u32 };
` + store([['X', 'array<f32>', 1], ['P', 'array<f32>'], ['NI', 'array<vec4<f32>>'], ['C', 'array<Con>'], ['rest', 'array<f32>', 1], ['plastic', 'array<f32>', 1], ['wp', 'array<f32>', 1]]) + `
@group(2) @binding(0) var<uniform> Rg: Range;
@compute @workgroup_size(${WG}) fn main(@builtin(global_invocation_id) g: vec3<u32>) {
  if (g.x >= Rg.cnt) { return; }
  let c = Rg.off + g.x;
  let k = C[c];
  let a3 = 3u * k.a; let b3 = 3u * k.b;
  let xa = vec3<f32>(X[a3], X[a3 + 1u], X[a3 + 2u]);
  let xb = vec3<f32>(X[b3], X[b3 + 1u], X[b3 + 2u]);
  let d = xb - xa;
  let len = length(d);
  if (len < 1e-9) { return; }
  let wa = NI[k.a].x; let wb = NI[k.b].x; let ws = wa + wb;
  let pa = vec3<f32>(P[a3], P[a3 + 1u], P[a3 + 2u]);
  let pb = vec3<f32>(P[b3], P[b3 + 1u], P[b3 + 2u]);
  // XPBD with damping (Macklin et al. 2016), as physics.js substep step 2
  let vp = dot(d, (xb - pb) - (xa - pa)) / len;
  let gamma = k.damp * k.comp / S.dt;
  let r0 = rest[c];
  let dl = -(len - r0 + gamma * vp) / ((1.0 + gamma) * ws + k.comp / (S.dt * S.dt));
  let s = dl / len;
  let na = xa - wa * s * d; let nb = xb + wb * s * d;
  X[a3] = na.x; X[a3 + 1u] = na.y; X[a3 + 2u] = na.z;
  X[b3] = nb.x; X[b3 + 1u] = nb.y; X[b3 + 2u] = nb.z;
  // plastic yield: the rest length follows the stretch beyond the yield strain
  let el = len + ws * dl - r0;
  let lim = k.cey * k.c0;
  if (el > lim || el < -lim) {
    let nr = clamp(r0 + select(el + lim, el - lim, el > 0.0), MIN_RATIO * k.c0, MAX_RATIO * k.c0);
    let dr = abs(nr - r0);
    wp[c] = wp[c] + k.ck * lim * dr;
    plastic[c] = plastic[c] + dr / k.c0;
    rest[c] = nr;
  }
}`;
    // the ground (and the rigid barrier): CT = (ground, barrier or honeycomb, surface) corrections
    const rigid = ob.kind === 'rigid' ? `
    if (x.x + R > 0.0 && x.y < ${f(ob.height)} && abs(x.z) < ${f(ob.halfWidth)}) {
      ct.y = x.x + R; x.x = -R;
      let imp = ct.y / (ni.x * S.dt);
      IMPS[2u * a] = IMPS[2u * a] + vec4<f32>(imp, imp * x.x, imp * x.y, imp * x.z);
      IMPS[2u * a + 1u].x = IMPS[2u * a + 1u].x + imp;
      FIRST[a] = min(FIRST[a], S.idx);
    }` : '';
    // the game modes' world (physics.js worldSDF): each shape is (x, z, cos, sin) at time 0, (half
    // length or radius, half width, height, flags: 1 a cylinder, 2 a roof) and (vx, vz) its speed
    const W = ob.kind === 'world' ? ob.shapes : null;
    const arr = (list) => `array<vec4<f32>, ${W.length}>(${list.map(v => `vec4<f32>(${v.map(f).join(', ')})`).join(', ')})`;
    const worldDecl = W ? `
const NS: u32 = ${W.length}u;
var<private> SA: array<vec4<f32>, ${W.length}> = ${arr(W.map(q => [q.x, q.z, q.c, q.s]))};
var<private> SB: array<vec4<f32>, ${W.length}> = ${arr(W.map(q => [q.hx, q.hz, q.height, (q.box ? 0 : 1) + (q.top ? 2 : 0)]))};
var<private> SC: array<vec4<f32>, ${W.length}> = ${arr(W.map(q => [q.vx || 0, q.vz || 0, 0, 0]))};
fn stime() -> f32 { return bitcast<f32>(S.p0); }
` : '';
    // a roof is a floor for a node over it that came down from above it
    const roofs = W && W.some(q => q.top) ? `
    let tt = stime(); let py = P[i + 1u];
    for (var k = 0u; k < NS; k++) {
      let sb = SB[k];
      if ((u32(sb.w) & 2u) == 0u || py < sb.z - 0.25) { continue; }
      let sa = SA[k]; let sc = SC[k];
      let dx = x.x - (sa.x + sc.x * tt); let dz = x.z - (sa.y + sc.y * tt);
      if (abs(dx * sa.z + dz * sa.w) > sb.x || abs(-dx * sa.w + dz * sa.z) > sb.y) { continue; }
      let fl = sb.z + ni.y;
      if (x.y < fl) { ct.x = max(ct.x, fl - x.y); x.y = fl; }
    }` : '';
    out.ground = head + worldDecl + store([['X', 'array<f32>', 1], ['P', 'array<f32>'], ['NI', 'array<vec4<f32>>'], ['CT', 'array<vec4<f32>>', 1], ['IMPS', 'array<vec4<f32>>', 1], ['FIRST', 'array<u32>', 1]]) + `
@compute @workgroup_size(${WG}) fn main(@builtin(global_invocation_id) g: vec3<u32>) {
  let a = g.x;
  if (a >= N) { return; }
  let ni = NI[a];
  var ct = vec4<f32>(0.0);
  if ((u32(ni.z) & 1u) == 0u) {
    let i = 3u * a;
    var x = vec3<f32>(X[i], X[i + 1u], X[i + 2u]);
    if (x.y < ni.y) { ct.x = ni.y - x.y; x.y = ni.y; }${rigid}${roofs}
    X[i] = x.x; X[i + 1u] = x.y; X[i + 2u] = x.z;
  }
  CT[a] = ct;
}`;
    if (hc) out.honeycomb = head + `
const NL: u32 = ${hc.lanes}u;
const HH: f32 = ${f(hc.h)}; const NZC: u32 = ${hc.nzc}u; const NYC: u32 = ${hc.nyc}u; const HY0: f32 = ${f(hc.y0)};
const PADY: f32 = ${f(hc.padY)}; const PADZ: f32 = ${f(hc.padZ)}; const SIDE: f32 = ${f(ob.side)}; const ZEDGE: f32 = ${f(ob.zEdge)};
const SOLID: f32 = ${f(hc.solid)}; const MAIN_D: f32 = ${f(hc.mainDepth)}; const BUMP_D: f32 = ${f(hc.bumperDepth)};
const MAIN_S: f32 = ${f(hc.mainStress)}; const BUMP_S: f32 = ${f(hc.bumperStress)};
` + store([['X', 'array<f32>', 1], ['P', 'array<f32>'], ['NI', 'array<vec4<f32>>'], ['CT', 'array<vec4<f32>>', 1], ['IMPS', 'array<vec4<f32>>', 1], ['FIRST', 'array<u32>', 1],
      ['LN', 'array<u32>'], ['CD', 'array<vec2<f32>>', 1], ['CLAIM', 'array<atomic<u32>>', 1], ['WHC', 'array<f32>', 1]]) + `
fn stressOf(c: f32, dep: f32) -> f32 { if (c < BUMP_D && dep > MAIN_D + 1e-6) { return BUMP_S; } return MAIN_S; }
fn work(c0: f32, c1: f32, dep: f32) -> f32 {   // crushing a cell from c0 to c1 (J), as physics.js crushWork
  let b = select(0.0, BUMP_D, dep > MAIN_D + 1e-6);
  let inB = max(0.0, min(c1, b) - c0);
  return HH * HH * (inB * BUMP_S + ((c1 - c0) - inB) * MAIN_S);
}
// One thread per lane of nodes (the nodes one behind the other at the same height and side
// position, in the CPU's order), as physics.js honeycombContact; a cell is crushed by at most one
// node per step (CLAIM holds the step that claimed it).
@compute @workgroup_size(${WG}) fn main(@builtin(global_invocation_id) g: vec3<u32>) {
  let lane = g.x;
  if (lane >= NL) { return; }
  for (var q = LN[lane]; q < LN[lane + 1u]; q++) {
    let a = LN[NL + 1u + q];
    let ni = NI[a]; let i3 = 3u * a;
    var x = vec3<f32>(X[i3], X[i3 + 1u], X[i3 + 2u]);
    let p = vec3<f32>(P[i3], P[i3 + 1u], P[i3 + 2u]);
    let w = -SIDE * (x.z - ZEDGE);
    let iz0 = max(0, i32(ceil((-w - PADZ) / HH - 0.5))); let iz1 = min(i32(NZC) - 1, i32(floor((-w + PADZ) / HH - 0.5)));
    let iy0 = max(0, i32(ceil((x.y - PADY - HY0) / HH - 0.5))); let iy1 = min(i32(NYC) - 1, i32(floor((x.y + PADY - HY0) / HH - 0.5)));
    if (iz0 > iz1 || iy0 > iy1) { continue; }
    var xf = 0.0; var cnt = 0.0; var cap = 0.0; var solid = false;
    for (var iy = iy0; iy <= iy1; iy++) {
      for (var iz = iz0; iz <= iz1; iz++) {
        let i = u32(iy) * NZC + u32(iz);
        let cd = CD[i];
        xf = xf + cd.x - cd.y; cnt = cnt + 1.0;
        if (cd.x >= cd.y - SOLID - 1e-9) { solid = true; }
        else if (atomicLoad(&CLAIM[i]) != S.idx) { cap = cap + stressOf(cd.x, cd.y) * HH * HH; }
      }
    }
    xf = xf / cnt;
    var pen = x.x + R - xf;
    if (pen <= 0.0) { continue; }
    pen = min(pen, max(0.0, x.x - p.x + MAXSEP * S.dt));
    if (pen <= 0.0) { continue; }
    let m = 1.0 / ni.x;
    let crush = !solid && m * pen > cap * S.dt * S.dt;
    var dx = pen;
    if (crush) { dx = cap * S.dt * S.dt / m; }
    x.x = x.x - dx;
    if (crush) {
      let front = x.x + R; let adv = max(0.0, x.x - p.x);
      for (var iy = iy0; iy <= iy1; iy++) {
        for (var iz = iz0; iz <= iz1; iz++) {
          let i = u32(iy) * NZC + u32(iz);
          if (atomicExchange(&CLAIM[i], S.idx) == S.idx) { continue; }
          let cd = CD[i];
          let c1 = min(min(cd.y - SOLID, front + cd.y), cd.x + adv);
          if (c1 > cd.x) { WHC[i] = WHC[i] + work(cd.x, c1, cd.y); CD[i] = vec2<f32>(c1, cd.y); }
        }
      }
    }
    var ct = CT[a]; ct.y = dx; CT[a] = ct;
    let imp = dx / (ni.x * S.dt);
    IMPS[2u * a] = IMPS[2u * a] + vec4<f32>(imp, imp * x.x, imp * x.y, imp * x.z);
    IMPS[2u * a + 1u].x = IMPS[2u * a + 1u].x + imp;
    FIRST[a] = min(FIRST[a], S.idx);
    X[i3] = x.x; X[i3 + 1u] = x.y; X[i3 + 2u] = x.z;
  }
}`;
    // the offset barrier's block, the pole or the world, as a signed distance (physics.js obstacleSDF):
    // (distance, nx, nz, the world shape's index)
    if (ob.kind === 'offset' || ob.kind === 'pole' || W) {
      const sdf = W ? worldDecl + `
fn sdf(x: vec3<f32>) -> vec4<f32> {
  let tt = stime();
  var best = 1e9; var bn = vec2<f32>(-1.0, 0.0); var bi = 0.0;
  for (var k = 0u; k < NS; k++) {
    let sa = SA[k]; let sb = SB[k]; let sc = SC[k];
    if (x.y > sb.z) { continue; }
    let dx = x.x - (sa.x + sc.x * tt); let dz = x.z - (sa.y + sc.y * tt);
    var d: f32; var nn: vec2<f32>;
    if ((u32(sb.w) & 1u) != 0u) {
      let l = max(length(vec2<f32>(dx, dz)), 1e-9); d = l - sb.x; nn = vec2<f32>(dx / l, dz / l);
    } else {
      let u = dx * sa.z + dz * sa.w; let w = -dx * sa.w + dz * sa.z;
      let qu = abs(u) - sb.x; let qw = abs(w) - sb.y; let su = select(1.0, -1.0, u < 0.0); let sw = select(1.0, -1.0, w < 0.0);
      var nu: f32; var nw: f32;
      if (qu > 0.0 || qw > 0.0) { let ou = max(qu, 0.0); let ow = max(qw, 0.0); let l = max(length(vec2<f32>(ou, ow)), 1e-9); d = l; nu = su * ou / l; nw = sw * ow / l; }
      else if (qu > qw) { d = qu; nu = su; nw = 0.0; }
      else { d = qw; nu = 0.0; nw = sw; }
      nn = vec2<f32>(nu * sa.z - nw * sa.w, nu * sa.w + nw * sa.z);
    }
    if (d < best) { best = d; bn = nn; bi = f32(k); }
  }
  return vec4<f32>(best, bn.x, bn.y, bi);
}` : ob.kind === 'pole' ? `
fn sdf(x: vec3<f32>) -> vec4<f32> {
  let dx = x.x - ${f(ob.x)}; let dz = x.z - ${f(ob.z)}; let d = max(length(vec2<f32>(dx, dz)), 1e-9);
  if (x.y > ${f(ob.height)}) { return vec4<f32>(1e9, dx / d, dz / d, 0.0); }
  return vec4<f32>(d - ${f(ob.r)}, dx / d, dz / d, 0.0);
}` : `
fn sdf(x: vec3<f32>) -> vec4<f32> {
  if (x.y > ${f(ob.height)}) { return vec4<f32>(1e9, -1.0, 0.0, 0.0); }
  let s = -(${f(ob.side)}); let w = s * (x.z - ${f(ob.zEdge)}); let rho = ${f(ob.edgeRadius)};
  var d: f32; var nx: f32; var nw: f32;
  if (x.x < rho && w > -rho) { let ex = x.x - rho; let ew = w + rho; let l = max(length(vec2<f32>(ex, ew)), 1e-9); d = l - rho; nx = ex / l; nw = ew / l; }
  else if (w > -rho) { d = w; nx = 0.0; nw = 1.0; }
  else if (x.x < rho || x.x < -w) { d = -x.x; nx = -1.0; nw = 0.0; }
  else { d = w; nx = 0.0; nw = 1.0; }
  if (-(${f(ob.width)}) - w > d) { d = -(${f(ob.width)}) - w; nx = 0.0; nw = -1.0; }
  return vec4<f32>(d, nx, s * nw, 0.0);
}`;
      out.surface = head + store([['X', 'array<f32>', 1], ['P', 'array<f32>'], ['NI', 'array<vec4<f32>>'], ['CT', 'array<vec4<f32>>', 1], ['NRM', 'array<vec4<f32>>', 1], ['IMPS', 'array<vec4<f32>>', 1], ['FIRST', 'array<u32>', 1]]) + sdf + `
@compute @workgroup_size(${WG}) fn main(@builtin(global_invocation_id) g: vec3<u32>) {
  let a = g.x;
  if (a >= N) { return; }
  let ni = NI[a];
  if ((u32(ni.z) & 1u) != 0u) { return; }
  let i = 3u * a;
  var x = vec3<f32>(X[i], X[i + 1u], X[i + 2u]);
  let p = vec3<f32>(P[i], P[i + 1u], P[i + 2u]);
  let gq = sdf(x);
  if (gq.x >= R) { return; }
  // cancel this step's approach (relative to a moving box), but never push the node out faster than MAXSEP
  ${W ? 'let sv = SC[u32(gq.w)].xy;' : 'let sv = vec2<f32>(0.0);'}
  let pen = min(R - gq.x, max(0.0, -((x.x - p.x - sv.x * S.dt) * gq.y + (x.z - p.z - sv.y * S.dt) * gq.z) + MAXSEP * S.dt));
  if (pen <= 0.0) { return; }
  x.x = x.x + pen * gq.y; x.z = x.z + pen * gq.z;
  var ct = CT[a]; ct.z = pen; CT[a] = ct;
  NRM[a] = vec4<f32>(gq.y, gq.z, sv.x, sv.y);
  let imp = pen / (ni.x * S.dt);
  IMPS[2u * a] = IMPS[2u * a] + vec4<f32>(imp, imp * x.x, imp * x.y, imp * x.z);
  IMPS[2u * a + 1u].x = IMPS[2u * a + 1u].x + ${ob.kind === 'offset' ? 'imp * max(0.0, -gq.y)' : 'imp'};
  FIRST[a] = min(FIRST[a], S.idx);
  X[i] = x.x; X[i + 1u] = x.y; X[i + 2u] = x.z;
}`;
    }
    const multi = d.units > 1;
    if (multi) out.cars = head + `
const D: f32 = 2.0 * R;
const NODE_SEP: f32 = ${f(d.NODE_SEPARATION)};
const K: u32 = ${PAIRS}u;
var<workgroup> TX: array<vec4<f32>, ${WG}>;
var<workgroup> TP: array<vec4<f32>, ${WG}>;
` + store([['X', 'array<f32>'], ['P', 'array<f32>'], ['NI', 'array<vec4<f32>>'], ['DC', 'array<vec4<f32>>', 1], ['PR', 'array<vec4<f32>>', 1], ['IMPS', 'array<vec4<f32>>', 1], ['FIRST', 'array<u32>', 1]]) + `
// Car against car: each node against every node of the other cars (tiled through workgroup
// memory), its own share of each correction gathered from the same positions (physics.js
// carCarContacts does them one after the other). The contacts are kept for friction.
@compute @workgroup_size(${WG}) fn main(@builtin(global_invocation_id) g: vec3<u32>, @builtin(local_invocation_index) li: u32) {
  let a = g.x;
  let valid = a < N;
  var xa = vec3<f32>(0.0); var pa = vec3<f32>(0.0); var wa = 0.0; var ua = 0u; var ghostA = true;
  if (valid) {
    xa = vec3<f32>(X[3u * a], X[3u * a + 1u], X[3u * a + 2u]); pa = vec3<f32>(P[3u * a], P[3u * a + 1u], P[3u * a + 2u]);
    let ni = NI[a]; wa = ni.x; ua = u32(ni.z) >> 2u; ghostA = (u32(ni.z) & 1u) != 0u;
  }
  var dc = vec3<f32>(0.0); var np = 0u; var fimp = 0.0; var eimp = vec4<f32>(0.0); var first = 0xffffffffu;
  for (var base = 0u; base < N; base = base + ${WG}u) {
    let b = base + li;
    if (b < N) {
      TX[li] = vec4<f32>(X[3u * b], X[3u * b + 1u], X[3u * b + 2u], NI[b].x);
      TP[li] = vec4<f32>(P[3u * b], P[3u * b + 1u], P[3u * b + 2u], NI[b].z);
    } else { TP[li] = vec4<f32>(0.0, 0.0, 0.0, 1.0); }
    workgroupBarrier();
    if (valid && !ghostA) {
      for (var j = 0u; j < ${WG}u; j++) {
        let bb = base + j;
        if (bb >= N) { break; }
        let fl = u32(TP[j].w);
        if ((fl & 1u) != 0u || (fl >> 2u) == ua) { continue; }
        let xb = TX[j].xyz;
        let dv = xa - xb; let d2 = dot(dv, dv);
        if (d2 >= D * D || d2 < 1e-18) { continue; }
        let dl0 = sqrt(d2); let nrm = dv / dl0;
        let pen = min(D - dl0, max(0.0, -dot((xa - pa) - (xb - TP[j].xyz), nrm) + NODE_SEP * S.dt));
        if (pen <= 0.0) { continue; }
        let dl = pen / (wa + TX[j].w);
        dc = dc + wa * dl * nrm;
        if (np < K) { PR[2u * (a * K + np)] = vec4<f32>(bitcast<f32>(bb), dl, 0.0, 0.0); PR[2u * (a * K + np) + 1u] = vec4<f32>(nrm, 0.0); np = np + 1u; }
        let imp = dl / S.dt;   // the contact force times the step
        fimp = fimp + imp;
        if (ua < (fl >> 2u)) { let mid = 0.5 * (xa + xb); eimp = eimp + vec4<f32>(imp, imp * mid); }
        first = min(first, S.idx);
      }
    }
    workgroupBarrier();
  }
  if (valid) {
    DC[a] = vec4<f32>(dc, f32(np));
    if (!ghostA) {
      IMPS[2u * a] = IMPS[2u * a] + eimp;
      IMPS[2u * a + 1u].y = IMPS[2u * a + 1u].y + fimp;
      FIRST[a] = min(FIRST[a], first);
    }
  }
}`;
    // friction at the node's own contacts (physics.js frictionPass), then (one car) velocities
    const surfFr = out.surface ? `
    if (ct.z > 0.0) {
      let nn = NRM[a];
      var t = x - p - vec3<f32>(nn.z, 0.0, nn.w) * S.dt;
      let dn = t.x * nn.x + t.z * nn.y; t.x = t.x - dn * nn.x; t.z = t.z - dn * nn.y;
      let len = length(t); let lim = ${f(d.MU_WALL)} * ct.z;
      x = x - select(lim / len, 1.0, len <= lim) * t;
    }` : '';
    out.friction = head + store([['X', 'array<f32>', 1], ['P', 'array<f32>'], ['V', 'array<f32>', 1], ['NI', 'array<vec4<f32>>'], ['CT', 'array<vec4<f32>>'],
      ...(out.surface ? [['NRM', 'array<vec4<f32>>']] : []), ...(multi ? [['DC', 'array<vec4<f32>>']] : [])]) + `
@compute @workgroup_size(${WG}) fn main(@builtin(global_invocation_id) g: vec3<u32>) {
  let a = g.x;
  if (a >= N) { return; }
  let i = 3u * a;
  var x = vec3<f32>(X[i], X[i + 1u], X[i + 2u]);
  let p = vec3<f32>(P[i], P[i + 1u], P[i + 2u]);
  let ni = NI[a];
  let flags = u32(ni.z);${multi ? '\n  x = x + DC[a].xyz;' : ''}
  if ((flags & 1u) == 0u) {
    let ct = CT[a];
    if (ct.x > 0.0) {
      let dx = x.x - p.x; let dz = x.z - p.z;
      if ((flags & 2u) != 0u) {   // a wheel: rolls along its car, grips sideways
        let r = S.roll[flags >> 2u];
        let fx = r.x; let fz = r.y; let lx = -fz; let lz = fx;
        let rf = clamp(dx * fx + dz * fz, -ni.w * ct.x, ni.w * ct.x);
        let rl = clamp(dx * lx + dz * lz, -${f(d.MU_LAT)} * ct.x, ${f(d.MU_LAT)} * ct.x);
        x.x = x.x - (rf * fx + rl * lx); x.z = x.z - (rf * fz + rl * lz);
      } else {
        let len = length(vec2<f32>(dx, dz)); let lim = ${f(d.MU_BODY)} * ct.x;
        let s = select(lim / len, 1.0, len <= lim);
        x.x = x.x - s * dx; x.z = x.z - s * dz;
      }
    }
    if (ct.y > 0.0) {
      let dy = x.y - p.y; let dz = x.z - p.z;
      let len = length(vec2<f32>(dy, dz)); let lim = ${f(d.MU_WALL)} * ct.y;
      let s = select(lim / len, 1.0, len <= lim);
      x.y = x.y - s * dy; x.z = x.z - s * dz;
    }${surfFr}
  }
  X[i] = x.x; X[i + 1u] = x.y; X[i + 2u] = x.z;${multi ? '' : `
  let v = (x - p) / S.dt;
  V[i] = v.x; V[i + 1u] = v.y; V[i + 2u] = v.z;`}
}`;
    if (multi) {
      out.carFriction = head + `const K: u32 = ${PAIRS}u;\n` + store([['X', 'array<f32>'], ['P', 'array<f32>'], ['NI', 'array<vec4<f32>>'], ['DC', 'array<vec4<f32>>'], ['PR', 'array<vec4<f32>>'], ['D2', 'array<vec4<f32>>', 1]]) + `
// friction at the car-against-car contacts, each node's share from the same positions
@compute @workgroup_size(${WG}) fn main(@builtin(global_invocation_id) g: vec3<u32>) {
  let a = g.x;
  if (a >= N) { return; }
  let xa = vec3<f32>(X[3u * a], X[3u * a + 1u], X[3u * a + 2u]); let pa = vec3<f32>(P[3u * a], P[3u * a + 1u], P[3u * a + 2u]);
  let wa = NI[a].x;
  var d2 = vec3<f32>(0.0);
  let np = u32(DC[a].w);
  for (var k = 0u; k < np; k++) {
    let e0 = PR[2u * (a * K + k)]; let nrm = PR[2u * (a * K + k) + 1u].xyz;
    let b = bitcast<u32>(e0.x);
    let xb = vec3<f32>(X[3u * b], X[3u * b + 1u], X[3u * b + 2u]); let pb = vec3<f32>(P[3u * b], P[3u * b + 1u], P[3u * b + 2u]);
    var t = (xa - pa) - (xb - pb);
    t = t - dot(t, nrm) * nrm;
    let len = length(t);
    if (len < 1e-12) { continue; }
    let lt = min(len / (wa + NI[b].x), ${f(d.MU_CAR)} * e0.y);
    d2 = d2 - wa * lt * (t / len);
  }
  D2[a] = vec4<f32>(d2, 0.0);
}`;
      out.finish = head + store([['X', 'array<f32>', 1], ['P', 'array<f32>'], ['V', 'array<f32>', 1], ['D2', 'array<vec4<f32>>']]) + `
@compute @workgroup_size(${WG}) fn main(@builtin(global_invocation_id) g: vec3<u32>) {
  let a = g.x;
  if (a >= N) { return; }
  let i = 3u * a;
  let x = vec3<f32>(X[i], X[i + 1u], X[i + 2u]) + D2[a].xyz;
  let p = vec3<f32>(P[i], P[i + 1u], P[i + 2u]);
  X[i] = x.x; X[i + 1u] = x.y; X[i + 2u] = x.z;
  let v = (x - p) / S.dt;
  V[i] = v.x; V[i + 1u] = v.y; V[i + 2u] = v.z;
}`;
    }
    return out;
  }

  /* d: { n, nc, X, V, W (inverse masses), floor (ground height per node: the tyre radius for wheel
   *      nodes), ghost, wheel (0/1 per node), muRoll, unitOf, units (count), ca, cb, rest, c0, comp,
   *      damp, cey, ck, r (node radius), G, MU_BODY, MU_WALL, MU_LAT, MU_CAR, MIN_RATIO, MAX_RATIO,
   *      MAX_SEPARATION, NODE_SEPARATION,
   *      obstacle: { kind: 'rigid' (height, halfWidth) | 'offset' (side, zEdge, width, height,
   *                  edgeRadius) | 'pole' (x, z, r, height) | 'world' (shapes: physics.js buildWorld's,
   *                  at time 0) | 'none' },
   *      honeycomb: null or { h, nzc, nyc, y0, depth, crush, padY, padZ, solid, mainDepth,
   *                  bumperDepth, mainStress, bumperStress, ijk (the nodes' lattice indices), ny, nz },
   *      maxSteps } */
  function lattice(gpu, d) {
    const dev = gpu.device, n = d.n, nc = d.nc, maxSteps = d.maxSteps || 256, multi = d.units > 1;
    if (d.units > 4) throw new Error('the GPU solver takes at most 4 vehicles');
    if (d.honeycomb && multi) throw new Error('the GPU solver has no honeycomb with several vehicles');
    if (d.honeycomb && gpu.maxStorage < 10) throw new Error('this GPU allows too few storage buffers for the honeycomb face');
    const C = colour(d.ca, d.cb, n);
    const SU = GPUBufferUsage.STORAGE, CD = GPUBufferUsage.COPY_DST, CS = GPUBufferUsage.COPY_SRC;
    const buf = (bytes, usage) => dev.createBuffer({ size: Math.max(16, Math.ceil(bytes / 16) * 16), usage });
    const put = (b, arr) => dev.queue.writeBuffer(b, 0, arr);
    const B = {};
    // node state and properties
    B.X = buf(12 * n, SU | CD | CS); B.P = buf(12 * n, SU | CD); B.V = buf(12 * n, SU | CD | CS);
    B.NI = buf(16 * n, SU | CD); B.CT = buf(16 * n, SU); B.IMPS = buf(32 * n, SU | CD | CS); B.FIRST = buf(4 * n, SU | CD | CS);
    put(B.X, Float32Array.from(d.X)); put(B.P, Float32Array.from(d.X)); put(B.V, Float32Array.from(d.V));
    const ni = new Float32Array(4 * n);
    for (let a = 0; a < n; a++) {
      ni[4 * a] = d.W[a]; ni[4 * a + 1] = d.floor[a];
      ni[4 * a + 2] = (d.ghost[a] ? 1 : 0) + (d.wheel[a] ? 2 : 0) + 4 * (d.unitOf ? d.unitOf[a] : 0);
      ni[4 * a + 3] = d.muRoll[a];
    }
    put(B.NI, ni);
    const noFirst = new Uint32Array(n).fill(0xffffffff), zerosI = new Float32Array(8 * n);
    put(B.FIRST, noFirst);
    if (d.obstacle.kind === 'offset' || d.obstacle.kind === 'pole' || d.obstacle.kind === 'world') B.NRM = buf(16 * n, SU);
    if (multi) { B.DC = buf(16 * n, SU); B.PR = buf(32 * PAIRS * n, SU); B.D2 = buf(16 * n, SU); }
    // the honeycomb: lanes of nodes (same lattice row and column, front to back as the CPU visits
    // them), and its cells (crush, depth), claims and crush work
    const H = d.honeycomb;
    let nCells = 0, zerosW = null;
    if (H) {
      const lanes = new Map();
      for (let a = 0; a < n; a++) {
        if (d.ghost[a]) continue;
        const key = H.ijk[3 * a + 1] * H.nz + H.ijk[3 * a + 2];
        if (!lanes.has(key)) lanes.set(key, []);
        lanes.get(key).push(a);
      }
      const L = [...lanes.values()], ln = new Uint32Array(L.length + 1 + n);
      let q = 0;
      L.forEach((list, i) => { ln[i] = q; for (const a of list) ln[L.length + 1 + q++] = a; });
      ln[L.length] = q;
      H.lanes = L.length;
      nCells = H.nzc * H.nyc;
      B.LN = buf(4 * ln.length, SU | CD); put(B.LN, ln);
      const cd = new Float32Array(2 * nCells);
      for (let i = 0; i < nCells; i++) { cd[2 * i] = H.crush[i]; cd[2 * i + 1] = H.depth[i]; }
      B.CD = buf(8 * nCells, SU | CD | CS); put(B.CD, cd);
      B.CLAIM = buf(4 * nCells, SU | CD); put(B.CLAIM, new Uint32Array(nCells).fill(0xffffffff));
      B.WHC = buf(4 * nCells, SU | CD | CS);
      zerosW = new Float32Array(nCells);
    }
    // constraints, in colour order
    const con = new ArrayBuffer(32 * nc), cu = new Uint32Array(con), cf = new Float32Array(con);
    const restS = new Float32Array(nc);
    for (let j = 0; j < nc; j++) {
      const c = C.order[j], o = 8 * j;
      cu[o] = d.ca[c]; cu[o + 1] = d.cb[c];
      cf[o + 2] = d.c0[c]; cf[o + 3] = d.comp[c]; cf[o + 4] = d.damp[c]; cf[o + 5] = d.cey[c]; cf[o + 6] = d.ck[c];
      restS[j] = d.rest[c];
    }
    B.C = buf(32 * nc, SU | CD); B.rest = buf(4 * nc, SU | CD | CS); B.plastic = buf(4 * nc, SU | CD | CS); B.wp = buf(4 * nc, SU | CD | CS);
    put(B.C, con); put(B.rest, restS);
    const zerosC = new Float32Array(nc);
    // per-step uniforms (dynamic offsets) and per-colour ranges
    B.step = dev.createBuffer({ size: STEP_STRIDE * maxSteps, usage: GPUBufferUsage.UNIFORM | CD });
    B.range = dev.createBuffer({ size: STEP_STRIDE * C.ncol, usage: GPUBufferUsage.UNIFORM | CD });
    const rr = new Uint32Array(C.ncol * STEP_STRIDE / 4);
    C.ranges.forEach(([o, c], k) => { rr[k * STEP_STRIDE / 4] = o; rr[k * STEP_STRIDE / 4 + 1] = c; });
    put(B.range, rr);
    // pipelines: every kernel gets its storage buffers in the order its shader declares them
    const sh = shaders(Object.assign({}, d, { honeycomb: H }));
    const ubl = (size) => dev.createBindGroupLayout({ entries: [{ binding: 0, visibility: GPUShaderStage.COMPUTE, buffer: { type: 'uniform', hasDynamicOffset: true, minBindingSize: size } }] });
    const stepL = ubl(STEP_SIZE), rangeL = ubl(16);
    const gStep = dev.createBindGroup({ layout: stepL, entries: [{ binding: 0, resource: { buffer: B.step, size: STEP_SIZE } }] });
    const gRange = dev.createBindGroup({ layout: rangeL, entries: [{ binding: 0, resource: { buffer: B.range, size: 16 } }] });
    function kernel(name, bufs) {   // bufs: [[buffer, writable], ...] in binding order
      const layout = dev.createBindGroupLayout({ entries: bufs.map(([, w], i) => ({ binding: i, visibility: GPUShaderStage.COMPUTE, buffer: { type: w ? 'storage' : 'read-only-storage' } })) });
      const layouts = name === 'solve' ? [layout, stepL, rangeL] : [layout, stepL];
      const pipeline = dev.createComputePipeline({ layout: dev.createPipelineLayout({ bindGroupLayouts: layouts }), compute: { module: dev.createShaderModule({ code: sh[name] }), entryPoint: 'main' } });
      return { pipeline, group: dev.createBindGroup({ layout, entries: bufs.map(([b], i) => ({ binding: i, resource: { buffer: b } })) }) };
    }
    const ng = Math.ceil(n / WG);
    const K = {
      predict: kernel('predict', [[B.X, 1], [B.P, 1], [B.V, 1]]),
      solve: kernel('solve', [[B.X, 1], [B.P], [B.NI], [B.C], [B.rest, 1], [B.plastic, 1], [B.wp, 1]]),
      ground: kernel('ground', [[B.X, 1], [B.P], [B.NI], [B.CT, 1], [B.IMPS, 1], [B.FIRST, 1]]),
      friction: kernel('friction', [[B.X, 1], [B.P], [B.V, 1], [B.NI], [B.CT], ...(B.NRM ? [[B.NRM]] : []), ...(multi ? [[B.DC]] : [])]),
    };
    if (H) K.honeycomb = kernel('honeycomb', [[B.X, 1], [B.P], [B.NI], [B.CT, 1], [B.IMPS, 1], [B.FIRST, 1], [B.LN], [B.CD, 1], [B.CLAIM, 1], [B.WHC, 1]]);
    if (B.NRM) K.surface = kernel('surface', [[B.X, 1], [B.P], [B.NI], [B.CT, 1], [B.NRM, 1], [B.IMPS, 1], [B.FIRST, 1]]);
    if (multi) {
      K.cars = kernel('cars', [[B.X], [B.P], [B.NI], [B.DC, 1], [B.PR, 1], [B.IMPS, 1], [B.FIRST, 1]]);
      K.carFriction = kernel('carFriction', [[B.X], [B.P], [B.NI], [B.DC], [B.PR], [B.D2, 1]]);
      K.finish = kernel('finish', [[B.X, 1], [B.P], [B.V, 1], [B.D2]]);
    }
    // one step, in the CPU's order
    const order = ['predict', 'solve', 'ground', ...(H ? ['honeycomb'] : []), ...(K.surface ? ['surface'] : []), ...(multi ? ['cars'] : []), 'friction', ...(multi ? ['carFriction', 'finish'] : [])];
    // read-back: X, V, rest, plastic, plastic work, impulses, first contact step (and the honeycomb)
    const parts = [[B.X, 12 * n], [B.V, 12 * n], [B.rest, 4 * nc], [B.plastic, 4 * nc], [B.wp, 4 * nc], [B.IMPS, 32 * n], [B.FIRST, 4 * n]];
    if (H) parts.push([B.CD, 8 * nCells], [B.WHC, 4 * nCells]);
    const offs = [];
    let total = 0;
    for (const [, sz] of parts) { offs.push(total); total += Math.ceil(sz / 16) * 16; }
    const staging = dev.createBuffer({ size: total, usage: GPUBufferUsage.MAP_READ | CD });
    let lost = false;

    // rolls: each vehicle's forward direction in the ground plane [x, z], for its wheels
    // t0: the time at the first step's start (moving boxes are where they are at each step's end)
    async function run(dts, rolls, base, t0 = 0) {
      if (lost) throw new Error('the GPU solver was stopped');
      const k = Math.min(dts.length, maxSteps), su = new ArrayBuffer(STEP_STRIDE * k), sf = new Float32Array(su), si = new Uint32Array(su);
      let tt = t0;
      for (let s = 0; s < k; s++) {
        const o = s * STEP_STRIDE / 4;
        tt += dts[s];
        sf[o] = dts[s]; si[o + 1] = base + s; sf[o + 2] = tt;
        rolls.forEach((r, u) => { sf[o + 4 + 4 * u] = r[0]; sf[o + 5 + 4 * u] = r[1]; });
      }
      dev.queue.writeBuffer(B.step, 0, su);
      const enc = dev.createCommandEncoder(), pass = enc.beginComputePass();
      for (let s = 0; s < k; s++) {
        const so = [s * STEP_STRIDE];
        for (const name of order) {
          const q = K[name];
          pass.setPipeline(q.pipeline); pass.setBindGroup(0, q.group); pass.setBindGroup(1, gStep, so);
          if (name === 'solve') {
            for (let c = 0; c < C.ncol; c++) { pass.setBindGroup(2, gRange, [c * STEP_STRIDE]); pass.dispatchWorkgroups(Math.ceil(C.ranges[c][1] / WG)); }
          } else pass.dispatchWorkgroups(name === 'honeycomb' ? Math.ceil(H.lanes / WG) : ng);
        }
      }
      pass.end();
      parts.forEach(([b, sz], i) => enc.copyBufferToBuffer(b, 0, staging, offs[i], Math.ceil(sz / 4) * 4));
      dev.queue.submit([enc.finish()]);
      await staging.mapAsync(GPUMapMode.READ);
      const all = staging.getMappedRange(), F = (i, len) => new Float32Array(all.slice(offs[i], offs[i] + 4 * len));
      const restC = F(2, nc), plC = F(3, nc), wpC = F(4, nc);
      const out = { X: F(0, 3 * n), V: F(1, 3 * n), imps: F(5, 8 * n), first: new Uint32Array(all.slice(offs[6], offs[6] + 4 * n)),
        rest: new Float32Array(nc), plastic: new Float32Array(nc), wp: new Float32Array(nc), steps: k };
      for (let j = 0; j < nc; j++) { const c = C.order[j]; out.rest[c] = restC[j]; out.plastic[c] = plC[j]; out.wp[c] = wpC[j]; }
      if (H) {
        const cd = F(7, 2 * nCells);
        out.crush = new Float32Array(nCells);
        for (let i = 0; i < nCells; i++) out.crush[i] = cd[2 * i];
        out.whc = F(8, nCells);
      }
      staging.unmap();
      // the plastic work, impulses, first contact and crush work are per batch
      dev.queue.writeBuffer(B.wp, 0, zerosC); dev.queue.writeBuffer(B.IMPS, 0, zerosI); dev.queue.writeBuffer(B.FIRST, 0, noFirst);
      if (H) dev.queue.writeBuffer(B.WHC, 0, zerosW);
      return out;
    }
    function destroy() { lost = true; for (const b of Object.values(B)) b.destroy(); staging.destroy(); }
    return { run, destroy, colours: C.ncol, maxSteps, name: gpu.name };
  }

  return { init, lattice, colour, get available() { return typeof navigator !== 'undefined' && !!navigator.gpu; } };
})();
if (typeof window !== 'undefined') window.CrashGPU = CrashGPU;
