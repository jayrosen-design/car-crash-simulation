/* GPU solver check (WebGPU, js/gpu-lattice.js): runs the same crashes with the CPU solver and the
 * GPU solver in headless Chrome and compares what they compute.
 *   node tools/gpu-check.js            (all)
 *   node tools/gpu-check.js honeycomb  (scenarios whose name contains "honeycomb"; "scaling" for the timing)
 * Needs Chrome with WebGPU (the page is opened from disk, a secure context). The scenarios are
 * rigid-barrier crashes in which nothing comes off on the CPU either, so both solve the same thing,
 * then the crash labs' set-ups (offset barrier, honeycomb, two cars, side trolley, pole).
 * Differences come from the order the GPU works in (constraints in colour groups, car-to-car
 * contacts gathered per node) and its 32-bit floats. Fails if a GPU run errors or falls back to the
 * CPU, or if what a test reports differs by more than its tolerance. */
'use strict';
const { spawn } = require('child_process');
const fs = require('fs'), path = require('path'), os = require('os');
const CHROME = process.env.CHROME || 'C:/Program Files/Google/Chrome/Application/chrome.exe';
const page = 'file:///' + path.join(__dirname, '..', 'index.html').split(path.sep).join('/');
const SC = [['lab', 56], ['lab', 40], ['lexus', 56], ['mustang', 48]];
const TOL = { crush: 0.06, peak: 0.12, dv: 0.03, plastic: 0.08 };   // relative
const sleep = (ms) => new Promise(r => setTimeout(r, ms));
const filter = process.argv[2] || '';
const want = (name) => !filter || name.includes(filter);

