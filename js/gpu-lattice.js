/* The car lattice on the GPU (WebGPU compute, WGSL): an opt-in alternative to the inner loop of
 * physics.js createImpactSim (cfg.gpu), for one car into the rigid barrier.
 *
 * Each step runs the same equations as the CPU solver: predict; the lattice's distance constraints
 * (XPBD with damping, plastic yield and its rest-length limits); ground and barrier contact with
 * Coulomb friction (rolling along the car for the wheel nodes); velocities. The CPU solver projects
 * the constraints one after the other (Gauss-Seidel). Here they are split into colour groups, no two
 * constraints in a group sharing a node, so each group is projected in parallel and the groups one
 * after the other: the same method in a different order. Positions are 32-bit floats (the CPU uses
 * 64-bit), so results differ slightly from the CPU's.
 *
 * run(dts, rollDir, base) does a batch of steps (one recorded frame's worth) and resolves to the
 * state read back from the GPU, for the CPU's bookkeeping (telemetry, energies, frames).
 * Browser only: needs navigator.gpu (a secure context: https, localhost or file://). */
const CrashGPU = (() => {
  'use strict';
  const STEP_STRIDE = 256;   // uniform buffer offset alignment
  const WG = 64;

  let devicePromise = null;
  // the GPU device, requested once; rejects with a readable message if there is none
  function init() {
    if (!devicePromise) devicePromise = (async () => {
      if (typeof navigator === 'undefined' || !navigator.gpu) throw new Error('this browser has no WebGPU');
      const adapter = await navigator.gpu.requestAdapter({ powerPreference: 'high-performance' });
      if (!adapter) throw new Error('no WebGPU adapter (GPU) available');
      const device = await adapter.requestDevice();
      const info = adapter.info || {};
      device.lost.then((e) => { devicePromise = null; console.warn('WebGPU device lost:', e.message); });
      return { device, name: [info.vendor, info.architecture].filter(Boolean).join(' ') || 'GPU' };
    })();
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

  const STEP = 'struct Step { dt: f32, idx: u32, rx: f32, rz: f32 };\n@group(1) @binding(0) var<uniform> S: Step;\n';
  function shaders(d) {
    const f = (v) => { const s = String(v); return /[.e]/.test(s) ? s : s + '.0'; };
    const head = `const N: u32 = ${d.n}u;\nconst G: f32 = ${f(d.G)};\n` + STEP;
    const predict = head + `
@group(0) @binding(0) var<storage, read_write> X: array<f32>;
@group(0) @binding(1) var<storage, read_write> P: array<f32>;
@group(0) @binding(2) var<storage, read_write> V: array<f32>;
@compute @workgroup_size(${WG}) fn main(@builtin(global_invocation_id) g: vec3<u32>) {
  let a = g.x;
  if (a >= N) { return; }
  let i = 3u * a;
  P[i] = X[i]; P[i + 1u] = X[i + 1u]; P[i + 2u] = X[i + 2u];
  V[i + 1u] = V[i + 1u] - G * S.dt;
  X[i] = X[i] + V[i] * S.dt; X[i + 1u] = X[i + 1u] + V[i + 1u] * S.dt; X[i + 2u] = X[i + 2u] + V[i + 2u] * S.dt;
}`;
    const solve = STEP + `
const MIN_RATIO: f32 = ${f(d.MIN_RATIO)};
const MAX_RATIO: f32 = ${f(d.MAX_RATIO)};
struct Con { a: u32, b: u32, c0: f32, comp: f32, damp: f32, cey: f32, ck: f32, pad: f32 };
struct Range { off: u32, cnt: u32, pad0: u32, pad1: u32 };
@group(0) @binding(0) var<storage, read_write> X: array<f32>;
@group(0) @binding(1) var<storage, read> P: array<f32>;
@group(0) @binding(2) var<storage, read> NI: array<vec4<f32>>;
@group(0) @binding(3) var<storage, read> C: array<Con>;
@group(0) @binding(4) var<storage, read_write> rest: array<f32>;
@group(0) @binding(5) var<storage, read_write> plastic: array<f32>;
@group(0) @binding(6) var<storage, read_write> wp: array<f32>;
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
    const nodes = head + `
const R: f32 = ${f(d.r)};
const BH: f32 = ${f(d.barrier.height)};
const BW: f32 = ${f(d.barrier.halfWidth)};
const MU_BODY: f32 = ${f(d.MU_BODY)};
const MU_WALL: f32 = ${f(d.MU_WALL)};
const MU_LAT: f32 = ${f(d.MU_LAT)};
@group(0) @binding(0) var<storage, read_write> X: array<f32>;
@group(0) @binding(1) var<storage, read> P: array<f32>;
@group(0) @binding(2) var<storage, read_write> V: array<f32>;
@group(0) @binding(3) var<storage, read> NI: array<vec4<f32>>;
@group(0) @binding(4) var<storage, read_write> IMP: array<vec4<f32>>;
@group(0) @binding(5) var<storage, read_write> FIRST: array<u32>;
@compute @workgroup_size(${WG}) fn main(@builtin(global_invocation_id) g: vec3<u32>) {
  let a = g.x;
  if (a >= N) { return; }
  let i = 3u * a;
  var x = vec3<f32>(X[i], X[i + 1u], X[i + 2u]);
  let p = vec3<f32>(P[i], P[i + 1u], P[i + 2u]);
  let ni = NI[a];
  let flags = u32(ni.z);
  if ((flags & 1u) == 0u) {
    // contacts: the ground (or the tyre's radius), then the barrier face
    var lg = 0.0; var lb = 0.0;
    if (x.y < ni.y) { lg = ni.y - x.y; x.y = ni.y; }
    if (x.x + R > 0.0 && x.y < BH && abs(x.z) < BW) {
      lb = x.x + R; x.x = -R;
      let imp = lb / (ni.x * S.dt);   // m d / dt, the impulse this step
      IMP[a] = IMP[a] + vec4<f32>(imp, imp * x.x, imp * x.y, imp * x.z);
      FIRST[a] = min(FIRST[a], S.idx);
    }
    // friction (physics.js frictionPass): wheels roll along the car and grip sideways
    if (lg > 0.0) {
      let dx = x.x - p.x; let dz = x.z - p.z;
      if ((flags & 2u) != 0u) {
        let fx = S.rx; let fz = S.rz; let lx = -fz; let lz = fx;
        let rf = clamp(dx * fx + dz * fz, -ni.w * lg, ni.w * lg);
        let rl = clamp(dx * lx + dz * lz, -MU_LAT * lg, MU_LAT * lg);
        x.x = x.x - (rf * fx + rl * lx); x.z = x.z - (rf * fz + rl * lz);
      } else {
        let len = length(vec2<f32>(dx, dz)); let lim = MU_BODY * lg;
        let s = select(lim / len, 1.0, len <= lim);
        x.x = x.x - s * dx; x.z = x.z - s * dz;
      }
    }
    if (lb > 0.0) {
      let dy = x.y - p.y; let dz = x.z - p.z;
      let len = length(vec2<f32>(dy, dz)); let lim = MU_WALL * lb;
      let s = select(lim / len, 1.0, len <= lim);
      x.y = x.y - s * dy; x.z = x.z - s * dz;
    }
  }
  X[i] = x.x; X[i + 1u] = x.y; X[i + 2u] = x.z;
  let v = (x - p) / S.dt;
  V[i] = v.x; V[i + 1u] = v.y; V[i + 2u] = v.z;
}`;
    return { predict, solve, nodes };
  }

  /* d: { n, nc, X, V, W (inverse masses), floor (ground height per node: the tyre radius for wheel
   *      nodes), ghost, wheel (0/1 per node), muRoll, ca, cb, rest, c0, comp, damp, cey, ck,
   *      r (node radius), barrier { height, halfWidth }, G, MU_BODY, MU_WALL, MU_LAT, MIN_RATIO,
   *      MAX_RATIO, maxSteps } */
  function lattice(gpu, d) {
    const dev = gpu.device, n = d.n, nc = d.nc, maxSteps = d.maxSteps || 256;
    const C = colour(d.ca, d.cb, n);
    const S = GPUBufferUsage.STORAGE, CD = GPUBufferUsage.COPY_DST, CS = GPUBufferUsage.COPY_SRC;
    const buf = (bytes, usage) => dev.createBuffer({ size: Math.max(16, Math.ceil(bytes / 16) * 16), usage });
    const put = (b, arr) => dev.queue.writeBuffer(b, 0, arr);
    // node state and properties
    const bX = buf(12 * n, S | CD | CS), bP = buf(12 * n, S | CD), bV = buf(12 * n, S | CD | CS);
    const bNI = buf(16 * n, S | CD), bIMP = buf(16 * n, S | CD | CS), bFIRST = buf(4 * n, S | CD | CS);
    put(bX, Float32Array.from(d.X)); put(bP, Float32Array.from(d.X)); put(bV, Float32Array.from(d.V));
    const ni = new Float32Array(4 * n);
    for (let a = 0; a < n; a++) { ni[4 * a] = d.W[a]; ni[4 * a + 1] = d.floor[a]; ni[4 * a + 2] = (d.ghost[a] ? 1 : 0) + (d.wheel[a] ? 2 : 0); ni[4 * a + 3] = d.muRoll[a]; }
    put(bNI, ni);
    const noFirst = new Uint32Array(n).fill(0xffffffff), zeros4 = new Float32Array(4 * n);
    put(bFIRST, noFirst);
    // constraints, in colour order
    const con = new ArrayBuffer(32 * nc), cu = new Uint32Array(con), cf = new Float32Array(con);
    const restS = new Float32Array(nc);
    for (let j = 0; j < nc; j++) {
      const c = C.order[j], o = 8 * j;
      cu[o] = d.ca[c]; cu[o + 1] = d.cb[c];
      cf[o + 2] = d.c0[c]; cf[o + 3] = d.comp[c]; cf[o + 4] = d.damp[c]; cf[o + 5] = d.cey[c]; cf[o + 6] = d.ck[c];
      restS[j] = d.rest[c];
    }
    const bC = buf(32 * nc, S | CD), bRest = buf(4 * nc, S | CD | CS), bPl = buf(4 * nc, S | CD | CS), bWp = buf(4 * nc, S | CD | CS);
    put(bC, con); put(bRest, restS);
    const zerosC = new Float32Array(nc);
    // per-step uniforms (dynamic offsets) and per-colour ranges
    const bStep = dev.createBuffer({ size: STEP_STRIDE * maxSteps, usage: GPUBufferUsage.UNIFORM | CD });
    const bRange = dev.createBuffer({ size: STEP_STRIDE * C.ncol, usage: GPUBufferUsage.UNIFORM | CD });
    const rr = new Uint32Array(C.ncol * STEP_STRIDE / 4);
    C.ranges.forEach(([o, c], k) => { rr[k * STEP_STRIDE / 4] = o; rr[k * STEP_STRIDE / 4 + 1] = c; });
    put(bRange, rr);
    // pipelines
    const sh = shaders(d);
    const ubl = (dyn) => dev.createBindGroupLayout({ entries: [{ binding: 0, visibility: GPUShaderStage.COMPUTE, buffer: { type: 'uniform', hasDynamicOffset: dyn } }] });
    const stepL = ubl(true), rangeL = ubl(true);
    const storeL = (kinds) => dev.createBindGroupLayout({ entries: kinds.map((k, i) => ({ binding: i, visibility: GPUShaderStage.COMPUTE, buffer: { type: k === 'r' ? 'read-only-storage' : 'storage' } })) });
    const mk = (code, layouts) => dev.createComputePipeline({ layout: dev.createPipelineLayout({ bindGroupLayouts: layouts }), compute: { module: dev.createShaderModule({ code }), entryPoint: 'main' } });
    const lPred = storeL(['w', 'w', 'w']), lSolve = storeL(['w', 'r', 'r', 'r', 'w', 'w', 'w']), lNodes = storeL(['w', 'r', 'w', 'r', 'w', 'w']);
    const pPred = mk(sh.predict, [lPred, stepL]), pSolve = mk(sh.solve, [lSolve, stepL, rangeL]), pNodes = mk(sh.nodes, [lNodes, stepL]);
    const bg = (layout, bufs) => dev.createBindGroup({ layout, entries: bufs.map((b, i) => ({ binding: i, resource: { buffer: b } })) });
    const gPred = bg(lPred, [bX, bP, bV]), gSolve = bg(lSolve, [bX, bP, bNI, bC, bRest, bPl, bWp]), gNodes = bg(lNodes, [bX, bP, bV, bNI, bIMP, bFIRST]);
    const gStep = dev.createBindGroup({ layout: stepL, entries: [{ binding: 0, resource: { buffer: bStep, size: 16 } }] });
    const gRange = dev.createBindGroup({ layout: rangeL, entries: [{ binding: 0, resource: { buffer: bRange, size: 16 } }] });
    // read-back: X, V, rest, plastic, plastic work, impulses, first contact step
    const parts = [[bX, 12 * n], [bV, 12 * n], [bRest, 4 * nc], [bPl, 4 * nc], [bWp, 4 * nc], [bIMP, 16 * n], [bFIRST, 4 * n]];
    const offs = []; let total = 0;
    for (const [, sz] of parts) { offs.push(total); total += Math.ceil(sz / 16) * 16; }
    const staging = dev.createBuffer({ size: total, usage: GPUBufferUsage.MAP_READ | CD });
    const ng = Math.ceil(n / WG);
    let lost = false;

    async function run(dts, roll, base) {
      if (lost) throw new Error('the GPU solver was stopped');
      const k = Math.min(dts.length, maxSteps), su = new ArrayBuffer(STEP_STRIDE * k), sf = new Float32Array(su), si = new Uint32Array(su);
      for (let s = 0; s < k; s++) { const o = s * STEP_STRIDE / 4; sf[o] = dts[s]; si[o + 1] = base + s; sf[o + 2] = roll[0]; sf[o + 3] = roll[1]; }
      dev.queue.writeBuffer(bStep, 0, su);
      const enc = dev.createCommandEncoder(), pass = enc.beginComputePass();
      for (let s = 0; s < k; s++) {
        const so = [s * STEP_STRIDE];
        pass.setPipeline(pPred); pass.setBindGroup(0, gPred); pass.setBindGroup(1, gStep, so); pass.dispatchWorkgroups(ng);
        pass.setPipeline(pSolve); pass.setBindGroup(0, gSolve); pass.setBindGroup(1, gStep, so);
        for (let c = 0; c < C.ncol; c++) { pass.setBindGroup(2, gRange, [c * STEP_STRIDE]); pass.dispatchWorkgroups(Math.ceil(C.ranges[c][1] / WG)); }
        pass.setPipeline(pNodes); pass.setBindGroup(0, gNodes); pass.setBindGroup(1, gStep, so); pass.dispatchWorkgroups(ng);
      }
      pass.end();
      parts.forEach(([b, sz], i) => enc.copyBufferToBuffer(b, 0, staging, offs[i], Math.ceil(sz / 4) * 4));
      dev.queue.submit([enc.finish()]);
      await staging.mapAsync(GPUMapMode.READ);
      const all = staging.getMappedRange(), F = (i, len) => new Float32Array(all.slice(offs[i], offs[i] + 4 * len));
      const restC = F(2, nc), plC = F(3, nc), wpC = F(4, nc);
      const out = { X: F(0, 3 * n), V: F(1, 3 * n), imp: F(5, 4 * n), first: new Uint32Array(all.slice(offs[6], offs[6] + 4 * n)),
        rest: new Float32Array(nc), plastic: new Float32Array(nc), wp: new Float32Array(nc), steps: k };
      for (let j = 0; j < nc; j++) { const c = C.order[j]; out.rest[c] = restC[j]; out.plastic[c] = plC[j]; out.wp[c] = wpC[j]; }
      staging.unmap();
      // the plastic work, impulses and first contact are per batch
      dev.queue.writeBuffer(bWp, 0, zerosC); dev.queue.writeBuffer(bIMP, 0, zeros4); dev.queue.writeBuffer(bFIRST, 0, noFirst);
      return out;
    }
    function destroy() { lost = true; for (const b of [bX, bP, bV, bNI, bIMP, bFIRST, bC, bRest, bPl, bWp, bStep, bRange, staging]) b.destroy(); }
    return { run, destroy, colours: C.ncol, maxSteps, name: gpu.name };
  }

  return { init, lattice, colour, get available() { return typeof navigator !== 'undefined' && !!navigator.gpu; } };
})();
if (typeof window !== 'undefined') window.CrashGPU = CrashGPU;
