/* The Race game's crashes: the full crash solver (js/physics.js), started from the cars' state at the
 * moment of impact and run in the background while the crash camera plays it back.
 *
 * The solver runs in a Web Worker built from the physics scripts' own text (a blob, so it also
 * works from a file opened from disk). Every slice it posts what it has recorded since the last
 * one: frames (node positions, plastic strain, body poses, cabin axes), parts that came off,
 * events, and glass as it breaks (scanGlass). The camera plays these back no faster than they
 * arrive. When the run ends it posts the final result (pulse, metrics, the full glass list) for the
 * replay. Without a worker, the same runs on the main thread a few milliseconds per frame.
 *
 * start(cfg): cfg = { units: [{ key, massKg, pose, velocity, yawRate }], world: { boxes, cyls },
 *   duration, damage } -> a crash: { F (frames so far), debris, glass, events, T0, t, done, result,
 *   unitView(u) }. No race logic here: the Destruction mode can use it as it is.
 */
const RaceCrash = (() => {
  'use strict';
  const SOURCES = ['models/lexus.phys.js', 'models/mustang.phys.js', 'js/occupant.js', 'js/vehicles.js', 'js/physics.js'];
  let workerUrl = null, spare = null, mode = 'none';

  // a script's text: inline in the single-file build (it starts with a comment naming it), else fetched
  async function sourceOf(path) {
    for (const s of document.scripts) if (!s.src && s.textContent.startsWith(`/* ${path} */`)) return s.textContent;
    const r = await fetch(path);
    if (!r.ok) throw new Error(`could not read ${path}`);
    return r.text();
  }
  // build the worker once at load and keep one warm, so a crash starts without parsing the scripts
  async function prepare() {
    if (new URLSearchParams(location.search).get('worker') === '0') { mode = 'main'; return mode; }   // test hook: the fallback
    try {
      const texts = await Promise.all(SOURCES.map(sourceOf));
      const body = texts.join('\n;\n') + '\n;(' + workerMain.toString() + ')();';
      workerUrl = URL.createObjectURL(new Blob([body], { type: 'text/javascript' }));
      spare = new Worker(workerUrl);
      mode = 'worker';
    } catch (e) {
      mode = 'main';   // e.g. a file opened from disk in the development page: run on the main thread
    }
    return mode;
  }

  // ---------------------------------------------------------------- inside the worker
  function workerMain() {
    let sim = null, sent = 0, sentDebris = 0, sentEvents = 0, stop = false;
    const ch = new MessageChannel();
    ch.port1.onmessage = () => loop();
    self.onmessage = (e) => {
      const m = e.data;
      if (m.type === 'run') {
        const V = self.CrashVehicles;
        sim = self.CrashPhysics.createImpactSim({ barrier: 'world', world: m.cfg.world, duration: m.cfg.duration, minDuration: m.cfg.minDuration || 0.3,
          vehicles: m.cfg.units.map(u => ({ vehicle: V.get(u.key), massKg: u.massKg, stiffness: 'standard', damage: m.cfg.damage || 'realistic', pose: u.pose, velocity: u.velocity, yawRate: u.yawRate })) });
        sent = sentDebris = sentEvents = 0; stop = false;
        ch.port2.postMessage(0);
      } else if (m.type === 'stop') stop = true;
    };
    function loop() {
      if (!sim) return;
      if (!stop && !sim.done) sim.advance(10);
      const finished = stop || sim.done;
      flush(finished);
      if (!finished) { ch.port2.postMessage(0); return; }
      const r = sim.finalize();
      // the final result without what the page already has (frames) or can't use (lattices, specs)
      self.postMessage({ type: 'done', result: { T0: r.T0, tEnd: r.tEnd, contact: r.contact, glass: r.glass, events: r.events, bursts: r.bursts, metrics: r.metrics, pulse: r.pulse, world: r.world, barrier: r.barrier,
        units: r.units.map(u => ({ key: u.key, off: u.off, n: u.n, massKg: u.massKg, metrics: u.metrics, pulse: u.pulse, crush: u.crush })) } });
      sim = null;
    }
    function flush(final) {
      const F = sim.frames, n = F.t.length, frames = [];
      for (let k = sent; k < n; k++) frames.push({ t: F.t[k], pos: F.pos[k], strain: F.strain[k], bricks: F.bricks[k], axes: F.axes[k], unitAxes: F.unitAxes ? F.unitAxes.map(a => a[k]) : null, energy: F.energy[k] });
      sent = n;
      const debris = sim.debris.slice(sentDebris); sentDebris = sim.debris.length;
      const events = sim.events.slice(sentEvents); sentEvents = sim.events.length;
      const g = sim.scanGlass(final);
      self.postMessage({ type: 'frames', t: sim.t, T0: sim.T0, frames, debris, events, glass: g.glass, glassEvents: g.events });
    }
  }

  // ---------------------------------------------------------------- on the page
  function start(cfg) {
    const nU = cfg.units.length;
    const crash = {
      cfg, mode, t: 0, T0: -1, done: false, result: null, started: performance.now(), firstFrameMs: -1,
      F: { t: [], pos: [], strain: [], bricks: [], axes: [], energy: [], unitAxes: cfg.units.map(() => []) },
      debris: [], glass: [], events: [],
      offs: null,                // node offsets of the units in the joined lattice
      views: [],                 // per unit: frames, debris and glass of that car (see unitView)
      stop() { if (worker) worker.postMessage({ type: 'stop' }); else if (sim) crash.done = true; },
      // advance the main-thread fallback (call every frame); a no-op with the worker
      tick(budgetMs) { if (sim && !crash.done) { sim.advance(budgetMs); take(); } },
      unitView,
    };
    // node counts per unit, for slicing the joined frames
    const counts = cfg.units.map(u => CrashPhysics.buildCar(u.massKg, 'standard', CrashVehicles.get(u.key)).n);
    crash.offs = counts.map((_, i) => counts.slice(0, i).reduce((a, b) => a + b, 0));
    function receive(m) {
      if (m.type === 'frames') {
        const F = crash.F;
        for (const f of m.frames) {
          F.t.push(f.t); F.pos.push(f.pos); F.strain.push(f.strain); F.bricks.push(f.bricks); F.axes.push(f.axes); F.energy.push(f.energy);
          for (let u = 0; u < nU; u++) F.unitAxes[u].push(f.unitAxes ? f.unitAxes[u] : f.axes);
        }
        if (m.frames.length && crash.firstFrameMs < 0) crash.firstFrameMs = performance.now() - crash.started;
        crash.debris.push(...m.debris); crash.events.push(...m.events, ...m.glassEvents); crash.glass.push(...m.glass);
        crash.t = m.t; crash.T0 = m.T0;
        for (const v of crash.views) grow(v);
      } else if (m.type === 'done') {
        crash.result = m.result; crash.done = true;
        if (worker) { worker.onmessage = null; worker.terminate(); }
      }
    }
    // the worker (a warm one if there is one), else the main thread
    let worker = null, sim = null;
    if (mode === 'worker') {
      worker = spare || new Worker(workerUrl);
      spare = new Worker(workerUrl);   // warm up the next one
      worker.onmessage = (e) => receive(e.data);
      worker.postMessage({ type: 'run', cfg });
    } else {
      const V = CrashVehicles;
      sim = CrashPhysics.createImpactSim({ barrier: 'world', world: cfg.world, duration: cfg.duration, minDuration: cfg.minDuration || 0.3,
        vehicles: cfg.units.map(u => ({ vehicle: V.get(u.key), massKg: u.massKg, stiffness: 'standard', damage: cfg.damage || 'realistic', pose: u.pose, velocity: u.velocity, yawRate: u.yawRate })) });
      crash.mode = 'main';
    }
    let mSent = 0, mDebris = 0, mEvents = 0;
    function take() {
      const F = sim.frames, frames = [];
      for (let k = mSent; k < F.t.length; k++) frames.push({ t: F.t[k], pos: F.pos[k], strain: F.strain[k], bricks: F.bricks[k], axes: F.axes[k], unitAxes: F.unitAxes ? F.unitAxes.map(a => a[k]) : null, energy: F.energy[k] });
      mSent = F.t.length;
      const debris = sim.debris.slice(mDebris); mDebris = sim.debris.length;
      const events = sim.events.slice(mEvents); mEvents = sim.events.length;
      const g = sim.scanGlass(sim.done);
      receive({ type: 'frames', t: sim.t, T0: sim.T0, frames, debris, events, glass: g.glass, glassEvents: g.events });
      if (sim.done) { const r = sim.finalize(); receive({ type: 'done', result: r }); sim = null; }
    }

    // One car's share of the crash, in the shape carmodel.js takes (a result): its own node
    // positions, strain and cabin axes in every frame, its debris (with its lattice slice) and glass.
    // The arrays grow as frames arrive.
    function unitView(u) {
      if (crash.views[u]) return crash.views[u];
      const v = { u, off: crash.offs[u], n: counts[u], barrier: 'world', frames: { t: crash.F.t, pos: [], strain: [], bricks: crash.F.bricks, axes: crash.F.unitAxes[u] }, debris: [], glass: [], nd: 0, ng: 0 };
      crash.views[u] = v;
      grow(v);
      return v;
    }
    function grow(v) {
      const F = crash.F, V = v.frames, o = v.off, n = v.n;
      while (V.pos.length < F.pos.length) {
        const k = V.pos.length;
        V.pos.push(nU > 1 ? F.pos[k].subarray(3 * o, 3 * (o + n)) : F.pos[k]);
        V.strain.push(nU > 1 ? F.strain[k].subarray(o, o + n) : F.strain[k]);
      }
      for (; v.nd < crash.debris.length; v.nd++) { const d = crash.debris[v.nd]; if (d.unit === v.u) v.debris.push(nU > 1 ? Object.assign({}, d, { X: d.X ? d.X.subarray(3 * o, 3 * (o + n)) : d.X }) : d); }
      for (; v.ng < crash.glass.length; v.ng++) { const g = crash.glass[v.ng]; if (g.unit === v.u) v.glass.push(g); }
    }
    return crash;
  }

  return { prepare, start, get mode() { return mode; } };
})();
