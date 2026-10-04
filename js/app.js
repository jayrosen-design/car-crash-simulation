/* App controller: test-stage state machine (Setup -> Approach -> Impact -> Playback), UI wiring,
 * results and charts, playback interpolation and event-driven effects. */
(() => {
  'use strict';
  const Phys = CrashPhysics, Occ = CrashOccupant, Guid = CrashGuidance, Veh = CrashVehicles, G = 9.81;
  const $ = (s) => document.querySelector(s), $$ = (s) => Array.from(document.querySelectorAll(s));
  // Mass presets keep the lab car's ratios (1,100 / 1,500 / 2,200 kg) around each car's curb mass.
  const massOf = (key) => key === 'standard' ? CAR.massKg : Math.round(CAR.massKg * (key === 'light' ? 1100 : 2200) / 1500);
  const MASS = { get light() { return massOf('light'); }, get standard() { return massOf('standard'); }, get heavy() { return massOf('heavy'); } };
  // Settings from the URL, e.g. Simulator.html?preset=brick (the home page's quick options), or
  // individual ones: vehicle, speed, angle, barrier, wall, damage, mass, stiffness.
  const PRESETS = {
    rigid: { vehicle: 'lexus', barrier: 'rigid', speed: 56, angle: 0, damage: 'realistic', label: 'Rigid barrier: 56 km/h full-frontal test, Realistic damage.' },
    brick: { vehicle: 'lexus', barrier: 'brick', wallStrength: 'standard', speed: 64, angle: 0, damage: 'dramatic', label: 'Brick wall: 64 km/h head-on, Dramatic damage.' },
  };
  const preset = (() => {
    const q = new URLSearchParams(location.search), s = Object.assign({}, PRESETS[q.get('preset')] || {});
    for (const k of ['vehicle', 'barrier', 'wall', 'damage', 'mass', 'stiffness']) if (q.get(k)) s[k === 'wall' ? 'wallStrength' : k] = q.get(k);
    for (const k of ['speed', 'angle']) if (q.get(k) && Number.isFinite(+q.get(k))) s[k] = +q.get(k);
    return s;
  })();
  let CAR = Veh.get(preset.vehicle && Veh.specs[preset.vehicle] ? preset.vehicle : Veh.defaultKey), AX = Phys.axles(CAR), vehicleReady = false;
  const cfg = { vehicle: CAR.key, damage: 'realistic', speed: 56, angle: 0, mass: 'standard', stiffness: 'standard', barrier: 'rigid', wallStrength: 'standard', belt: true, airbag: true };
  let state = 'setup', approach = null, sim = null, result = null, occ = null, inj = null, play = null, braked = false, events = [];
  let liveBricks = null, toastTimer = 0, charts = [];
  const rad = (d) => d * Math.PI / 180;

  Scene3D.init($('#view'));
  $('#loading').remove();
  const fireFx = CrashFire.Effects(Scene3D.scene);
  let hazards = [];   // steam or fire after the crash (CrashFire.assess)
  for (const b of $$('.seg[data-name=vehicle] button')) { b.disabled = !Veh.specs[b.dataset.v]; b.classList.toggle('on', b.dataset.v === cfg.vehicle); }

  // Vehicle switch: the model is parsed once (a second or so), then kept.
  async function chooseVehicle(key) {
    cfg.vehicle = key;
    CAR = Veh.get(key); AX = Phys.axles(CAR);
    vehicleReady = false;
    $('#btn-run').disabled = true;
    $('#veh-status').textContent = key === 'lab' ? '' : 'Loading model…';
    const fmt = (v) => v.toLocaleString(undefined, { maximumFractionDigits: 0 }) + ' kg';
    for (const k of ['light', 'standard', 'heavy']) $('#mass-' + k).textContent = fmt(massOf(k));
    const cr = CAR.credit;
    $('#damage-field').hidden = !CAR.parts;
    $('#veh-credit').innerHTML = cr ? `Model: <a href="${cr.url}" target="_blank" rel="noopener">${cr.title}</a> by ${cr.author}, ${cr.license}. Split into parts and simplified for this app.` : 'Procedural body; deforms with the lattice but has no separate parts.';
    try {
      await Scene3D.setVehicle(key);
      if (cfg.vehicle !== key) return;
      $('#veh-status').textContent = '';
      vehicleReady = true;
      $('#btn-run').disabled = false;
      previewSetup(true);
    } catch (err) {
      console.error(err);
      $('#veh-status').textContent = 'Could not load the model';
      toast('Could not load the ' + CAR.short + ' model: ' + err.message);
    }
  }

  // ---------------------------------------------------------------- setup controls
  function bindRange(rangeSel, numSel, key) {
    const r = $(rangeSel), n = $(numSel);
    const set = (v, from) => {
      v = Math.max(+r.min, Math.min(+r.max, Math.round(+v || 0)));
      cfg[key] = v; r.value = v; if (from !== n) n.value = v;
      previewSetup(key !== 'angle' || from !== 'drag');
    };
    r.addEventListener('input', () => set(r.value, r));
    n.addEventListener('change', () => set(n.value, n));
    return set;
  }
  const setSpeed = bindRange('#in-speed', '#in-speed-num', 'speed');
  const setAngle = bindRange('#in-angle', '#in-angle-num', 'angle');
  Scene3D.onAngleDrag((deg) => { if (state === 'setup') { $('#in-angle-num').value = deg; setAngle(deg, 'drag'); } });
  for (const seg of $$('.seg[data-name]')) {
    seg.addEventListener('click', (e) => {
      const b = e.target.closest('button'); if (!b || b.disabled) return;
      seg.querySelectorAll('button').forEach(x => x.classList.toggle('on', x === b));
      const name = seg.dataset.name;
      if (name === 'camera') { setCamera(b.dataset.v); return; }
      if (name === 'vehicle') { if (state === 'setup') chooseVehicle(b.dataset.v); return; }
      cfg[name] = b.dataset.v;
      if (name === 'barrier') $('#scenario').value = '?preset=' + cfg.barrier;   // the Simulation menu follows
      previewSetup(true);
    });
  }
  $('#in-belt').addEventListener('change', (e) => { cfg.belt = e.target.checked; previewSetup(false); });
  $('#in-bag').addEventListener('change', (e) => { cfg.airbag = e.target.checked; previewSetup(false); });

  function approachFor() {
    return Guid.createApproach({ speed: cfg.speed / 3.6, angle: rad(cfg.angle), massKg: MASS[cfg.mass], wheelbase: AX.wheelbase, rearToCenter: -AX.rearX, length: CAR.length, width: CAR.width });
  }
  const rest = Occ.restPose();
  function seatedDummy(extra) {
    return Object.assign({ x: rest.x, y: rest.y, phT: 0, phH: 0, bagR: 0, belt: cfg.belt, injury: null, x0: rest.x[0], y0: rest.y[0] }, extra || {});
  }
  function previewSetup(reframe) {
    const m = MASS[cfg.mass], v = cfg.speed / 3.6;
    $('#ro-energy').textContent = `${(0.5 * m * v * v / 1000).toFixed(0)} kJ`;
    $('#ro-drop').textContent = `${(v * v / (2 * G)).toFixed(1)} m`;
    $('#ro-momentum').textContent = `${(m * v).toLocaleString(undefined, { maximumFractionDigits: 0 })} kg·m/s`;
    $('#wall-field').querySelectorAll('button').forEach(b => { b.disabled = cfg.barrier !== 'brick'; });
    const notes = [];
    if (Math.abs(cfg.angle) > 15) notes.push(`At ${Math.abs(cfg.angle)}°, the frontal dummy's readings are only indicative.`);
    if (cfg.barrier === 'brick') notes.push('Brick wall is a breakable demo mode: injury numbers are not comparable to rigid-barrier tests.');
    $('#setup-note').hidden = !notes.length;
    $('#setup-note').textContent = notes.join(' ');
    if (state !== 'setup') return;
    const a = approachFor(), pose = a.pose();
    Scene3D.setBarrier(cfg.barrier);
    Scene3D.resetBricks();
    Scene3D.setPath(rad(cfg.angle), a.distance, true);
    Scene3D.setCarRigid(pose, 0, 0);
    Scene3D.setDummy(seatedDummy());
    if (reframe) {
      const f = new THREE.Vector3(Math.cos(pose.heading), 0, Math.sin(pose.heading)), l = new THREE.Vector3(-f.z, 0, f.x);
      const c = new THREE.Vector3(pose.x, 0, pose.z);
      Scene3D.setCameraMode('setup', { frame: { pos: c.clone().addScaledVector(f, -10).addScaledVector(l, -6).add(new THREE.Vector3(0, 4.5, 0)), target: c.clone().addScaledVector(f, 10).add(new THREE.Vector3(0, 0.5, 0)) } });
    }
  }

  // ---------------------------------------------------------------- state machine
  function setState(s) {
    state = s;
    const order = ['setup', 'approach', 'impact', 'playback'];
    $$('#stepper li').forEach(li => {
      const i = order.indexOf(li.dataset.step), cur = order.indexOf(s);
      li.classList.toggle('on', i === cur); li.classList.toggle('done', i < cur);
    });
    $('#setup').hidden = s !== 'setup';
    $('#hud').hidden = s !== 'approach';
    $('#computing').hidden = s !== 'impact';
    $('#results').hidden = s !== 'playback';
    $('#timeline').hidden = s !== 'playback';
    $('#btn-stop').hidden = !(s === 'approach' || s === 'impact');
    $('#btn-reset').hidden = s === 'setup';
    updateLegend();
  }

  $('#btn-run').addEventListener('click', () => {
    if (!vehicleReady) return;
    FX.initAudio(); FX.engineStart();
    approach = approachFor(); braked = false;
    Scene3D.particles.clear();
    setState('approach');
    const p = approach.pose();
    Scene3D.setPath(rad(cfg.angle), approach.distance, true);
    Scene3D.setCameraMode('chase', { f0: new THREE.Vector3(Math.cos(p.heading), 0, Math.sin(p.heading)) });
    $('#hud-target').textContent = `${cfg.speed} km/h`;
  });

  // Kill switch: during the approach it cuts drive and brakes hard; during the impact
  // computation it abandons the run. The ~100 ms impact itself is too fast for a human to stop.
  $('#btn-stop').addEventListener('click', () => {
    if (state === 'approach' && !braked) { approach.brake(); braked = true; FX.engineStop(); toast('Emergency stop: drive cut, full braking.'); }
    else if (state === 'impact') { sim.cancel(); sim = null; toast('Impact computation cancelled.'); toSetup(); }
  });
  $('#btn-reset').addEventListener('click', toSetup);
  function toSetup() {
    FX.engineStop();
    approach = null; sim = null; result = null; occ = null; play = null;
    charts.forEach(c => c.destroy()); charts = [];
    Scene3D.particles.clear();
    $$('#tg-strain, #tg-injury, #tg-xray').forEach(t => { t.checked = false; });
    Scene3D.setStrainMode(false); Scene3D.setXray(false);
    setHazards(null);
    setState('setup');
    previewSetup(true);
  }
  // Steam and fire after the crash, shown in real time once the replay has reached its end.
  function setHazards(r) {
    const h = r ? CrashFire.assess(r, 0) : null;
    hazards = h && (h.fire || h.steam) ? [h] : [];
    fireFx.set(hazards, r ? r.frames.t.length - 1 : 0);
    if (!hazards.length) { fireFx.update(-1); FX.fireUpdate(0, 0); }
    const box = $('#res-hazard'); box.innerHTML = '';
    if (!hazards.length) return;
    const p = document.createElement('p'); p.className = 'note hazard'; p.textContent = CrashFire.describe(hazards, false);
    const b = document.createElement('button'); b.className = 'small'; b.textContent = 'Show the aftermath';
    b.addEventListener('click', () => { if (play) scrubTo(play.tEnd); });
    p.append(' ', b); box.appendChild(p);
  }
  $('#btn-sound').addEventListener('click', (e) => {
    const on = !FX.enabled; FX.setEnabled(on);
    e.target.textContent = on ? 'Sound: on' : 'Sound: off'; e.target.setAttribute('aria-pressed', on);
  });

  function updateApproach(dt) {
    const s = approach.state, startGap = 0.01 + s.v * 0.004;
    const steps = Math.min(100, Math.max(1, Math.round(dt * 1000)));
    let travelled = 0;
    for (let i = 0; i < steps; i++) {
      approach.step(0.001);
      travelled += s.v * 0.001;
      if (approach.gap() <= startGap) { beginImpact(); return; }
      if (braked && s.v <= 0) {
        toast(`Stopped ${approach.gap().toFixed(1)} m short of the barrier. Test aborted.`);
        setTimeout(toSetup, 1200);
        approach = null;
        return;
      }
    }
    Scene3D.setCarRigid(approach.pose(), s.delta, travelled / CAR.wheelRadius);
    Scene3D.setDummy(seatedDummy());
    $('#hud-speed').textContent = `${(s.v * 3.6).toFixed(1)} km/h`;
    $('#hud-force').textContent = `${(s.force / 1000).toFixed(1)} kN`;
    $('#hud-steer').textContent = `${(s.delta * 180 / Math.PI).toFixed(2)}°`;
    $('#hud-xte').textContent = `${(s.crossTrack * 100).toFixed(1)} cm`;
    $('#hud-head').textContent = `${(s.headingError * 180 / Math.PI).toFixed(2)}°`;
    $('#hud-dist').textContent = `${approach.gap().toFixed(1)} m`;
    $('#hud-mode').textContent = braked ? 'Braking' : (Math.abs(s.v - cfg.speed / 3.6) > 0.3 ? 'Accelerating' : 'Holding speed');
    FX.engineUpdate(s.v * 3.6, s.force / (0.45 * MASS[cfg.mass] * G));
  }

  function beginImpact() {
    FX.engineStop();
    const s = approach.state;
    sim = Phys.createImpactSim({ vehicle: CAR, damage: cfg.damage, massKg: MASS[cfg.mass], stiffness: cfg.stiffness, barrier: cfg.barrier, wallStrength: cfg.wallStrength, pose: approach.pose(), speed: s.v, yawRate: s.yawRate });
    liveBricks = sim.nb ? new Float32Array(7 * sim.nb) : null;
    const p = approach.pose();
    Scene3D.setPath(rad(cfg.angle), approach.distance, false);
    // the free camera, starting beside the front of the car, follows it through the crash
    Scene3D.setCameraMode('free', { f0: new THREE.Vector3(Math.cos(p.heading), 0, Math.sin(p.heading)), from: 'quarter' });
    $$('.seg[data-name=camera] button').forEach(b => b.classList.toggle('on', b.dataset.v === 'free'));
    setState('impact');
  }

  const qp = [0, 0, 0], qq = [0, 0, 0, 0];
  function updateImpact() {
    const prog = sim.advance(12);
    const f = sim.frame;
    Scene3D.setCabinFrame(f.o, f.f, f.u);
    Scene3D.setCarDeformed(sim.X, null, 0, null);
    if (liveBricks) {
      for (let b = 0; b < sim.nb; b++) { sim.brickPose(b, qp, qq); liveBricks.set(qp, 7 * b); liveBricks.set(qq, 7 * b + 3); }
      Scene3D.setBricks(liveBricks);
    }
    Scene3D.setDummy(seatedDummy());
    $('#comp-bar').style.width = `${(prog * 100).toFixed(0)}%`;
    $('#comp-text').textContent = `${(prog * 100).toFixed(0)}%  ·  simulated ${(Math.max(0, sim.t - Math.max(0, sim.T0)) * 1000).toFixed(0)} ms after contact`;
    if (sim.done) finishImpact();
  }

  function finishImpact() {
    result = sim.finalize(); sim = null;
    if (!result) { toSetup(); return; }
    $('#pb-belt').checked = cfg.belt; $('#pb-bag').checked = cfg.airbag;
    Scene3D.setDestruction(result);
    runOccupant(cfg.belt, cfg.airbag);
    const t0 = result.contact ? result.T0 : 0;
    const tStart = Math.max(result.frames.t[0], t0 - 0.02);
    play = { t: tStart, tStart, playing: true, speed: +$('#tl-speed').value, t0, tEnd: result.tEnd, after: 0 };
    setHazards(result);
    resetEventCursor();
    setState('playback');
    applyFrame(play.t);
  }

  // ---------------------------------------------------------------- occupant + results
  function runOccupant(belt, airbag) {
    occ = Occ.simulate(result.pulse, { belt, airbag, interior: CAR.interior });
    // windshield hits crack the glass where the head struck (occupant frame -> car-local)
    const H = CAR.hPoint;
    Scene3D.setHeadStrikes(occ.events.filter(e => e.type === 'headStrike' && e.surface === 'windshield').map(e => ({ t: e.t, mag: e.mag, p: [H[0] + e.hx, H[1] + e.hy, H[2]] })));
    inj = injurySeries(occ);
    events = result.events.concat(occ.events).sort((a, b) => a.t - b.t);
    buildResults();
    buildCharts();
    if (play) resetEventCursor();
  }
  $('#pb-belt').addEventListener('change', () => runOccupant($('#pb-belt').checked, $('#pb-bag').checked));
  $('#pb-bag').addEventListener('change', () => runOccupant($('#pb-belt').checked, $('#pb-bag').checked));

  // Running injury ratios for the dummy heatmap (value so far / limit).
  function injurySeries(o) {
    const S = o.metrics.series, n = o.n, dt = o.dt, W = Math.round(0.015 / dt);
    const head = new Float32Array(n), neck = new Float32Array(n), chest = new Float32Array(n);
    const cum = new Float64Array(n);
    for (let i = 1; i < n; i++) cum[i] = cum[i - 1] + 0.5 * (S.head.r[i] + S.head.r[i - 1]) * dt;
    let hicRun = 0, nijRun = 0, chestRun = 0, avg = 0;
    const win = Math.round(0.003 / dt);
    for (let i = 0; i < n; i++) {
      if (i >= o.i0 - 50 && i <= o.i0 + 3000) {
        for (let j = Math.max(0, i - W); j < i; j++) {
          const T = (i - j) * dt, a = (cum[i] - cum[j]) / T;
          if (a > 0) hicRun = Math.max(hicRun, T * Math.pow(a, 2.5));
        }
      }
      nijRun = Math.max(nijRun, S.nij[i] || 0);
      avg += S.chest.r[i] - (i >= win ? S.chest.r[i - win] : 0);
      chestRun = Math.max(chestRun, avg / win / Occ.LIMITS.chest3ms, S.defl[i] * 1000 / Occ.LIMITS.chestDefl);
      head[i] = hicRun / Occ.LIMITS.hic15; neck[i] = nijRun / Occ.LIMITS.nij; chest[i] = chestRun;
    }
    return { head, neck, chest };
  }

  function metricRow(container, name, value, unit, limit, digits = 0) {
    const r = limit ? value / limit : null;
    const el = document.createElement('div'); el.className = 'metric';
    const nm = document.createElement('span'); nm.className = 'name'; nm.textContent = name;
    const vl = document.createElement('span'); vl.className = 'val'; vl.textContent = `${value.toFixed(digits)}${unit}`;
    el.append(nm, vl);
    if (limit) {
      const meter = document.createElement('div'); meter.className = 'meter';
      const fill = document.createElement('i'), mark = document.createElement('b');
      const cls = r >= 1 ? 'bad' : r >= 0.8 ? 'warn' : 'ok';
      fill.style.width = `${Math.min(100, r / 1.5 * 100)}%`;
      fill.style.background = `var(--${cls})`;
      mark.style.left = `${100 / 1.5}%`;
      meter.append(fill, mark);
      const st = document.createElement('span'); st.className = 'status ' + cls;
      st.textContent = (r >= 1 ? '✕ Exceeds limit' : r >= 0.8 ? '! Near limit' : '✓ Within limit') + ` (${limit.toLocaleString()}${unit})`;
      el.append(meter, st);
    }
    container.appendChild(el);
  }
  function buildResults() {
    const q = occ.metrics, m = result.metrics, L = Occ.LIMITS;
    const oc = $('#res-occupant'); oc.innerHTML = '';
    metricRow(oc, 'Head injury criterion (HIC15)', q.hic15, '', L.hic15);
    metricRow(oc, 'Chest acceleration, 3 ms', q.chest3ms, ' g', L.chest3ms, 1);
    metricRow(oc, 'Chest deflection', q.chestDeflMm, ' mm', L.chestDefl, 1);
    metricRow(oc, 'Neck injury criterion (Nij)', q.nij, '', L.nij, 2);
    metricRow(oc, 'Neck tension', q.neckTension / 1000, ' kN', L.neckTension / 1000, 2);
    metricRow(oc, 'Neck compression', q.neckCompression / 1000, ' kN', L.neckCompression / 1000, 2);
    const vc = $('#res-vehicle'); vc.innerHTML = '';
    metricRow(vc, 'Impact speed', m.impactSpeed * 3.6, ' km/h', null, 1);
    metricRow(vc, 'Speed change (Δv)', m.deltaV * 3.6, ' km/h', null, 1);
    metricRow(vc, 'Peak cabin decel.', m.peakDecelG, ' g', null, 1);
    metricRow(vc, m.timeToStop >= 0 ? 'Time to stop' : 'Exit speed', m.timeToStop >= 0 ? m.timeToStop * 1000 : m.exitSpeed * 3.6, m.timeToStop >= 0 ? ' ms' : ' km/h', null, 0);
    metricRow(vc, 'Max crush', m.maxCrush * 1000, ' mm', null);
    metricRow(vc, 'Permanent crush', m.residualCrush * 1000, ' mm', null);
    metricRow(vc, 'Cabin intrusion', Math.max(0, m.maxIntrusion) * 1000, ' mm', null);
    metricRow(vc, 'Rebound speed', m.rebound * 3.6, ' km/h', null, 1);
    const notes = [];
    if (braked) notes.push(`Emergency stop was used: impact at ${(m.impactSpeed * 3.6).toFixed(0)} km/h instead of ${cfg.speed} km/h.`);
    if (Math.abs(cfg.angle) > 15) notes.push(`Oblique impact (${cfg.angle}°): the frontal dummy model is only indicative at this angle.`);
    if (result.barrier === 'brick') notes.push('Brick-wall mode: the wall breaks and absorbs energy, so these numbers are not comparable to rigid-barrier tests.');
    if (occ.airbag && occ.tFire < 0) notes.push('The airbag did not fire: the crash stayed below the firing threshold (2 m/s speed change within 45 ms).');
    if (!result.contact) notes.push('The car did not reach the barrier.');
    const NAMES = { BumperF: 'front bumper', BumperR: 'rear bumper', Hood: 'hood', FenderL: 'left fender', FenderR: 'right fender', DoorFL: 'left front door', DoorFR: 'right front door',
      DoorRL: 'left rear door', DoorRR: 'right rear door', Trunk: CAR.key === 'lexus' ? 'tailgate' : 'trunk lid', MirrorL: 'left mirror', MirrorR: 'right mirror' };
    const WHEELS = { FL: 'left front wheel', FR: 'right front wheel', RL: 'left rear wheel', RR: 'right rear wheel' };
    const lost = (result.debris || []).map(d => d.kind === 'wheel' ? WHEELS[d.key] : NAMES[d.name.replace(/^(DEFORM_|BREAKAWAY_)/, '')] || d.name);
    const panes = (result.glass || []).filter(g => g.t >= 0 && !g.lamp && !g.laminated).length, ws = (result.glass || []).some(g => g.t >= 0 && g.laminated);
    const bursts = (result.bursts || []).filter(b => b.t >= 0).length;
    if (CAR.parts) notes.push(`Damage (${result.damage}): ${lost.length ? 'came off: ' + lost.join(', ') : 'no parts came off'}; ${panes} window${panes === 1 ? '' : 's'} shattered${ws ? ', windshield cracked' : ''}; ${bursts} tyre${bursts === 1 ? '' : 's'} burst.`);
    $('#res-notes').innerHTML = '';
    for (const n of notes) { const p = document.createElement('p'); p.className = 'note'; p.textContent = n; $('#res-notes').appendChild(p); }
  }

  // ---------------------------------------------------------------- charts
  const C = { blue: '#56b4e9', orange: '#e69f00', green: '#009e73', yellow: '#f0e442', purple: '#cc79a7', deep: '#0072b2', grey: '#8b95a1', red: '#d55e00' };
  function buildCharts() {
    charts.forEach(c => c.destroy()); charts = [];
    const o = occ, q = o.metrics, S = q.series, dt = o.dt, n = o.n, t0 = result.contact ? result.T0 : 0;
    const tms = new Float64Array(n); for (let i = 0; i < n; i++) tms[i] = (i * dt - t0) * 1000;
    const xr = [-20, 250], scrub = (x) => scrubTo(t0 + x / 1000);
    const g = (arr) => Float64Array.from(arr, v => v / G);
    const P1 = document.querySelector('[data-panel=occupant]'), P2 = document.querySelector('[data-panel=vehicle]'), P3 = document.querySelector('[data-panel=energy]');
    [P1, P2, P3].forEach(p => { p.innerHTML = ''; });
    const L = Occ.LIMITS;
    charts.push(new Charts.LineChart(P1, { title: 'Head acceleration, g (CFC 1000)', value: `HIC15 ${q.hic15.toFixed(0)}`, xRange: xr, xLabel: 'ms', onScrub: scrub,
      shade: [(q.hicT1 - t0) * 1000, (q.hicT2 - t0) * 1000],
      series: [{ x: tms, y: S.head.r, color: C.orange, label: 'resultant', width: 2 }, { x: tms, y: g(S.head.x), color: C.blue, label: 'forward (x)' }, { x: tms, y: g(S.head.y), color: C.green, label: 'vertical' }] }));
    charts.push(new Charts.LineChart(P1, { title: 'Chest acceleration, g (CFC 180)', value: `3 ms: ${q.chest3ms.toFixed(1)} g`, xRange: xr, xLabel: 'ms', onScrub: scrub,
      limits: [{ y: L.chest3ms, label: '60 g' }], series: [{ x: tms, y: S.chest.r, color: C.orange, label: 'resultant', width: 2 }] }));
    charts.push(new Charts.LineChart(P1, { title: 'Chest deflection, mm (CFC 180)', value: `${q.chestDeflMm.toFixed(1)} mm`, xRange: xr, xLabel: 'ms', onScrub: scrub,
      limits: [{ y: L.chestDefl, label: '63 mm' }], series: [{ x: tms, y: Float64Array.from(S.defl, v => v * 1000), color: C.blue, label: 'sternum to spine', width: 2 }] }));
    charts.push(new Charts.LineChart(P1, { title: 'Neck injury criterion Nij (CFC 600)', value: `${q.nij.toFixed(2)} ${q.nijMode}`, xRange: xr, xLabel: 'ms', onScrub: scrub,
      limits: [{ y: 1, label: '1.0' }], series: [{ x: tms, y: S.nij, color: C.purple, label: 'Nij', width: 2 }] }));
    charts.push(new Charts.LineChart(P1, { title: 'Upper neck axial force, kN', value: `${(q.neckTension / 1000).toFixed(2)} kN tension`, xRange: xr, xLabel: 'ms', onScrub: scrub,
      limits: [{ y: L.neckTension / 1000, label: 'tension 4.17' }, { y: -L.neckCompression / 1000, label: 'compression 4.0' }],
      series: [{ x: tms, y: Float64Array.from(S.fz, v => v / 1000), color: C.deep, label: 'tension +', width: 2 }] }));
    charts.push(new Charts.LineChart(P1, { title: 'Restraint loads, kN', value: o.tFire >= 0 && o.airbag ? `airbag fired ${((o.tFire - t0) * 1000).toFixed(0)} ms` : '', xRange: xr, xLabel: 'ms', onScrub: scrub,
      series: [{ x: tms, y: Float64Array.from(o.beltT, v => v / 1000), color: C.blue, label: 'shoulder belt' }, { x: tms, y: Float64Array.from(o.lapT, v => v / 1000), color: C.green, label: 'lap belt' }] }));

    const pu = result.pulse, pn = pu.n, ptms = new Float64Array(pn);
    for (let i = 0; i < pn; i++) ptms[i] = (i * pu.dt - t0) * 1000;
    const m = result.metrics;
    charts.push(new Charts.LineChart(P2, { title: 'Cabin deceleration, g (CFC 60)', value: `peak ${m.peakDecelG.toFixed(1)} g`, xRange: xr, xLabel: 'ms', onScrub: scrub,
      series: [{ x: ptms, y: Float64Array.from(pu.ax, v => -v / G), color: C.orange, label: 'longitudinal', width: 2 }, { x: ptms, y: Float64Array.from(pu.az, v => v / G), color: C.blue, label: 'lateral' }] }));
    charts.push(new Charts.LineChart(P2, { title: 'Cabin speed along the approach, km/h', value: `Δv ${(m.deltaV * 3.6).toFixed(1)} km/h`, xRange: xr, xLabel: 'ms', onScrub: scrub,
      series: [{ x: ptms, y: Float64Array.from(pu.vLong, v => v * 3.6), color: C.blue, label: 'speed', width: 2 }] }));
    charts.push(new Charts.LineChart(P2, { title: result.barrier === 'rigid' ? 'Barrier load-cell force, kN (CFC 60)' : 'Force on the wall, kN (CFC 60)', xRange: xr, xLabel: 'ms', onScrub: scrub,
      series: [{ x: ptms, y: Float64Array.from(pu.force, v => v / 1000), color: C.purple, label: 'normal force', width: 2 }] }));
    const F = result.frames, fms = Float64Array.from(F.t, t => (t - t0) * 1000);
    const crushMm = Float64Array.from(F.crush, v => v * 1000), forceAt = Float64Array.from(F.t, t => pu.force[Math.min(pn - 1, Math.round(t / pu.dt))] / 1000);
    const iEnd = F.t.findIndex(t => t > t0 + 0.25);
    const fcN = iEnd > 0 ? iEnd : F.t.length;
    const fcX = crushMm.slice(0, fcN), fcY = forceAt.slice(0, fcN);
    const fc = new Charts.LineChart(P2, { title: 'Force vs crush, kN over mm', xRange: [0, Math.max(50, Math.max(...fcX) * 1.05)], xLabel: 'mm crush', cursor: 'point',
      series: [{ x: fcX, y: fcY, color: C.orange, label: 'first 250 ms', width: 2 }] });
    fc.isForceCrush = true; fc.n = fcN; charts.push(fc);
    charts.push(new Charts.LineChart(P2, { title: 'Crush and cabin intrusion, mm', value: `max crush ${(m.maxCrush * 1000).toFixed(0)} mm`, xRange: xr, xLabel: 'ms', onScrub: scrub,
      series: [{ x: fms, y: crushMm, color: C.orange, label: 'front crush', width: 2 }, { x: fms, y: Float64Array.from(F.intrusion, v => Math.max(0, v) * 1000), color: C.red, label: 'dash → seat intrusion' }] }));

    const E = F.energy, kJ = (key) => Float64Array.from(E, e => e[key] / 1000);
    const e0 = m.energyInitial / 1000;
    const eRange = [-20, Math.min((result.tEnd - t0) * 1000, result.barrier === 'brick' ? 1500 : 400)];
    const st = new Charts.StackChart(P3, { title: 'Where the kinetic energy goes, kJ', value: `½mv² = ${e0.toFixed(0)} kJ`, x: fms, xRange: eRange, xLabel: 'ms', unit: ' kJ', onScrub: scrub,
      channels: [
        { y: kJ('carKinetic'), color: C.blue, label: 'Car motion' },
        { y: kJ('debrisKinetic'), color: '#9ad3f5', label: 'Debris motion' },
        { y: kJ('elastic'), color: C.green, label: 'Elastic (springback)' },
        { y: kJ('plastic'), color: C.orange, label: 'Plastic deformation' },
        { y: kJ('fracture'), color: C.purple, label: result.barrier === 'brick' ? 'Mortar & part fracture' : 'Fracture (parts off)' },
        { y: kJ('friction'), color: C.yellow, label: 'Friction heat' },
        { y: kJ('contactSolver'), color: C.grey, label: 'Contact, damping & solver' },
      ] });
    charts.push(st);
    const fell = -Math.min(0, E[E.length - 1].potential) / 1000;
    const note = document.createElement('p'); note.className = 'muted small';
    note.textContent = 'Acoustic energy isn\'t modelled; in a real crash it is a tiny fraction. "Contact, damping & solver" groups losses that position-based dynamics cannot separate: impacts at the contacts, structural damping and numerical dissipation.'
      + (fell > 0.5 ? ` Falling bricks also released ${fell.toFixed(0)} kJ of gravitational energy, so the total exceeds ½mv².` : '');
    P3.appendChild(note);
  }
  $$('.tabs button').forEach(b => b.addEventListener('click', () => {
    $$('.tabs button').forEach(x => x.classList.toggle('on', x === b));
    $$('.tab-panels > div').forEach(p => { p.hidden = p.dataset.panel !== b.dataset.tab; });
    charts.forEach(c => c.render());
  }));
  $('#btn-collapse').addEventListener('click', (e) => {
    const body = $('#res-body'); body.hidden = !body.hidden;
    e.target.textContent = body.hidden ? 'Show' : 'Hide'; e.target.setAttribute('aria-expanded', !body.hidden);
  });

  // ---------------------------------------------------------------- playback
  $('#btn-play').addEventListener('click', togglePlay);
  function togglePlay() {
    if (!play) return;
    if (!play.playing && play.t >= play.tEnd - 1e-6) { play.t = play.tStart; resetEventCursor(); Scene3D.particles.clear(); }
    play.playing = !play.playing;
  }
  $('#tl-speed').addEventListener('change', (e) => { if (play) play.speed = +e.target.value; });
  $('#tl-scrub').addEventListener('input', (e) => {
    if (!play) return;
    scrubTo(play.tStart + (+e.target.value / 1000) * (play.tEnd - play.tStart));
  });
  function scrubTo(t) {
    if (!play) return;
    play.t = Math.max(play.tStart, Math.min(play.tEnd, t));
    play.playing = false;
    resetEventCursor();
    Scene3D.particles.clear();
  }
  window.addEventListener('keydown', (e) => {
    if (state !== 'playback' || e.target.matches('input[type=number], select')) return;
    if (e.code === 'Space') { e.preventDefault(); togglePlay(); }
    if (e.code === 'ArrowRight') scrubTo(play.t + (e.shiftKey ? 0.01 : 0.001));
    if (e.code === 'ArrowLeft') scrubTo(play.t - (e.shiftKey ? 0.01 : 0.001));
  });
  function setCamera(mode) { Scene3D.setCameraMode(mode); }
  $('#tg-strain').addEventListener('change', (e) => { Scene3D.setStrainMode(e.target.checked); updateLegend(); });
  $('#tg-injury').addEventListener('change', updateLegend);
  $('#tg-xray').addEventListener('change', (e) => Scene3D.setXray(e.target.checked));
  function updateLegend() {
    const lg = $('#legend'), parts = [];
    if (state === 'playback' && $('#tg-strain').checked) parts.push(['Car: plastic strain', 'linear-gradient(90deg,#c9ced6,#f0e442 25%,#e69f00 55%,#a8380a)', 'none', 'heavy']);
    if (state === 'playback' && $('#tg-injury').checked) parts.push(['Dummy: worst value so far ÷ limit', 'linear-gradient(90deg,#7fa6c9,#f0e442 50%,#e69f00 99%,#d55e00 100%)', '0', '≥ 1 (exceeds)']);
    lg.hidden = !parts.length;
    lg.innerHTML = '';
    for (const [title, grad, a, b] of parts) {
      const d = document.createElement('div');
      d.innerHTML = `<div></div><div class="ramp"></div><div class="ends"><span></span><span></span></div>`;
      d.children[0].textContent = title; d.children[1].style.background = grad;
      d.children[2].children[0].textContent = a; d.children[2].children[1].textContent = b;
      lg.appendChild(d);
    }
  }

  let evIdx = 0, lastCrunch = -1;
  function resetEventCursor() {
    evIdx = 0;
    while (evIdx < events.length && events[evIdx].t <= (play ? play.t : 0)) evIdx++;
    lastCrunch = -1;
  }
  function fireEvents(tA, tB) {
    const parts = Scene3D.particles;
    while (evIdx < events.length && events[evIdx].t <= tB) {
      const e = events[evIdx++];
      if (e.t < tA) continue;
      const pan = e.x !== undefined ? Scene3D.screenPan([e.x, e.y, e.z]) : 0;
      if (e.type === 'first') { FX.crunch(1, pan); parts.spawn(e.x, e.y, e.z, 30, 'spark', [-1, 0.3, 0]); parts.spawn(e.x, e.y, e.z, 14, 'dust'); }
      else if (e.type === 'contact') {
        // e.mag is this frame's contact impulse; compare with 1/30 of the car's momentum
        if (e.t - lastCrunch > 0.03) { FX.crunch(Math.min(1, e.mag / (result.car.massKg * result.metrics.impactSpeed / 30)), pan); lastCrunch = e.t; }
        if (Math.random() < 0.5) parts.spawn(e.x, e.y, e.z, 3, 'spark', [-1, 0.2, 0]);
        if (Math.random() < 0.3) parts.spawn(e.x, Math.max(0.2, e.y), e.z, 2, 'dust');
      } else if (e.type === 'break') {
        FX.breakSound(e.mass, e.count, pan);
        parts.spawn(e.x, e.y, e.z, Math.min(8, 2 + e.count), 'dust');
        parts.spawn(e.x, e.y, e.z, Math.min(6, 1 + e.count), 'chip', [1, 0.2, 0]);
      } else if (e.type === 'debris') { FX.thud(e.mass, pan); parts.spawn(e.x, 0.05, e.z, 6, 'dust'); }
      else if (e.type === 'airbag') FX.pop(0);
      else if (e.type === 'headStrike') { FX.hit(e.mag, 0); if (e.surface === 'windshield') FX.crack(0.6, 0); }
      else if (e.type === 'detach') {
        FX.clank(e.mass, pan);
        parts.spawn(e.x, e.y, e.z, Math.min(24, 6 + Math.round(e.mass)), 'spark', [0, 0.6, 0]);
        parts.spawn(e.x, Math.max(0.2, e.y), e.z, 4, 'dust');
      } else if (e.type === 'glass') { FX.glass(e.mass, pan); parts.spawn(e.x, e.y, e.z, 10, 'glass'); }
      else if (e.type === 'crack') FX.crack(0.8, pan);
      else if (e.type === 'burst') { FX.pop(pan); parts.spawn(e.x, 0.15, e.z, 10, 'dust'); }
    }
  }

  function frameIndex(t) {
    const T = result.frames.t;
    let lo = 0, hi = T.length - 1;
    if (t <= T[0]) return [0, 0];
    if (t >= T[hi]) return [hi, 0];
    while (lo < hi) { const m = (lo + hi + 1) >> 1; if (T[m] <= t) lo = m; else hi = m - 1; }
    return [lo, (t - T[lo]) / (T[lo + 1] - T[lo])];
  }
  function applyFrame(t) {
    const F = result.frames, [k, s] = frameIndex(t), k2 = Math.min(F.t.length - 1, k + 1);
    const a = F.axes[k], b = F.axes[k2], lerp = (i) => a[i] + (b[i] - a[i]) * s;
    Scene3D.setCabinFrame([lerp(0), lerp(1), lerp(2)], [lerp(3), lerp(4), lerp(5)], [lerp(6), lerp(7), lerp(8)]);
    Scene3D.updateDestruction(t, k, k2, s);
    Scene3D.setCarDeformed(F.pos[k], F.pos[k2], s, F.strain[k]);
    if (result.barrier === 'brick') Scene3D.setBricks(F.bricks[k], F.bricks[k2], s);
    const pi = Math.max(0, Math.min(Math.ceil(occ.n / occ.poseEvery) - 1, Math.round(t / (occ.dt * occ.poseEvery))));
    const o = pi * occ.poseStride, NP = Occ.PARTICLES.NP, xs = new Array(NP), ys = new Array(NP);
    for (let i = 0; i < NP; i++) { xs[i] = occ.pose[o + 2 * i]; ys[i] = occ.pose[o + 2 * i + 1]; }
    const si = Math.max(0, Math.min(occ.n - 1, Math.round(t / occ.dt)));
    Scene3D.setDummy({ x: xs, y: ys, phT: occ.pose[o + 2 * NP], phH: occ.pose[o + 2 * NP + 1], bagR: occ.pose[o + 2 * NP + 2], belt: occ.belt,
      x0: occ.seated.x[0], y0: occ.seated.y[0],
      injury: $('#tg-injury').checked ? { head: inj.head[si], neck: inj.neck[si], chest: inj.chest[si], pelvis: null } : null });
    const lv = fireFx.update(hazards.length && play.after > 0 ? play.after : -1);
    FX.fireUpdate(lv.fire, lv.steam);
    const rel = (t - play.t0) * 1000;
    if (play.after > 0) { $('#tl-time').textContent = '+' + (rel / 1000 + play.after).toFixed(1); $('#tl-unit').textContent = 's'; }
    else { $('#tl-time').textContent = (rel >= 0 ? '+' : '') + rel.toFixed(1); $('#tl-unit').textContent = 'ms'; }
    $('#tl-scrub').value = Math.round((t - play.tStart) / (play.tEnd - play.tStart) * 1000);
    $('#btn-play').textContent = play.playing ? 'Pause' : 'Play';
    for (const c of charts) {
      if (c.el.offsetParent === null) continue;
      if (c.isForceCrush) c.setCursor(Math.min(c.n - 1, k)); else c.setCursor(rel);
    }
  }
  function updatePlayback(dt) {
    if (play.playing) {
      const t1 = Math.min(play.tEnd, play.t + dt * play.speed);
      fireEvents(play.t, t1);
      Scene3D.particles.update(t1 - play.t);
      play.t = t1;
      if (play.t >= play.tEnd) play.playing = false;
    }
    // after the replay: steam and fire carry on in real time
    play.after = hazards.length && play.t >= play.tEnd - 1e-9 ? play.after + dt : 0;
    applyFrame(play.t);
  }

  // ---------------------------------------------------------------- loop
  function toast(msg) {
    const el = $('#toast'); el.textContent = msg; el.hidden = false;
    clearTimeout(toastTimer); toastTimer = setTimeout(() => { el.hidden = true; }, 3500);
  }
  let last = performance.now();
  function frame(now) {
    const dt = Math.min(0.05, (now - last) / 1000); last = now;
    try {
      if (state === 'approach' && approach) updateApproach(dt);
      else if (state === 'impact' && sim) updateImpact();
      else if (state === 'playback' && play) updatePlayback(dt);
    } catch (err) { console.error(err); toast('Error: ' + err.message); toSetup(); }
    const bottom = state === 'playback' ? $('#timeline').offsetHeight + 12 : 0;
    Scene3D.render(dt, state === 'playback', bottom);
    const pr = Scene3D.pipRect, lbl = $('#pip-label');
    lbl.hidden = !pr;
    if (pr) { lbl.style.left = pr.left + 'px'; lbl.style.top = (pr.top - 20) + 'px'; }
    requestAnimationFrame(frame);
  }
  // URL settings (after everything the setup preview needs exists)
  for (const k of ['barrier', 'wallStrength', 'damage', 'mass', 'stiffness']) {
    const seg = $(`.seg[data-name=${k}]`);
    if (!preset[k] || !seg || !seg.querySelector(`button[data-v="${preset[k]}"]`)) continue;
    seg.querySelectorAll('button').forEach(x => x.classList.toggle('on', x.dataset.v === preset[k]));
    cfg[k] = preset[k];
  }
  if (preset.speed !== undefined) setSpeed(preset.speed, null);
  if (preset.angle !== undefined) setAngle(preset.angle, null);
  setState('setup');
  previewSetup(true);
  chooseVehicle(cfg.vehicle);
  if (preset.label) toast(preset.label + ' Press "Run crash test" to start.');
  requestAnimationFrame(frame);
})();
