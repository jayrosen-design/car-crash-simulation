/* Headless physics check: runs approach -> impact -> occupant for a set of scenarios in Node and
 * prints the key numbers. Exits non-zero if a run produces NaN, gains energy, misses contact, or
 * fails one of the destruction checks.
 *   node tools/headless-check.js            (all scenarios)
 *   node tools/headless-check.js rigid56    (scenarios whose name contains "rigid56")
 *
 * Lab-car scenarios: the original 13 crashes and the standing-wall test.
 * Imported cars (lexus, mustang): crashes in both damage modes, checked for what comes off, plus
 * a car standing still, a coasting car, a spinning free wheel, a dropped wheel, a half time step
 * and destruction on/off.
 */
'use strict';
const path = require('path');
const Occ = require(path.join(__dirname, '../js/occupant.js'));
const Veh = require(path.join(__dirname, '../js/vehicles.js'));
const Phys = require(path.join(__dirname, '../js/physics.js'));
const Guid = require(path.join(__dirname, '../js/guidance.js'));

const MASS = { light: 1100, standard: 1500, heavy: 2200 };
const scenarios = [
  { name: 'rigid56-std', kmh: 56, angle: 0, mass: 'standard', stiff: 'standard', barrier: 'rigid' },
  { name: 'rigid30-std', kmh: 30, angle: 0, mass: 'standard', stiff: 'standard', barrier: 'rigid' },
  { name: 'rigid100-std', kmh: 100, angle: 0, mass: 'standard', stiff: 'standard', barrier: 'rigid' },
  { name: 'rigid150-std', kmh: 150, angle: 0, mass: 'standard', stiff: 'standard', barrier: 'rigid' },
  { name: 'rigid56-soft', kmh: 56, angle: 0, mass: 'standard', stiff: 'soft', barrier: 'rigid' },
  { name: 'rigid56-stiff', kmh: 56, angle: 0, mass: 'standard', stiff: 'stiff', barrier: 'rigid' },
  { name: 'rigid56-light', kmh: 56, angle: 0, mass: 'light', stiff: 'standard', barrier: 'rigid' },
  { name: 'rigid56-heavy', kmh: 56, angle: 0, mass: 'heavy', stiff: 'standard', barrier: 'rigid' },
  { name: 'rigid56-30deg', kmh: 56, angle: 30, mass: 'standard', stiff: 'standard', barrier: 'rigid' },
  { name: 'brick56-weak', kmh: 56, angle: 0, mass: 'standard', stiff: 'standard', barrier: 'brick', wall: 'weak' },
  { name: 'brick56-std', kmh: 56, angle: 0, mass: 'standard', stiff: 'standard', barrier: 'brick', wall: 'standard' },
  { name: 'brick56-strong', kmh: 56, angle: 0, mass: 'standard', stiff: 'standard', barrier: 'brick', wall: 'strong' },
  { name: 'brick30-std', kmh: 30, angle: 0, mass: 'standard', stiff: 'standard', barrier: 'brick', wall: 'standard' },
];
// imported cars: expect = what must (not) come off
const carScenarios = [
  { tag: 'rigid30', kmh: 30, damage: 'realistic', expect: 'intact' },
  { tag: 'rigid56', kmh: 56, damage: 'realistic', expect: 'keeps', plausible: true },
  { tag: 'rigid100', kmh: 100, damage: 'realistic' },
  { tag: 'rigid150', kmh: 150, damage: 'realistic', expect: 'heavy' },
  { tag: 'rigid56-30deg', kmh: 56, angle: 30, damage: 'realistic' },
  { tag: 'rigid56-dramatic', kmh: 56, damage: 'dramatic' },
  { tag: 'rigid100-dramatic', kmh: 100, damage: 'dramatic', expect: 'dramatic' },
  { tag: 'brick56', kmh: 56, barrier: 'brick', damage: 'realistic' },
  { tag: 'brick56-dramatic', kmh: 56, barrier: 'brick', damage: 'dramatic' },
];
const filter = process.argv[2];
let failures = 0;

function hasNaN(arr) { for (let i = 0; i < arr.length; i++) if (!Number.isFinite(arr[i])) return true; return false; }
function approachTo(V, kmh, angleDeg, massKg) {
  const speed = kmh / 3.6, ax = Phys.axles(V);
  const app = Guid.createApproach({ speed, angle: angleDeg * Math.PI / 180, massKg, wheelbase: ax.wheelbase, rearToCenter: -ax.rearX, length: V.length, width: V.width });
  const startGap = 0.01 + speed * 0.004;
  let steps = 0;
  while (app.gap() > startGap && steps < 120000) { app.step(0.001); steps++; }
  return app;
}
function energyProblems(res, problems) {
  const E = res.frames.energy, e0 = res.metrics.energyInitial;
  let minResidual = Infinity, maxResidual = -Infinity;
  for (const e of E) { minResidual = Math.min(minResidual, e.contactSolver); maxResidual = Math.max(maxResidual, e.contactSolver); }
  if (!res.contact) problems.push('no contact');
  if (hasNaN(res.pulse.ax) || hasNaN(res.frames.pos[res.frames.pos.length - 1])) problems.push('NaN in vehicle');
  if (minResidual < -0.03 * e0) problems.push(`energy gain ${(-minResidual / 1000).toFixed(1)} kJ`);
  return { minResidual, maxResidual };
}