(async () => {
  const port = 9300 + Math.floor(Math.random() * 300);
  const proc = spawn(CHROME, ['--headless=new', `--remote-debugging-port=${port}`, `--user-data-dir=${fs.mkdtempSync(path.join(os.tmpdir(), 'gpuc-'))}`, '--no-first-run', 'about:blank'], { stdio: 'ignore' });
  let target;
  for (let i = 0; i < 50 && !target; i++) { await sleep(200); try { target = (await (await fetch(`http://127.0.0.1:${port}/json/list`)).json()).find(t => t.type === 'page'); } catch { /* not up yet */ } }
  const ws = new WebSocket(target.webSocketDebuggerUrl);
  await new Promise(r => ws.addEventListener('open', r));
  let id = 0; const pending = new Map(), log = [];
  ws.addEventListener('message', (e) => {
    const m = JSON.parse(e.data);
    if (m.id && pending.has(m.id)) { pending.get(m.id)(m); pending.delete(m.id); return; }
    if (m.method === 'Runtime.exceptionThrown') log.push('exception: ' + (m.params.exceptionDetails.exception?.description || m.params.exceptionDetails.text));
  });
  const send = (method, params = {}) => new Promise(r => { const i = ++id; pending.set(i, r); ws.send(JSON.stringify({ id: i, method, params })); });
  const ev = async (x) => { const r = await send('Runtime.evaluate', { expression: x, returnByValue: true, awaitPromise: true }); if (r.result.exceptionDetails) throw new Error(r.result.exceptionDetails.exception?.description || r.result.exceptionDetails.text); return r.result.result.value; };
  await send('Runtime.enable');
  await send('Page.navigate', { url: page });
  for (let i = 0; i < 100; i++) { await sleep(200); if (await ev('!!(window.CrashPhysics && window.CrashGPU && window.CrashGuidance)').catch(() => false)) break; }
  const gpuName = await ev(`CrashGPU.init().then(g => g.name, e => 'ERROR ' + e.message)`);
  console.log('GPU:', gpuName);
  if (gpuName.startsWith('ERROR')) { console.log(log.join('\n')); proc.kill(); process.exit(1); }
  let failures = 0;
  for (const [veh, kmh] of SC) {
    if (!want(`${veh} ${kmh} km/h`)) continue;
    const r = await ev(`(async () => {
      const Phys = CrashPhysics, V = CrashVehicles.get('${veh}'), ax = Phys.axles(V), speed = ${kmh} / 3.6;
      const app = CrashGuidance.createApproach({ speed, angle: 0, massKg: V.massKg, wheelbase: ax.wheelbase, rearToCenter: -ax.rearX, length: V.length, width: V.width });
      while (app.gap() > 0.01 + speed * 0.004) app.step(0.001);
      const cfg = { vehicle: V, massKg: V.massKg, stiffness: 'standard', damage: 'realistic', barrier: 'rigid', pose: app.pose(), speed: app.state.v, yawRate: app.state.yawRate };
      const out = {};
      for (const kind of ['cpu', 'gpu']) {
        const gpu = kind === 'gpu' ? await CrashGPU.init() : null;
        const t0 = performance.now(), sim = Phys.createImpactSim(Object.assign({ gpu }, cfg));
        while (!sim.done) { sim.advance(50); if (gpu) await new Promise(r => setTimeout(r, 0)); }
        const ms = performance.now() - t0, res = sim.finalize();
        if (!res) { out[kind] = { error: String(sim.error && sim.error.message || 'no result') }; continue; }
        const m = res.metrics, E = res.frames.energy, e = E[E.length - 1];
        out[kind] = { ms, crush: m.maxCrush, peak: m.peakDecelG, dv: m.deltaV, stop: m.timeToStop, rebound: m.rebound, plastic: e.plastic / m.energyInitial,
          parts: res.debris.length, solver: res.solver, frames: res.frames.t.length };
      }
      return out;
    })()`);
    const c = r.cpu, g = r.gpu;
    if (c.error || g.error) { failures++; console.log(`${veh} ${kmh} km/h: ERROR cpu ${c.error || 'ok'}, gpu ${g.error || 'ok'}`); continue; }
    const rel = (k) => Math.abs(g[k] / c[k] - 1);
    const bad = Object.keys(TOL).filter(k => !(rel(k) <= TOL[k]));
    if (bad.length || c.parts) failures++;
    console.log(`\n=== ${veh} ${kmh} km/h  (GPU: ${g.solver.colours} colour groups, ${g.solver.steps} steps in ${g.solver.batches} batches)`);
    const row = (name, k, f, u) => console.log(`  ${name.padEnd(22)} CPU ${f(c[k]).padStart(8)}  GPU ${f(g[k]).padStart(8)} ${u.padEnd(3)} ${(100 * rel(k)).toFixed(1).padStart(5)}%${TOL[k] ? (rel(k) <= TOL[k] ? '  ok' : '  OVER ' + (100 * TOL[k]) + '%') : ''}`);
    row('max crush', 'crush', v => (v * 1000).toFixed(0), 'mm');
    row('peak deceleration', 'peak', v => v.toFixed(1), 'g');
    row('speed change', 'dv', v => (v * 3.6).toFixed(1), 'km/h');
    row('time to stop', 'stop', v => (v * 1000).toFixed(0), 'ms');
    row('plastic energy', 'plastic', v => (v * 100).toFixed(1), '%');
    console.log(`  wall time              CPU ${c.ms.toFixed(0).padStart(6)} ms  GPU ${g.ms.toFixed(0).padStart(6)} ms (of which waiting on the GPU ${g.solver.ms.toFixed(0)} ms)${c.parts ? '  (CPU lost parts: not comparable)' : ''}`);
  }
  // The crash labs' set-ups: the offset barrier with and without its honeycomb face, two cars, the
  // side-impact trolley and the pole. Each is built in the page as the labs build it (simplified
  // approaches), run with both solvers, and compared on what the lab reports.
  const LABS = [
    ['overlap 40% honeycomb, 40 mph', `(() => { const V = CrashVehicles.get('lexus'), W = V.width, sp = 64 / 3.6, ax = Phys.axles(V), face = Phys.HONEYCOMB.main.depth + Phys.HONEYCOMB.bumper.depth;
      const app = CrashGuidance.createApproach({ speed: sp, angle: 0, massKg: V.massKg, wheelbase: ax.wheelbase, rearToCenter: -ax.rearX, length: V.length, width: V.width });
      while (app.gap() > 0.01 + sp * 0.004 + face) app.step(0.001);
      return { vehicle: V, massKg: V.massKg, stiffness: 'standard', damage: 'realistic', barrier: 'offset', measure: true, structure: { footwell: true },
        offset: { zEdge: -W / 2 + 0.4 * W, side: -1, width: 1, height: 1.5, edgeRadius: 0, honeycomb: true }, pose: app.pose(), speed: app.state.v, yawRate: app.state.yawRate }; })()`,
      [['peak deceleration', 'peak', 0.15, 'g', 1], ['max crush', 'crush0', 0.08, 'mm', 1000], ['honeycomb crushed', 'hc', 0.10, 'mm', 1000], ['hinge pillar intrusion', 'hinge', 0.25, 'mm', 1000], ['plastic energy', 'plastic', 0.10, '%', 100]]],
    ['overlap 25% rigid, 40 mph', `(() => { const V = CrashVehicles.get('lexus'), W = V.width, sp = 64 / 3.6, ax = Phys.axles(V);
      const app = CrashGuidance.createApproach({ speed: sp, angle: 0, massKg: V.massKg, wheelbase: ax.wheelbase, rearToCenter: -ax.rearX, length: V.length, width: V.width });
      while (app.gap() > 0.01 + sp * 0.004) app.step(0.001);
      return { vehicle: V, massKg: V.massKg, stiffness: 'standard', damage: 'realistic', barrier: 'offset', measure: true, structure: { footwell: true },
        offset: { zEdge: -W / 2 + 0.25 * W, side: -1, width: 1, height: 1.5, edgeRadius: 0.15, honeycomb: false }, pose: app.pose(), speed: app.state.v, yawRate: app.state.yawRate }; })()`,
      [['peak deceleration', 'peak', 0.15, 'g', 1], ['max crush', 'crush0', 0.08, 'mm', 1000], ['hinge pillar intrusion', 'hinge', 0.25, 'mm', 1000], ['plastic energy', 'plastic', 0.10, '%', 100]]],
    ['two cars, Mustang vs Lexus 2,400 kg, 40 mph each', `(() => { const A = CrashVehicles.get('mustang'), B = CrashVehicles.get('lexus'), v = 40 * 0.44704, gap = 0.02 + 2 * v * 0.004;
      const fa = A.xMin + A.length, fb = B.xMin + B.length;
      return { barrier: 'none', measure: true, duration: 1.4, vehicles: [
        { vehicle: A, massKg: 1890, stiffness: 'standard', damage: 'realistic', pose: { x: -gap / 2 - fa, z: 0, heading: 0 }, speed: v },
        { vehicle: B, massKg: 2400, stiffness: 'standard', damage: 'realistic', pose: { x: gap / 2 + fb, z: 0, heading: Math.PI }, speed: v }] }; })()`,
      [['speed change, car A', 'dv0', 0.05, 'km/h', 3.6], ['speed change, car B', 'dv1', 0.05, 'km/h', 3.6], ['peak deceleration, car A', 'peak', 0.20, 'g', 1], ['crush, car A', 'crush0', 0.10, 'mm', 1000], ['crush, car B', 'crush1', 0.10, 'mm', 1000]]],
    ['side impact, barrier trolley 37 mph, mild steel', `(() => { const V = CrashVehicles.get('lexus'), H = V.hPoint, W = V.width, M = CrashVehicles.MDB;
      return { barrier: 'none', measure: true, duration: 0.5, vehicles: [
        { vehicle: V, massKg: V.massKg, stiffness: 'standard', damage: 'realistic', pose: { x: 0, z: 0, heading: 0 }, speed: 0, structure: { steel: 'mild' } },
        { vehicle: M, massKg: M.massKg, stiffness: 'standard', pose: { x: H[0] - 0.1, z: -W / 2 - 0.02 - (M.xMin + M.length), heading: Math.PI / 2 }, speed: 37 * 0.44704 }] }; })()`,
      [['B-pillar intrusion', 'bpillar', 0.15, 'mm', 1000], ['struck car speed change', 'dv0', 0.08, 'km/h', 3.6], ['plastic energy', 'plastic', 0.12, '%', 100]]],
    ['side impact, pole 20 mph', `(() => { const V = CrashVehicles.get('lexus'), H = V.hPoint, W = V.width;
      return { barrier: 'pole', measure: true, duration: 0.5, sled: true, pole: { x: H[0] + 0.05, z: -W / 2 - Phys.POLE_RADIUS - 0.03 },
        vehicles: [{ vehicle: V, massKg: V.massKg, stiffness: 'standard', damage: 'realistic', pose: { x: 0, z: 0, heading: 0 }, speed: 0, velocity: [0, -20 * 0.44704], structure: { steel: 'uhss' } }] }; })()`,
      [['B-pillar intrusion', 'bpillar', 0.15, 'mm', 1000], ['car speed change', 'dv0', 0.08, 'km/h', 3.6], ['plastic energy', 'plastic', 0.12, '%', 100]]],
  ];
  for (const [name, build, rows] of LABS) {
    if (!want(name)) continue;
    const r = await ev(`(async () => {
      const Phys = CrashPhysics, cfg = ${build}, out = {};
      const meas = (res, u, nm, axis, sign) => { const M = res.units[u].measure; if (!M) return NaN; const q = M.names.indexOf(nm); let m = -Infinity; for (const fr of M.frames) m = Math.max(m, sign * fr[3 * q + axis]); return m; };
      for (const kind of ['cpu', 'gpu']) {
        const gpu = kind === 'gpu' ? await CrashGPU.init() : null;
        const t0 = performance.now(), sim = Phys.createImpactSim(Object.assign({ gpu }, cfg));
        while (!sim.done) { sim.advance(50); if (gpu) await new Promise(r => setTimeout(r, 0)); }
        const ms = performance.now() - t0, res = sim.finalize();
        if (!res) { out[kind] = { error: String(sim.error && sim.error.message || 'no result') }; continue; }
        const E = res.frames.energy, e = E[E.length - 1], U = res.units;
        const H = res.offset && res.offset.honeycomb, last = H ? H.frames[H.frames.length - 1] : null;
        out[kind] = { ms, solver: res.solver, parts: res.debris.length, peak: U[0].metrics.peakDecelG, plastic: e.plastic / res.metrics.energyInitial,
          crush0: U[0].metrics.maxCrush, crush1: U[1] ? U[1].metrics.maxCrush : NaN, dv0: U[0].metrics.deltaVVector, dv1: U[1] ? U[1].metrics.deltaVVector : NaN,
          hc: last ? Math.max(...last) : NaN, hinge: meas(res, 0, 'hinge', 0, -1), bpillar: meas(res, 0, 'bpillarMid', 2, 1) };
      }
      return out;
    })()`);
    const c = r.cpu, g = r.gpu;
    if (c.error || g.error) { failures++; console.log(`\n=== ${name}: ERROR cpu ${c.error || 'ok'}, gpu ${g.error || 'ok'}`); continue; }
    if (g.solver.kind !== 'gpu') { failures++; console.log(`\n=== ${name}: the GPU did not run it (${g.solver.fallback})`); continue; }
    console.log(`\n=== ${name}  (GPU: ${g.solver.colours} colour groups, ${g.solver.steps} steps in ${g.solver.batches} batches)`);
    for (const [label, k, tol, unit, scale] of rows) {
      const rel = Math.abs(g[k] / c[k] - 1), ok = rel <= tol;
      if (!ok) failures++;
      console.log(`  ${label.padEnd(26)} CPU ${(c[k] * scale).toFixed(1).padStart(8)}  GPU ${(g[k] * scale).toFixed(1).padStart(8)} ${unit.padEnd(4)} ${(100 * rel).toFixed(1).padStart(5)}%  ${ok ? 'ok' : 'OVER ' + (100 * tol) + '%'}`);
    }
    console.log(`  wall time                  CPU ${c.ms.toFixed(0).padStart(6)} ms  GPU ${g.ms.toFixed(0).padStart(6)} ms${c.parts ? `  (the CPU lost ${c.parts} part(s): not quite the same crash)` : ''}`);
  }
  // Scaling: the lab car's lattice at 1, 2 and 3 times the resolution (springs scaled with the
  // spacing, so the material stays as stiff), 56 km/h, the first 150 ms after contact
  console.log('\n=== scaling: lab car lattice refined, 56 km/h, 150 ms after contact');
  for (const f of want('scaling') ? [1, 2, 3] : []) {
    const r = await ev(`(async () => {
      const Phys = CrashPhysics, L = CrashVehicles.get('lab'), f = ${f};
      const V = Object.assign({}, L, { nx: (L.nx - 1) * f + 1, ny: (L.ny - 1) * f + 1, nz: (L.nz - 1) * f + 1, wheelI: L.wheelI.map(i => i * f), kScale: 1 / f,
        cabin: Object.assign({}, L.cabin, { topJ: L.cabin.topJ * f }) });
      const cfg = { vehicle: V, massKg: V.massKg, stiffness: 'standard', barrier: 'rigid', pose: { x: -L.length / 2 - 0.03, z: 0, heading: 0 }, speed: 56 / 3.6, duration: 0.15 };
      const out = {};
      for (const kind of ['cpu', 'gpu']) {
        const gpu = kind === 'gpu' ? await CrashGPU.init() : null;
        const t0 = performance.now(), sim = Phys.createImpactSim(Object.assign({ gpu }, cfg));
        while (!sim.done) { sim.advance(50); if (gpu) await new Promise(r => setTimeout(r, 0)); }
        const ms = performance.now() - t0, res = sim.finalize();
        out[kind] = res ? { ms, crush: res.metrics.maxCrush, n: sim.n, nc: res.units[0].car.cons.n, solver: res.solver } : { error: String(sim.error && sim.error.message) };
      }
      return out;
    })()`);
    const c = r.cpu, g = r.gpu;
    if (c.error || g.error) { failures++; console.log(`  x${f}: ERROR ${c.error || g.error}`); continue; }
    console.log(`  x${f}: ${String(c.n).padStart(6)} nodes ${String(c.nc).padStart(7)} springs  CPU ${c.ms.toFixed(0).padStart(6)} ms  GPU ${g.ms.toFixed(0).padStart(6)} ms (CPU / GPU ${(c.ms / g.ms).toFixed(2)})  ${g.solver.colours} colour groups  crush ${(c.crush * 1000).toFixed(0)} / ${(g.crush * 1000).toFixed(0)} mm`);
  }
  console.log(log.length ? '\n' + log.join('\n') : '');
  console.log(failures ? `${failures} scenario(s) failed` : 'GPU and CPU agree within the tolerances in every scenario');
  ws.close(); proc.kill(); process.exit(failures ? 1 : 0);
})();
