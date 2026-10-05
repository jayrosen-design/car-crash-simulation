/* GPU solver check (WebGPU, js/gpu-lattice.js): runs the same crashes with the CPU solver and the
 * GPU solver in headless Chrome and compares what they compute.
 *   node tools/gpu-check.js
 * Needs Chrome with WebGPU (the page is opened from disk, a secure context). The scenarios are
 * rigid-barrier crashes in which nothing comes off on the CPU either, so both solve the same thing.
 * Differences come from the order the GPU projects the constraints in (colour groups instead of
 * one after the other) and its 32-bit floats. Fails if a GPU run errors, or if crush, peak
 * deceleration, speed change or plastic energy differ by more than the tolerances below. */
'use strict';
const { spawn } = require('child_process');
const fs = require('fs'), path = require('path'), os = require('os');
const CHROME = process.env.CHROME || 'C:/Program Files/Google/Chrome/Application/chrome.exe';
const page = 'file:///' + path.join(__dirname, '..', 'index.html').split(path.sep).join('/');
const SC = [['lab', 56], ['lab', 40], ['lexus', 56], ['mustang', 48]];
const TOL = { crush: 0.06, peak: 0.12, dv: 0.03, plastic: 0.08 };   // relative
const sleep = (ms) => new Promise(r => setTimeout(r, ms));

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
  // Scaling: the lab car's lattice at 1, 2 and 3 times the resolution (springs scaled with the
  // spacing, so the material stays as stiff), 56 km/h, the first 150 ms after contact
  console.log('\n=== scaling: lab car lattice refined, 56 km/h, 150 ms after contact');
  for (const f of [1, 2, 3]) {
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