// ---------------------------------------------------------------- lab car (the original baseline)
for (const sc of scenarios) {
  if (filter && !sc.name.includes(filter)) continue;
  const massKg = MASS[sc.mass], speed = sc.kmh / 3.6, angle = sc.angle * Math.PI / 180;
  const C = Phys.CAR, ax = Phys.axles();
  const app = Guid.createApproach({ speed, angle, massKg, wheelbase: ax.wheelbase, rearToCenter: -ax.rearX, length: C.length, width: C.width });
  const startGap = 0.01 + speed * 0.004;
  let steps = 0;
  while (app.gap() > startGap && steps < 120000) { app.step(0.001); steps++; }
  const st = app.state;
  const t0 = Date.now();
  const sim = Phys.createImpactSim({
    massKg, stiffness: sc.stiff, barrier: sc.barrier, wallStrength: sc.wall,
    pose: app.pose(), speed: st.v, yawRate: st.yawRate,
  });
  sim.advance(1e9);
  const res = sim.finalize();
  const simMs = Date.now() - t0;
  const m = res.metrics;
  const E = res.frames.energy, e0 = m.energyInitial, eEnd = E[E.length - 1];
  const problems = [];
  const { minResidual, maxResidual } = energyProblems(res, problems);

  console.log(`\n=== ${sc.name}  (${sc.kmh} km/h, ${sc.angle} deg, ${massKg} kg, ${sc.stiff}, ${sc.barrier}${sc.wall ? '/' + sc.wall : ''})`);
  console.log(`approach: ${(st.t).toFixed(2)} s, v at handoff ${(st.v * 3.6).toFixed(1)} km/h, cross-track ${(st.crossTrack * 100).toFixed(1)} cm, heading err ${(st.headingError * 180 / Math.PI).toFixed(2)} deg`);
  console.log(`impact sim: ${simMs} ms wall clock, ${res.frames.t.length} frames, T0 ${(res.T0 * 1000).toFixed(1)} ms, end ${res.tEnd.toFixed(2)} s`);
  console.log(`vehicle: peak cabin decel ${m.peakDecelG.toFixed(1)} g, dV ${(m.deltaV * 3.6).toFixed(1)} km/h, rebound ${(m.rebound * 3.6).toFixed(1)} km/h, exit ${(m.exitSpeed * 3.6).toFixed(1)} km/h, time to stop ${m.timeToStop >= 0 ? (m.timeToStop * 1000).toFixed(0) + ' ms' : 'n/a'}`);
  console.log(`         max crush ${(m.maxCrush * 1000).toFixed(0)} mm, residual ${(m.residualCrush * 1000).toFixed(0)} mm, intrusion ${(m.maxIntrusion * 1000).toFixed(0)} mm`);
  const pct = (v) => (100 * v / e0).toFixed(1) + '%';
  console.log(`energy (E0 ${(e0 / 1000).toFixed(1)} kJ): carKE ${pct(eEnd.carKinetic)}, debrisKE ${pct(eEnd.debrisKinetic)}, plastic ${pct(eEnd.plastic)}, elastic ${pct(eEnd.elastic)}, fracture ${pct(eEnd.fracture)}, friction ${pct(eEnd.friction)}, potential ${pct(eEnd.potential)}, contact+solver ${pct(eEnd.contactSolver)} (range ${pct(minResidual)}..${pct(maxResidual)})`);
  if (res.wall) {
    const last = res.frames.bricks[res.frames.bricks.length - 1], first = res.frames.bricks[0];
    let moved = 0;
    for (let b = 0; b < res.wall.nb; b++) {
      const d = Math.hypot(last[7 * b] - first[7 * b], last[7 * b + 1] - first[7 * b + 1], last[7 * b + 2] - first[7 * b + 2]);
      if (d > 0.05) moved++;
    }
    const breaks = res.events.filter(e => e.type === 'break').reduce((s, e) => s + e.count, 0);
    console.log(`wall: ${moved}/${res.wall.nb} bricks displaced > 5 cm, ${breaks} bonds broken`);
  }
  for (const [label, opts] of [['belt+bag', { belt: true, airbag: true }], ['belt only', { belt: true, airbag: false }], ['unbelted+bag', { belt: false, airbag: true }], ['none', { belt: false, airbag: false }]]) {
    const o = Occ.simulate(res.pulse, Object.assign({ cabin: res.cabin || (res.cabin = Phys.cabinInput(res, 0)) }, opts)), q = o.metrics;
    if (hasNaN(o.headAx) || !Number.isFinite(q.hic15)) problems.push('NaN in occupant ' + label);
    console.log(`  ${label.padEnd(13)} HIC15 ${q.hic15.toFixed(0).padStart(5)}  head ${q.headPeakG.toFixed(0).padStart(4)} g  chest3ms ${q.chest3ms.toFixed(1).padStart(5)} g  defl ${q.chestDeflMm.toFixed(1).padStart(5)} mm  VC ${q.vc.toFixed(2)}  Nij ${q.nij.toFixed(2)} (${q.nijMode})  tension ${(q.neckTension / 1000).toFixed(2)} kN  pelvis ${q.pelvisPeakG.toFixed(0)} g  fire ${o.tFire >= 0 ? ((o.tFire - res.T0) * 1000).toFixed(1) + ' ms' : 'no'}`);
  }
  if (problems.length) { failures++; console.log('  PROBLEMS: ' + problems.join('; ')); }
}
// Standing-wall check: every brick awake, no car contact. A wall that can't hold itself up
// (e.g. joints that act as ball joints) drifts or breaks here.
if (!filter || 'wall-stands'.includes(filter)) {
  const sim = Phys.createImpactSim({ massKg: 1500, stiffness: 'standard', barrier: 'brick', wallStrength: 'weak', pose: { x: -60, z: 0, heading: 0 }, speed: 0, wakeAll: true });
  const p0 = [], pos = [0, 0, 0], q = [0, 0, 0, 0];
  for (let b = 0; b < sim.nb; b++) { sim.brickPose(b, pos, q); p0.push(pos.slice()); }
  sim.advance(1e9);
  const res = sim.finalize();
  let maxd = 0;
  for (let b = 0; b < sim.nb; b++) { sim.brickPose(b, pos, q); maxd = Math.max(maxd, Math.hypot(pos[0] - p0[b][0], pos[1] - p0[b][1], pos[2] - p0[b][2])); }
  const breaks = res.events.filter(e => e.type === 'break').length;
  const ok = maxd < 0.005 && breaks === 0;
  console.log(`\n=== wall-stands (weak mortar, all bricks awake, no car): max brick drift ${(maxd * 1000).toFixed(2)} mm, ${breaks} breaks ${ok ? 'OK' : 'PROBLEM'}`);
  if (!ok) failures++;
}

