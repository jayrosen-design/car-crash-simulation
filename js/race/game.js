/* The Race game: three laps against seven rivals through city traffic.
 *
 * The world steps at 240 Hz (fixed), the screen as fast as the browser draws. Progress round the
 * circuit is the nearest point on its centre line; a lap counts when a car crosses the start line
 * going forward, having been round the rest of the loop. Position is laps plus distance.
 *
 * Boost fills from near misses (passing traffic within a metre), driving in the oncoming lanes,
 * drifting and takedowns (a rival that wrecks within two seconds of a hit from you), and is spent
 * holding the boost button.
 *
 * Crashes: when a hit is hard enough (world.js), the cars go back one step (to just before they
 * touched) and are handed to the full crash solver (crash.js), which runs in the background. The
 * crash camera plays its frames back in slow motion, never ahead of them: the real deformation,
 * parts coming off and glass breaking, within a moment of the impact. Meanwhile the race goes on
 * (the rivals gain time); the camera shows the street as it was. Then the car is put back on the
 * road. Rivals that crash on their own spin out as rigid bodies and rejoin.
 *
 * URL: ?car=lexus|mustang, ?seed=<n> (another city), ?damage=dramatic, ?traffic=0,
 * ?test=wall150|headon|takedown (a scripted crash or takedown at once, results in
 * window.__race.test), ?worker=0.
 */
