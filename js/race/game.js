/* The Race game: three laps against seven rivals through city traffic.
 *
 * The world steps at 240 Hz (fixed), the screen as fast as the browser draws. Progress round the
 * circuit is the nearest point on its centre line; a lap counts when a car crosses the start line
 * going forward, having been round the rest of the loop. Position is laps plus distance.
 *
 * Boost fills from near misses (passing traffic within 1.2 m), runs in the oncoming lanes, drifting
 * and in the air, slams and takedowns, and is spent holding the boost button. Slams and takedowns follow
 * Burnout 3's rules (rules.js): a slam never wrecks a rival by itself; a full one (side, or a shunt
 * from behind) puts it out of control for a moment, and its wreck within two seconds of your hit is
 * your takedown. A slam takes a little of the rival's boost for you. The aggressive rivals slam you
 * too (ai.js picks their fights): a full one turns your wheel away for a moment, and a crash soon
 * after is that rival's takedown of you, and it becomes your revenge target.
 *
 * The score (score.js) adds points for all of it: near misses in chains, runs in the oncoming
 * lanes, drifting and in the air (paid by the metre), slams, takedowns, lucky escapes and props. A
 * crash loses what isn't banked yet. The results show the breakdown and the best score so far.
 *
 * Crashes: when a hit is hard enough (world.js), the cars go back one step (to just before they
 * touched) and are handed to the full crash solver (crash.js), which runs in the background. The
 * crash camera plays its frames back in slow motion, never ahead of them: the real deformation,
 * parts coming off and glass breaking, within a moment of the impact. Meanwhile the race goes on
 * (the rivals gain time); the camera shows the street as it was. Then the car is put back on the
 * road. Rivals that crash on their own spin out as rigid bodies and rejoin.
 *
 * Before the race, a car-select screen: the garage's cars (js/garage.js), each starting in its signature
 * paint from one palette of eighteen, and each car's performance as measured by driving it (RaceCar.measure).
 * The choice is remembered for the next race in this browser. The motorcycle and the drone crash as
 * rigid bodies (rigs.js) instead of on the crash solver; the drone hops on the handbrake; the tank
 * doesn't crash (it stalls) and races unranked: no place, no best, done when the last rival is.
 *
 * URL: ?car=<key> (the car the select screen starts on: lexus, mustang, civic ...), ?seed=<n> (another city),
 * ?damage=dramatic, ?traffic=0,
 * ?test=wall150|headon|takedown (a scripted crash or takedown at once, results in
 * window.__race.test), ?worker=0, ?touch=1|0 (on-screen buttons on or off; by default on touch screens).
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
  // the crash physics: on the CPU (in a worker) or the GPU (WebGPU); ?solver=gpu, or the select screen's button
  const solverPick = RaceCrash.solverChoice(document.getElementById('btn-solver'));
  FX.recordedChoice(document.getElementById('btn-sfx'));   // recorded or synthesized sound effects

  // the track (?level=, else the player's last pick; scripted runs default to downtown): picking
  // another on the select screen reloads the page with it
  const LEVEL = (() => {
    const want = q.get('level') || (!q.get('test') && !q.has('director') && (() => { try { return localStorage.getItem('race-level'); } catch (e) { return null; } })());
    return CrashLevel.LEVELS[want] ? want : 'downtown';
  })();
  const level = CrashLevel.build({ level: LEVEL, seed: +q.get('seed') || undefined });
  const L = level.length;
  // a touch screen (or ?touch=1): on-screen buttons, and a lighter picture for a phone's GPU
  const TOUCH = q.get('touch') === '1' || (q.get('touch') !== '0' && window.matchMedia && window.matchMedia('(pointer: coarse)').matches);
  if (TOUCH) document.body.classList.add('touch');
  const R = RaceRender.create({ level, container: $('#view'), pixelRatio: TOUCH ? 1 : 1.5, shadowSize: TOUCH ? 1024 : 2048, look: RaceRender.lookFor(level.look), bloom: !TOUCH && level.look !== 'day' });   // the level's time of day
  const world = RaceWorld.create(level);
  const props = RaceProps.create(level);   // street lights, signals, cones, bins ... to knock over
  // the garage's road cars this page loaded (the rivals and traffic drive the Lexus and Mustang)
  const specs = {};
  for (const k of CrashGarage.latticeKeys) if (Veh.specs[k]) specs[k] = Veh.get(k);
  for (const v of CrashGarage.LIST) if (v.type !== 'car' && RaceRigs.spec(v.key)) specs[v.key] = RaceRigs.spec(v.key);
  const DAMAGE = q.get('damage') === 'dramatic' ? 'dramatic' : 'realistic';
  // the car-select screen's cars and paints (sRGB). Scripted runs (?test, ?director: the trailer
  // recorder) always start in the URL's car in red; a player's last choice is remembered.
  const CARS = {};
  for (const v of CrashGarage.LIST) if (v.race && specs[v.key]) CARS[v.key] = v;
  const PAINTS = [
    { name: 'Crimson red', hex: 0xa3161f }, { name: 'Cobalt blue', hex: 0x1d4fa3 }, { name: 'Pearl white', hex: 0xe9e9e6 }, { name: 'Jet black', hex: 0x121315 },
    { name: 'Liquid silver', hex: 0x9ea3a8 }, { name: 'Sunset orange', hex: 0xd9581c }, { name: 'Signal yellow', hex: 0xe6b81e }, { name: 'Racing green', hex: 0x1f6b43 },
  ];
  const SCRIPTED = !!TEST || q.has('director');
  const LEVEL_NOTES = { downtown: 'Towers, hills and three jumps', harbour: 'Flat out past the docks, after dark', hillside: 'Big hills and fast bends at midday' };
  const saved = (() => { if (SCRIPTED) return null; try { return JSON.parse(localStorage.getItem('race-choice')); } catch (e) { return null; } })() || {};
  let carKey = CARS[q.get('car')] ? q.get('car') : CARS[saved.car] ? saved.car : 'lexus';
  // one palette for every car, in one order: the eight, then the garage's signature paints. A car
  // starts in its signature paint (the Lexus and Mustang in red) and keeps the paint picked for it.
  for (const v of CrashGarage.LIST) if (v.paint) PAINTS.push({ name: v.paint.name[0].toUpperCase() + v.paint.name.slice(1), hex: v.paint.hex });
  const homePaint = (key) => Math.max(0, PAINTS.findIndex((p) => CARS[key].paint && p.hex === CARS[key].paint.hex));
  let paintIdx = PAINTS[saved.paint] ? +saved.paint : homePaint(carKey);
  const paintFor = { [carKey]: paintIdx };
  const paintNow = () => PAINTS[paintIdx];

  // ---------------------------------------------------------------- the grid
  // aggr: how readily a rival picks a fight (ai.js), 0 to 1
  const RIVALS = [
    { name: 'Ava Lindqvist', key: 'supra', paint: 0x2b5fa8, skill: 1.0, aggr: 0.5 },
    { name: 'Marco Reyes', key: 'lexus', paint: 0xe0b022, skill: 0.985, aggr: 0.25 },
    { name: 'Kenji Tanaka', key: 'mustang', paint: 0x1f7a4a, skill: 0.975, aggr: 0.8 },
    { name: 'Léa Moreau', key: 'civic', paint: 0xe8e8e6, skill: 0.965, aggr: 0.35 },
    { name: 'Sam Okafor', key: 'trx', paint: 0xd2541e, skill: 0.955, aggr: 0.9 },
    { name: 'Nina Novak', key: 'lexus', paint: 0x111214, skill: 0.945, aggr: 0.45 },
    { name: 'Ravi Mehta', key: 'mustang', paint: 0x6b2c8f, skill: 0.935, aggr: 0.65 },
  ];
  const PLAYER_SLOT = 5;
  const slotPose = (i) => { const s = level.start.s - 8 - Math.floor(i / 2) * 9, lane = i % 2 ? 5.25 : 1.75, p = level.poseAt(s, lane); return { s, lane, x: p.x, z: p.z, h: p.h }; };
  const grid = [];
  for (let i = 0, k = 0; i < 8; i++) if (i !== PLAYER_SLOT) grid.push(Object.assign(slotPose(i), RIVALS[k++]));

  let car = RaceCar.create(specs[carKey]);   // replaced when another car is picked (chooseCar)
  car.arcade = true;                          // the player's handling: drifts, boost kick (vehicle.js)
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
  const rules = RaceRules.create();   // slams, takedowns, doubles, sprees, psyche-outs, revenge
  const score = RaceScore.create();   // points
  const RUNS = [['oncoming', 'Oncoming'], ['drift', 'Drift'], ['air', 'Air']];
  let ooc = null;                     // the player out of control after a rival's full slam: { t, dur, kick }
  function gainBoost(x, label) { boost = Math.min(1, boost + x); if (label) chip(label); }

  // ---------------------------------------------------------------- health
  // Hits wear the car down by how hard they are (RaceWorld.hitDamage: scrapes and nudges are free, a
  // square 47 km/h hit on a wall takes about a fifth); the full crash comes when it runs out, or at
  // once from a hit hard enough to empty it. Back to full after a crash.
  let health = 1, hurtT = 0, hurtAt = -1, hurtD = 0;
  function hurt(d) {
    health = Math.max(0, health - d);
    hurtT = Math.min(1, 0.25 + d * 3);
    // the bar flashes red (an opacity animation: the compositor runs it, nothing is laid out again)
    if ($('#health-flash').animate) $('#health-flash').animate([{ opacity: 0.85 }, { opacity: 0 }], { duration: 400, easing: 'ease-out' });
    if (d > 0.08) chip(`Damage ${Math.round(d * 100)}%`);
  }
  // props knocked over: a sound, sparks or splinters, a little boost for the player; a burst hydrant
  // sprays for a few seconds
  const geysers = [];
  const SPLINTERS = { crate: 'chip', bench: 'chip', tree: 'chip' };
  function propHit(h) {
    const mine = h.body === me, d = Math.hypot(h.x - car.x, h.z - car.z);
    if (d > 90) return;
    const pos = [h.x, h.y, h.z];
    if (h.prop.T.metal) { FX.clank(Math.min(30, h.prop.T.m / 4) * Math.min(1, h.vrel / 12), pos); sparks.spawn(h.x, h.y, h.z, Math.min(18, 3 + Math.round(h.vrel)), 'spark', [0, 0.5, 0]); }
    else { FX.hit(Math.min(8000, h.prop.T.m * h.vrel * 20), pos); if (SPLINTERS[h.type]) sparks.spawn(h.x, h.y, h.z, 10, 'chip', [0, 0.6, 0]); }
    if (h.first && h.type === 'hydrant') geysers.push({ x: h.x, z: h.z, y: level.terrain(h.x, h.z), t: 6 });
    if (mine && h.first && state === 'race') { gainBoost(0.02, null); score.prop(); RaceInput.rumble(0.25, 0.4, 70); }
  }
  function nearMisses() {
    for (const t of traffic.cars) {
      const kind = RaceAI.nearMiss(car, t);
      if (kind) {
        const n = score.nearMiss(kind, simT);   // its place in the chain
        gainBoost(kind === 'oncoming' ? 0.15 : 0.1, (kind === 'oncoming' ? 'Oncoming near miss' : 'Near miss') + (n > 1 ? ` ×${n}` : ''));
        if (!FX.passBy([t.body.car.x, 0.6, t.body.car.z])) FX.hit(1500, [t.body.car.x, 0.6, t.body.car.z]);
      }
    }
  }
  // a takedown that counts (rules.update: half a second after the wreck): { r, psyche, double, spree }.
  // The slow motion and the crunch came at the wreck itself.
  function takedown(td) {
    takedowns++;
    gainBoost(1, null);
    score.takedown(td);
    toast(td.spree >= 3 ? `Takedown spree ×${td.spree}` : td.revenge ? 'Revenge!' : td.double ? 'Double takedown!' : td.psyche ? 'Psyche-out!' : 'Takedown!', 1600);
    RaceInput.rumble(0.8, 0.6, 300);
    if (TEST) (testOut.takedowns = testOut.takedowns || []).push({ t: +simT.toFixed(2), psyche: td.psyche, double: td.double, spree: td.spree, revenge: td.revenge });
  }

  // ---------------------------------------------------------------- crashes
  let state = TEST ? 'race' : 'select', countdown = 3.6, crash = null, crashT = 0, tPlay = 0, kCur = 0, camAngle = 0, evPending = [], crashUnits = [], frozenDraw = null;
  const crashes = [];   // the last two, for replays
  const testOut = (window.__race = { test: null }).test = { frames: [], aheadOfStream: 0 };
  function triggerCrash(e) {
    if (state !== 'race') return;
    if (tdCam) endTakedownCam();
    if (car.kind === 'tracked') { stall(); return; }   // a tank isn't wrecked by a hit: it stalls
    // a takedown not yet counted is lost; a rival that drove into the player just before took them down
    const by = rules.playerCrashed(simT);
    ooc = null;
    score.crashed();   // the chain and runs under way are lost
    const other = e.b && e.b !== me ? e.b : (e.a !== me ? e.a : null);
    // back to the start of this step: just before the cars touched
    world.restore(me, 1);
    if (other) world.restore(other, 1);
    const bodies = other ? [me, other] : [me];
    // a car in the air (off a ramp or a crest) starts the crash in the air: its height over the
    // ground here, its vertical speed and attitude (the solver's ground is flat, drawn at this height)
    const ground = level.groundAt(car.x, car.z).h;
    const units = bodies.map(b => {
      const c = b.car, u = { key: c.key, massKg: c.m, pose: c.pose, velocity: c.originVelocity(), yawRate: c.yaw };
      if (c.air || c.y - ground > 0.05) Object.assign(u, { lift: c.y - ground, vy: c.vy, pitch: c.pitch + c.gPitch, roll: c.roll + c.gRoll });
      return u;
    });
    if (car.spec.rig) {
      // the motorcycle or drone: rigid bodies against the street and the car it hit (held still)
      const B = other && world.box(other);
      crash = RaceRigs.crash({ level, car, W: DestructionWrecks, seed: crashes.length + 3, other: B ? { x: B.x, z: B.z, hx: B.hx, hz: B.hz, angle: Math.atan2(B.uz, B.ux), height: other.top || 1.4 } : null });
      crash.sound = CARS[car.key].sound;   // its own crash recording at the first impact
      crashUnits = [{ body: me, model: R.player, view: crash.unitView(0), paint: paintNow().hex }];
    } else {
      const near = level.collidersNear(e.x, e.z, 32);
      const shapes = { boxes: near.filter(o => o.box).map(o => ({ x: o.x, z: o.z, hx: o.hx, hz: o.hz, angle: o.angle, height: o.height })), cyls: near.filter(o => !o.box).map(o => ({ x: o.x, z: o.z, r: o.r, height: o.height })) };
      crash = RaceCrash.start({ units, world: shapes, duration: 1.6, damage: DAMAGE, solver: solverPick.solver });
      // the solver's ground is flat at 0: the crash is drawn at the ground's height here
      crash.lift = ground;
      crashUnits = bodies.map((b, u) => ({ body: b, model: u === 0 ? R.player : R.wrecks[b.car.key], view: crash.unitView(u), paint: paintOf(b) }));
    }
    crash.impactKmh = e.vn * 3.6;
    crashRec = { cr: crash, units: crashUnits.map((U, u) => ({ key: U.body.car.key, model: U.model === R.player ? 'player' : U.body.car.key, u, paint: U.paint })) };
    noteMoment('crash', { kmh: crash.impactKmh });
    R.setCrashLift(crash.lift); PT.y = crash.lift;
    for (const U of crashUnits) { U.body.frozen = true; if (U.model !== R.player) { U.model.group.visible = true; if (U.paint !== undefined) U.model.setPaint(U.paint); } }
    frozenDraw = drawStates();   // the street as it was, for the crash camera
    state = 'crash'; crashT = 0; tPlay = 0; kCur = 0; evPending = [];
    camAngle = Math.atan2(car.vz, car.vx) + Math.PI * 0.62;
    FX.engineStop();
    FX.setTimeScale(0.25);
    RaceInput.rumble(1, 1, 450);
    $('#crash').hidden = false; $('#crash-skip').hidden = true;
    $('#crash-speed').textContent = `Impact ${Math.round(crash.impactKmh)} km/h` + (by ? ` · taken down by ${by.name}` : '');
    if (TEST) testOut.crashAt = performance.now();
  }
  const PT = { x: 0, z: 0, y: 0 };   // the crash camera's target (y: the ground's height there)
  // slow motion through the impact, back to real time as the wreck settles (since: s after first contact)
  const slowmoAt = (since) => since < 0 ? 0.25 : since < 0.12 ? 0.08 : since < 0.3 ? 0.08 + (since - 0.12) / 0.18 * 0.22 : since < 0.8 ? 0.3 + (since - 0.3) / 0.5 * 0.7 : 1;
  // the tank, worn out: it stops dead for a moment (brakes on), then carries on repaired, a ghost for 2 s
  let stallT = 0;
  function stall() {
    stallT = 1.5; health = 1; me.ghost = 3.5;
    score.crashed();
    toast('Stalled', 1500);
    RaceInput.rumble(0.8, 0.8, 300);
  }
  // play crash frames on the crash's models at time t (frame cursor kept in kCur)
  const kRef = { get k() { return kCur; } };   // the frame the crash camera shows (for the smoke)
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
      const speed = slowmoAt(since);
      const limit = crash.done ? F.t[n - 1] : F.t[n - 3];   // never ahead of the stream (two frames behind)
      const want = tPlay + dt * speed;
      if (want > limit) testOut.aheadOfStream++;
      tPlay = Math.min(want, limit);
      FX.setTimeScale(speed);
      showCrashFrame(crash, crashUnits, tPlay);
      fxScale = speed;
      fireEvents(crash, tPlay, crashUnits, kRef);
      camAngle += dt * 0.35;
      R.orbit(PT, camAngle, 7.5, 1.9, level);
    }
    if (crashT > 1.2) { $('#crash-skip').hidden = false; if (TOUCH) $('#crash-skip').textContent = 'Tap Gas to carry on'; }
    const over = (crash.done && tPlay >= F.t[n - 1] - 1e-6) || (crash.T0 >= 0 && tPlay >= crash.T0 + 1.25);
    if (over || (crashT > 1.2 && (input.start || input.throttle > 0.5))) respawn();
  }
  // where a crashed car's engine bay is in the world now (frame cur.k of its crash view): the engine
  // zone's middle, carried by the cabin's axes (the lattice keeps the cabin rigid); a rig's hull
  function engineBay(U, cur, lift) {
    const S = specs[U.key || U.body.car.key], v = U.view;
    if (S.rig || !U.model.lat) return () => { const a = v.frames.axes[Math.min(cur.k, v.frames.axes.length - 1)]; return a ? [a[0], a[1] + lift + 0.3, a[2]] : null; };
    const E = S.engine, cr = U.model.lat.cabinRest, dx = S.xMin + (E.u0 + E.u1) / 2 - cr[0], dy = Math.min(E.yMax, 0.62 * S.height) - cr[1], dz = -cr[2];
    return () => {
      const a = v.frames.axes[Math.min(cur.k, v.frames.axes.length - 1)];
      if (!a) return null;
      const fx = a[3], fy = a[4], fz = a[5], ux = a[6], uy = a[7], uz = a[8], lx = fy * uz - fz * uy, ly = fz * ux - fx * uz, lz = fx * uy - fy * ux;
      return [a[0] + fx * dx + ux * dy + lx * dz, a[1] + fy * dx + uy * dy + ly * dz + lift, a[2] + fz * dx + uz * dy + lz * dz];
    };
  }
  // smoke from every car in a crash from its first impact, and fire too after a hard one
  function smokeCrash(cr, units, cur, e) {
    const lift = cr.lift || 0, kmh = cr.impactKmh || 0;
    crashSmoke.burst(e.x, e.y + lift, e.z, Math.min(1.6, 0.6 + kmh / 120));
    if (kmh < 30) return;
    for (const U of units) crashSmoke.emit({ pos: engineBay(U, cur, lift), fire: kmh >= (cr.takedown ? 70 : 90) && !specs[U.key || U.body.car.key].rig, size: Math.min(1.4, specs[U.key || U.body.car.key].length / 4.6) });
  }
  function fireEvents(cr, t, units, cur, Q = evPending) {
    const fresh = cr.events.slice(Q.cursor || 0);
    Q.cursor = cr.events.length;
    Q.push(...fresh);
    Q.sort((a, b) => a.t - b.t);
    const lift = cr.lift || 0;   // the crash is drawn at the ground's height there
    while (Q.length && Q[0].t <= t) {
      const e = Q.shift(), y = e.y + lift, pos = [e.x, y, e.z];
      if (e.type === 'first') { if (!FX.crashClip(cr.sound, pos)) FX.crunch(1, pos); sparks.spawn(e.x, y, e.z, 40, 'spark', [0, 0.6, 0]); sparks.spawn(e.x, y, e.z, 16, 'dust'); if (units) smokeCrash(cr, units, cur, e); }
      else if (e.type === 'contact') { if (Math.random() < 0.25) FX.crunch(Math.min(1, e.mag / 3000), pos); if (Math.random() < 0.5) sparks.spawn(e.x, y, e.z, 4, 'spark', [0, 0.3, 0]); }
      else if (e.type === 'detach') { FX.tear(e.mass, pos); FX.clank(e.mass, pos); sparks.spawn(e.x, y, e.z, Math.min(24, 6 + Math.round(e.mass)), 'spark', [0, 0.6, 0]); }
      else if (e.type === 'glass') { FX.glass(e.mass, pos); sparks.spawn(e.x, y, e.z, 12, 'glass'); }
      else if (e.type === 'crack') FX.crack(0.8, pos);
      else if (e.type === 'burst') { FX.blowout(pos); sparks.spawn(e.x, lift + 0.15, e.z, 10, 'dust'); }
    }
  }
  function respawn() {
    crashSmoke.stop();   // the wreck is gone: what's in the air drifts away
    crashes.push({ crash, units: crashUnits.map(U => ({ key: U.body.car.key, model: U.model === R.player ? 'player' : U.body.car.key, u: crashUnits.indexOf(U), paint: U.paint })) });
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
    health = 1;   // repaired
    if (rules.revenge) chip(`Revenge: ${rules.revenge.name}`);
    R.setCrashLift(0); PT.y = 0;
    FX.setTimeScale(1);
    if (audio) FX.engineStart();
    $('#crash').hidden = true;
  }

  // ---------------------------------------------------------------- highlights, filmed by the drone
  // The race is recorded as it's drawn (the cars' poses, the player's crash and a takedown's wreck as
  // frames of their crashes, the props that moved), the last 6 s at a time. A moment (a takedown, the
  // player's crash, a big jump) keeps the 4 s before it and a few after as a clip, at most eight. After
  // the finish the clips play back as the camera crew's drone saw them: following the action from 7 m
  // up, drifting round it, a little unsteady; the crashes smoke again.
  const KEYS = Object.keys(specs), HL_MAX = 8;
  const hlRing = [], clips = [];
  let hlClock = 0, airT = 0, crashRec = null, hl = null;
  function noteMoment(kind, info) {
    if ((SCRIPTED && TEST !== 'takedown') || state === 'select' || state === 'countdown') return;
    const pre = kind === 'jump' ? info.air + 2.2 : 4, post = kind === 'jump' ? 1.6 : kind === 'crash' ? 4.2 : 3.6;
    const title = kind === 'takedown' ? `Takedown · ${info.name}` : kind === 'crash' ? `Your crash · ${Math.round(info.kmh)} km/h` : `Big air · ${info.air.toFixed(1)} s`;
    const pri = { takedown: 3, crash: 2, jump: 1 }[kind];
    const open = clips.find(c => c.end > hlClock - pre);
    if (open) { open.end = Math.max(open.end, hlClock + post); if (pri > open.pri) { open.pri = pri; open.kind = kind; open.title = title; } return; }
    clips.push({ kind, title, pri, start: hlClock - pre, end: hlClock + post, frames: hlRing.filter(f => f.t >= hlClock - pre) });
    if (clips.length > HL_MAX) {   // the least of them goes (the earliest, of the lowest kind)
      let worst = 0; for (let i = 1; i < clips.length; i++) if (clips[i].pri < clips[worst].pri) worst = i;
      clips.splice(worst, 1);
    }
  }
  // what was drawn this frame (dt: real seconds); draws: the other cars
  function recordFrame(dt, draws) {
    if (state !== 'race' && state !== 'crash') return;
    hlClock += dt;
    const f = { t: hlClock, cars: new Float32Array(draws.length * 14), props: null, player: null, td: null };
    draws.forEach((d, i) => {
      const o = 14 * i, sp = d.spins || [0, 0, 0, 0];
      f.cars.set([KEYS.indexOf(d.key), d.x, d.z, d.h, d.pitch || 0, d.roll || 0, d.lift || 0, d.steer || 0, sp[0], sp[1], sp[2], sp[3], d.paint === undefined ? -1 : d.paint, 0], o);
    });
    if (state === 'crash' && crashRec) f.player = { rec: crashRec, t: tPlay };
    else { const p = car.pose; f.player = { x: p.x, z: p.z, h: p.heading, pitch: car.pitch + car.gPitch, roll: (car.kind === 'bike' ? -car.lean : car.roll) + car.gRoll, lift: car.y, steer: car.steer, wheelie: car.wheelie, spin: car.wheels[2].spin }; }
    if (tdCam) f.td = { rec: tdCam.rec, t: tdCam.t };
    for (let i = 0; i < props.list.length; i++) { const pr = props.list[i]; if (pr.dirty) (f.props = f.props || []).push([i, ...pr.p, ...pr.q]); }
    hlRing.push(f);
    while (hlRing.length && hlRing[0].t < hlClock - 6.5) hlRing.shift();
    for (const c of clips) if (c.end >= hlClock && c.frames[c.frames.length - 1] !== f) c.frames.push(f);
    // a big jump: noted on landing
    if (state === 'race') { if (car.air) airT += dt; else { if (airT > 1.0) noteMoment('jump', { air: airT }); airT = 0; } }
  }
  // the crash frame at time t (cur.k kept between calls): [k, k2, s]
  function frameAt(F, t, cur) {
    const n = F.t.length;
    let k = Math.min(cur.k, Math.max(0, n - 2)); while (k > 0 && F.t[k] > t) k--; while (k < n - 2 && F.t[k + 1] <= t) k++; cur.k = k;
    const k2 = Math.min(n - 1, k + 1);
    return [k, k2, F.t[k2] > F.t[k] ? Math.min(1, Math.max(0, (t - F.t[k]) / (F.t[k2] - F.t[k]))) : 0];
  }
  function startHighlights() {
    const list = clips.filter(c => c.frames.length > 10);
    if (!list.length) { toast('Nothing to show yet', 1500); return; }
    for (const c of list) for (const f of c.frames) for (const r of [f.player && f.player.rec, f.td && f.td.rec]) if (r && !r.cr.done) { toast('The crashes are still being worked out', 1500); return; }
    hl = { list, i: -1, prevState: state, saved: new Map() };
    $('#results').hidden = true; $('#hud').hidden = true;
    const bar = $('#replay-bar');
    bar.innerHTML = '<span class="dot"></span>Drone cam · <span id="replay-clock" class="mono"></span>';
    bar.hidden = false;
    FX.engineStop();
    state = 'replay';
    nextClip();
  }
  // the units of a recorded crash, ready to play (models, views, their own event queue and cursor)
  function playRec(rec) {
    if (hl.recs.has(rec)) return hl.recs.get(rec);
    const units = rec.units.map(u => ({ key: u.key, model: u.model === 'player' ? R.player : R.wrecks[u.key], view: rec.cr.unitView(u.u), paint: u.paint }));
    for (const U of units) { if (U.model !== R.player && U.paint !== undefined) U.model.setPaint(U.paint); U.model.prepareDestruction(U.view); }
    const p = { rec, units, Q: [], cur: { k: 0 }, on: false };
    hl.recs.set(rec, p);
    return p;
  }
  function showRec(p, t, focus) {
    const [k, k2, s] = frameAt(p.rec.cr.F, t, p.cur);
    for (const U of p.units) {
      if (U.model !== R.player) U.model.group.visible = true;
      R.deform(U.model, U.view, k, k2, s, t);
      const ax = U.view.frames.axes[k];
      if (ax) { focus.x += ax[0]; focus.y += ax[1] + (p.rec.cr.lift || 0); focus.z += ax[2]; focus.n++; }
    }
    R.setCrashLift(p.rec.cr.lift || 0);
    fireEvents(p.rec.cr, t, p.units, p.cur, p.Q);
    p.on = true;
  }
  function hideRec(p) {
    for (const U of p.units) { U.model.clearDestruction(); if (U.model !== R.player) U.model.group.visible = false; }
    p.on = false; p.cur.k = 0; p.Q.length = 0; p.Q.cursor = 0;
  }
  function endClip() {
    if (!hl || !hl.clip) return;
    for (const p of hl.recs.values()) hideRec(p);
    // the props back where they lie now
    for (const [i, pose] of hl.saved) { const pr = props.list[i]; pr.p = pose[0]; pr.q = pose[1]; pr.dirty = true; }
    hl.saved.clear();
    crashSmoke.clear();
    R.setCrashLift(0);
  }
  function nextClip() {
    endClip();
    hl.i++;
    if (hl.i >= hl.list.length) { endHighlights(); return; }
    const c = hl.clip = hl.list[hl.i];
    hl.recs = new Map(); hl.t = 0; hl.fi = 0; hl.propAt = 0; hl.draws = [];
    // the props this clip moves: back to where they stood (and the live poses kept for after)
    const touched = new Set();
    for (const f of c.frames) if (f.props) for (const q of f.props) touched.add(q[0]);
    for (const i of touched) { const pr = props.list[i]; hl.saved.set(i, [pr.p.slice(), pr.q.slice()]); pr.p = pr.p0.slice(); pr.q = pr.q0.slice(); pr.dirty = true; }
    const p0 = c.frames[0].player;
    const h0 = p0 && p0.h !== undefined ? p0.h : 0;
    hl.drone = { a: h0 + Math.PI + 0.55, pos: null, look: null, alt: 7 };
    crashSmoke.clear();
  }
  function endHighlights() {
    endClip();
    const back = hl.prevState;
    hl = null;
    state = back;
    $('#replay-bar').hidden = true; $('#hud').hidden = false;
    FX.setTimeScale(1);
    if (audio) FX.engineStart();
    if (state === 'finished') $('#results').hidden = false;
  }
  const DV = new THREE.Vector3(), DL = new THREE.Vector3();
  function updateHighlights(dt, input) {
    if (input.pause) { endHighlights(); return; }
    if (input.start) { nextClip(); if (!hl) return; }
    const c = hl.clip, F = c.frames;
    hl.t += dt;
    const ct = F[0].t + hl.t;
    while (hl.fi < F.length - 1 && F[hl.fi + 1].t <= ct) hl.fi++;
    const f = F[hl.fi];
    // the props, as they moved up to now
    for (; hl.propAt <= hl.fi; hl.propAt++) { const g = F[hl.propAt].props; if (g) for (const q of g) { const pr = props.list[q[0]]; pr.p = [q[1], q[2], q[3]]; pr.q = [q[4], q[5], q[6], q[7]]; pr.dirty = true; } }
    // the other cars
    hl.draws.length = 0;
    for (let o = 0; o < f.cars.length; o += 14) {
      const a = f.cars;
      hl.draws.push({ key: KEYS[a[o]], x: a[o + 1], z: a[o + 2], h: a[o + 3], pitch: a[o + 4], roll: a[o + 5], lift: a[o + 6], steer: a[o + 7], spins: [a[o + 8], a[o + 9], a[o + 10], a[o + 11]], paint: a[o + 12] < 0 ? undefined : a[o + 12] });
    }
    // the player's car (or its crash), and a takedown's wreck; what the drone follows
    const focus = { x: 0, y: 0, z: 0, n: 0 };
    let live = new Set();
    if (f.td) { const p = playRec(f.td.rec); showRec(p, f.td.t, focus); live.add(p); }
    if (f.player && f.player.rec) {
      const p = playRec(f.player.rec); const fx = { x: 0, y: 0, z: 0, n: 0 };
      showRec(p, f.player.t, fx); live.add(p);
      if (!focus.n) Object.assign(focus, fx);
    } else if (f.player) {
      const pl = f.player;
      R.drawPlayer({ x: pl.x, z: pl.z, h: pl.h, pitch: pl.pitch, roll: pl.roll, lift: pl.lift, steer: pl.steer, wheelie: pl.wheelie }, pl.spin - (hl.spin === undefined ? pl.spin : hl.spin));
      hl.spin = pl.spin;
      if (!focus.n) { focus.x = pl.x; focus.y = pl.lift; focus.z = pl.z; focus.n = 1; }
    }
    for (const p of hl.recs.values()) if (p.on && !live.has(p)) hideRec(p);
    if (focus.n) { focus.x /= focus.n; focus.y /= focus.n; focus.z /= focus.n; }
    // the drone: drifts round the action, about 13 m off and 7 m up (higher over a building), easing
    // after it like a camera on a quadcopter, with a little sway
    const d = hl.drone, crashing = !!(f.td || (f.player && f.player.rec));
    d.a += dt * (crashing ? 0.16 : 0.08);
    const dist = crashing ? 11 : 13;
    let alt = crashing ? 5.5 : 7;
    const wx = focus.x + Math.cos(d.a) * dist, wz = focus.z + Math.sin(d.a) * dist;
    for (const o of level.collidersNear(wx, wz, 1.5)) if (o.box && o.height) alt = Math.max(alt, o.height + 3 - (focus.y || 0));
    d.alt += (alt - d.alt) * (1 - Math.exp(-dt * 1.5));
    DV.set(wx, (focus.y || 0) + d.alt + Math.sin(hl.t * 1.7) * 0.18, wz);
    DL.set(focus.x, (focus.y || 0) + 0.8, focus.z);
    if (!d.pos) { d.pos = DV.clone(); d.look = DL.clone(); }
    d.pos.lerp(DV, 1 - Math.exp(-dt * 1.4));
    d.look.lerp(DL, 1 - Math.exp(-dt * 3.5));
    R.orbit({ x: focus.x, y: focus.y || 0, z: focus.z }, d.a, dist, d.alt, null);   // (the sun's shadows follow the focus)
    R.camera.position.set(d.pos.x + Math.sin(hl.t * 1.3) * 0.12, d.pos.y, d.pos.z + Math.cos(hl.t * 1.1) * 0.12);
    R.camera.lookAt(d.look);
    R.camera.rotateZ(Math.sin(hl.t * 0.9) * 0.012);
    if (Math.abs(R.camera.fov - 48) > 0.01) { R.camera.fov = 48; R.camera.updateProjectionMatrix(); }
    fxScale = 1;
    $('#replay-clock').textContent = `${c.title} · ${hl.i + 1} of ${hl.list.length} · alt ${Math.round(d.pos.y - (focus.y || 0))} m · ${TOUCH ? 'tap for the next' : 'Enter: next · Esc: close'}`;
    if (ct >= F[F.length - 1].t) nextClip();
  }
  $('#replay-bar').addEventListener('click', () => { if (hl) nextClip(); });

  // ---------------------------------------------------------------- the finish
  let autopilot = null;
  function finish(t) {
    prog.done = true; prog.time = t;
    score.finish(t);
    car.arcade = false;   // the rivals' driver takes over: plain handling (it brakes and steers at once)
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
      return { pos: i + 1, name: e.name, you: e.you, car: CARS[e.key].name, time, est: !e.prog.done };
    }).sort((a, b) => a.time - b.time).map((r, i) => Object.assign(r, { pos: i + 1 }));
    const mine = rows.find(r => r.you);
    $('#results-title').textContent = unranked() ? 'Unranked' : `${ord(mine.pos)} place`;
    if (unranked()) { mine.pos = '–'; rows.forEach((r, i) => { if (!r.you) r.pos = rows.filter(q => !q.you).indexOf(r) + 1; }); }
    $('#results-sub').textContent = `${fmtTime(prog.time)} · best lap ${fmtTime(prog.best)} · ${takedowns} takedown${takedowns === 1 ? '' : 's'}`;
    $('#results-table').innerHTML = '<tr><th></th><th>Driver</th><th>Car</th><th>Time</th></tr>' + rows.map(r =>
      `<tr class="${r.you ? 'you' : ''}"><td>${r.pos}</td><td>${r.name}</td><td>${r.car}</td><td class="mono">${fmtTime(r.time)}${r.est ? ' *' : ''}</td></tr>`).join('');
    $('#results-note').hidden = !rows.some(r => r.est);
    // the score: its breakdown, and the best so far in this browser (not for scripted runs)
    let best = null;
    // each track keeps its own best (downtown under the original key)
    const bestKey = LEVEL === 'downtown' ? 'race-best' : 'race-best-' + LEVEL;
    if (!SCRIPTED && !unranked()) try { best = +localStorage.getItem(bestKey) || 0; if (score.score > best) localStorage.setItem(bestKey, String(score.score)); } catch (e) { best = null; }
    const fmt = (n) => n.toLocaleString('en-US');
    $('#results-score').innerHTML = `<h3>Score ${fmt(score.score)}${best === null ? '' : score.score > best ? ' · a new best' : ` · best ${fmt(best)}`}</h3>` +
      `<table>${score.breakdown().map(b => `<tr><td>${b.label}</td><td class="n">×${b.n}</td><td class="p">${fmt(b.pts)}</td></tr>`).join('')}</table>`;
    $('#btn-replay').hidden = !clips.some(c => c.frames.length > 10);
    $('#results').hidden = false;
  }
  // racing again: the page again, straight into the race with the same car and track (?go), or to the
  // car and track select (once the music has faded out)
  const reloadTo = (race) => { const u = new URL(location.href); if (race) u.searchParams.set('go', '1'); else u.searchParams.delete('go'); Music.leave(() => { location.href = u.toString(); }); };
  $('#btn-again').addEventListener('click', () => reloadTo(true));
  $('#btn-change').addEventListener('click', () => reloadTo(false));
  $('#btn-replay').addEventListener('click', () => startHighlights());

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
      // the revenge target: a red ring
      if (rules.revenge) { const c = rules.revenge.body.car; ctx.strokeStyle = '#e6281e'; ctx.lineWidth = 2; ctx.beginPath(); ctx.arc(X(c.x), Z(c.z), 7, 0, 7); ctx.stroke(); }
      ctx.fillStyle = '#ff4a3d'; ctx.beginPath(); ctx.arc(X(car.x), Z(car.z), 5, 0, 7); ctx.fill(); ctx.strokeStyle = '#fff'; ctx.lineWidth = 1.5; ctx.stroke();
    };
  })();
  function hud(dt, t) {
    $('#hud-speed').textContent = Math.round(Math.max(0, car.forward) * 3.6);
    $('#hud-gear').textContent = car.reverse ? 'R' : car.gear;
    $('#hud-lap').textContent = `${Math.min(prog.lap, level.laps)} / ${level.laps}`;
    const st = standings(), pos = st.findIndex(e => e.you) + 1;
    $('#hud-pos').innerHTML = unranked() ? '–' : `${pos}<small>/${st.length}</small>`;
    $('#hud-time').textContent = fmtTime(prog.done ? prog.time : t);
    $('#hud-best').textContent = fmtTime(prog.best);
    $('#boost-fill').style.width = `${Math.round(boost * 100)}%`;
    $('#boost').classList.toggle('on', car.boosting);
    $('#health-fill').style.width = `${Math.round(health * 100)}%`;
    const hc = 'health' + (health > 0.5 ? '' : health > 0.25 ? ' low' : ' critical');
    if ($('#health').className !== hc) $('#health').className = hc;
    if (hurtT > 0) hurtT = Math.max(0, hurtT - dt * 1.8);
    $('#hurt').style.opacity = hurtT.toFixed(3);
    $('#hud-td').textContent = takedowns;
    const sc = score.score.toLocaleString('en-US');
    if ($('#hud-score').textContent !== sc) $('#hud-score').textContent = sc;
    // the runs under way (past their minimum) and the near-miss chain
    const combo = RUNS.filter(([k]) => score.run(k) > 0).map(([k, l]) => `${l} ${Math.round(score.run(k))} m`).concat(score.chain > 1 ? [`Near miss ×${score.chain}`] : []).join(' · ');
    if ($('#combo').textContent !== combo) $('#combo').textContent = combo;
    if ($('#combo').hidden === !!combo) $('#combo').hidden = !combo;
    if (toastT > 0) { toastT -= dt; if (toastT <= 0) $('#msg').hidden = true; }
    if (chipT > 0) { chipT -= dt; if (chipT <= 0) $('#chip').hidden = true; }
    $('#hud-wrong').hidden = prog.wrong < 1 || state !== 'race';
    const canPause = state === 'race' || state === 'countdown';
    if ($('#btn-menu').hidden === canPause) $('#btn-menu').hidden = !canPause;
    revengeTag();
    mini();
  }
  // the revenge target's tag, over its car while it's in view (within 160 m)
  const tagAt = new THREE.Vector3();
  function revengeTag() {
    const rv = rules.revenge, el = $('#revenge-tag');
    let show = false;
    if (rv && !(rv.wreck > 0) && state === 'race') {
      const c = rv.body.car, cv = R.renderer.domElement;
      tagAt.set(c.x, c.y + 2.1, c.z).project(R.camera);
      if (tagAt.z < 1 && Math.abs(tagAt.x) < 1 && Math.abs(tagAt.y) < 1 && Math.hypot(c.x - car.x, c.z - car.z) < 160) {
        show = true;
        el.style.transform = `translate(${((tagAt.x + 1) / 2 * cv.clientWidth).toFixed(1)}px, ${((1 - tagAt.y) / 2 * cv.clientHeight).toFixed(1)}px) translate(-50%, -100%)`;
      }
    }
    if (el.hidden === show) el.hidden = !show;
  }

  // ---------------------------------------------------------------- car select
  // The car waits just past the start line, clear of the grid, facing the camera (for the trailer
  // recorder it stays on the grid). A model is made the first time its car is picked; until
  // it's ready the start button waits.
  const show = level.poseAt(level.start.s + 10, 3.5);
  const DRIVE = { AWD: 'all-wheel', RWD: 'rear-wheel', FWD: 'front-wheel', thrust: 'rotor', tracked: 'six-wheel' };
  const BARS = [   // [label, fill 0-1 from the measured figures, value]
    ['Top speed', (p) => (p.top - 60) / 240, (p) => `${Math.round(p.top)} km/h`],
    ['0–100 km/h', (p) => p.t100 < 0 ? 0 : (10 - p.t100) / 7, (p) => p.t100 < 0 ? '–' : `${p.t100.toFixed(1)} s`],
    ['100–0 km/h', (p) => (50 - p.stop100) / 20, (p) => `${p.stop100.toFixed(1)} m`],
    ['Cornering', (p) => (p.lateralG - 0.6) / 0.6, (p) => `${p.lateralG.toFixed(2)} g`],
  ];
  let selRow = 0, selToken = 0, selBusy = false, selT = 0, lineup = null;
  const perfs = {};   // measured when a car is first shown (about 0.1 s each)
  const perfOf = (key) => perfs[key] || (perfs[key] = RaceCar.measure(specs[key]));
  const driveOf = (key) => { const S = specs[key], t = S.tune || RaceCar.TUNE[key]; return S.rig === 'hover' ? 'thrust' : S.rig === 'tracked' ? 'tracked' : t.drive[0] > 0 && t.drive[1] > 0 ? 'AWD' : t.drive[1] > 0 ? 'RWD' : 'FWD'; };
  const unranked = () => CARS[carKey].race === 'unranked';
  function placeForSelect() { const p = q.has('director') ? ps : show; car.place(p.x, p.z, p.h, 0); }
  function buildSelect() {
    // the garage lineup (garageui.js): each car's side view, all to one scale, in its signature paint
    lineup = GarageUI.lineup($('#sel-lineup'), Object.keys(CARS).map((k) => ({ key: k, name: CARS[k].name, paint: CARS[k].paint ? CARS[k].paint.hex : PAINTS[0].hex, phys: (window.CAR_PHYS || {})[k] || (window.RIG_PHYS || {})[k] })),
      (k) => { selRow = 0; chooseCar(k); });
    buildSwatches();
    $('#sel-bars').innerHTML = BARS.map(([k], i) => `<div class="bar"><span class="k">${k}</span><span class="track"><i id="bar-${i}"></i></span><span class="val" id="bar-v${i}"></span></div>`).join('');
    $('#sel-levels').innerHTML = Object.entries(CrashLevel.LEVELS).map(([k, D]) => `<button type="button" class="sel-car sel-level" role="radio" data-level="${k}"><b>${D.name}</b><span>${LEVEL_NOTES[k]}</span></button>`).join('');
    document.querySelectorAll('.sel-level').forEach((b) => b.addEventListener('click', () => { b.blur(); pickLevel(b.dataset.level); }));
    $('#btn-start').addEventListener('click', () => { $('#btn-start').blur(); startRace(); });
  }
  // the touch screen's handbrake button: the drone hops with it
  function hopLabel() { const b = document.querySelector('#touch .t-hand'); if (b) b.textContent = car.kind === 'hover' ? 'Hop' : 'Drift'; }
  // the paint swatches, in two rows
  function buildSwatches() {
    $('#sel-swatches').innerHTML = PAINTS.map((p, i) => `<button type="button" class="swatch" role="radio" data-i="${i}" title="${p.name}" aria-label="${p.name}" style="background: #${p.hex.toString(16).padStart(6, '0')}"></button>`).join('');
    $('#sel-swatches').style.gridTemplateColumns = `repeat(${Math.ceil(PAINTS.length / 2)}, 1fr)`;
    document.querySelectorAll('.swatch').forEach((b) => b.addEventListener('click', () => { b.blur(); selRow = 1; pickPaint(+b.dataset.i); }));
  }
  function showSelect() {
    lineup.select(carKey);
    document.querySelectorAll('.sel-level').forEach((b) => b.setAttribute('aria-checked', String(b.dataset.level === LEVEL)));
    document.querySelectorAll('.swatch').forEach((b, i) => b.setAttribute('aria-checked', String(i === paintIdx)));
    document.querySelectorAll('.sel-row').forEach((r) => r.classList.toggle('focus', +r.dataset.row === selRow));
    $('#sel-paint-name').textContent = paintNow().name;
    const p = perfOf(carKey);
    GarageUI.card($('#sel-card'), CARS[carKey], p);
    BARS.forEach(([, fill, value], i) => { $('#bar-' + i).style.width = `${Math.round(100 * Math.max(0.04, Math.min(1, fill(p))))}%`; $('#bar-v' + i).textContent = value(p); });
    $('#sel-specs').innerHTML = [['Power', `${Math.round(p.powerKW)} kW · ${Math.round(p.powerKW * 1.341)} hp`], ['Weight', `${Math.round(p.massKg).toLocaleString('en-US')} kg`],
      ['Drive', DRIVE[p.drive]], ['Gearbox', p.gears > 1 ? `${p.gears}-speed automatic` : 'single speed'], ['Top speed with boost', `${Math.round(p.topBoost)} km/h`]].map(([k, v]) => `<dt>${k}</dt><dd>${v}</dd>`).join('');
    $('#btn-start').disabled = selBusy;
  }
  async function chooseCar(key) {
    if (!specs[key] || (key === carKey && !selBusy)) return;
    const token = ++selToken;
    carKey = key;
    paintIdx = key in paintFor ? paintFor[key] : homePaint(key);
    car = RaceCar.create(specs[key]);
    car.arcade = true;
    me.car = car;
    world.respec(me);
    hopLabel();
    placeForSelect();
    selBusy = true; showSelect();
    FX.ui('move'); voiceFor(key);
    // a model not made yet waits for the pick to settle (stepping through the lineup doesn't decode each)
    if (!R.hasModel(key)) { await new Promise((r) => setTimeout(r, 250)); if (token !== selToken) return; }
    await R.preparePlayer(key, specs[key], paintNow().hex);
    if (token !== selToken) return;   // another car was picked meanwhile
    R.player.setPaint(paintNow().hex);
    selBusy = false; showSelect();
    FX.garage(CARS[key].sound);   // its engine starting or revving, if it has a recording
  }
  // the engine's recordings and rev range (fx.js): idle, redline, top speed (km/h, for the tank's tracks)
  function voiceFor(key) {
    const S = specs[key], t = S.tune || RaceCar.TUNE[key];
    FX.engineVoice(CARS[key].sound, S.rig === 'hover' ? 3000 : S.rig === 'tracked' ? 700 : 900, t.redline, t.vmax ? t.vmax * 3.6 : 250);
  }
  function pickPaint(i) {
    const n = PAINTS.length;
    FX.ui('pick');
    paintIdx = paintFor[carKey] = (i + n) % n;
    if (!selBusy) R.player.setPaint(paintNow().hex);   // else chooseCar paints the new model
    showSelect();
  }
  // another track: the page again with ?level= (the car and paint kept), once the music has faded out
  // (the menu song picks up where it was)
  function pickLevel(key) {
    if (key === LEVEL || !CrashLevel.LEVELS[key] || state !== 'select') return;
    FX.ui('move');
    try { localStorage.setItem('race-level', key); localStorage.setItem('race-choice', JSON.stringify({ car: carKey, paint: paintIdx })); } catch (e) { /* not remembered */ }
    const u = new URL(location.href); u.searchParams.set('level', key); Music.leave(() => { location.href = u.toString(); });
  }
  function updateSelect(inp) {
    if (inp.nav.y) { selRow = (selRow + inp.nav.y + 3) % 3; showSelect(); FX.ui('move'); }
    if (inp.nav.x && selRow === 0) { const keys = Object.keys(CARS); chooseCar(keys[(keys.indexOf(carKey) + inp.nav.x + keys.length) % keys.length]); }
    else if (inp.nav.x && selRow === 2) { const keys = Object.keys(CrashLevel.LEVELS); pickLevel(keys[(keys.indexOf(LEVEL) + inp.nav.x + keys.length) % keys.length]); }
    else if (inp.nav.x) pickPaint(paintIdx + inp.nav.x);
    if (inp.start) startRace();
  }
  function startRace() {
    if (state !== 'select' || selBusy) return;
    FX.ui('ok');
    if (!SCRIPTED) { try { localStorage.setItem('race-choice', JSON.stringify({ car: carKey, paint: paintIdx })); } catch (e) { /* not remembered (private window) */ } }
    car.place(ps.x, ps.z, ps.h, 0);
    state = 'countdown';
    $('#select').hidden = true; $('#hud').hidden = false;
  }

  // ---------------------------------------------------------------- touch screens
  const upright = window.matchMedia('(orientation: portrait)');
  if (TOUCH) {
    RaceInput.bindTouch($('#touch'));
    // the first touch also starts the sound (phones only allow it inside a tap)
    window.addEventListener('pointerdown', () => { if (!audio) { FX.initAudio(); FX.engineStart(); audio = true; } });
    // full screen (and landscape, where the browser allows it): Android Chrome; not iPhone Safari
    if (document.fullscreenEnabled) {
      $('#btn-full').hidden = false;
      $('#btn-full').addEventListener('click', () => {
        if (document.fullscreenElement) { document.exitFullscreen(); return; }
        document.documentElement.requestFullscreen({ navigationUI: 'hide' }).then(() => screen.orientation && screen.orientation.lock && screen.orientation.lock('landscape')).catch(() => {});
      });
    }
  }
  // the pause menu (Esc, P, the controller's Menu button, the HUD's menu button or a phone's II):
  // carry on, restart, quit to the select screen, or leave for the other game mode or home
  function setPaused(on) { paused = on; $('#pause').hidden = !on; if (on) RaceInput.menuReset(); FX.ui('back'); }
  $('#btn-resume').addEventListener('click', () => { if (upright.matches && TOUCH) return; setPaused(false); });
  $('#btn-restart').addEventListener('click', () => reloadTo(true));
  $('#btn-quit').addEventListener('click', () => reloadTo(false));
  $('#btn-menu').addEventListener('click', () => { if (state === 'race' || state === 'countdown') setPaused(true); });
  // a clicked button lets go of the keyboard focus (Enter or Space would press it again)
  document.querySelectorAll('#pause .btn, #results .btn, #btn-menu').forEach((b) => b.addEventListener('click', () => b.blur()));

  // ---------------------------------------------------------------- loop
  const sparks = new FX.Particles(R.scene, 2500);
  const crashSmoke = RaceSmoke.create(R.scene);   // smoke and fire from crashed cars (smoke.js)
  let fxScale = 1;   // how fast the smoke runs: slow motion slows it
  let acc = 0, last = performance.now(), simT = 0, audio = false, prevSpin = 0, paused = false, held = false;
  let input = { steer: 0, throttle: 0, brake: 0 };
  const testDrive = { throttle: 1 };
  // rivals may attack (ai.js) once the race is 10 s old, two at a time, not while the player is a ghost
  const ctxAI = { traffic, racing: true, player: me, lead: leadOver,
    attack: (r) => state === 'race' && simT > 10 && !me.ghost && ai.rivals.filter(o => o !== r && ai.attacking(o)).length < 2 };
  let stepN = 0;
  // a director (the trailer recorder, tools/race-trailer.js) can drive the player and place the
  // camera; both stay null in the game
  const director = { input: null, camera: null };
  function playerInput() {
    if (director.input) return director.input(STEP);
    if (TEST === 'takedown') return { throttle: 1, steer: simT < 1.2 ? 0.5 : -0.5 };   // shove, then pull away
    if (tdCam) return { throttle: 0.4 };   // watching a takedown: the car holds its line
    if (TEST) return testDrive;
    if (state === 'finished' && autopilot) return ai.drive(autopilot, STEP, ctxAI);
    if (stallT > 0) { stallT -= STEP; return { brake: 1 }; }
    const want = !!input.boost && boost > 0.01, inp = Object.assign({}, input, { boost: want });
    // fully slammed by a rival: the wheel turns away from the hit, all of it for 0.3 s, then handed back
    if (ooc) {
      ooc.t += STEP;
      const k = ooc.t < 0.3 ? 1 : Math.max(0, 1 - (ooc.t - 0.3) / (ooc.dur - 0.3));
      inp.steer = (inp.steer || 0) * (1 - k) + ooc.kick * k;
      inp.ooc = ooc.t < 0.3;   // and no stability control at first
      if (ooc.t >= ooc.dur) ooc = null;
    }
    return inp;
  }
  const earDir = new THREE.Vector3();
  function frame(now) {
    const dt = Math.min(0.1, (now - last) / 1000); last = now;
    if (TEST) testOut.frames.push([state, Math.round(dt * 1000), crash ? crash.F.t.length : -1, crash ? crash.debris.length : -1]);
    input = RaceInput.poll(dt);
    if (input.any && !audio) { FX.initAudio(); FX.engineStart(); audio = true; }
    if (input.pause && (state === 'race' || state === 'countdown')) setPaused(!paused);
    else if (paused) RaceInput.menu($('#pause'), input);   // arrows or the d-pad, Enter or A
    else if (state === 'finished' && !$('#results').hidden) RaceInput.menu($('#results'), input);
    // touch: the buttons while racing; a phone held upright pauses the race (and asks to turn it)
    if (TOUCH) {
      const show = state === 'countdown' || state === 'race' || state === 'crash';
      if ($('#touch').hidden === show) $('#touch').hidden = !show;
      if (upright.matches && (state === 'race' || state === 'countdown') && !paused) setPaused(true);
    }
    // the music (js/music.js): the menu song on the select screen, the track's own song from the
    // countdown, the results song at the finish; quieter and muffled while paused or in the crash camera
    const ms = state === 'replay' ? hl.prevState : state, muffle = paused || state === 'crash';
    Music.play(ms === 'select' ? 'menu' : ms === 'finished' ? 'results' : 'race:' + LEVEL);
    Music.preload('race:' + LEVEL, 'results');
    Music.duck(paused ? 0.35 : muffle ? 0.5 : 1, muffle);
    if (state === 'replay') updateHighlights(dt, input);
    if (state === 'select') updateSelect(input);
    const hold = state === 'select' || state === 'countdown';
    if (hold !== held) { held = hold; me.frozen = hold && !TEST; for (const r of ai.rivals) r.body.frozen = hold; }
    if (!paused && state !== 'replay' && state !== 'select') {
      if (state === 'race') {
        if (input.camera) R.cam.mode = R.cam.mode === 'chase' ? 'cockpit' : 'chase';
        if (input.reset) resetToTrack();
        R.cam.back = !!input.lookBack;
      }
      if (state === 'countdown') {
        const before = Math.ceil(countdown);
        countdown -= dt;
        if (Math.ceil(countdown) !== before && countdown > 0) { toast(String(Math.ceil(countdown)), 900); if (audio) FX.count(false); }
        if (countdown <= 0) { state = 'race'; simT = 0; toast('Go!', 900); if (audio) FX.count(true); }
      }
      const scale = tdCam ? 0.03 : slowmo > 0 ? 0.3 : 1;
      if (slowmo > 0) slowmo -= dt;
      if (state !== 'crash' && !tdCam) { FX.setTimeScale(scale); fxScale = scale; }
      acc += dt * scale;
      while (acc >= STEP) {
        stepN++;
        const racing = state === 'race' || state === 'finished' || state === 'crash';
        ctxAI.racing = racing;
        if (stepN % 4 === 0 && state !== 'countdown') traffic.step(STEP * 4, prog.s, [me].concat(ai.rivals.map(r => r.body)));
        const ev = world.step(STEP, (b) => b === me ? playerInput() : b.rival ? (racing ? ai.drive(b.rival, STEP, ctxAI) : { brake: 1 }) : b.drive ? b.drive() : (b.traffic && !b.kinematic ? { brake: 0.5 } : null));
        if (state === 'race' || state === 'finished' || state === 'crash') simT += STEP;
        acc -= STEP;
        for (const e of ev) handleContact(e);
        for (const h of props.step(STEP, world.bodies)) propHit(h);
        if (state === 'race' || state === 'finished') track(simT);
        for (const r of ai.rivals) {
          ai.track(r, simT, level.laps);
          if (r.wreck > 0) { r.wreck -= STEP; if (r.wreck <= 0) ai.respawn(r, r.body.track ? r.body.track.s - 10 : level.start.s); }
          else if (r.stuck > 3) ai.respawn(r, r.body.track ? r.body.track.s : level.start.s);
        }
        // the tank's race is over when the last rival's is (three laps at 72 km/h would take minutes)
        if (state === 'race' && unranked() && ai.rivals.length && ai.rivals.every(r => r.prog.done)) finish(simT);
        // boost: spent while held, filled by runs in the oncoming lanes, drifting and in the air (by
        // the metre, once each is long enough: score.js), which score when they end
        if (state === 'race') {
          if (car.boosting) boost = Math.max(0, boost - 0.22 * STEP);
          const on = { oncoming: prog.l < -0.6 && car.forward > 20, drift: (car.mode === 'drift' || car.drift > 0.35) && car.speed > 15, air: car.air };
          for (const [kind, label] of RUNS) {
            const r = score.step(kind, on[kind], car.speed * STEP);
            if (r.boost) boost = Math.min(1, boost + r.boost);
            if (r.banked) chip(`${label} +${r.banked}`);
          }
          const ch = score.update(simT);
          if (ch && ch.n > 1) chip(`Near-miss chain ×${ch.n} +${ch.pts}`);
          if (stepN % 4 === 0) {
            nearMisses(); spinOuts();
            for (const r of ai.rivals) if (!(r.wreck > 0)) rules.tail(me, r, simT);   // for psyche-outs
          }
          for (const u of rules.update(simT)) {
            if (u.kind === 'takedown') takedown(u);
            else if (u.kind === 'lucky') { chip('Lucky escape'); score.lucky(); }
            else { chip('Takedown denied'); if (TEST) testOut.denied = (testOut.denied || 0) + 1; }
          }
        }
      }
    }
    // the player's car and the camera
    if (tdCam && state !== 'race' && state !== 'finished') endTakedownCam();
    if (state === 'crash') updateCrash(dt, input);
    else if (state !== 'replay') {
      const p = car.pose, spinNow = car.wheels[2].spin;
      R.drawPlayer({ x: p.x, z: p.z, h: p.heading, pitch: car.pitch + car.gPitch, roll: (car.kind === 'bike' ? -car.lean : car.roll) + car.gRoll, lift: car.y, steer: car.steer, wheelie: car.wheelie, car }, spinNow - prevSpin);
      prevSpin = spinNow;
      // the car faces the camera: a front three-quarter view, swaying 3-37 degrees off the nose
      if (state === 'select') { selT += dt; R.orbit({ x: car.x, z: car.z, y: car.y }, car.h + 0.35 + 0.3 * Math.sin(selT * 0.35), 6.4 * Math.max(1, specs[carKey].length / 4.86), 1.5, level); }
      else if (tdCam) updateTakedownCam(dt, input);
      else {
        R.follow({ x: p.x, z: p.z, h: p.heading, y: car.y, speed: car.speed, boost: car.boosting, size: [specs[carKey].length, specs[carKey].height], eye: eyeOf(carKey), pitch: car.pitch + car.gPitch, roll: (car.kind === 'bike' ? -car.lean : car.roll) + car.gRoll }, dt);
        // the boost's first surge widens the view a little more (the camera keeps its own smoothed
        // field of view, which it puts back next frame)
        if (car.kick > 0) { R.camera.fov += 5 * car.kick; R.camera.updateProjectionMatrix(); }
      }
    }
    R.cockpit(R.cam.mode === 'cockpit' && !tdCam && (state === 'race' || state === 'countdown' || state === 'finished'));
    crashSmoke.update(dt * fxScale);
    // everyone else (instanced): the street as it was during a crash or replay
    const draws = state === 'replay' ? (hl ? hl.draws : []) : state === 'crash' && frozenDraw ? frozenDraw : drawStates();
    recordFrame(dt, draws);
    const slots = {};
    for (const d of draws) { slots[d.key] = slots[d.key] || 0; R.drawCar(d.key, slots[d.key]++, d); }
    R.endCars();
    // head and tail lights glowing at dusk and at night (everyone's, the player's too, but not in a crash)
    const glow = [];
    const lamps = (key, x, z, h, y) => {
      const L = lampsOf(key), c = Math.cos(h), s = Math.sin(h), f = L.xh, b = L.xt;
      for (const sd of [-1, 1]) {
        glow.push({ x: x + c * f - s * sd * L.wh, y: y + L.yh, z: z + s * f + c * sd * L.wh, r: 1, g: 0.9, b: 0.72 });
        glow.push({ x: x + c * b - s * sd * L.wt, y: y + L.yt, z: z + s * b + c * sd * L.wt, r: 0.95, g: 0.08, b: 0.04 });
      }
    };
    if (level.look !== 'day') {
      for (const d of draws) lamps(d.key, d.x, d.z, d.h, d.lift || 0);
      if (state !== 'crash' && state !== 'replay') { const p = car.pose; lamps(carKey, p.x, p.z, p.heading, car.y); }
    }
    R.carLights(glow);
    // burst hydrants spray for a few seconds
    for (let i = geysers.length - 1; i >= 0; i--) {
      const g = geysers[i];
      g.t -= dt;
      if (g.t <= 0) { geysers.splice(i, 1); continue; }
      sparks.spawn(g.x, g.y + 0.2, g.z, Math.max(1, Math.round(60 * dt * Math.min(1, g.t / 2))), 'water', [0, 4, 0]);
    }
    sparks.update(dt);
    R.drawProps();
    sparks.setScale(R.renderer.domElement.height / (2 * Math.tan(R.camera.fov * Math.PI / 360)));
    if (audio && (state === 'race' || state === 'countdown' || state === 'finished')) FX.engineUpdate(car.forward * 3.6, Math.max(car.throttle, input.throttle || 0), state === 'countdown' ? 900 + 4500 * (input.throttle || 0) : car.rpm);
    hud(dt, simT);
    if (director.camera) director.camera(dt, state);
    FX.listen(R.camera.position, R.camera.getWorldDirection(earDir), R.camera.up);   // positioned sounds are heard from the camera
    R.render();
    requestAnimationFrame(frame);
  }
  // the driver's eyes, in the car's frame: about 0.6 m over the H-point (a little ahead of it: the view
  // leans over the dash the models don't have); the rider's helmet; the commander, in the turret hatch
  const eyeOf = (key) => {
    const S = specs[key];
    if (S.rig === 'bike') return [-0.1, 1.5, 0];
    if (S.rig) return [0.4, S.height - 0.15, -0.3];
    const H = S.hPoint || [-0.25, 0.6, -0.37];
    return [H[0] + 0.15, H[1] + 0.62, H[2]];
  };
  // where a car's head and tail lamps glow: on its lamp parts (just off the front of the headlamp and the
  // back of the tail lamp, at their height and spread), or a rig's lamp points
  const lampCache = {};
  function lampsOf(key) {
    if (lampCache[key]) return lampCache[key];
    const S = specs[key], part = (n) => S.parts.find((p) => p.name === n);
    if (S.rig) { const h = S.lamps.head[0], t = S.lamps.tail[0]; return (lampCache[key] = { xh: h[0], xt: t[0], yh: h[1], yt: t[1], wh: Math.abs(h[2]), wt: Math.abs(t[2]) }); }
    const H = part('BRITTLE_LightHR'), T = part('BRITTLE_LightTR');
    const mid = (p, i) => (p.lo[i] + p.hi[i]) / 2;
    return (lampCache[key] = !H || !T ? { xh: S.xMin + S.length - 0.15, xt: S.xMin + 0.1, yh: 0.7, yt: 0.86, wh: S.width / 2 - 0.32, wt: S.width / 2 - 0.32 }
      : { xh: H.hi[0] + 0.02, xt: T.lo[0] - 0.02, yh: mid(H, 1), yt: mid(T, 1), wh: Math.min(S.width / 2 - 0.12, mid(H, 2)), wt: Math.min(S.width / 2 - 0.12, mid(T, 2)) });
  }
  // what to draw for the other cars
  function drawStates() {
    const out = [];
    const add = (body, key, paint) => { if (body.frozen && state !== 'select' && state !== 'countdown') return; const c = body.car, p = c.pose; out.push({ key, x: p.x, z: p.z, h: p.heading, pitch: c.pitch + c.gPitch, roll: c.roll + c.gRoll, lift: c.y, steer: c.steer, spins: c.wheels.map(w => w.spin), paint }); };
    for (const r of ai.rivals) add(r.body, r.key, r.paint);
    for (const t of traffic.cars) add(t.body, t.key, t.paint);
    for (const o of extra) add(o.body, o.key, o.paint);
    return out;
  }
  const extra = [];   // scripted test cars
  // a body's paint: rivals, traffic, scripted cars (the wreck model in a crash takes it)
  function paintOf(b) { return b.rival ? b.rival.paint : b.traffic ? b.traffic.paint : (extra.find(o => o.body === b) || {}).paint; }
  function handleContact(e) {
    const mine = e.a === me || e.b === me;
    if (TEST && (e.a.rival || (e.b && e.b.rival) || mine && e.vn > 1)) (testOut.contacts = testOut.contacts || []).push([+simT.toFixed(2), e.kind, e.a === me ? 'me' : e.a.rival ? 'rival' : 'x', e.b === me ? 'me' : e.b && e.b.rival ? 'rival' : e.b ? 'x' : 'static', +e.vn.toFixed(1), e.crash]);
    const other = e.a === me ? e.b : e.b === me ? e.a : null;
    if (e.kind === 'land') {   // touching down after a jump or a crest
      if (mine && e.vn > 3) {
        FX.thud(Math.min(40, e.vn * 5), [e.x, car.y, e.z]); RaceInput.rumble(Math.min(1, e.vn / 10), 0.5, 140);
        if (e.vn > 5) sparks.spawn(e.x, car.y + 0.1, e.z, 14, 'spark', [car.vx * 0.2, 0.4, car.vz * 0.2]);
      }
      return;
    }
    // the player and a rival: the slam, either way (rules.js), noted before the hit's damage, so a
    // crash from it is the rival's takedown of the player
    const r = mine && other && other.rival && !(other.rival.wreck > 0) ? other.rival : null;
    const slam = r ? rules.contact(e, me, r, simT) : null;
    // a rival on the attack stands down once it touches its target (the attack landed) or hits
    // anything else (over 2 m/s)
    for (const b of [e.a, e.b]) if (b && b.rival && ai.attacking(b.rival)) { const landed = (b === e.a ? e.b : e.a) === b.rival.att.target; if (landed || e.vn > 2) ai.standDown(b.rival, landed); }
    // the player: the hit wears the health down; the crash when it's gone
    if (mine && state === 'race' && !me.ghost) {
      let d = RaceWorld.hitDamage(e, me);
      // one hit can touch several times in a few steps: within 0.15 s only the worst one counts
      if (simT - hurtAt < 0.15) { const extra = Math.max(0, d - hurtD); hurtD = Math.max(hurtD, d); d = extra; }
      else if (d > 0) { hurtAt = simT; hurtD = d; }
      if (d > 0) hurt(d);
      if (health <= 0) { triggerCrash(e); return; }
    }
    if (mine && !r) rules.playerContact(e.vn, simT);   // walls, posts, traffic: for a lucky escape
    if (slam && slam.by === 'player') {
      // the player's slam takes some of the rival's boost; a full one also puts the rival out of
      // control for a moment, steering away from the hit (the push itself is world.js's), and it
      // bears a grudge
      const x = slam.full ? 0.08 : 0.03;
      gainBoost(x, slam.full ? (slam.type === 'rear' ? 'Shunt' : 'Side slam') : 'Slam');
      score.slam(slam.full);
      r.boost = Math.max(0, r.boost - x);
      if (slam.full) r.aggr = Math.min(1, r.aggr + 0.15);
      if (slam.full && !(r.stagger > 0)) {
        const c = r.body.car, side = Math.sign((c.x - car.x) * -Math.sin(c.h) + (c.z - car.z) * Math.cos(c.h)) || 1;
        r.stagger = 0.4 + Math.min(0.6, e.vn * 0.08); r.kick = side * 0.8;
      }
    } else if (slam) {
      // a rival's slam on the player: the same, the other way round
      const x = slam.full ? 0.08 : 0.03;
      boost = Math.max(0, boost - x); r.boost = Math.min(1, r.boost + x);
      if (slam.full) {
        chip(`Slammed by ${r.name}`);
        const c = r.body.car, side = Math.sign((car.x - c.x) * -Math.sin(car.h) + (car.z - c.z) * Math.cos(car.h)) || 1;
        if (!ooc) ooc = { t: 0, dur: 0.4 + Math.min(0.6, e.vn * 0.08), kick: side * 0.8 };
      }
    }
    if (slam && TEST) (testOut.slams = testOut.slams || []).push({ t: +simT.toFixed(2), by: slam.by, type: slam.type, full: slam.full, vn: +e.vn.toFixed(1) });
    if (mine && other && other.traffic) other.traffic.touched = true;
    if (mine && e.vn > 2) {
      const pos = [e.x, car.y + 0.5, e.z];
      FX.hit(Math.min(4e5, e.J * 40), pos);
      sparks.spawn(e.x, car.y + 0.45, e.z, Math.min(60, 8 + e.vn * 3), 'spark', [e.nx * 2 + car.vx * 0.3, 1.5, e.nz * 2 + car.vz * 0.3]);
      RaceInput.rumble(Math.min(1, e.vn / 15), 0.3, 120);
    }
    // a rival hitting anything but the player: wrecked when it's a crash, or easily when the player
    // has just hit it (rules.js)
    for (const b of [e.a, e.b]) {
      if (!b || !b.rival || b.rival.wreck > 0 || mine) continue;
      if (rules.rivalContact(e, b.rival, simT)) wreckRival(b.rival, e);
    }
  }
  // ---------------------------------------------------------------- the takedown camera
  // A rival the player takes down by putting it into a wall, a post or another car crashes on the full
  // crash solver (Dramatic damage: it comes apart), and the camera leaves the player to watch it in
  // slow motion: the race all but stops (3% speed), the player's car holds a steady throttle (nothing to
  // steer), and the wreck is orbited through the impact (about 4 s, at most 4.5; a fresh press of the
  // gas or Enter skips it), then the race carries on. The takedown counts as the camera starts. The
  // camera follows the rival alone, smoothly, gliding round a building in its way. The rival rejoins
  // behind; a traffic car it hit leaves.
  let tdCam = null;
  function startTakedownCam(r, e) {
    const b = r.body, c = b.car;
    if (specs[r.key].rig || !R.wrecks[r.key]) return false;
    const other = e.a === b ? e.b : e.a;
    world.restore(b, 1);
    // another car in it: a unit of the crash too when its model is free (a different car), else a box
    const ok = other && other.car && !other.frozen && other.car.key !== r.key && R.wrecks[other.car.key] && !specs[other.car.key].rig;
    if (ok) world.restore(other, 1);
    const bodies = ok ? [b, other] : [b];
    const ground = level.groundAt(c.x, c.z).h;
    const units = bodies.map(q => {
      const k = q.car, u = { key: k.key, massKg: k.m, pose: k.pose, velocity: k.originVelocity(), yawRate: k.yaw };
      if (k.air || k.y - ground > 0.05) Object.assign(u, { lift: k.y - ground, vy: k.vy, pitch: k.pitch + k.gPitch, roll: k.roll + k.gRoll });
      return u;
    });
    // a takedown is a wreck: the rival leaves the ground rolling away from the hit, so it tumbles into
    // what it hit (an arcade touch: a scrape along a rail would otherwise be all there was to see)
    { const u = units[0], rx = -Math.sin(c.h), rz = Math.cos(c.h), side = Math.sign((e.x - c.x) * rx + (e.z - c.z) * rz) || 1, v = Math.hypot(c.vx, c.vz);
      Object.assign(u, { lift: Math.max(u.lift || 0, 0.35), vy: Math.max(u.vy || 0, 3 + v * 0.08), roll: (u.roll || 0) + side * 0.5, pitch: (u.pitch || 0) - 0.08, yawRate: u.yawRate + side * Math.min(2.5, 0.8 + v * 0.05) }); }
    const near = level.collidersNear(e.x, e.z, 32);
    const boxes = near.filter(o => o.box).map(o => ({ x: o.x, z: o.z, hx: o.hx, hz: o.hz, angle: o.angle, height: o.height }));
    if (other && other.car && !ok) { const B = world.box(other); if (B) boxes.push({ x: B.x, z: B.z, hx: B.hx, hz: B.hz, angle: Math.atan2(B.uz, B.ux), height: other.top || 1.5 }); }
    const cr = RaceCrash.start({ units, world: { boxes, cyls: near.filter(o => !o.box).map(o => ({ x: o.x, z: o.z, r: o.r, height: o.height })) }, duration: 1.6, damage: 'dramatic', solver: solverPick.solver });
    cr.lift = ground; cr.takedown = true; cr.impactKmh = Math.max(e.vn * 3.6, Math.hypot(c.vx, c.vz) * 3.6 * 0.7);
    const tu = bodies.map((q, u) => ({ body: q, key: q.car.key, model: R.wrecks[q.car.key], view: cr.unitView(u), paint: paintOf(q) }));
    for (const U of tu) { U.body.frozen = true; U.model.group.visible = true; if (U.paint !== undefined) U.model.setPaint(U.paint); }
    r.wreck = 99;
    rules.commit(r, simT);
    tdCam = { cr, units: tu, r, t: 0, real: 0, cur: { k: 0 }, ev: [], angle: Math.atan2(car.z - c.z, car.x - c.x) + 0.5, name: r.name, at: simT, P: null, gas: true,
      rec: { cr, units: tu.map((U, u) => ({ key: U.key, model: U.key, u, paint: U.paint })) } };
    noteMoment('takedown', { name: r.name });
    R.setCrashLift(ground);
    RaceInput.rumble(0.9, 0.7, 350);
    return true;
  }
  function updateTakedownCam(dt, input) {
    const td = tdCam, cr = td.cr, F = cr.F, n = F.t.length;
    td.real += dt;
    cr.tick(6);
    let speed = 0.25;
    if (n >= 3) {
      const T0 = cr.T0 >= 0 ? cr.T0 : F.t[n - 1];
      speed = slowmoAt(td.t - T0);
      const limit = cr.done ? F.t[n - 1] : F.t[n - 3];
      td.t = Math.min(td.t + dt * speed, limit);
      let k = Math.min(td.cur.k, n - 2); while (k > 0 && F.t[k] > td.t) k--; while (k < n - 2 && F.t[k + 1] <= td.t) k++; td.cur.k = k;
      const k2 = Math.min(n - 1, k + 1), s = F.t[k2] > F.t[k] ? Math.min(1, Math.max(0, (td.t - F.t[k]) / (F.t[k2] - F.t[k]))) : 0;
      for (const U of td.units) R.deform(U.model, U.view, k, k2, s, td.t);
      // the camera: on the rival (unit 0), eased, circling; R.orbit steps it round a building, and it
      // carries on from there rather than swinging back
      const ax = td.units[0].view.frames.axes[k], ke = 1 - Math.exp(-dt * 5);
      if (!td.P) td.P = { x: ax[0], z: ax[2], y: cr.lift };
      td.P.x += (ax[0] - td.P.x) * ke; td.P.z += (ax[2] - td.P.z) * ke;
      fireEvents(cr, td.t, td.units, td.cur, td.ev);   // its own queue: the player's crash queue isn't touched
      td.angle = R.orbit(td.P, td.angle + dt * 0.4, 8, 2.1, level);
      // (glides there: a step round a building is a quick move, not a cut)
      if (!td.cp) td.cp = R.camera.position.clone(); else td.cp.lerp(R.camera.position, 1 - Math.exp(-dt * 7));
      R.camera.position.copy(td.cp); R.camera.lookAt(td.P.x, td.P.y + 0.7, td.P.z);
      fxScale = speed;
      if (!(input.throttle > 0.5)) td.gas = false;   // the gas held from the race doesn't skip it; a new press does
      const skip = td.real > 0.6 && (input.start || (input.throttle > 0.5 && !td.gas));
      const over = (cr.done && td.t >= F.t[n - 1] - 1e-6) || (cr.T0 >= 0 && td.t >= cr.T0 + 1.2) || td.real > 4.5;
      if (td.real > 0.6) { $('#td-skip').hidden = false; if (TOUCH) $('#td-skip').textContent = 'Tap Gas to carry on'; }
      if (over || skip) endTakedownCam();
    } else if (td.real > 3) endTakedownCam();   // the solver never got going: give up on it
    FX.setTimeScale(Math.max(0.3, speed));
  }
  function endTakedownCam() {
    const td = tdCam;
    if (!td) return;
    tdCam = null;
    $('#td-skip').hidden = true;
    crashSmoke.stop();
    if (!td.cr.done) td.cr.stop();
    for (const U of td.units) { U.body.frozen = false; U.model.clearDestruction(); U.model.group.visible = false; }
    R.setCrashLift(0);
    const f = level.nearest(car.x, car.z, prog.i);
    for (const U of td.units) {
      if (U.body.rival) { U.body.rival.wreck = 0; ai.respawn(U.body.rival, f.s - 30); }
      else if (U.body.traffic) traffic.remove(U.body.traffic);
    }
    R.cam.init = false;   // the chase camera picks the player up again
    FX.setTimeScale(1);
  }

  // rival r wrecks (from contact event e, or spun out with e null): it spins away from the hit and
  // brakes to a stop (ai.js), and rejoins; the player's takedown if the rules say so (a hit into
  // something: the takedown camera, above)
  function wreckRival(r, e) {
    const b = r.body, c = b.car;
    r.wreck = 3; b.wrecked = true;
    if (e) {
      // the hit's turn: the normal points toward e.a; its moment about the rival's centre of gravity
      const s = b === e.a ? 1 : -1, turn = (e.x - c.x) * e.nz * s - (e.z - c.z) * e.nx * s;
      c.yaw += (Math.sign(turn) || (Math.random() < 0.5 ? -1 : 1)) * Math.min(3, 0.6 + 0.15 * e.vn);
    }
    const x = e ? e.x : c.x, z = e ? e.z : c.z;
    sparks.spawn(x, 0.5, z, 40, 'spark', [0, 0.8, 0]);
    const d = Math.hypot(c.x - car.x, c.z - car.z);
    if (state === 'race' && rules.wrecked(r, simT)) {   // counts half a second later
      if (!(e && !tdCam && (!SCRIPTED || TEST === 'takedown') && startTakedownCam(r, e))) { slowmo = 0.9; FX.crunch(1, [x, 0.6, z]); }   // (not for the trailer's director)
    }
    else if (d < 80) FX.crunch(Math.max(0.3, 1 - d / 80), [x, 0.5, z]);
  }
  // a rival the player hit that spins out (past 60 degrees, still moving) is wrecked too
  function spinOuts() {
    for (const r of ai.rivals) {
      if (r.wreck > 0 || !rules.hitRecently(r, simT)) continue;
      const c = r.body.car;
      if (Math.abs(c.sideSlip) > 1.05 && c.speed > 10) wreckRival(r, null);
    }
  }

  // ---------------------------------------------------------------- scripted tests
  function setupTest() {
    if (TEST === 'wall150') {
      const b = level.buildings.find(o => o.front === 1 && Math.abs(level.wrapDiff(level.nearest(o.x, o.z).s, 420)) < 60) || level.buildings.find(o => o.front === 1);
      const f = level.nearest(b.x, b.z), p = level.poseAt(f.s, -5.25);
      car.place(p.x, p.z, Math.atan2(b.z - p.z, b.x - p.x), 150 / 3.6);
    } else if (TEST === 'takedown') {
      // side by side at 100 km/h, the rival on the kerb side: shove it toward the trees, pull away
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
    await R.preparePlayer(carKey, specs[carKey], paintNow().hex);   // warmed for a crash there
    // the traffic's two cars, and the rivals' (one each); a wreck model of each for a crash with it
    const others = [...new Set(RIVALS.map(r => r.key))].filter(k => k !== 'lexus' && k !== 'mustang');
    await R.prepareCars(['lexus', 'mustang'], 48);
    await R.prepareCars(others, 4);
    R.prepareProps(props);
    for (const k of ['lexus', 'mustang', ...others]) await R.prepareWreck(k, specs[k]);
    for (const k of ['lexus', 'mustang', ...others]) R.wrecks[k].warm(R.renderer, R.camera);
    R.renderer.compile(R.scene, R.camera);
    // draw the particles once too (they draw nothing until the first crash), and everything else with
    // the frustum culling off: some drivers finish a shader only at its first draw, and the crash
    // camera may be the first to see a ramp
    const culled = [];
    R.scene.traverse((o) => { if (o.frustumCulled && (o.isMesh || o.isPoints)) { o.frustumCulled = false; culled.push(o); } });
    sparks.spawn(car.x, 1, car.z, 4, 'spark'); sparks.update(1e-3); R.render();
    for (const o of culled) o.frustumCulled = true;
    sparks.n = 0; sparks.update(0);
    await workerMode;
    $('#loading').hidden = true;
    voiceFor(carKey);
    if (TEST) setupTest();
    else {
      buildSelect(); placeForSelect(); showSelect();
      $('#hud').hidden = true; $('#select').hidden = false;
      if (q.has('go') && !SCRIPTED) startRace();   // Race again or Restart: straight into the race
    }
    requestAnimationFrame((t) => { last = t; frame(t); });
  }
  start().catch((err) => { $('#loading').textContent = 'Could not start: ' + err.message; console.error(err); });

  return { level, world, get car() { return car; }, get carKey() { return carKey; }, get paint() { return paintNow(); }, me, R, ai, traffic, director, crashFocus: PT, get simT() { return simT; }, get takedowns() { return takedowns; }, get prog() { return prog; }, get state() { return state; }, get crash() { return crash; }, get crashes() { return crashes; }, get clips() { return clips; }, highlights: () => startHighlights(), get tdCam() { return tdCam; }, get boost() { return boost; }, get health() { return health; }, props, standings };
})();