// ---------------------------------------------------------------- imported cars
const short = (name) => name.replace(/^(DEFORM_|BREAKAWAY_|BRITTLE_|RIGID_Mech_)/, '');
function crash(V, sc, extra) {
  const app = approachTo(V, sc.kmh, sc.angle || 0, V.massKg), st = app.state;
  const t0 = Date.now();
  const sim = Phys.createImpactSim(Object.assign({
    vehicle: V, massKg: V.massKg, stiffness: 'standard', barrier: sc.barrier || 'rigid', wallStrength: 'standard', damage: sc.damage,
    pose: app.pose(), speed: st.v, yawRate: st.yawRate, checkSpawns: true,
  }, extra || {}));
  sim.advance(1e9);
  const res = sim.finalize();
  res.simMs = Date.now() - t0;
  return res;
}
for (const key of Veh.keys.filter(k => k !== 'lab')) {
  const V = Veh.get(key);
  for (const sc of carScenarios) {
    const name = `${key}-${sc.tag}`;
    if (filter && !name.includes(filter)) continue;
    const res = crash(V, sc), m = res.metrics, problems = [];
    const { minResidual } = energyProblems(res, problems);
    for (const c of res.spawnChecks) {
      if (c.dP > 1e-9 * Math.max(1, c.P)) problems.push(`momentum changed by ${c.dP.toExponential(2)} at ${short(c.name)}`);
      if (Math.abs(c.dE) > 1) problems.push(`energy changed by ${c.dE.toFixed(2)} J at ${short(c.name)}`);
    }
    const parts = res.debris.filter(d => d.kind === 'part'), wheels = res.debris.filter(d => d.kind === 'wheel');
    const panes = res.glass.filter(g => g.t >= 0 && !g.lamp), bursts = res.bursts.filter(b => b.t >= 0);
    if (sc.expect === 'intact' && (res.debris.length || bursts.length)) problems.push('parts came off or a tyre burst at 30 km/h');
    if (sc.expect === 'keeps' && res.debris.length) problems.push('parts came off in a realistic 56 km/h test');
    if (sc.expect === 'heavy' && (!parts.length || !bursts.some(b => b.key[0] === 'F'))) problems.push('no panel off or no front tyre burst at 150 km/h');
    if (sc.expect === 'dramatic' && (res.debris.length < 3 || !panes.length)) problems.push('fewer than 3 parts off or no pane broken (Dramatic, 100 km/h)');
    if (sc.plausible && (m.maxCrush < 0.3 || m.maxCrush > 0.8 || m.peakDecelG < 25 || m.peakDecelG > 80)) problems.push('crush or peak deceleration outside 300-800 mm / 25-80 g');
    const o = Occ.simulate(res.pulse, { belt: true, airbag: true, interior: V.interior, cabin: Phys.cabinInput(res, 0) }), q = o.metrics;
    if (hasNaN(o.headAx) || !Number.isFinite(q.hic15)) problems.push('NaN in occupant');
    const e0 = m.energyInitial, eEnd = res.frames.energy[res.frames.energy.length - 1], pct = (v) => (100 * v / e0).toFixed(1) + '%';
    console.log(`\n=== ${name}  (${sc.kmh} km/h, ${sc.angle || 0} deg, ${V.massKg} kg, ${sc.barrier || 'rigid'}, ${sc.damage})`);
    console.log(`impact sim: ${res.simMs} ms; peak ${m.peakDecelG.toFixed(1)} g, dV ${(m.deltaV * 3.6).toFixed(1)} km/h, crush ${(m.maxCrush * 1000).toFixed(0)} mm, intrusion ${(m.maxIntrusion * 1000).toFixed(0)} mm; HIC15 ${q.hic15.toFixed(0)}, chest ${q.chest3ms.toFixed(1)} g, Nij ${q.nij.toFixed(2)} (belt + airbag)`);
    console.log(`energy: plastic ${pct(eEnd.plastic)}, fracture ${pct(eEnd.fracture)}, debris KE ${pct(eEnd.debrisKinetic)}, contact+solver ${pct(eEnd.contactSolver)} (min ${pct(minResidual)})`);
    console.log(`came off: ${res.debris.map(d => short(d.name) + (d.key || '') + ' ' + ((d.t - res.T0) * 1000).toFixed(0) + ' ms').join(', ') || 'nothing'}`);
    console.log(`glass: ${res.glass.filter(g => g.t >= 0).map(g => short(g.name) + (g.laminated ? ' cracked' : '') + ' (' + g.cause + ')').join(', ') || 'intact'}; tyres burst: ${bursts.map(b => b.key).join(', ') || 'none'}; spawn checks ${res.spawnChecks.length}`);
    if (problems.length) { failures++; console.log('  PROBLEMS: ' + problems.join('; ')); }
  }

  // standing still: nothing may come off, break or drift
  if (!filter || `${key}-stands`.includes(filter)) {
    const sim = Phys.createImpactSim({ vehicle: V, massKg: V.massKg, stiffness: 'standard', barrier: 'rigid', pose: { x: -60, z: 0, heading: 0 }, speed: 0, minDuration: 1.0 });
    sim.advance(1e9);
    const res = sim.finalize(), P = res.frames.pos, a = P[Math.min(P.length - 1, Math.round(P.length * 0.5))], b = P[P.length - 1];
    let drift = 0;
    for (let i = 0; i < a.length; i++) drift = Math.max(drift, Math.abs(b[i] - a[i]));
    const broken = res.glass.filter(g => g.t >= 0).length, bursts = res.bursts.filter(x => x.t >= 0).length;
    const ok = !res.debris.length && !broken && !bursts && drift < 0.005;
    console.log(`\n=== ${key}-stands (parked 1 s): ${res.debris.length} parts off, ${broken} panes broken, ${bursts} bursts, node drift over the last 0.5 s ${(drift * 1000).toFixed(2)} mm ${ok ? 'OK' : 'PROBLEM'}`);
    if (!ok) failures++;
  }
  // coasting at 30 km/h with nothing to hit: the wheels must roll, not slide
  if (!filter || `${key}-coast`.includes(filter)) {
    const v0 = 30 / 3.6;
    const sim = Phys.createImpactSim({ vehicle: V, massKg: V.massKg, stiffness: 'standard', barrier: 'rigid', pose: { x: -80, z: 0, heading: 0 }, speed: v0, minDuration: 0.8 });
    sim.advance(1e9);
    const res = sim.finalize(), vEnd = res.pulse.vLong[res.pulse.n - 1], loss = 1 - vEnd / v0;
    const ok = !res.debris.length && loss < 0.05 && loss > -0.01;
    console.log(`=== ${key}-coast (30 km/h, 0.8 s): speed loss ${(loss * 100).toFixed(2)}%, ${res.debris.length} parts off ${ok ? 'OK' : 'PROBLEM'}`);
    if (!ok) failures++;
  }
  // a free wheel spinning at 130 rad/s, tilted 5 degrees, high above the ground for 2 s
  if (!filter || `${key}-freewheel`.includes(filter)) {
    const sim = Phys.createImpactSim({ vehicle: V, massKg: V.massKg, stiffness: 'standard', barrier: 'rigid', pose: { x: -80, z: 0, heading: 0 }, speed: 0, minDuration: 2.0 });
    const tilt = 5 * Math.PI / 180, w = 130;
    const b = sim.testWheel('RL', [-80, 40, 0], [0, 0, 0], [0, w * Math.sin(tilt), -w * Math.cos(tilt)]);
    const s0 = sim.bodyState(b);
    sim.advance(1e9);
    const s1 = sim.bodyState(b);
    const L0 = Math.hypot(...s0.omega) * s0.inertia, L1 = Math.hypot(...s1.omega) * s1.inertia;
    const k0 = 0.5 * s0.inertia * (s0.omega[0] ** 2 + s0.omega[1] ** 2 + s0.omega[2] ** 2), k1 = 0.5 * s1.inertia * (s1.omega[0] ** 2 + s1.omega[1] ** 2 + s1.omega[2] ** 2);
    const dL = Math.abs(L1 / L0 - 1), dK = Math.abs(k1 / k0 - 1), ok = dL < 0.005 && dK < 0.005 && s1.pos[1] > 0;
    console.log(`=== ${key}-freewheel (130 rad/s, 5 deg tilt, 2 s): angular momentum drift ${(dL * 100).toFixed(3)}%, spin energy drift ${(dK * 100).toFixed(3)}% ${ok ? 'OK' : 'PROBLEM'}`);
    if (!ok) failures++;
  }
  // a wheel dropped while sliding at 8 m/s: it must end up rolling (or at rest), not sliding or sinking
  if (!filter || `${key}-dropwheel`.includes(filter)) {
    const sim = Phys.createImpactSim({ vehicle: V, massKg: V.massKg, stiffness: 'standard', barrier: 'rigid', pose: { x: -80, z: 0, heading: 0 }, speed: 0, minDuration: 2.0 });
    const R = V.wheelRadius;
    const b = sim.testWheel('RL', [-90, R + 0.3, 5], [8, 0, 0], [0, 0, 0]);
    sim.advance(1e9);
    const s = sim.bodyState(b);
    // contact-point velocity v + w x (-R up)
    const slip = Math.hypot(s.vel[0] + s.omega[2] * R, s.vel[1], s.vel[2] - s.omega[0] * R);
    const ok = slip < 0.1 && s.pos[1] > 0.8 * R && s.pos[1] < 1.2 * R;
    console.log(`=== ${key}-dropwheel (dropped sliding at 8 m/s): after 2 s speed ${Math.hypot(...s.vel).toFixed(2)} m/s, contact slip ${slip.toFixed(3)} m/s, hub height ${s.pos[1].toFixed(3)} m ${ok ? 'OK' : 'PROBLEM'}`);
    if (!ok) failures++;
  }
}
// half the time step: the same parts must come off, at about the same times (within 5 ms: their
// strains differ by 2-5% between the two step sizes, which moves a gradual threshold crossing by a
// few milliseconds)
if (Veh.specs.lexus && (!filter || 'lexus-halfstep'.includes(filter))) {
  const V = Veh.get('lexus'), sc = { kmh: 100, damage: 'realistic' };
  const a = crash(V, sc), b = crash(V, sc, { dtScale: 0.5 });
  const list = (r) => r.debris.map(d => short(d.name) + (d.key || '')).sort().join(',');
  const times = (r) => Object.fromEntries(r.debris.map(d => [short(d.name) + (d.key || ''), (d.t - r.T0) * 1000]));
  const ta = times(a), tb = times(b);
  let worst = 0;
  for (const k in ta) if (k in tb) worst = Math.max(worst, Math.abs(ta[k] - tb[k]));
  const ok = list(a) === list(b) && worst <= 5;
  console.log(`\n=== lexus-halfstep (100 km/h, dt and dt/2): ${list(a) || 'nothing'} vs ${list(b) || 'nothing'}, largest time difference ${worst.toFixed(1)} ms ${ok ? 'OK' : 'PROBLEM'}`);
  if (!ok) failures++;
}
// destruction on vs off: losing the panels must not change the pulse the dummy feels much
// (56 km/h Dramatic, where the bumper and hood come off at a survivable severity)
if (Veh.specs.lexus && (!filter || 'lexus-onoff'.includes(filter))) {
  const V = Veh.get('lexus'), off = Object.assign({}, V, { parts: null, hubs: null }), sc = { kmh: 56, damage: 'dramatic' };
  const a = crash(V, sc), b = crash(off, sc);
  const qa = Occ.simulate(a.pulse, { belt: true, airbag: true, interior: V.interior }).metrics, qb = Occ.simulate(b.pulse, { belt: true, airbag: true, interior: V.interior }).metrics;
  const dg = Math.abs(a.metrics.peakDecelG / b.metrics.peakDecelG - 1), dh = Math.abs(qa.hic15 / qb.hic15 - 1);
  const ok = dg < 0.03 && dh < 0.03;
  console.log(`=== lexus-onoff (56 km/h Dramatic, destruction on vs off): peak ${a.metrics.peakDecelG.toFixed(1)} vs ${b.metrics.peakDecelG.toFixed(1)} g (${(dg * 100).toFixed(1)}%), HIC ${qa.hic15.toFixed(0)} vs ${qb.hic15.toFixed(0)} (${(dh * 100).toFixed(1)}%) ${ok ? 'OK' : 'PROBLEM'}`);
  if (!ok) failures++;
}
// ---------------------------------------------------------------- crash labs
// Each check is the claim the lab makes: if the physics stops showing it, the check fails.
const WL = require(path.join(__dirname, '../js/whiplash.js'));
const PED = require(path.join(__dirname, '../js/pedestrian.js'));
function labCheck(name, ok, detail) {
  console.log(`=== lab-${name}: ${detail} ${ok ? 'OK' : 'PROBLEM'}`);
  if (!ok) failures++;
}
const residualOk = (res) => { const p = []; energyProblems(res, p); return p; };
const maxMeasure = (res, u, nm, axis, sign) => { const M = res.units[u].measure, q = M.names.indexOf(nm); let m = -Infinity; for (const f of M.frames) m = Math.max(m, sign * f[3 * q + axis]); return m; };
if (Veh.specs.lexus && (!filter || 'lab-overlap'.includes(filter))) {
  const V = Veh.get('lexus'), W = V.width, run = (ov, honeycomb) => {
    const app = approachTo(V, 64, 0, V.massKg), st = app.state, face = honeycomb ? Phys.HONEYCOMB.main.depth + Phys.HONEYCOMB.bumper.depth : 0;
    while (app.gap() > 0.01 + st.v * 0.004 + face) app.step(0.001);
    const sim = Phys.createImpactSim({ vehicle: V, massKg: V.massKg, stiffness: 'standard', damage: 'realistic', barrier: 'offset', measure: true, structure: { footwell: true },
      offset: { zEdge: -W / 2 + ov * W, side: -1, width: 1, height: 1.5, edgeRadius: honeycomb ? 0 : 0.15, honeycomb }, pose: app.pose(), speed: st.v, yawRate: st.yawRate });
    sim.advance(1e9);
    return sim.finalize();
  };
  const mod = run(0.4, true), small = run(0.25, false), pm = residualOk(mod).concat(residualOk(small));
  const H = mod.offset.honeycomb, last = H.frames[H.frames.length - 1];
  let crush = 0; for (const c of last) crush = Math.max(crush, c);
  const hm = maxMeasure(mod, 0, 'hinge', 0, -1), hs = maxMeasure(small, 0, 'hinge', 0, -1);
  labCheck('overlap', !pm.length && crush > 0.05 && crush <= 0.54 && hs > hm,
    `40% honeycomb: peak ${mod.metrics.peakDecelG.toFixed(1)} g, honeycomb crushed ${(crush * 100).toFixed(0)} cm, hinge pillar ${(hm * 100).toFixed(1)} cm; 25% rigid: peak ${small.metrics.peakDecelG.toFixed(1)} g, hinge pillar ${(hs * 100).toFixed(1)} cm (must be more)${pm.length ? '; ' + pm.join('; ') : ''}`);
  // the 3D dummy in the small overlap: the toe pan comes back (the cabin moving, from cabinInput)
  // and must push the driver's left foot back, which a fixed cabin doesn't
  const cab = Phys.cabinInput(small, 0), q = cab.names.indexOf('toe');
  let toe = 0;
  for (let k = 0; k < cab.t.length; k++) toe = Math.max(toe, Math.hypot(...[0, 1, 2].map(c => cab.p[3 * (k * cab.np + q) + c] - cab.p[3 * q + c])));
  const occ = (cabin) => Occ.simulate(small.pulse, { belt: true, airbag: true, interior: V.interior, cabin });
  const fixed = occ(null), moving = occ(cab), i = 3 * Occ.PARTICLES.AL, end = Math.round((small.T0 + 0.15) / (fixed.dt * fixed.poseEvery));
  let pushed = 0;   // how much further back the left foot is with the cabin moving, at the same moment, in the 150 ms after contact
  for (let p = 0; p <= end && p * fixed.poseStride < fixed.pose.length; p++) pushed = Math.max(pushed, fixed.pose[p * fixed.poseStride + i] - moving.pose[p * moving.poseStride + i]);
  labCheck('overlap-occupant', Number.isFinite(moving.metrics.hic15) && toe > 0.08 && pushed > 0.05,
    `25% rigid: toe pan back ${(toe * 100).toFixed(1)} cm, left foot ${(pushed * 100).toFixed(1)} cm further back than with a fixed cabin (must be over 5 cm); femur ${(moving.metrics.femur / 1000).toFixed(2)} vs ${(fixed.metrics.femur / 1000).toFixed(2)} kN, HIC15 ${moving.metrics.hic15.toFixed(0)} vs ${fixed.metrics.hic15.toFixed(0)}`);
}
if (Veh.specs.lexus && (!filter || 'lab-multi'.includes(filter))) {
  const lab = Veh.get('lab'), lex = Veh.get('lexus');
  const run = (A, mA, B, mB, kmh) => {
    const fa = A.xMin + A.length, fb = B.xMin + B.length, v = kmh / 3.6, gap = 0.02 + 2 * v * 0.004;
    const sim = Phys.createImpactSim({ barrier: 'none', duration: 1.0, vehicles: [
      { vehicle: A, massKg: mA, stiffness: 'standard', damage: 'realistic', pose: { x: -gap / 2 - fa, z: 0, heading: 0 }, speed: v },
      { vehicle: B, massKg: mB, stiffness: 'standard', damage: 'realistic', pose: { x: gap / 2 + fb, z: 0, heading: Math.PI }, speed: v }] });
    sim.advance(1e9);
    return sim.finalize();
  };
  const eq = run(lex, 1950, lex, 1950, 56), mm = run(lab, 1200, lex, 2400, 64);
  const dv = (r, u) => r.units[u].metrics.deltaVVector, pr = residualOk(eq).concat(residualOk(mm));
  // momentum over the first 30 ms of contact (the tyres take little in that time)
  const E = mm.frames.energy, k0 = mm.frames.t.findIndex(t => t >= mm.T0), k1 = mm.frames.t.findIndex(t => t >= mm.T0 + 0.03);
  const p = (k) => Math.hypot(E[k].units[0].px + E[k].units[1].px, E[k].units[0].pz + E[k].units[1].pz), dp = Math.abs(p(k1) / p(k0) - 1);
  const ratio = dv(mm, 0) / dv(mm, 1), sym = Math.abs(dv(eq, 0) / dv(eq, 1) - 1);
  labCheck('multi', !pr.length && sym < 0.05 && ratio > 1.6 && ratio < 2.4 && dp < 0.02,
    `equal cars at 56 km/h: dV ${(dv(eq, 0) * 3.6).toFixed(1)} / ${(dv(eq, 1) * 3.6).toFixed(1)} km/h; 1,200 kg vs 2,400 kg at 64 km/h: dV ${(dv(mm, 0) * 3.6).toFixed(1)} / ${(dv(mm, 1) * 3.6).toFixed(1)} km/h (ratio ${ratio.toFixed(2)}, mass ratio 2), momentum change over 30 ms ${(dp * 100).toFixed(2)}%${pr.length ? '; ' + pr.join('; ') : ''}`);
}
if (Veh.specs.lexus && (!filter || 'lab-side'.includes(filter))) {
  const V = Veh.get('lexus'), H = V.hPoint, W = V.width;
  const run = (kind, steel) => {
    const units = [{ vehicle: V, massKg: V.massKg, stiffness: 'standard', damage: 'realistic', pose: { x: 0, z: 0, heading: 0 }, speed: 0, structure: { steel } }];
    const cfg = { barrier: kind === 'pole' ? 'pole' : 'none', measure: true, duration: 0.5, vehicles: units };
    if (kind === 'mdb') { const M = Veh.MDB; units.push({ vehicle: M, massKg: M.massKg, stiffness: 'standard', pose: { x: H[0] - 0.1, z: -W / 2 - 0.02 - (M.xMin + M.length), heading: Math.PI / 2 }, speed: 37 * 0.44704 }); }
    else { units[0].velocity = [0, -20 * 0.44704]; cfg.pole = { x: H[0] + 0.05, z: -W / 2 - Phys.POLE_RADIUS - 0.03 }; cfg.sled = true; }
    const sim = Phys.createImpactSim(cfg); sim.advance(1e9);
    return sim.finalize();
  };
  const mild = run('mdb', 'mild'), uhss = run('mdb', 'uhss'), pole = run('pole', 'uhss');
  const bp = (r) => maxMeasure(r, 0, 'bpillarMid', 2, 1) * 100, pr = residualOk(mild).concat(residualOk(uhss), residualOk(pole));
  const inp = Phys.sideInput(pole), on = Occ.simulateSide(inp, { curtain: true }).metrics, off = Occ.simulateSide(inp, { curtain: false }).metrics;
  const nan = [on.hic36, off.hic36, on.ribDeflMm].some(v => !Number.isFinite(v));
  labCheck('side', !pr.length && !nan && bp(mild) > 15 && bp(uhss) < 15 && on.hic36 < off.hic36,
    `barrier 37 mph: B-pillar ${bp(mild).toFixed(1)} cm mild (must exceed 15), ${bp(uhss).toFixed(1)} cm hot-stamped (must stay under); pole 20 mph: HIC36 ${on.hic36.toFixed(0)} with curtain, ${off.hic36.toFixed(0)} without, rib ${on.ribDeflMm.toFixed(1)} mm${pr.length ? '; ' + pr.join('; ') : ''}`);
}
if (!filter || 'lab-whiplash'.includes(filter)) {
  const good = WL.simulate({ strikeMph: 20, backset: 0.04, height: -0.03 }).metrics, far = WL.simulate({ strikeMph: 20, backset: 0.10, height: -0.06 }).metrics, hard = WL.simulate({ strikeMph: 30, backset: 0.04, height: -0.03 }).metrics;
  const nan = [good, far, hard].some(m => !Number.isFinite(m.t1PeakG) || !Number.isFinite(m.nic));
  labCheck('whiplash', !nan && good.contactMs > 0 && good.contactMs <= 70 && good.t1PeakG <= 9.5 && far.contactMs > 70 && hard.t1PeakG > good.t1PeakG,
    `20 mph, 4 cm backset: contact ${good.contactMs.toFixed(0)} ms, T1 ${good.t1PeakG.toFixed(2)} g (must pass both); 10 cm backset: contact ${far.contactMs.toFixed(0)} ms (must be late); 30 mph: T1 ${hard.t1PeakG.toFixed(1)} g`);
}
if (Veh.specs.lexus && (!filter || 'lab-restraint'.includes(filter))) {
  const V = Veh.get('lexus'), res = crash(V, { kmh: 56, damage: 'realistic' });
  const cabin = Phys.cabinInput(res, 0), q = (o) => Occ.simulate(res.pulse, Object.assign({ interior: V.interior, cabin }, o));
  const none = q({ belt: false, airbag: false }), belt = q({ belt: true, airbag: false, pretensioner: false, loadLimiter: false }), full = q({ belt: true, airbag: true });
  const org = Occ.organs(full, res.pulse), ph = org.phases;
  const ok = none.metrics.hic15 > belt.metrics.hic15 && belt.metrics.hic15 > full.metrics.hic15 && Number.isFinite(org.brainMaxMm) && ph[0].t0 < ph[1].t0 && ph[1].t0 >= 0;
  labCheck('restraint', ok, `HIC15 unbelted ${none.metrics.hic15.toFixed(0)} > belt ${belt.metrics.hic15.toFixed(0)} > belt + limiter + airbags ${full.metrics.hic15.toFixed(0)}; collisions start at ${ph.map(p => ((p.t0 - res.T0) * 1000).toFixed(0)).join(' / ')} ms; brain ${org.brainMaxMm.toFixed(1)} mm, heart ${org.heartMaxMm.toFixed(1)} mm`);
}
if (Veh.specs.lexus && (!filter || 'lab-pedestrian'.includes(filter))) {
  const V = Veh.get('lexus'), kmh = 25 * 1.609344;
  const aeb = PED.simulate({ kmh, target: 'adult', aeb: true, bumper: 'foam', vehicle: V }), off = PED.simulate({ kmh, target: 'adult', aeb: false, bumper: 'foam', vehicle: V });
  const fast = PED.simulate({ kmh: 37 * 1.609344, target: 'adult', aeb: true, bumper: 'foam', vehicle: V });
  const m = off.impact && off.impact.metrics, c = off.compare && off.compare.impact.metrics;
  const nan = !m || [m.hic15, m.tibiaPeakG, m.kneeDeg, c.tibiaPeakG].some(v => !Number.isFinite(v));
  labCheck('pedestrian', !aeb.plan.impact && !nan && m.tibiaPeakG < c.tibiaPeakG && fast.plan.impact && fast.plan.impact.v < 37 * 0.44704 * 0.6,
    `25 mph adult: avoided with AEB (stopped ${aeb.plan.distLeft.toFixed(1)} m short); without, HIC ${m ? m.hic15.toFixed(0) : 'NaN'}, leg ${m ? m.tibiaPeakG.toFixed(0) : 'NaN'} g foam vs ${c ? c.tibiaPeakG.toFixed(0) : 'NaN'} g steel; 37 mph with AEB: impact at ${fast.plan.impact ? (fast.plan.impact.v / 0.44704).toFixed(1) : '-'} mph`);
}
// ---------------------------------------------------------------- world obstacles (the Race game)
// barrier 'world': boxes and cylinders anywhere, at any angle. The checks: one cylinder is exactly
// the pole; a box wall behaves like the rigid barrier, and the same at another angle; the glass
// found while the run goes on (scanGlass) is exactly what finalize finds; a fast two-car crash
// among obstacles stays sound.
if (Veh.specs.lexus && (!filter || 'world'.includes(filter))) {
  const crypto = require('crypto'), V = Veh.get('lexus'), H = V.hPoint, W = V.width, R = Phys.POLE_RADIUS;
  const hash = (r) => { const h = crypto.createHash('sha1'); for (const p of r.frames.pos) h.update(Buffer.from(p.buffer, p.byteOffset, p.byteLength)); h.update(JSON.stringify(r.glass)); h.update(JSON.stringify(r.events)); h.update(JSON.stringify(r.metrics)); return h.digest('hex'); };
  const check = (name, ok, detail) => { console.log(`=== ${name}: ${detail} ${ok ? 'OK' : 'PROBLEM'}`); if (!ok) failures++; };
  const run = (cfg) => { const sim = Phys.createImpactSim(cfg); sim.advance(1e9); return sim.finalize(); };
  // one cylinder = the pole
  const side = (barrier) => { const px = H[0] + 0.05, pz = -W / 2 - R - 0.03, cfg = { barrier, measure: true, duration: 0.5, sled: true,
    vehicles: [{ vehicle: V, massKg: V.massKg, stiffness: 'standard', damage: 'realistic', pose: { x: 0, z: 0, heading: 0 }, speed: 0, velocity: [0, -20 * 0.44704], structure: { steel: 'mild' } }] };
    if (barrier === 'pole') cfg.pole = { x: px, z: pz }; else cfg.world = { cyls: [{ x: px, z: pz, r: R, height: 3 }] };
    return run(cfg); };
  const hp = hash(side('pole')), hw = hash(side('world'));
  check('world-pole', hp === hw, `a world of one 254 mm cylinder and the pole test: ${hp === hw ? 'identical' : 'different'} frames, glass, events and metrics`);
  // a box wall against the rigid barrier, head-on and with the whole scene turned 30 degrees
  const app = approachTo(V, 56, 0, V.massKg), pose = app.pose(), st = app.state;
  const base = { vehicle: V, massKg: V.massKg, stiffness: 'standard', damage: 'realistic', speed: st.v, yawRate: st.yawRate };
  const rigid = run(Object.assign({ barrier: 'rigid', pose }, base));
  const turned = (th) => { const c = Math.cos(th), s = Math.sin(th), rot = (x, z) => [x * c - z * s, x * s + z * c], p = rot(pose.x, pose.z), w = rot(1.5, 0);
    return run(Object.assign({ barrier: 'world', world: { boxes: [{ x: w[0], z: w[1], hx: 1.5, hz: 9, angle: th, height: 3 }] }, pose: { x: p[0], z: p[1], heading: pose.heading + th } }, base)); };
  const w0 = turned(0), w30 = turned(30 * Math.PI / 180), rel = (a, b) => Math.abs(a / b - 1);
  const pw = residualOk(w0).concat(residualOk(w30));
  check('world-wall', !pw.length && rel(w0.metrics.peakDecelG, rigid.metrics.peakDecelG) < 0.1 && rel(w0.metrics.maxCrush, rigid.metrics.maxCrush) < 0.1
    && rel(w30.metrics.peakDecelG, w0.metrics.peakDecelG) < 0.03 && rel(w30.metrics.maxCrush, w0.metrics.maxCrush) < 0.03,
    `Lexus 56 km/h: rigid barrier peak ${rigid.metrics.peakDecelG.toFixed(1)} g, crush ${(rigid.metrics.maxCrush * 1000).toFixed(0)} mm; box wall ${w0.metrics.peakDecelG.toFixed(1)} g, ${(w0.metrics.maxCrush * 1000).toFixed(0)} mm (within 10%); turned 30 degrees ${w30.metrics.peakDecelG.toFixed(1)} g, ${(w30.metrics.maxCrush * 1000).toFixed(0)} mm (within 3%)${pw.length ? '; ' + pw.join('; ') : ''}`);
  // live glass = finalize's glass: a Dramatic 100 km/h crash into a wall, and two cars among obstacles
  const live = (cfg) => { const sim = Phys.createImpactSim(cfg), got = [];
    while (!sim.done) { sim.advance(5); got.push(...sim.scanGlass(false).glass); }
    got.push(...sim.scanGlass(true).glass);
    const fin = sim.finalize().glass.filter(g => g.t >= 0), key = (g) => g.unit + g.name, srt = (a) => a.slice().sort((x, y) => key(x) < key(y) ? -1 : 1);
    return { same: JSON.stringify(srt(got)) === JSON.stringify(srt(fin)), n: fin.length, sim }; };
  const a100 = approachTo(V, 100, 0, V.massKg);
  const g1 = live(Object.assign({}, base, { damage: 'dramatic', speed: a100.state.v, yawRate: a100.state.yawRate, pose: a100.pose(), barrier: 'world', world: { boxes: [{ x: 1.5, z: 0, hx: 1.5, hz: 9, angle: 0, height: 3 }] } }));
  // two Lexus head-on at 160 km/h each, between a building corner and a lamp post
  const M = Veh.get('mustang'), v = 160 / 3.6, fa = V.xMin + V.length, fb = M.xMin + M.length, gap = 0.02 + 2 * v * 0.004, a = 0.25;
  const two = { barrier: 'world', duration: 1.2, world: { boxes: [{ x: 1, z: 4.5, hx: 6, hz: 2, angle: 0.1, height: 12 }], cyls: [{ x: -2, z: -2.6, r: 0.16, height: 6 }] },
    vehicles: [{ vehicle: V, massKg: V.massKg, stiffness: 'standard', damage: 'realistic', pose: { x: -gap / 2 - fa, z: 0, heading: 0 }, speed: v },
      { vehicle: M, massKg: M.massKg, stiffness: 'standard', damage: 'realistic', pose: { x: Math.cos(a) * (gap / 2 + fb), z: -Math.sin(a) * (gap / 2 + fb), heading: Math.PI - a }, speed: v }] };
  const g2 = live(two), r2 = g2.sim.finalize(), p2 = residualOk(r2);
  check('world-glass', g1.same && g2.same, `glass found during the run = at the end: Dramatic 100 km/h wall ${g1.n} panes ${g1.same ? 'same' : 'DIFFERENT'}; two cars ${g2.n} panes ${g2.same ? 'same' : 'DIFFERENT'}`);
  check('world-fast', !p2.length, `Lexus and Mustang head-on at 2 x 160 km/h beside a building and a lamp post: peak ${r2.units.map(u => u.metrics.peakDecelG.toFixed(0)).join(' / ')} g, ${r2.debris.length} parts off, back-off ${(r2.world.backOff * 1000).toFixed(1)} mm${p2.length ? '; ' + p2.join('; ') : ''}`);
}

// after the crash (js/fire.js): steam once the radiator is crushed; fire only when the engine is
// driven back toward the firewall, which a 56 km/h barrier test must not do and a 100 km/h one does
if (Veh.specs.lexus && (!filter || 'fire'.includes(filter))) {
  const Fire = require(path.join(__dirname, '../js/fire.js'));
  const V = Veh.get('lexus'), f56 = Fire.assess(crash(V, { kmh: 56, damage: 'realistic' }), 0), f100 = Fire.assess(crash(V, { kmh: 100, damage: 'realistic' }), 0);
  labCheck('fire', f56.steam && !f56.fire && f100.fire,
    `56 km/h: engine back ${(f56.engineBack * 100).toFixed(0)} cm, steam ${f56.steam}, fire ${f56.fire} (must be steam only); 100 km/h: engine back ${(f100.engineBack * 100).toFixed(0)} cm, fire ${f100.fire} (must burn; rule: ${Fire.ENGINE_BACK * 100} cm)`);
}

console.log(failures ? `\n${failures} scenario(s) with problems` : '\nall scenarios ran without NaN, energy gain, missed contact or failed destruction checks');
process.exit(failures ? 1 : 0);