const RaceGame = (() => {
  'use strict';
  const Veh = CrashVehicles;
  const STEP = 1 / 240;
  const q = new URLSearchParams(location.search);
  const $ = (s) => document.querySelector(s);
  const fmtTime = (t) => { if (!(t >= 0)) return '--:--.--'; const m = Math.floor(t / 60), s = t - m * 60; return `${m}:${s < 10 ? '0' : ''}${s.toFixed(2)}`; };
  const ord = (n) => n + (n % 10 === 1 && n !== 11 ? 'st' : n % 10 === 2 && n !== 12 ? 'nd' : n % 10 === 3 && n !== 13 ? 'rd' : 'th');
  const TEST = q.get('test');

  const level = CrashLevel.build({ seed: +q.get('seed') || undefined });
  const L = level.length;
  const R = RaceRender.create({ level, container: $('#view') });
  const world = RaceWorld.create(level);
  const specs = { lexus: Veh.get('lexus'), mustang: Veh.get('mustang') };
  const carKey = specs[q.get('car')] ? q.get('car') : 'lexus';
  const DAMAGE = q.get('damage') === 'dramatic' ? 'dramatic' : 'realistic';
  const PAINT = 0xa3161f;

  // ---------------------------------------------------------------- the grid
  const RIVALS = [
    { name: 'Ava Lindqvist', key: 'mustang', paint: 0x2b5fa8, skill: 1.0 },
    { name: 'Marco Reyes', key: 'lexus', paint: 0xe0b022, skill: 0.985 },
    { name: 'Kenji Tanaka', key: 'mustang', paint: 0x1f7a4a, skill: 0.975 },
    { name: 'Léa Moreau', key: 'lexus', paint: 0xe8e8e6, skill: 0.965 },
    { name: 'Sam Okafor', key: 'mustang', paint: 0xd2541e, skill: 0.955 },
    { name: 'Nina Novak', key: 'lexus', paint: 0x111214, skill: 0.945 },
    { name: 'Ravi Mehta', key: 'mustang', paint: 0x6b2c8f, skill: 0.935 },
  ];
  const PLAYER_SLOT = 5;
  const slotPose = (i) => { const s = level.start.s - 8 - Math.floor(i / 2) * 9, lane = i % 2 ? 5.25 : 1.75, p = level.poseAt(s, lane); return { s, lane, x: p.x, z: p.z, h: p.h }; };
  const grid = [];
  for (let i = 0, k = 0; i < 8; i++) if (i !== PLAYER_SLOT) grid.push(Object.assign(slotPose(i), RIVALS[k++]));

  const car = RaceCar.create(specs[carKey]);
  const me = world.add(car, { kind: 'player' });
  const ps = slotPose(PLAYER_SLOT);
  car.place(ps.x, ps.z, ps.h, 0);
  const ai = RaceAI.createRivals(level, world, { grid, specs, seed: 11 });
  const traffic = q.get('traffic') === '0' || TEST ? { cars: [], step() {}, clearAhead() {}, remove() {} } : RaceAI.createTraffic(level, world, { specs, seed: 23, clearStart: true });
  // scripted tests run without the field (the takedown test keeps one rival)
  if (TEST) { const keep = TEST === 'takedown' ? 1 : 0; for (const r of ai.rivals.slice(keep)) world.bodies.splice(world.bodies.indexOf(r.body), 1); ai.rivals.length = keep; world.bodies.forEach((b, i) => { b.id = i; }); }

  // ---------------------------------------------------------------- progress
  const prog = { i: -1, s: ps.s, l: ps.lane, lap: 1, lapStart: 0, best: -1, last: -1, dist: 0, prevS: ps.s, wrong: 0, done: false, time: 0 };
  function track(t) {
    const p = car.pose, f = level.nearest(p.x, p.z, prog.i);
    prog.i = f.i; me.track = f;
    let ds = level.wrapDiff(f.s, prog.prevS);
    if (Math.abs(ds) > 50) ds = 0;   // a reset or a jump: not progress
    prog.dist += ds; prog.prevS = f.s;
    const rel = level.wrapDiff(f.s, level.start.s);
    if (ds > 0 && rel >= 0 && rel < ds + 0.01 && prog.dist > L * 0.8 && !prog.done) {
      const lapT = t - prog.lapStart;
      prog.last = lapT; prog.best = prog.best < 0 ? lapT : Math.min(prog.best, lapT);
      prog.lap++; prog.lapStart = t; prog.dist = 0;
      if (prog.lap > level.laps) finish(t);
      else toast(prog.lap === level.laps ? `Final lap · ${fmtTime(lapT)}` : `Lap ${prog.lap - 1} · ${fmtTime(lapT)}`);
    }
    prog.wrong = (Math.cos(car.h - f.h) < -0.3 && car.speed > 5) ? prog.wrong + STEP : 0;
    prog.l = f.l; prog.s = f.s;
  }
  const progress = (p) => (p.done ? 1e9 - p.time : (p.lap - 1) * L + p.dist);
  function standings() {
    const all = [{ name: 'You', you: true, prog, key: carKey }].concat(ai.rivals.map(r => ({ name: r.name, prog: r.prog, key: r.key, r })));
    return all.sort((a, b) => progress(b.prog) - progress(a.prog));
  }
  // the player's lead over rival r (m): for the rivals' rubber band
  const leadOver = (r) => progress(r.prog) - progress(prog);
  function placeOnRoad(body, s, l, speed) {
    const lane = l >= 0 ? (l > 3.5 ? 5.25 : 1.75) : (l < -3.5 ? 5.25 : 1.75);
    const p = level.poseAt(s, lane);
    body.car.place(p.x, p.z, p.h, speed);
    body.ghost = 2;
  }
  function resetToTrack() {
    const f = level.nearest(car.pose.x, car.pose.z, prog.i);
    placeOnRoad(me, f.s, f.l, Math.min(car.speed, 12));
    prog.prevS = f.s;
  }

  // ---------------------------------------------------------------- boost, near misses, takedowns
  let boost = 0.3, takedowns = 0, slowmo = 0;
  const lastHit = new Map();   // rival -> race time of the player's last contact with it
  function gainBoost(x, label) { boost = Math.min(1, boost + x); if (label) chip(label); }
  function nearMisses() {
    for (const t of traffic.cars) {
      const kind = RaceAI.nearMiss(car, t);
      if (kind) { gainBoost(kind === 'oncoming' ? 0.15 : 0.1, kind === 'oncoming' ? 'Oncoming near miss' : 'Near miss'); FX.hit(1500, [t.body.car.x, 0.6, t.body.car.z]); }
    }
  }
  function takedown(r) {
    takedowns++;
    gainBoost(1, null);
    toast('Takedown!', 1600);
    slowmo = 0.9;
    RaceInput.rumble(0.8, 0.6, 300);
    FX.crunch(1, [r.body.car.x, 0.6, r.body.car.z]);
  }

  // ---------------------------------------------------------------- crashes
  let state = TEST ? 'race' : 'intro', countdown = 3.6, crash = null, crashT = 0, tPlay = 0, kCur = 0, camAngle = 0, evPending = [], crashUnits = [], frozenDraw = null;
  const crashes = [];   // the last two, for replays
  const testOut = (window.__race = { test: null }).test = { frames: [], aheadOfStream: 0 };
  function triggerCrash(e) {
    if (state !== 'race') return;
    const other = e.b && e.b !== me ? e.b : (e.a !== me ? e.a : null);
    // back to the start of this step: just before the cars touched
    world.restore(me, 1);
    if (other) world.restore(other, 1);
    const bodies = other ? [me, other] : [me];
    const units = bodies.map(b => ({ key: b.car.key, massKg: b.car.m, pose: b.car.pose, velocity: b.car.originVelocity(), yawRate: b.car.yaw }));
    const near = level.collidersNear(e.x, e.z, 32);
    const shapes = { boxes: near.filter(o => o.box).map(o => ({ x: o.x, z: o.z, hx: o.hx, hz: o.hz, angle: o.angle, height: o.height })), cyls: near.filter(o => !o.box).map(o => ({ x: o.x, z: o.z, r: o.r, height: o.height })) };
    crash = RaceCrash.start({ units, world: shapes, duration: 1.6, damage: DAMAGE });
    crash.impactKmh = e.vn * 3.6;
    crashUnits = bodies.map((b, u) => ({ body: b, model: u === 0 ? R.player : R.wrecks[b.car.key], view: crash.unitView(u) }));
    for (const U of crashUnits) { U.body.frozen = true; if (U.model !== R.player) U.model.group.visible = true; }
    frozenDraw = drawStates();   // the street as it was, for the crash camera
    state = 'crash'; crashT = 0; tPlay = 0; kCur = 0; evPending = [];
    camAngle = Math.atan2(car.vz, car.vx) + Math.PI * 0.62;
    FX.engineStop();
    FX.setTimeScale(0.25);
    RaceInput.rumble(1, 1, 450);
    $('#crash').hidden = false; $('#crash-skip').hidden = true;
    $('#crash-speed').textContent = `Impact ${Math.round(crash.impactKmh)} km/h`;
    if (TEST) testOut.crashAt = performance.now();
  }
  const PT = { x: 0, z: 0 };
  // play crash frames on the crash's models at time t (frame cursor kept in kCur)
  function showCrashFrame(cr, units, t) {
    const F = cr.F, n = F.t.length;
    let k = Math.min(kCur, n - 2); while (k > 0 && F.t[k] > t) k--; while (k < n - 2 && F.t[k + 1] <= t) k++; kCur = k;
    const k2 = Math.min(n - 1, k + 1), s = F.t[k2] > F.t[k] ? Math.min(1, Math.max(0, (t - F.t[k]) / (F.t[k2] - F.t[k]))) : 0;
    PT.x = 0; PT.z = 0;
    for (const U of units) {
      R.deform(U.model, U.view, k, k2, s, t);
      const ax = U.view.frames.axes[k]; PT.x += ax[0] / units.length; PT.z += ax[2] / units.length;
    }
  }
  function updateCrash(dt, input) {
    crashT += dt;
    crash.tick(6);   // the main-thread fallback; nothing with the worker
    const F = crash.F, n = F.t.length;
    if (n >= 3) {
      if (TEST && testOut.firstFrameMs === undefined) testOut.firstFrameMs = performance.now() - testOut.crashAt;
      const T0 = crash.T0 >= 0 ? crash.T0 : F.t[n - 1], since = tPlay - T0;
      // slow motion through the impact, back to real time as the wreck settles
      const speed = since < 0 ? 0.25 : since < 0.12 ? 0.08 : since < 0.3 ? 0.08 + (since - 0.12) / 0.18 * 0.22 : since < 0.8 ? 0.3 + (since - 0.3) / 0.5 * 0.7 : 1;
      const limit = crash.done ? F.t[n - 1] : F.t[n - 3];   // never ahead of the stream (two frames behind)
      const want = tPlay + dt * speed;
      if (want > limit) testOut.aheadOfStream++;
      tPlay = Math.min(want, limit);
      FX.setTimeScale(speed);
      showCrashFrame(crash, crashUnits, tPlay);
      fireEvents(crash, tPlay);
      camAngle += dt * 0.35;
      R.orbit(PT, camAngle, 7.5, 1.9, level);
    }
    if (crashT > 1.2) $('#crash-skip').hidden = false;
    const over = (crash.done && tPlay >= F.t[n - 1] - 1e-6) || (crash.T0 >= 0 && tPlay >= crash.T0 + 1.25);
    if (over || (crashT > 1.2 && (input.start || input.throttle > 0.5))) respawn();
  }
  function fireEvents(cr, t) {
    const fresh = cr.events.slice(evPending.cursor || 0);
    evPending.cursor = cr.events.length;
    evPending.push(...fresh);
    evPending.sort((a, b) => a.t - b.t);
    while (evPending.length && evPending[0].t <= t) {
      const e = evPending.shift(), pos = [e.x, e.y, e.z];
      if (e.type === 'first') { FX.crunch(1, pos); sparks.spawn(e.x, e.y, e.z, 40, 'spark', [0, 0.6, 0]); sparks.spawn(e.x, e.y, e.z, 16, 'dust'); }
      else if (e.type === 'contact') { if (Math.random() < 0.25) FX.crunch(Math.min(1, e.mag / 3000), pos); if (Math.random() < 0.5) sparks.spawn(e.x, e.y, e.z, 4, 'spark', [0, 0.3, 0]); }
      else if (e.type === 'detach') { FX.tear(e.mass, pos); FX.clank(e.mass, pos); sparks.spawn(e.x, e.y, e.z, Math.min(24, 6 + Math.round(e.mass)), 'spark', [0, 0.6, 0]); }
      else if (e.type === 'glass') { FX.glass(e.mass, pos); sparks.spawn(e.x, e.y, e.z, 12, 'glass'); }
      else if (e.type === 'crack') FX.crack(0.8, pos);
      else if (e.type === 'burst') { FX.blowout(pos); sparks.spawn(e.x, 0.15, e.z, 10, 'dust'); }
    }
  }
  function respawn() {
    crashes.push({ crash, units: crashUnits.map(U => ({ key: U.body.car.key, model: U.model === R.player ? 'player' : U.body.car.key, u: crashUnits.indexOf(U) })) });
    if (crashes.length > 2) crashes.shift();
    for (const U of crashUnits) {
      U.body.frozen = false;
      if (U.model !== R.player) { U.model.clearDestruction(); U.model.group.visible = false; }
    }
    // the player: back on the road a little ahead of the wreck, the road ahead cleared of traffic
    const ax = crash.F.axes[kCur] || [car.pose.x, 0, car.pose.z];
    const f = level.nearest(ax[0], ax[2], prog.i);
    placeOnRoad(me, f.s + 12, f.l, 60 / 3.6);
    prog.prevS = level.nearest(car.pose.x, car.pose.z).s;
    traffic.clearAhead(f.s, 90);
    // the other car: traffic leaves, a rival rejoins behind
    for (const U of crashUnits) {
      if (U.body === me) continue;
      if (U.body.traffic) traffic.remove(U.body.traffic);
      else if (U.body.rival) ai.respawn(U.body.rival, f.s - 25);
    }
    if (TEST) { testOut.respawnMs = performance.now() - testOut.crashAt; testOut.parts = crash.debris.length; testOut.glass = crash.glass.length; testOut.mode = crash.mode; testOut.T0 = crash.T0; }
    state = prog.done ? 'finished' : 'race'; crash = null; crashUnits = []; frozenDraw = null;
    FX.setTimeScale(1);
    if (audio) FX.engineStart();
    $('#crash').hidden = true;
  }

  // ---------------------------------------------------------------- replay of a crash (results screen)
  let replay = null;
  function startReplay(idx) {
    const c = crashes[idx];
    if (!c || !c.crash.done || !c.crash.result) { toast('The crash is still being worked out', 1500); return; }
    const cr = c.crash, res = cr.result;
    const units = c.units.map(u => ({ model: u.model === 'player' ? R.player : R.wrecks[u.key], view: cr.unitView(u.u) }));
    for (const U of units) { U.model.group.visible = true; U.model.prepareDestruction(U.view); }
    const cin = Cinematic.fromCrash({ units: res.units.map((u, i) => Object.assign({}, u, { axes: cr.F.unitAxes[i] })), frames: cr.F, T0: res.T0, contact: res.contact }, cr.events);
    replay = { cr, units, cin, t: Math.max(0, res.T0 - 0.15), end: cr.F.t[cr.F.t.length - 1], prevState: state };
    evPending = []; kCur = 0; camAngle = 0.4;
    state = 'replay';
    $('#results').hidden = true; $('#replay-bar').hidden = false;
  }
  function updateReplay(dt, input) {
    const rp = replay, sp = rp.cin.speed(rp.t);
    rp.t = Math.min(rp.end, rp.t + dt * sp);
    FX.setTimeScale(sp);
    showCrashFrame(rp.cr, rp.units, rp.t);
    fireEvents(rp.cr, rp.t);
    camAngle += dt * 0.25;
    R.orbit(PT, camAngle, 7, 1.7, level);
    $('#replay-clock').textContent = `+${Math.round((rp.t - rp.cr.result.T0) * 1000)} ms · ${sp >= 0.995 ? '1×' : '1/' + Math.round(1 / sp) + '×'}`;
    if (rp.t >= rp.end || input.pause || input.start) endReplay();
  }
  function endReplay() {
    for (const U of replay.units) { U.model.clearDestruction(); if (U.model !== R.player) U.model.group.visible = false; }
    state = replay.prevState; replay = null;
    FX.setTimeScale(1);
    $('#replay-bar').hidden = true;
    if (state === 'finished') $('#results').hidden = false;
  }

  // ---------------------------------------------------------------- the finish
  let autopilot = null;
  function finish(t) {
    prog.done = true; prog.time = t;
    autopilot = ai.adopt(me, prog.l > 3.5 ? 5.25 : 1.75, 0.95);
    autopilot.prog = { i: prog.i, s: prog.s, prevS: prog.s, lap: 99, dist: 0, done: true, time: t };
    state = 'finished';
    setTimeout(showResults, 1600);
    toast('Finish', 1500);
  }
  function showResults() {
    const st = standings(), now = simT;
    // unfinished rivals: an estimate from their remaining distance at their average pace
    const rows = st.map((e, i) => {
      let time = e.prog.done ? e.prog.time : now + (level.laps * L - progress(e.prog)) / Math.max(20, progress(e.prog) / Math.max(1, now));
      return { pos: i + 1, name: e.name, you: e.you, car: e.key === 'lexus' ? 'Lexus RX 350' : 'Ford Mustang GT500', time, est: !e.prog.done };
    }).sort((a, b) => a.time - b.time).map((r, i) => Object.assign(r, { pos: i + 1 }));
    const mine = rows.find(r => r.you);
    $('#results-title').textContent = `${ord(mine.pos)} place`;
    $('#results-sub').textContent = `${fmtTime(prog.time)} · best lap ${fmtTime(prog.best)} · ${takedowns} takedown${takedowns === 1 ? '' : 's'}`;
    $('#results-table').innerHTML = '<tr><th></th><th>Driver</th><th>Car</th><th>Time</th></tr>' + rows.map(r =>
      `<tr class="${r.you ? 'you' : ''}"><td>${r.pos}</td><td>${r.name}</td><td>${r.car}</td><td class="mono">${fmtTime(r.time)}${r.est ? ' *' : ''}</td></tr>`).join('');
    $('#results-note').hidden = !rows.some(r => r.est);
    $('#btn-replay').hidden = !crashes.length;
    $('#results').hidden = false;
  }
  $('#btn-again').addEventListener('click', () => location.reload());
  $('#btn-replay').addEventListener('click', () => startReplay(crashes.length - 1));

  // ---------------------------------------------------------------- HUD
  let toastT = 0, chipT = 0;
  function toast(text, ms = 1800) { const el = $('#msg'); el.textContent = text; el.hidden = false; toastT = ms / 1000; }
  function chip(text) { const el = $('#chip'); el.textContent = text; el.hidden = false; chipT = 1.2; }
  const mini = (() => {
    const cv = $('#minimap'), ctx = cv.getContext('2d'), C = level.circuit, B = level.bounds, pad = 10;
    const sc = Math.min((cv.width - 2 * pad) / (B.x1 - B.x0), (cv.height - 2 * pad) / (B.z1 - B.z0));
    const X = (x) => pad + (x - B.x0) * sc, Z = (z) => pad + (z - B.z0) * sc;
    const path = new Path2D();
    for (let i = 0; i <= C.N; i += 4) { const j = i % C.N; if (!i) path.moveTo(X(C.x[j]), Z(C.z[j])); else path.lineTo(X(C.x[j]), Z(C.z[j])); }
    path.closePath();
    return () => {
      ctx.clearRect(0, 0, cv.width, cv.height);
      ctx.lineWidth = 6; ctx.strokeStyle = 'rgba(255,255,255,0.18)'; ctx.stroke(path);
      ctx.lineWidth = 2; ctx.strokeStyle = 'rgba(255,255,255,0.55)'; ctx.stroke(path);
      for (const r of ai.rivals) { const c = r.body.car; ctx.fillStyle = '#' + r.paint.toString(16).padStart(6, '0'); ctx.beginPath(); ctx.arc(X(c.x), Z(c.z), 3.5, 0, 7); ctx.fill(); ctx.strokeStyle = 'rgba(0,0,0,0.6)'; ctx.lineWidth = 1; ctx.stroke(); }
      ctx.fillStyle = '#ff4a3d'; ctx.beginPath(); ctx.arc(X(car.x), Z(car.z), 5, 0, 7); ctx.fill(); ctx.strokeStyle = '#fff'; ctx.lineWidth = 1.5; ctx.stroke();
    };
  })();
  function hud(dt, t) {
    $('#hud-speed').textContent = Math.round(Math.max(0, car.forward) * 3.6);
    $('#hud-gear').textContent = car.reverse ? 'R' : car.gear;
    $('#hud-lap').textContent = `${Math.min(prog.lap, level.laps)} / ${level.laps}`;
    const st = standings(), pos = st.findIndex(e => e.you) + 1;
    $('#hud-pos').innerHTML = `${pos}<small>/${st.length}</small>`;
    $('#hud-time').textContent = fmtTime(prog.done ? prog.time : t);
    $('#hud-best').textContent = fmtTime(prog.best);
    $('#boost-fill').style.width = `${Math.round(boost * 100)}%`;
    $('#boost').classList.toggle('on', car.boosting);
    $('#hud-td').textContent = takedowns;
    if (toastT > 0) { toastT -= dt; if (toastT <= 0) $('#msg').hidden = true; }
    if (chipT > 0) { chipT -= dt; if (chipT <= 0) $('#chip').hidden = true; }
    $('#hud-wrong').hidden = prog.wrong < 1 || state !== 'race';
    mini();
  }

  // ---------------------------------------------------------------- loop
  const sparks = new FX.Particles(R.scene, 2500);
  let acc = 0, last = performance.now(), simT = 0, audio = false, prevSpin = 0, paused = false, held = false;
  let input = { steer: 0, throttle: 0, brake: 0 };
  const testDrive = { throttle: 1 };
  const ctxAI = { traffic, racing: true, player: me, lead: leadOver };
  let stepN = 0;
  // a director (the trailer recorder, tools/race-trailer.js) can drive the player and place the
  // camera; both stay null in the game
  const director = { input: null, camera: null };
  function playerInput() {
    if (director.input) return director.input(STEP);
    if (TEST === 'takedown') return { throttle: 1, steer: simT < 2.8 ? 0.5 : -0.3 };
    if (TEST) return testDrive;
    if (state === 'finished' && autopilot) return ai.drive(autopilot, STEP, ctxAI);
    const want = !!input.boost && boost > 0.01;
    return Object.assign({}, input, { boost: want });
  }
  function frame(now) {
    const dt = Math.min(0.1, (now - last) / 1000); last = now;
    if (TEST) testOut.frames.push([state, Math.round(dt * 1000), crash ? crash.F.t.length : -1, crash ? crash.debris.length : -1]);
    input = RaceInput.poll(dt);
    if (input.any && !audio) { FX.initAudio(); FX.engineStart(); audio = true; }
    if (input.pause && (state === 'race' || state === 'countdown')) { paused = !paused; $('#pause').hidden = !paused; }
    if (state === 'replay') updateReplay(dt, input);
    if (state === 'intro' && (input.start || input.throttle > 0.5)) { state = 'countdown'; $('#intro').hidden = true; }
    const hold = state === 'intro' || state === 'countdown';
    if (hold !== held) { held = hold; me.frozen = hold && !TEST; for (const r of ai.rivals) r.body.frozen = hold; }
    if (!paused && state !== 'replay' && state !== 'intro') {
      if (state === 'race') {
        if (input.camera) R.cam.mode = R.cam.mode === 'chase' ? 'bumper' : 'chase';
        if (input.reset) resetToTrack();
        R.cam.back = !!input.lookBack;
      }
      if (state === 'countdown') {
        const before = Math.ceil(countdown);
        countdown -= dt;
        if (Math.ceil(countdown) !== before && countdown > 0) { toast(String(Math.ceil(countdown)), 900); if (audio) FX.beep(440); }
        if (countdown <= 0) { state = 'race'; simT = 0; toast('Go!', 900); if (audio) FX.beep(880); }
      }
      const scale = slowmo > 0 ? 0.3 : 1;
      if (slowmo > 0) slowmo -= dt;
      if (state !== 'crash') FX.setTimeScale(scale);
      acc += dt * scale;
      while (acc >= STEP) {
        stepN++;
        const racing = state === 'race' || state === 'finished' || state === 'crash';
        ctxAI.racing = racing;
        if (stepN % 4 === 0 && state !== 'countdown') traffic.step(STEP * 4, prog.s, [me].concat(ai.rivals.map(r => r.body)));
        const ev = world.step(STEP, (b) => b === me ? playerInput() : b.rival ? (racing ? ai.drive(b.rival, STEP, ctxAI) : { brake: 1 }) : (b.traffic && !b.kinematic ? { brake: 0.5 } : null));
        if (state === 'race' || state === 'finished' || state === 'crash') simT += STEP;
        acc -= STEP;
        for (const e of ev) handleContact(e);
        if (state === 'race' || state === 'finished') track(simT);
        for (const r of ai.rivals) {
          ai.track(r, simT, level.laps);
          if (r.wreck > 0) { r.wreck -= STEP; if (r.wreck <= 0) ai.respawn(r, r.body.track ? r.body.track.s - 10 : level.start.s); }
          else if (r.stuck > 3) ai.respawn(r, r.body.track ? r.body.track.s : level.start.s);
        }
        // boost: spent while held, filled by driving in the oncoming lanes and by drifting
        if (state === 'race') {
          if (car.boosting) boost = Math.max(0, boost - 0.22 * STEP);
          if (prog.l < -0.6 && car.forward > 20) boost = Math.min(1, boost + 0.07 * STEP);
          if (car.drift > 0.35 && car.speed > 15) boost = Math.min(1, boost + 0.14 * STEP);
          if (stepN % 4 === 0) { nearMisses(); spinOuts(); }
        }
      }
    }
    // the player's car and the camera
    if (state === 'crash') updateCrash(dt, input);
    else if (state !== 'replay') {
      const p = car.pose, spinNow = car.wheels[2].spin;
      R.drawPlayer({ x: p.x, z: p.z, h: p.heading, pitch: car.pitch, roll: car.roll, steer: car.steer }, spinNow - prevSpin);
      prevSpin = spinNow;
      R.follow({ x: p.x, z: p.z, h: p.heading, speed: car.speed, boost: car.boosting }, dt);
    }
    // everyone else (instanced): the street as it was during a crash or replay
    const draws = (state === 'crash' || state === 'replay') && frozenDraw ? frozenDraw : drawStates();
    const slots = { lexus: 0, mustang: 0 };
    for (const d of draws) R.drawCar(d.key, slots[d.key]++, d);
    R.endCars();
    sparks.update(dt);
    sparks.setScale(R.renderer.domElement.height / (2 * Math.tan(R.camera.fov * Math.PI / 360)));
    if (audio && (state === 'race' || state === 'countdown' || state === 'finished')) FX.engineUpdate(car.forward * 3.6, Math.max(car.throttle, input.throttle || 0), state === 'countdown' ? 900 + 4500 * (input.throttle || 0) : car.rpm);
    hud(dt, simT);
    if (director.camera) director.camera(dt, state);
    R.render();
    requestAnimationFrame(frame);
  }
  // what to draw for the other cars
  function drawStates() {
    const out = [];
    const add = (body, key, paint) => { if (body.frozen && state !== 'intro' && state !== 'countdown') return; const c = body.car, p = c.pose; out.push({ key, x: p.x, z: p.z, h: p.heading, pitch: c.pitch, roll: c.roll, steer: c.steer, spins: c.wheels.map(w => w.spin), paint }); };
    for (const r of ai.rivals) add(r.body, r.key, r.paint);
    for (const t of traffic.cars) add(t.body, t.key, t.paint);
    for (const o of extra) add(o.body, o.key, o.paint);
    return out;
  }
  const extra = [];   // scripted test cars
  function handleContact(e) {
    const mine = e.a === me || e.b === me;
    if (TEST && (e.a.rival || (e.b && e.b.rival) || mine && e.vn > 1)) (testOut.contacts = testOut.contacts || []).push([+simT.toFixed(2), e.kind, e.a === me ? 'me' : e.a.rival ? 'rival' : 'x', e.b === me ? 'me' : e.b && e.b.rival ? 'rival' : e.b ? 'x' : 'static', +e.vn.toFixed(1), e.crash]);
    const other = e.a === me ? e.b : e.b === me ? e.a : null;
    if (mine && e.crash && state === 'race') { triggerCrash(e); return; }
    if (mine && other && other.rival) {
      lastHit.set(other.rival, simT);
      // a solid shunt unsettles the rival: a yaw kick away from the hit, and a moment out of control
      if (e.vn > 3 && !(other.rival.stagger > 0)) {
        const r = other.rival, c = r.body.car, side = Math.sign((c.x - car.x) * -Math.sin(c.h) + (c.z - car.z) * Math.cos(c.h)) || 1;
        r.stagger = 0.4 + Math.min(0.6, e.vn * 0.08); r.kick = side * 0.8;
        c.yaw += side * Math.min(2.2, 0.25 * e.vn);
      }
    }
    if (mine && other && other.traffic) other.traffic.touched = true;
    if (mine && e.vn > 2) {
      const pos = [e.x, 0.5, e.z];
      FX.hit(Math.min(4e5, e.J * 40), pos);
      sparks.spawn(e.x, 0.45, e.z, Math.min(60, 8 + e.vn * 3), 'spark', [e.nx * 2 + car.vx * 0.3, 1.5, e.nz * 2 + car.vz * 0.3]);
      RaceInput.rumble(Math.min(1, e.vn / 15), 0.3, 120);
    }
    // a rival wrecked (without wrecking the player): spun out; a takedown if the player hit it just
    // before. A rival the player has just hit wrecks more easily (7 m/s into something, as in Burnout)
    for (const b of [e.a, e.b]) {
      if (!b || !b.rival || b.rival.wreck > 0 || mine) continue;
      const r = b.rival, shoved = lastHit.has(r) && simT - lastHit.get(r) < 2;
      if (!(e.crash || (shoved && e.vn > 7))) continue;
      wreckRival(r, e.x, e.z);
    }
  }
  function wreckRival(r, x, z) {
    const b = r.body;
    {
      r.wreck = 3;
      b.car.yaw += (Math.random() - 0.5) * 6;
      sparks.spawn(x, 0.5, z, 40, 'spark', [0, 0.8, 0]);
      const d = Math.hypot(b.car.x - car.x, b.car.z - car.z);
      if (d < 80) FX.crunch(Math.max(0.3, 1 - d / 80), [x, 0.5, z]);
      if (lastHit.has(r) && simT - lastHit.get(r) < 2 && state === 'race') takedown(r);
    }
  }
  // a rival the player hit that spins out (past 60 degrees, still moving) is wrecked too
  function spinOuts() {
    for (const r of ai.rivals) {
      if (r.wreck > 0 || !lastHit.has(r) || simT - lastHit.get(r) > 2) continue;
      const c = r.body.car;
      if (Math.abs(c.sideSlip) > 1.05 && c.speed > 10) wreckRival(r, c.x, c.z);
    }
  }

  // ---------------------------------------------------------------- scripted tests
  function setupTest() {
    if (TEST === 'wall150') {
      const b = level.buildings.find(o => o.front === 1 && Math.abs(level.wrapDiff(level.nearest(o.x, o.z).s, 420)) < 60) || level.buildings.find(o => o.front === 1);
      const f = level.nearest(b.x, b.z), p = level.poseAt(f.s, -5.25);
      car.place(p.x, p.z, Math.atan2(b.z - p.z, b.x - p.x), 150 / 3.6);
    } else if (TEST === 'takedown') {
      // side by side at 100 km/h, the rival on the kerb side: steer into it, toward the street lights
      const p = level.poseAt(300, 1.75), r = ai.rivals[0], p2 = level.poseAt(300, 5.25);
      car.place(p.x, p.z, p.h, 100 / 3.6); r.body.car.place(p2.x, p2.z, p2.h, 100 / 3.6); r.lane = r.l = r.laneT = 5.25; r.prog.prevS = 300;
    } else if (TEST === 'headon') {
      const p = level.poseAt(360, 1.75), m = RaceCar.create(specs.mustang);
      car.place(p.x, p.z, p.h, 90 / 3.6);
      const q2 = level.poseAt(410, 1.75);
      m.place(q2.x, q2.z, q2.h + Math.PI, 90 / 3.6);
      const body = world.add(m, { kind: 'traffic' });
      body.drive = () => ({ throttle: 0.4 });
      extra.push({ body, key: 'mustang', paint: 0x2b5fa8 });
    }
  }

  async function start() {
    $('#loading').textContent = 'Building the city…';
    const workerMode = RaceCrash.prepare();
    await R.preparePlayer(carKey, specs[carKey], PAINT);
    await R.prepareCars(['lexus', 'mustang'], 48);
    await R.prepareWreck('lexus', specs.lexus);
    await R.prepareWreck('mustang', specs.mustang);
    for (const m of [R.player, R.wrecks.lexus, R.wrecks.mustang]) m.warm(R.renderer, R.camera);
    R.renderer.compile(R.scene, R.camera);
    // draw the particles once too (they draw nothing until the first crash)
    sparks.spawn(car.x, 1, car.z, 4, 'spark'); sparks.update(1e-3); R.render();
    sparks.n = 0; sparks.update(0);
    await workerMode;
    $('#loading').hidden = true;
    if (TEST) setupTest();
    else { $('#intro').hidden = false; }
    requestAnimationFrame((t) => { last = t; frame(t); });
  }
  start().catch((err) => { $('#loading').textContent = 'Could not start: ' + err.message; console.error(err); });

  return { level, world, car, me, R, ai, traffic, director, crashFocus: PT, get simT() { return simT; }, get takedowns() { return takedowns; }, get prog() { return prog; }, get state() { return state; }, get crash() { return crash; }, get crashes() { return crashes; }, get boost() { return boost; }, standings };
})();
