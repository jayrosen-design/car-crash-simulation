/* The Destruction mode: one junction, as much damage as possible (Burnout 3's Crash Mode).
 *
 * An attempt: pick a car and paint; a countdown while the traffic flows; then drive down Main St
 * into the junction, boost (the gauge starts full) or not, take the ramp or not. The first real hit
 * is the crash: the cars go back one step and are handed to the full crash solver (crash.js, as in
 * the Race game), which a slow-motion camera plays back while the junction runs on in the same slow
 * time. Buses, trucks and tankers nearby enter the solver as moving boxes (with roofs). After about
 * 0.9 s of crash the wrecks carry on as rigid bodies in the pile-up (wrecks.js), keeping the shape the
 * solver left them in; the traffic keeps coming and piles in. Everything damaged pays out ($ popups,
 * a running total), totalled vehicles burn and explode, tankers and fuel pumps go up big, and the
 * Crashbreaker (once five vehicles are wrecked) blows up your own wreck, bigger for the boost you
 * saved. When nothing has paid out for four seconds (or 25 s after the crash) the total is counted
 * up against the bronze, silver and gold targets, and the best is kept in this browser.
 *
 * The garage's rigs (rigs.js) skip the crash solver: the motorcycle and drone crash as rigid bodies
 * (thrown rider, arms off) in the same slow motion, then their hull is your wreck in the pile-up; the
 * tank's crash starts at its first real contact (2 m/s into a vehicle, 4 m/s into a wall): a car it
 * hits goes through the solver with the tank as a moving box, and anything heavier sends the tank
 * straight into the pile-up.
 *
 * The world steps at 240 Hz (the wrecks at 120 Hz); the traffic is the same every attempt.
 *
 * URL: ?car=<key> (lexus, mustang, halcyon ...: the garage's cars, js/garage.js), ?damage=dramatic, ?touch=1|0, ?worker=0, ?test=tbone|tanker|ramp|plain
 * (a scripted attempt at once; results in window.__destruction).
 */
const DestructionGame = (() => {
  'use strict';
  const T = THREE, Veh = CrashVehicles, W = DestructionWrecks;
  const STEP = 1 / 240;
  const q = new URLSearchParams(location.search);
  const $ = (s) => document.querySelector(s);
  const TEST = q.get('test');
  // the crash physics: on the CPU (in a worker) or the GPU (WebGPU); ?solver=gpu, or the select screen's button
  const solverPick = RaceCrash.solverChoice(document.getElementById('btn-solver'));
  FX.recordedChoice(document.getElementById('btn-sfx'));   // recorded or synthesized sound effects
  const money = (v) => '$' + Math.round(v).toLocaleString('en-US');
  const short = (v) => v >= 1e6 ? '$' + (v / 1e6).toFixed(v >= 1e7 ? 0 : 1) + 'M' : '$' + Math.round(v / 1000) + 'k';

  // the props this level has beyond the Race game's (before the props are made)
  Object.assign(RaceProps.TYPES, DestructionLevel.PROP_TYPES);
  // the junction (?level=, else the player's last pick; ?test runs default to the crossroads):
  // picking another on the select screen reloads the page with it
  const LEVEL = (() => {
    const want = q.get('level') || (!q.get('test') && !q.has('director') && (() => { try { return localStorage.getItem('destruction-level'); } catch (e) { return null; } })());
    return DestructionLevel.LEVELS[want] ? want : 'crossroads';
  })();
  const level = DestructionLevel.build({ level: LEVEL });
  const TOUCH = q.get('touch') === '1' || (q.get('touch') !== '0' && window.matchMedia && window.matchMedia('(pointer: coarse)').matches);
  if (TOUCH) document.body.classList.add('touch');
  const R = RaceRender.create({ level, container: $('#view'), pixelRatio: TOUCH ? 1 : 1.5, shadowSize: TOUCH ? 1024 : 2048, look: level.look === 'dusk' ? DestructionLook.DUSK : level.look === 'night' ? RaceRender.NIGHT : {}, propParts });
  const world = RaceWorld.create(level);
  const props = RaceProps.create(level);
  // the garage's road cars this page loaded (the traffic drives the Lexus and Mustang)
  const specs = {};
  for (const k of CrashGarage.latticeKeys) if (Veh.specs[k]) specs[k] = Veh.get(k);
  for (const v of CrashGarage.LIST) if (v.type !== 'car' && RaceRigs.spec(v.key)) specs[v.key] = RaceRigs.spec(v.key);
  const traffic = DestructionTraffic.create(level, world, { specs });
  for (const k of ['bus', 'truck', 'tanker']) specs[k] = traffic.spec(k);
  const look = DestructionLook.create(R, level, { touch: TOUCH });
  const DAMAGE = q.get('damage') === 'dramatic' ? 'dramatic' : 'realistic';
  const VALUES = level.values;
  const heightOf = (spec) => spec.height || (spec.key === 'mustang' ? 1.46 : 1.75);

  // the props' meshes: a pump, the bus shelter, a shop window, a cafe table (the Race renderer has the rest)
  function propParts(type) {
    const box = (w, h, d, x, y, z) => { const g = new T.BoxGeometry(w, h, d); g.translate(x, y, z); return g; };
    const M = propParts.mats || (propParts.mats = {
      pump: new T.MeshStandardMaterial({ color: 0xd9d6cf, roughness: 0.5, metalness: 0.2 }), red: new T.MeshStandardMaterial({ color: 0xc8261e, roughness: 0.5 }),
      screen: new T.MeshStandardMaterial({ color: 0x0b1015, emissive: 0x3a8cff, emissiveIntensity: 0.6 }),
      glass: new T.MeshStandardMaterial({ color: 0x9ab8cc, metalness: 0.4, roughness: 0.05, transparent: true, opacity: 0.35, depthWrite: false }),
      frame: new T.MeshStandardMaterial({ color: 0x2a2d31, metalness: 0.6, roughness: 0.4 }), wood: new T.MeshStandardMaterial({ color: 0x8a5a33, roughness: 0.7 }),
      ad: new T.MeshStandardMaterial({ color: 0xffffff, emissive: 0xffe2b0, emissiveIntensity: 0.55 }),
    });
    switch (type) {
      case 'signalR': case 'signalG': {
        const lit = (hex) => new T.MeshStandardMaterial({ color: 0x111111, emissive: hex, emissiveIntensity: 2.2 });
        M.on = M.on || { signalR: lit(0xff2a1a), signalG: lit(0x2aff7a) };
        M.off = M.off || new T.MeshStandardMaterial({ color: 0x1b1d1f, emissive: 0x150d05, roughness: 0.5 });
        const pole = new T.CylinderGeometry(0.1, 0.12, 6, 8); pole.translate(0, 3, 0);
        const lamp = (y) => { const g = new T.SphereGeometry(0.11, 10, 8); g.translate(0.19, y, 0); return g; };
        const red = type === 'signalR';
        return [[pole, new T.MeshStandardMaterial({ color: 0x3c4146, metalness: 0.6, roughness: 0.45 })], [box(0.35, 1.0, 0.35, 0, 4.3, 0), M.off],
          [lamp(red ? 4.62 : 3.98), M.on[type]], [window.mergeGeometries([lamp(red ? 3.98 : 4.62), lamp(4.3)]), M.off]];
      }
      case 'pump': return [[window.mergeGeometries([box(0.8, 1.7, 0.55, 0, 0.95, 0), box(0.95, 0.12, 0.7, 0, 0.06, 0)]), M.pump], [box(0.82, 0.32, 0.6, 0, 1.72, 0), M.red], [box(0.5, 0.35, 0.58, 0, 1.2, 0), M.screen]];
      case 'shelter': return [[window.mergeGeometries([box(3.6, 0.1, 1.3, 0, 2.45, 0), box(0.08, 2.4, 0.08, -1.75, 1.2, -0.6), box(0.08, 2.4, 0.08, 1.75, 1.2, -0.6), box(0.08, 2.4, 0.08, -1.75, 1.2, 0.6), box(0.08, 2.4, 0.08, 1.75, 1.2, 0.6)]), M.frame], [box(3.5, 1.9, 0.04, 0, 1.25, -0.62), M.glass], [box(1.2, 1.7, 0.08, 1.2, 1.2, -0.6), M.ad]];
      case 'pane': return [[box(2.7, 2.4, 0.06, 0, 1.2, 0), M.glass], [box(2.76, 0.1, 0.1, 0, 2.4, 0), M.frame]];
      case 'table': return [[window.mergeGeometries([box(0.8, 0.05, 0.8, 0, 0.74, 0), box(0.06, 0.72, 0.06, 0, 0.36, 0), box(0.5, 0.04, 0.5, 0, 0.02, 0)]), M.wood]];
    }
    return null;
  }

  // ---------------------------------------------------------------- the player's car and paint
  const CARS = {};
  for (const v of CrashGarage.LIST) if (v.destruction && specs[v.key]) CARS[v.key] = v;
  const PAINTS = [
    { name: 'Crimson red', hex: 0xa3161f }, { name: 'Cobalt blue', hex: 0x1d4fa3 }, { name: 'Pearl white', hex: 0xe9e9e6 }, { name: 'Jet black', hex: 0x121315 },
    { name: 'Liquid silver', hex: 0x9ea3a8 }, { name: 'Sunset orange', hex: 0xd9581c }, { name: 'Signal yellow', hex: 0xe6b81e }, { name: 'Racing green', hex: 0x1f6b43 },
  ];
  // the Race game's last choice is the default here (read only); this mode keeps its own
  const saved = (() => { if (TEST) return null; try { return JSON.parse(localStorage.getItem('destruction-choice')) || JSON.parse(localStorage.getItem('race-choice')); } catch (e) { return null; } })() || {};
  let carKey = CARS[q.get('car')] ? q.get('car') : CARS[saved.car] ? saved.car : 'lexus';
  // one palette for every car, in one order: the eight, then the garage's signature paints. A car
  // starts in its signature paint (the Lexus and Mustang in red) and keeps the paint picked for it.
  for (const v of CrashGarage.LIST) if (v.paint) PAINTS.push({ name: v.paint.name[0].toUpperCase() + v.paint.name.slice(1), hex: v.paint.hex });
  const homePaint = (key) => Math.max(0, PAINTS.findIndex((p) => CARS[key].paint && p.hex === CARS[key].paint.hex));
  let paintIdx = PAINTS[saved.paint] ? +saved.paint : homePaint(carKey);
  const paintFor = { [carKey]: paintIdx };
  const paintNow = () => PAINTS[paintIdx];
  let car = RaceCar.create(specs[carKey]);
  const me = world.add(car, { kind: 'player' });
  const P0 = level.player;
  // on the select screen the car waits down the street, facing back up it: the junction behind it
  const SHOW = { x: 1.75, z: -95, h: -Math.PI / 2 };
  // put the car at (x, z) facing h, standing on the ground there (the start is 9 m up the hill, and
  // a car held still before the start isn't moved onto the ground by the world's step)
  function placeCar(p) {
    car.place(p.x, p.z, p.h, 0);
    const g = level.groundAt(car.x, car.z);
    car.y = g.h; car.vy = 0; car.air = false;
    car.gPitch = Math.atan(g.gx * Math.cos(p.h) + g.gz * Math.sin(p.h)); car.gRoll = -Math.atan(-g.gx * Math.sin(p.h) + g.gz * Math.cos(p.h));
  }
  placeCar(SHOW);
  const LEVEL_NOTES = { crossroads: 'Gas station, roadworks, one tanker timed for you', docklands: 'Freight trucks and three tankers, after dark', boulevard: 'Towers, buses and a crowd at midday' };
  const bestKey = LEVEL === 'crossroads' ? 'destruction-best' : 'destruction-best-' + LEVEL;
  let best = (() => { try { return JSON.parse(localStorage.getItem(bestKey)) || null; } catch (e) { return null; } })();

  // ---------------------------------------------------------------- attempt state
  let state = TEST ? 'countdown' : 'select', countdown = 4, simT = -3, tRun = 0;
  let wrecks = null, crash = null, crashUnits = [], crashT = 0, tPlay = 0, kCur = 0, camAngle = 0, evPending = [], impactAt = -1;
  let boost = 1, boostAtImpact = 0, health = 1, hurtAt = -1, hurtD = 0, cbReady = false, cbUsed = false, lastCash = 0, slowmo = 0;
  let taken = new Set(), parked = [], adapters = new Map(), chunks = [], pumpsLit = new Set(), pending = [], tally = null;
  const testOut = (window.__destruction = { test: TEST, frames: [], events: [] });

  // the parked cars at the pumps: still, until something hits them
  function placeParked() {
    for (const p of parked) { const i = world.bodies.indexOf(p.body); if (i >= 0) world.bodies.splice(i, 1); }
    world.bodies.forEach((b, k) => { b.id = k; });
    parked = level.parked.map((o) => {
      const c = RaceCar.create(specs[o.type]), S = specs[o.type];
      const off = S.xMin + S.length / 2;
      c.setKinematic(o.x - Math.cos(o.h) * off, o.z - Math.sin(o.h) * off, o.h, 0);
      const body = world.add(c, { kinematic: true, kind: 'traffic', height: heightOf(S) });
      const p = { type: o.type, key: o.type, paint: look ? DestructionLook.PAINTS[o.paint % 8] : 0, spec: S, len: S.length, body, parked: true, v: 0 };
      body.traffic = p;
      return p;
    });
  }

  // a fresh attempt: the traffic from its schedule, the props back up, no wrecks
  function resetAttempt() {
    if (crash) crash.stop();
    crash = null; crashUnits = []; impactAt = -1; slowmo = 0;
    for (const m of [R.player, R.wrecks.lexus, R.wrecks.mustang]) if (m) { m.clearDestruction(); m.group.matrixAutoUpdate = false; }
    for (const k of ['lexus', 'mustang']) if (R.wrecks[k]) R.wrecks[k].group.visible = false;
    // (wheels that came off go back on their car; clearDestruction removed the other pieces)
    for (const ch of chunks) if (ch.wheelOf) ch.wheelOf.group.add(ch.g);
    chunks = [];
    traffic.reset();
    placeParked();
    props.reset(); R.drawProps(true);
    wrecks = W.create(level, { damage: RaceWorld.damage, values: VALUES, seed: 11 });
    adapters = new Map(); taken = new Set(); pumpsLit = new Set(); pending = [];
    look.reset();
    placeCar(P0); me.frozen = true; me.ghost = 0;
    boost = 1; boostAtImpact = 0; health = 1; hurtAt = -1; cbReady = false; cbUsed = false; lastCash = 0; tally = null;
    simT = -3; countdown = 4; tRun = 0; acc = 0; stepN = 0;
    R.setCrashLift(0); R.cam.init = false;
    FX.setTimeScale(1);
    popups.forEach(p => { p.el.style.opacity = 0; p.alive = false; });
    playerWreck = null; boomFocus = null; focus.init = false;
    $('#cb').hidden = true; $('#cb').classList.remove('ready'); $('#t-boost').textContent = 'Boost';
    $('#results').hidden = true; $('#callout').style.opacity = 0;
    $('#d-mult').hidden = true;
    for (const g of ['b', 's', 'g']) $('#goal-' + g).classList.remove('got');
  }

  // ---------------------------------------------------------------- drawing the vehicles
  const M4 = new T.Matrix4(), M5 = new T.Matrix4(), Qt = new T.Quaternion(), Vp = new T.Vector3(), S1 = new T.Vector3(1, 1, 1);
  const paintOf = (v) => DestructionLook.PAINTS[(v.paint || 0) % 8];
  function wreckMatrix(b, out) {
    // the body's pose, then from its box's middle to the model's origin (on the ground, at the spec's origin)
    out.compose(Vp.set(b.p[0], b.p[1], b.p[2]), Qt.set(b.q[0], b.q[1], b.q[2], b.q[3]), S1);
    const S = specs[b.key], H = b.hi[1] - b.lo[1];
    const ox = S && !traffic.HEAVY[b.key] ? S.xMin + S.length / 2 : 0;
    return out.multiply(M5.makeTranslation(-ox - (b.lo[0] + b.hi[0]) / 2, -H / 2 - (b.lo[1] + b.hi[1]) / 2, -(b.lo[2] + b.hi[2]) / 2));
  }
  function drawVehicles() {
    const slots = { bus: 0, truck: 0, tanker: 0 };
    for (const k in specs) slots[k] = 0;
    const heavyPaint = (v) => v.type === 'bus' ? DestructionLook.BUS_PAINTS[v.paint % 4] : paintOf(v);
    const driving = traffic.vehicles.concat(parked.filter(p => world.bodies.includes(p.body)));
    for (const v of driving) {
      const c = v.body.car, key = v.type;
      if (traffic.HEAVY[key]) {
        M4.makeRotationY(-c.h).setPosition(c.x - Math.cos(c.h) * c.cgX, c.y, c.z - Math.sin(c.h) * c.cgX);
        look.drawHeavy(key, slots[key]++, M4, heavyPaint(v), null);
      } else {
        const p = c.pose, i = slots[key]++;
        R.drawCar(key, i, { x: p.x, z: p.z, h: p.heading, pitch: c.pitch + c.gPitch, roll: c.roll + c.gRoll, lift: c.y, steer: c.steer, spins: c.wheels.map(w => w.spin), paint: paintOf(v) });
        look.dentCar(key, i, null);
      }
    }
    if (wrecks) for (const b of wrecks.bodies) {
      if (b.kind === 'player' || b.kind === 'chunk' || b.kind === 'proxy' || b.model) continue;
      const key = b.key;
      wreckMatrix(b, M4);
      const d = b.dents.concat([b.exploded ? 1 : Math.min(0.6, b.burn >= 0 ? b.burn * 0.2 : 0)]);
      if (traffic.HEAVY[key]) look.drawHeavy(key, slots[key]++, M4, key === 'bus' ? DestructionLook.BUS_PAINTS[(b.paint || 0) % 4] : DestructionLook.PAINTS[(b.paint || 0) % 8], d);
      else { const i = slots[key]++; R.drawCar(key, i, { matrix: M4, spins: b.spins || [0, 0, 0, 0], paint: DestructionLook.PAINTS[(b.paint || 0) % 8] }); look.dentCar(key, i, d); }
    }
    R.endCars(); look.endHeavy();
  }

  // ---------------------------------------------------------------- vehicles becoming wrecks
  // a vehicle still driving (traffic or parked), hit: out of the traffic, into the pile-up with its
  // motion; dv: the hit's approach speed with the bounce and its share (m/s) for its first damage
  function wreckVehicle(v, dv, P) {
    const c = v.body.car, S = v.spec, H = heightOf(S);
    const ch = Math.cos(c.h), sh = Math.sin(c.h), off = S.xMin + S.length / 2 - c.cgX;
    const b = wrecks.add({ kind: traffic.HEAVY[v.type] ? v.type : 'car', key: v.type, p: [c.x + ch * off, c.y + H / 2, c.z + sh * off], q: W.yawQ(c.h),
      v: [c.vx, c.vy || 0, c.vz], w: [0, -c.yaw, 0], m: c.m, size: [S.length, H, S.width], value: VALUES[v.type] || 0, paint: v.paint, ref: v });
    b.spins = c.wheels.map(w => w.spin);
    if (v.parked) { const i = world.bodies.indexOf(v.body); if (i >= 0) { world.bodies.splice(i, 1); world.bodies.forEach((x, k) => { x.id = k; }); } parked.splice(parked.indexOf(v), 1); }
    else traffic.release(v);
    if (dv > 2.5) wrecks.settle(b, RaceWorld.damage(dv) * W.DAMAGE_SCALE, P || b.p);
    return b;
  }
  // the driving vehicles as boxes (for the wrecks and the crash solver)
  function driverBox(v) {
    const c = v.body.car, S = v.spec, ch = Math.cos(c.h), sh = Math.sin(c.h), off = S.xMin + S.length / 2 - c.cgX;
    return { x: c.x + ch * off, z: c.z + sh * off, y: c.y, h: c.h, hl: S.length / 2, hw: S.width / 2, height: heightOf(S), vx: c.vx, vz: c.vz, ref: v };
  }

  // ---------------------------------------------------------------- the crash (the first real hit)
  const PT = { x: 0, z: 0, y: 0 };
  function triggerCrash(e) {
    if (state !== 'run') return;
    const otherB = e.b && e.b !== me ? e.b : (e.a !== me ? e.a : null), other = otherB && otherB.traffic;
    world.restore(me, 1);
    if (otherB) world.restore(otherB, 1);
    if (car.kind === 'tracked') { tankCrash(e, otherB, other); return; }
    if (car.spec.rig) { rigCrash(e, otherB, other); return; }
    const ground = level.terrain(car.x, car.z);
    const lattice = other && !traffic.HEAVY[other.type];   // a car: both in the crash solver
    const unit = (b, u) => {
      const c = b.car, o = { key: c.key, massKg: c.m, pose: c.pose, velocity: c.originVelocity(), yawRate: c.yaw };
      const lift = c.y - ground;
      if (u === 0 && (c.air || lift > 0.05)) Object.assign(o, { lift, vy: c.vy, pitch: c.pitch + c.gPitch, roll: c.roll + c.gRoll });
      return o;
    };
    const bodies = lattice ? [me, otherB] : [me];
    const units = bodies.map(unit);
    // the level near the crash, and the vehicles near it as moving boxes (with roofs)
    const ex = e.x, ez = e.z, near = level.collidersNear(ex, ez, 32);
    const boxes = near.filter(o => o.box).map(o => ({ x: o.x, z: o.z, hx: o.hx, hz: o.hz, angle: o.angle, height: o.height }));
    const cyls = near.filter(o => !o.box).map(o => ({ x: o.x, z: o.z, r: o.r, height: o.height }));
    const movers = traffic.vehicles.concat(parked).filter(v => (!lattice || v !== other) && Math.hypot(v.body.car.x - ex, v.body.car.z - ez) < 20);
    for (const v of movers) { const d = driverBox(v); boxes.push({ x: d.x, z: d.z, hx: d.hl, hz: d.hw, angle: d.h, height: d.height, vx: d.vx, vz: d.vz, top: true }); }
    crash = RaceCrash.start({ units, world: { boxes, cyls }, duration: 0.9, damage: DAMAGE, solver: solverPick.solver });
    crash.impactKmh = e.vn * 3.6; crash.lift = ground;
    R.setCrashLift(ground); PT.y = ground;
    crashUnits = bodies.map((b, u) => ({ body: b, model: u === 0 ? R.player : R.wrecks[b.car.key], view: crash.unitView(u), paint: u === 0 ? paintNow().hex : paintOf(other), spec: specs[b.car.key], v: b === me ? null : other }));
    for (const U of crashUnits) if (U.model !== R.player) { U.model.group.visible = true; U.model.setPaint(U.paint); }
    me.frozen = true;
    // the other car leaves the traffic (the solver has it now); a heavy one becomes a wreck moving on
    // at its speed (held steady while the solver sees it as a moving box)
    if (lattice) {
      if (other.parked) { const i = world.bodies.indexOf(otherB); world.bodies.splice(i, 1); world.bodies.forEach((x, k) => { x.id = k; }); parked.splice(parked.indexOf(other), 1); } else traffic.release(other);
    } else if (other) {
      const b = wreckVehicle(other, e.vn * 0.6);   // (arcade: a bus or tanker takes a real beating from a car)
      wrecks.hold(b);
      crash.held = [b];
    }
    // kinematic stand-ins for the solver's cars, so the wrecks feel them
    for (const U of crashUnits) {
      const S = U.spec;
      U.proxy = wrecks.add({ kind: 'proxy', key: S.key, p: [0, -50, 0], m: S.massKg, size: [S.length, heightOf(S), S.width], kinematic: true });
    }
    boostAtImpact = boost;
    state = 'impact'; crashT = 0; tPlay = 0; kCur = 0; evPending = []; impactAt = simT;
    camAngle = Math.atan2(car.vz, car.vx) + Math.PI * 0.62;
    FX.engineStop(); FX.setTimeScale(0.25);
    RaceInput.rumble(1, 1, 450);
    callout('Crash!', '', 1300);
    if (TEST) testOut.crashAt = performance.now(), testOut.impactKmh = crash.impactKmh, testOut.partner = other ? other.type : 'static', testOut.air = units[0].lift !== undefined;
  }
  // the start of any impact's slow motion
  function beginImpact(e, other) {
    crash.impactKmh = e.vn * 3.6;
    boostAtImpact = boost;
    state = 'impact'; crashT = 0; tPlay = 0; kCur = 0; evPending = []; impactAt = simT;
    camAngle = Math.atan2(car.vz, car.vx) + Math.PI * 0.62;
    FX.engineStop(); FX.setTimeScale(0.25);
    RaceInput.rumble(1, 1, 450);
    callout('Crash!', '', 1300);
    if (TEST) testOut.crashAt = performance.now(), testOut.impactKmh = e.vn * 3.6, testOut.partner = other ? other.type : 'static', testOut.air = false;
  }
  // the motorcycle or drone: its own crash as rigid bodies; what it hit is a wreck at once (a 285 kg
  // bike hardly moves a car: that car's share of the hit is small)
  function rigCrash(e, otherB, other) {
    const B = otherB && world.box(otherB);
    crash = RaceRigs.crash({ level, car, W, seed: 7, other: B ? { x: B.x, z: B.z, hx: B.hx, hz: B.hz, angle: Math.atan2(B.uz, B.ux), height: other ? heightOf(other.spec) : 1.4 } : null });
    crash.sound = CARS[car.key].sound;   // its own crash recording at the first impact
    R.setCrashLift(0); PT.y = 0;
    crashUnits = [{ body: me, model: R.player, view: crash.unitView(0), paint: paintNow().hex, spec: car.spec, v: null, proxy: null }];
    me.frozen = true;
    if (other) wreckVehicle(other, e.vn * 1.2 * car.m / (car.m + otherB.car.m), [e.x, car.y + 0.6, e.z]);
    beginImpact(e, other);
  }
  // the tank: a wreck at once (yours). Into a car: held at its speed while the solver crushes that
  // car against it (a moving box with a roof); into anything heavier or a wall: straight to the pile-up
  function tankCrash(e, otherB, other) {
    const S = car.spec, pose = car.pose, ground = level.terrain(car.x, car.z);
    const tb = wrecks.add({ kind: 'player', key: S.key, p: [pose.x, car.y, pose.z], q: W.yawQ(car.h), v: [car.vx, 0, car.vz], w: [0, -car.yaw, 0], m: car.m, lo: S.lo, hi: S.hi, value: 0 });
    tb.model = R.player; tb.hand = { p: [0, 0, 0], q: [0, 0, 0, 1] };
    playerWreck = tb; me.frozen = true;
    if (other && !traffic.HEAVY[other.type]) {
      wrecks.hold(tb);
      const c = otherB.car, B = world.box(me);
      const u = { key: c.key, massKg: c.m, pose: c.pose, velocity: c.originVelocity(), yawRate: c.yaw };
      const near = level.collidersNear(e.x, e.z, 32);
      const boxes = near.filter(o => o.box).map(o => ({ x: o.x, z: o.z, hx: o.hx, hz: o.hz, angle: o.angle, height: o.height }));
      const cyls = near.filter(o => !o.box).map(o => ({ x: o.x, z: o.z, r: o.r, height: o.height }));
      boxes.push({ x: B.x, z: B.z, hx: B.hx, hz: B.hz, angle: car.h, height: S.height, vx: car.vx, vz: car.vz, top: true });
      for (const v of traffic.vehicles.concat(parked).filter(v => v !== other && Math.hypot(v.body.car.x - e.x, v.body.car.z - e.z) < 20)) { const d = driverBox(v); boxes.push({ x: d.x, z: d.z, hx: d.hl, hz: d.hw, angle: d.h, height: d.height, vx: d.vx, vz: d.vz, top: true }); }
      crash = RaceCrash.start({ units: [u], world: { boxes, cyls }, duration: 0.9, damage: DAMAGE, solver: solverPick.solver });
      crash.lift = ground; crash.held = [tb];
      R.setCrashLift(ground); PT.y = ground;
      crashUnits = [{ body: otherB, model: R.wrecks[c.key], view: crash.unitView(0), paint: paintOf(other), spec: specs[c.key], v: other }];
      const U = crashUnits[0];
      U.model.group.visible = true; U.model.setPaint(U.paint);
      U.proxy = wrecks.add({ kind: 'proxy', key: c.key, p: [0, -50, 0], m: c.m, size: [U.spec.length, heightOf(U.spec), U.spec.width], kinematic: true });
      if (other.parked) { const i = world.bodies.indexOf(otherB); world.bodies.splice(i, 1); world.bodies.forEach((x, k) => { x.id = k; }); parked.splice(parked.indexOf(other), 1); } else traffic.release(other);
      beginImpact(e, other);
    } else {
      if (other) wreckVehicle(other, e.vn * 1.2 * car.m / (car.m + otherB.car.m), [e.x, car.y + 1, e.z]);
      crash = null; crashUnits = [];
      boostAtImpact = boost; impactAt = simT; tPlayEnd = 0; handT = 0;
      state = 'pileup';
      RaceInput.rumble(1, 1, 450);
      callout('Crash!', '', 1300);
      if (TEST) testOut.crashAt = performance.now(), testOut.impactKmh = e.vn * 3.6, testOut.partner = other ? other.type : 'static', testOut.air = false;
    }
  }
  function showCrashFrame(t) {
    const F = crash.F, n = F.t.length;
    let k = Math.min(kCur, n - 2); while (k > 0 && F.t[k] > t) k--; while (k < n - 2 && F.t[k + 1] <= t) k++; kCur = k;
    const k2 = Math.min(n - 1, k + 1), s = F.t[k2] > F.t[k] ? Math.min(1, Math.max(0, (t - F.t[k]) / (F.t[k2] - F.t[k]))) : 0;
    PT.x = 0; PT.z = 0;
    for (const U of crashUnits) {
      R.deform(U.model, U.view, k, k2, s, t);
      const ax = U.view.frames.axes[k]; PT.x += ax[0] / crashUnits.length; PT.z += ax[2] / crashUnits.length;
      if (!U.proxy) continue;   // (a rig's crash: none)
      // its stand-in among the wrecks: at the cabin, turned as the cabin
      const f = [ax[3], ax[4], ax[5]], u = [ax[6], ax[7], ax[8]], z = [f[1] * u[2] - f[2] * u[1], f[2] * u[0] - f[0] * u[2], f[0] * u[1] - f[1] * u[0]];
      const P = U.proxy, np = [ax[0], ax[1] + crash.lift, ax[2]];
      P.v = P.p[1] > -40 && crashT > 0 ? [(np[0] - P.p[0]) / Math.max(1e-3, U.dtLast || 0.016), (np[1] - P.p[1]) / Math.max(1e-3, U.dtLast || 0.016), (np[2] - P.p[2]) / Math.max(1e-3, U.dtLast || 0.016)] : [0, 0, 0];
      P.p = np; P.q = W.fromAxes(f, u, z);
      // the loose parts' last moves (their speed when the pile-up takes them over)
      for (const g of U.model.pieces().debris) { if (!g.userData.track) g.userData.track = []; const tr = g.userData.track; tr.push([t, g.position.x, g.position.y, g.position.z]); if (tr.length > 6) tr.shift(); }
      for (const w of U.model.pieces().wheels) { if (!w.group.userData.track) w.group.userData.track = []; const tr = w.group.userData.track; tr.push([t, w.group.position.x, w.group.position.y, w.group.position.z]); if (tr.length > 6) tr.shift(); }
    }
  }
  function fireEvents(t) {
    const fresh = crash.events.slice(evPending.cursor || 0);
    evPending.cursor = crash.events.length;
    evPending.push(...fresh);
    evPending.sort((a, b) => a.t - b.t);
    const lift = crash.lift || 0;
    while (evPending.length && evPending[0].t <= t) {
      const e = evPending.shift(), y = e.y + lift, pos = [e.x, y, e.z];
      if (e.type === 'first') { if (!FX.crashClip(crash.sound, pos)) FX.crunch(1, pos); look.embers.spawn(e.x, y, e.z, 40, 'spark', [0, 0.6, 0]); look.embers.spawn(e.x, y, e.z, 16, 'dust'); look.shake(0.8, e.x, y, e.z); }
      else if (e.type === 'contact') { if (Math.random() < 0.25) FX.crunch(Math.min(1, e.mag / 3000), pos); if (Math.random() < 0.5) look.embers.spawn(e.x, y, e.z, 4, 'spark', [0, 0.3, 0]); }
      else if (e.type === 'detach') { FX.tear(e.mass, pos); FX.clank(e.mass, pos); look.embers.spawn(e.x, y, e.z, Math.min(24, 6 + Math.round(e.mass)), 'spark', [0, 0.6, 0]); }
      else if (e.type === 'glass') { FX.glass(e.mass, pos); look.embers.spawn(e.x, y, e.z, 12, 'glass'); }
      else if (e.type === 'crack') FX.crack(0.8, pos);
      else if (e.type === 'burst') { FX.blowout(pos); look.embers.spawn(e.x, lift + 0.15, e.z, 10, 'dust'); }
    }
  }
  // the impact in slow motion: the junction runs on at the playback's pace
  function updateImpact(dt) {
    crashT += dt;
    crash.tick(6);
    const F = crash.F, n = F.t.length;
    let adv = 0;
    if (n >= 3) {
      if (TEST && testOut.firstFrameMs === undefined) testOut.firstFrameMs = performance.now() - testOut.crashAt;
      const T0 = crash.T0 >= 0 ? crash.T0 : F.t[n - 1], since = tPlay - T0;
      const speed = since < 0 ? 0.25 : since < 0.12 ? 0.08 : since < 0.3 ? 0.08 + (since - 0.12) / 0.18 * 0.22 : since < 0.8 ? 0.3 + (since - 0.3) / 0.5 * 0.7 : 1;
      const limit = crash.done ? F.t[n - 1] : F.t[n - 3];
      const want = tPlay + dt * speed;
      if (TEST && want > limit + 1e-9) testOut.ahead = (testOut.ahead || 0) + 1;
      const t1 = Math.min(want, limit);
      adv = Math.max(0, t1 - tPlay); tPlay = t1;
      for (const U of crashUnits) U.dtLast = adv;
      FX.setTimeScale(Math.max(0.08, speed));
      showCrashFrame(tPlay);
      fireEvents(tPlay);
      camAngle += dt * 0.35;
      R.orbit(PT, camAngle, 7.5, 1.9, level);
    }
    const end = crash.done && tPlay >= F.t[n - 1] - 1e-6;
    if (end || crashT > 12) handOff();
    return adv;   // game time to run the junction
  }

  // the solver is done: its cars become wrecks keeping their shape, their loose parts small wrecks
  function handOff() {
    if (crash.mode === 'rigid') { handOffRig(); return; }
    if (!crash.done) crash.stop();
    const F = crash.F, kL = F.t.length - 1, k0 = Math.max(0, kL - 5), dtF = Math.max(1e-4, F.t[kL] - F.t[k0]), lift = crash.lift;
    for (const U of crashUnits) {
      const V = U.view.frames, X = V.pos[kL], X0 = V.pos[k0], mass = U.model.lat.mass, n = mass.length;
      let m = 0; const c = [0, 0, 0], c0 = [0, 0, 0];
      for (let a = 0; a < n; a++) { const w = mass[a]; m += w; for (let i = 0; i < 3; i++) { c[i] += w * X[3 * a + i]; c0[i] += w * X0[3 * a + i]; } }
      for (let i = 0; i < 3; i++) { c[i] /= m; c0[i] /= m; }
      const axQ = (ax) => { const f = [ax[3], ax[4], ax[5]], u = [ax[6], ax[7], ax[8]]; return W.fromAxes(f, u, [f[1] * u[2] - f[2] * u[1], f[2] * u[0] - f[0] * u[2], f[0] * u[1] - f[1] * u[0]]); };
      const q1 = axQ(V.axes[kL]), q0 = axQ(V.axes[k0]);
      // angular velocity from the turn over the last frames
      let dq = W.qmul(q1, W.conj(q0)); if (dq[3] < 0) dq = dq.map(x => -x);
      const ang = 2 * Math.acos(Math.min(1, dq[3])), sn = Math.sin(ang / 2) || 1;
      const w = ang > 1e-6 ? [dq[0] / sn * ang / dtF, dq[1] / sn * ang / dtF, dq[2] / sn * ang / dtF] : [0, 0, 0];
      // its crushed shape in its own frame: the box round its nodes
      const lo = [Infinity, Infinity, Infinity], hi = [-Infinity, -Infinity, -Infinity], qi = W.conj(q1), l = [0, 0, 0];
      for (let a = 0; a < n; a++) {
        W.rot(qi, [X[3 * a] - c[0], X[3 * a + 1] - c[1], X[3 * a + 2] - c[2]], l);
        for (let i = 0; i < 3; i++) { if (l[i] < lo[i]) lo[i] = l[i]; if (l[i] > hi[i]) hi[i] = l[i]; }
      }
      const S = U.spec, mine = U.body === me;
      const b = wrecks.add({ kind: mine ? 'player' : 'car', key: S.key, p: [c[0], c[1] + lift, c[2]], q: q1, v: [(c[0] - c0[0]) / dtF, (c[1] - c0[1]) / dtF, (c[2] - c0[2]) / dtF], w,
        m: S.massKg, lo, hi, value: mine ? 0 : VALUES[S.key], paint: U.v ? U.v.paint : 0, ref: U.v });
      // damage from the crash itself: the hit's speed, its share
      const share = mine ? 0.5 : 0.5, dv = (crash.impactKmh / 3.6) * 1.2 * share;
      wrecks.settle(b, RaceWorld.damage(dv) * W.DAMAGE_SCALE * 1.4, b.p);
      b.model = U.model; b.hand = { p: c.slice(), q: q1 };
      U.wreck = b;
      if (mine) playerWreck = b;
      wrecks.remove(U.proxy);
      // the parts that came off: small wrecks of their own (wheels moved out of the car's group)
      const pcs = U.model.pieces();
      for (const wl of pcs.wheels) { R.crashRoot.attach(wl.group); addChunk(wl.group, 0.35, 22, U).wheelOf = U.model; }
      for (const g of pcs.debris) addChunk(g, null, 12, U);
    }
    if (crash.held) for (const b of crash.held) wrecks.release(b);
    if (TEST) testOut.hand = crashUnits.map(U => ({ b: U.wreck, p: U.wreck.p.slice(), v: U.wreck.v.slice(), t: simT }));
    tPlayEnd = tPlay; handT = 0;
    state = 'pileup';
    FX.setTimeScale(1);
  }
  // a rig's crash is done: its hull is your wreck, the pieces that came off small wrecks, each moving
  // on as in the crash's last frames
  function handOffRig() {
    const U = crashUnits[0], V = U.view.frames, P = V.poses, kL = P.length - 1, k0 = Math.max(0, kL - 5), dtF = Math.max(1e-4, V.t[kL] - V.t[k0]), S = U.spec;
    const vel = (i) => { const a = P[k0][i], b = P[kL][i]; return a && b ? [(b[0] - a[0]) / dtF, (b[1] - a[1]) / dtF, (b[2] - a[2]) / dtF] : [0, 0, 0]; };
    const h = P[kL][0];
    const b = wrecks.add({ kind: 'player', key: S.key, p: h.slice(0, 3), q: h.slice(3), v: vel(0), w: [0, 0, 0], m: S.massKg, lo: S.lo, hi: S.hi, value: 0 });
    b.model = U.model; b.hand = { p: [0, 0, 0], q: [0, 0, 0, 1] };
    U.wreck = b; playerWreck = b;
    U.view.pieces.forEach((n, i) => {
      const g = U.model.nodes[n];
      if (!P[kL][i + 1] || !g) return;
      g.matrix.decompose(g.position, g.quaternion, g.scale); g.matrixAutoUpdate = true;
      const part = S.parts.find(p => p.name === n);
      addChunk(g, null, Math.max(1, part.mass), U).b.v = vel(i + 1);
    });
    if (TEST) testOut.hand = [{ b, p: b.p.slice(), v: b.v.slice(), t: simT }];
    tPlayEnd = tPlay; handT = 0;
    state = 'pileup';
    FX.setTimeScale(1);
  }
  let playerWreck = null, tPlayEnd = 0, handT = 0;
  const BOX = new T.Box3(), BV = new T.Vector3();
  function addChunk(g, radius, mass, U) {
    g.updateMatrixWorld(true);
    BOX.setFromObject(g); BOX.getSize(BV);
    const size = radius ? [radius * 2, radius * 2, 0.3] : [Math.max(0.2, BV.x * 0.7), Math.max(0.12, BV.y * 0.7), Math.max(0.2, BV.z * 0.7)];
    BOX.getCenter(BV);
    const tr = g.userData.track || [], a = tr[0], z = tr[tr.length - 1];
    const v = a && z && z[0] > a[0] ? [(z[1] - a[1]) / (z[0] - a[0]), (z[2] - a[2]) / (z[0] - a[0]), (z[3] - a[3]) / (z[0] - a[0])] : [0, 0, 0];
    const lift = crash.lift || 0;
    const b = wrecks.add({ kind: 'chunk', key: 'chunk', p: [BV.x, BV.y, BV.z], q: [0, 0, 0, 1], v, w: [(Math.random() - 0.5) * 4, (Math.random() - 0.5) * 4, (Math.random() - 0.5) * 4], m: mass, size, rMax: 0.3 });
    const ch = { g, b, p0: [BV.x, BV.y - lift, BV.z], gp: g.position.clone(), gq: g.quaternion.clone() };
    chunks.push(ch);
    return ch;
  }

  // ---------------------------------------------------------------- explosions, pumps, Crashbreaker
  function onExplode(e) {
    const size = e.kind === 'tanker' ? 1.15 : e.kind === 'pump' ? 0.75 : e.kind === 'crashbreaker' ? 0.95 : e.kind === 'bus' || e.kind === 'truck' ? 0.6 : 0.42;
    look.blast(e.x, e.y, e.z, e.r, size);
    FX.explosion(size, [e.x, e.y, e.z]);
    RaceInput.rumble(Math.min(1, size), Math.min(1, size), 400 + 400 * size);
    if (e.kind === 'tanker') { slowmo = 0.7; callout('Tanker boom!', 'huge', 1400); }
    else if (e.kind === 'crashbreaker') callout('Crashbreaker!', 'cb', 1400);
    else if (size > 0.5) callout('Boom!', '', 900);
    // the blast reaches the traffic (wrecked), and the props (flung; pumps go up next)
    for (const v of traffic.vehicles.concat(parked).slice()) {
      const c = v.body.car;
      if (Math.hypot(c.x - e.x, c.z - e.z) < e.r) wreckVehicle(v, 0);
    }
    blastProps(e.x, e.y, e.z, e.r, e.v0);
    wrecks.explode(e.x, e.y, e.z, e.r, e.v0, null, e.source, true);   // the push (counted by the caller)
    if (TEST) testOut.events.push(['explode', e.kind, +simT.toFixed(2)]);
  }
  function blastProps(x, y, z, r, v0) {
    for (const pr of props.list) {
      const dx = pr.p[0] - x, dy = pr.p[1] - (y - 1), dz = pr.p[2] - z, d = Math.hypot(dx, dy, dz);
      if (d > r || pr.p[1] < -20) continue;
      const f = (1 - d / r) ** 2, s = v0 * f * Math.min(3, Math.sqrt(150 / pr.T.m));
      pr.v[0] += dx / d * s; pr.v[1] += (dy / d + 0.8) * s; pr.v[2] += dz / d * s;
      pr.w[0] += (Math.random() - 0.5) * 6 * f; pr.w[2] += (Math.random() - 0.5) * 6 * f;
      pr.awake = true; pr.still = 0; pr.awakeT = 0; pr.dirty = true;
      knocked(pr, null, [pr.p[0], pr.p[1], pr.p[2]]);
    }
  }
  const PROP_LABEL = { signalR: 'SIGNAL', signalG: 'SIGNAL', pump: 'PUMP', pane: 'WINDOW', shelter: 'BUS STOP', signal: 'SIGNAL', lamp: 'STREET LIGHT', newsbox: 'NEWS BOX', table: 'TABLE', hydrant: 'HYDRANT', bench: 'BENCH', bin: 'BIN', cone: 'CONE', barrel: 'BARREL', crate: 'CRATE' };
  // a prop knocked for the first time: its value, glass for a window, a fuse for a pump
  function knocked(pr, h, pos) {
    if (pr.paidOut) return;
    pr.paidOut = true;
    const val = VALUES.props[pr.type] || 0;
    if (val) wrecks.pay(val, PROP_LABEL[pr.type] || pr.type.toUpperCase(), pos[0], pos[1] + 1, pos[2], pr);
    if (pr.type === 'pane') {
      FX.glass(2, pos); look.embers.spawn(pos[0], pos[1], pos[2], 40, 'glass', [0, 0.5, 0]);
      pr.p[1] = -60; pr.awake = false; pr.dirty = true;   // shattered: gone
    }
    if (pr.type === 'pump' && !pumpsLit.has(pr)) { pumpsLit.add(pr); pending.push({ t: simT + 0.45, x: pr.p[0], y: pr.p[1], z: pr.p[2], kind: 'pump' }); }
  }
  function crashbreaker() {
    if (!playerWreck || cbUsed) return;
    cbUsed = true;
    const k = boostAtImpact, R0 = 12 + 10 * k, v0 = 18 + 10 * k, b = playerWreck;
    wrecks.ledger.explosions++;
    onExplode({ kind: 'crashbreaker', x: b.p[0], y: b.p[1], z: b.p[2], r: R0, v0, source: b });
    wrecks.wake(b); wrecks.applyImpulse(b, [0.3, -0.3, 0.2], [0, b.m * 9, 0]);
    wrecks.settle(b, Math.max(b.damage, 1.2), b.p);
    b.exploded = true;
  }

  // ---------------------------------------------------------------- the score on screen
  const popups = [];
  for (let i = 0; i < 28; i++) { const el = document.createElement('div'); el.className = 'pop'; el.style.opacity = 0; $('#popups').appendChild(el); popups.push({ el, alive: false }); }
  const PV = new T.Vector3();
  function popup(amount, label, x, y, z, ref) {
    // the same thing paying again within 0.4 s: one popup, added up; so do props of one kind going
    // at once near each other (a blast's windows: "WINDOW ×8")
    const prop = ref && ref.T;
    let p = ref ? popups.find(o => o.alive && o.age < 0.4 && (o.ref === ref || (prop && o.prop && o.label === label && Math.hypot(o.x - x, o.z - z) < 25))) : null;
    if (!p) { p = popups.find(o => !o.alive) || popups.reduce((a, b) => (a.age > b.age ? a : b)); p.amount = 0; p.age = 0; p.n = 0; p.x = x; p.y = y; p.z = z; }
    if (p.ref !== ref) p.n++;
    Object.assign(p, { alive: true, ref, label, prop });
    if (p.n <= 1) { p.x = x; p.y = y; p.z = z; }
    p.amount += amount;
    p.el.className = 'pop' + (p.amount >= 150000 ? ' huge' : p.amount >= 40000 ? ' big' : '');
    p.el.innerHTML = `+${money(p.amount)}${label ? `<small>${label}${p.n > 1 ? ' ×' + p.n : ''}</small>` : ''}`;
    if (amount >= 15000 && audio) FX.cash(amount >= 100000);
  }
  function updatePopups(dt) {
    const w = R.renderer.domElement.clientWidth, h = R.renderer.domElement.clientHeight;
    for (const p of popups) {
      if (!p.alive) continue;
      p.age += dt;
      if (p.age > 1.6) { p.alive = false; p.el.style.opacity = 0; continue; }
      PV.set(p.x, p.y + 0.8 + p.age * 1.5, p.z).project(R.camera);
      if (PV.z > 1) { p.el.style.opacity = 0; continue; }
      const sx = (PV.x * 0.5 + 0.5) * w, sy = (-PV.y * 0.5 + 0.5) * h, k = p.age < 0.12 ? 0.6 + p.age / 0.12 * 0.5 : p.age < 0.25 ? 1.1 - (p.age - 0.12) : 1;
      p.el.style.transform = `translate(${sx.toFixed(1)}px, ${sy.toFixed(1)}px) translate(-50%, -50%) scale(${k.toFixed(3)})`;
      p.el.style.opacity = p.age > 1.2 ? (1.6 - p.age) / 0.4 : 1;
    }
  }
  let callT = 0;
  function callout(text, cls, ms) {
    const el = $('#callout');
    el.textContent = text; el.className = 'callout ' + (cls || '');
    if (el.animate) el.animate([{ opacity: 0, transform: 'translate(-50%, -50%) scale(1.6)' }, { opacity: 1, transform: 'translate(-50%, -50%) scale(1)', offset: 0.15 }, { opacity: 1, transform: 'translate(-50%, -50%) scale(1.02)', offset: 0.8 }, { opacity: 0, transform: 'translate(-50%, -50%) scale(1.1)' }], { duration: ms || 1000, easing: 'ease-out' });
    callT = (ms || 1000) / 1000;
  }
  function toast(text, ms) { const el = $('#msg'); el.textContent = text; el.hidden = false; clearTimeout(toast.t); toast.t = setTimeout(() => { el.hidden = true; }, ms || 1200); }
  let shownTotal = 0;
  const medalOf = (v) => v >= level.medals.gold ? 'gold' : v >= level.medals.silver ? 'silver' : v >= level.medals.bronze ? 'bronze' : null;
  let lastMedal = null;
  function hud(dt) {
    const L = wrecks.ledger, total = tally ? tally.shown : L.total;
    // the total counts up toward the ledger (fast for big jumps)
    shownTotal += (total - shownTotal) * (1 - Math.exp(-dt * 9));
    if (Math.abs(total - shownTotal) < 1) shownTotal = total;
    $('#d-total').textContent = money(shownTotal);
    $('#d-mult').hidden = L.mult <= 1; $('#d-mult').textContent = '×' + L.mult;
    $('#d-cars').textContent = L.wrecked; $('#d-booms').textContent = L.explosions;
    const g = level.medals.gold * 1.15;
    $('#d-fill').style.width = Math.min(100, 100 * shownTotal / g).toFixed(1) + '%';
    const m = medalOf(shownTotal);
    if (m && m !== lastMedal && state !== 'tally') { for (const [k, id] of [['bronze', 'b'], ['silver', 's'], ['gold', 'g']]) if (shownTotal >= level.medals[k]) $('#goal-' + id).classList.add('got'); }
    lastMedal = m;
    $('#boost-fill').style.width = Math.round(boost * 100) + '%';
    $('#boost').classList.toggle('on', car.boosting && state === 'run');
    const canPause = PAUSABLE.includes(state);
    if ($('#btn-menu').hidden === canPause) $('#btn-menu').hidden = !canPause;
    $('#hud-speed').textContent = Math.round(Math.abs(car.forward) * 3.6);
    $('.hud-br .speedo').hidden = impactAt >= 0;   // (after the crash: the Crashbreaker and boost only)
    $('#hud-gear').textContent = car.reverse ? 'R' : car.gear;
    if (impactAt >= 0 && !cbUsed) {
      $('#cb').hidden = false;
      const f = Math.min(1, L.wrecked / 5);
      $('#cb-fill').style.width = Math.round(f * 100) + '%';
      if (f >= 1 && !cbReady && playerWreck) { cbReady = true; callout('Crashbreaker ready', 'cb', 1600); $('#cb').classList.add('ready'); if (TOUCH) $('#t-boost').textContent = 'BOOM'; }
    } else if (cbUsed) $('#cb').hidden = true;
  }
  function setupHud() {
    const M = level.medals, g = M.gold * 1.15;
    for (const [k, id] of [['bronze', 'b'], ['silver', 's'], ['gold', 'g']]) { $('#tick-' + id).style.left = (100 * M[k] / g).toFixed(1) + '%'; $('#goal-' + id).textContent = short(M[k]); }
    $('#d-best').textContent = best ? money(best.total) : '–';
  }

  // ---------------------------------------------------------------- the end: count up, medal, results
  function startTally() {
    state = 'tally';
    const L = wrecks.ledger;
    L.frozen = true;   // what happens from here on is for show
    tally = { t: 0, from: 0, to: L.total, shown: 0, medal: medalOf(L.total), stamped: false };
    shownTotal = 0;
    for (const g of ['b', 's', 'g']) $('#goal-' + g).classList.remove('got');
    FX.engineStop();
    if (TEST) testOut.total = L.total, testOut.ledger = { raw: L.raw, mult: L.mult, wrecked: L.wrecked, explosions: L.explosions, biggest: L.biggest };
  }
  function updateTally(dt) {
    const tl = tally;
    tl.t += dt;
    const k = Math.min(1, tl.t / 2.4), e = 1 - Math.pow(1 - k, 3);
    const prev = tl.shown;
    tl.shown = Math.round(tl.to * e);
    if (audio && Math.floor(prev / 50000) !== Math.floor(tl.shown / 50000) && tl.t < 2.4) FX.cash(false);
    for (const [m, id] of [['bronze', 'b'], ['silver', 's'], ['gold', 'g']]) if (tl.shown >= level.medals[m] && !$('#goal-' + id).classList.contains('got')) $('#goal-' + id).classList.add('got');
    if (k >= 1 && !tl.stamped) {
      tl.stamped = true;
      const L = wrecks.ledger;
      if (tl.medal) { callout(tl.medal, tl.medal, 1800); if (audio) FX.medal(tl.medal === 'gold' ? 3 : tl.medal === 'silver' ? 2 : 1); }
      const isBest = !best || L.total > best.total;
      if (isBest && !TEST) { best = { total: L.total, medal: tl.medal }; try { localStorage.setItem(bestKey, JSON.stringify(best)); } catch (e) { /* not kept */ } }
      setTimeout(() => showResults(isBest), 1500);
    }
    camAngle += dt * 0.12;
    R.orbit({ x: 0, z: -4, y: 0 }, camAngle, 46, 24, level);
  }
  function showResults(isBest) {
    const L = wrecks.ledger, m = medalOf(L.total);
    $('#results-title').textContent = money(L.total);
    const line = $('#results-medal');
    line.className = 'd-medal-line ' + (m || 'none');
    line.textContent = (m ? m + ' medal' : 'No medal') + (isBest && L.total > 0 ? ' · new best' : '');
    const next = !m ? ['bronze', level.medals.bronze] : m === 'bronze' ? ['silver', level.medals.silver] : m === 'silver' ? ['gold', level.medals.gold] : null;
    $('#results-list').innerHTML = [['Vehicles wrecked', L.wrecked], ['Explosions', L.explosions], ['Biggest hit', money(L.biggest)], ['Multiplier', '×' + L.mult], ['Impact speed', crash ? Math.round(crash.impactKmh) + ' km/h' : '–'],
      ['Best', best ? money(best.total) : '–']].concat(next ? [[`To ${next[0]}`, money(next[1] - L.total)]] : []).map(([k, v]) => `<dt>${k}</dt><dd>${v}</dd>`).join('');
    state = 'results';
    $('#results').hidden = false;
    setupHud();
  }

  // ---------------------------------------------------------------- the select screen
  let selRow = 0, selToken = 0, selBusy = false, selT = 0, lineup = null;
  function buildSelect() {
    // the garage lineup (garageui.js): each car's side view, all to one scale, in its signature paint
    lineup = GarageUI.lineup($('#sel-lineup'), Object.keys(CARS).map((k) => ({ key: k, name: CARS[k].name, paint: CARS[k].paint ? CARS[k].paint.hex : PAINTS[0].hex, phys: (window.CAR_PHYS || {})[k] || (window.RIG_PHYS || {})[k] })),
      (k) => { selRow = 0; chooseCar(k); });
    buildSwatches();
    const M = level.medals;
    $('#sel-goals').innerHTML = [['Bronze', M.bronze, 'var(--bronze)'], ['Silver', M.silver, 'var(--silver)'], ['Gold', M.gold, 'var(--gold)']].map(([k, v, c]) => `<dt style="--c:${c}">${k}</dt><dd>${money(v)}</dd>`).join('');
    $('#sel-levels').innerHTML = Object.entries(DestructionLevel.LEVELS).map(([k, D]) => `<button type="button" class="sel-car sel-level" role="radio" data-level="${k}"><b>${D.name}</b><span>${LEVEL_NOTES[k]}</span></button>`).join('');
    document.querySelectorAll('.sel-level').forEach((b) => b.addEventListener('click', () => { b.blur(); pickLevel(b.dataset.level); }));
    $('#sel-title').textContent = level.name;
    $('#btn-start').addEventListener('click', () => { $('#btn-start').blur(); startAttempt(); });
  }
  // the paint swatches, in two rows
  function buildSwatches() {
    $('#sel-swatches').innerHTML = PAINTS.map((p, i) => `<button type="button" class="swatch" role="radio" data-i="${i}" title="${p.name}" aria-label="${p.name}" style="background: #${p.hex.toString(16).padStart(6, '0')}"></button>`).join('');
    $('#sel-swatches').style.gridTemplateColumns = `repeat(${Math.ceil(PAINTS.length / 2)}, 1fr)`;
    document.querySelectorAll('.swatch').forEach((b) => b.addEventListener('click', () => { b.blur(); selRow = 1; pickPaint(+b.dataset.i); }));
  }
  function showSelect() {
    lineup.select(carKey);
    GarageUI.card($('#sel-card'), CARS[carKey]);
    document.querySelectorAll('.sel-level').forEach((b) => b.setAttribute('aria-checked', String(b.dataset.level === LEVEL)));
    document.querySelectorAll('.swatch').forEach((b, i) => b.setAttribute('aria-checked', String(i === paintIdx)));
    document.querySelectorAll('.sel-row').forEach((r) => r.classList.toggle('focus', +r.dataset.row === selRow));
    $('#sel-paint-name').textContent = paintNow().name;
    $('#sel-best').textContent = best ? `Your best: ${money(best.total)}${best.medal ? ' (' + best.medal + ')' : ''}` : 'No attempt yet.';
    $('#btn-start').disabled = selBusy;
  }
  async function chooseCar(key) {
    if (!CARS[key] || (key === carKey && !selBusy)) return;
    const token = ++selToken;
    carKey = key;
    paintIdx = key in paintFor ? paintFor[key] : homePaint(key);
    car = RaceCar.create(specs[key]); me.car = car;
    world.respec(me);
    placeCar(SHOW);
    selBusy = true; showSelect();
    FX.ui('move'); voiceFor(key);
    // a model not made yet waits for the pick to settle (stepping through the lineup doesn't decode each)
    if (!R.hasModel(key)) { await new Promise((r) => setTimeout(r, 250)); if (token !== selToken) return; }
    await R.preparePlayer(key, specs[key], paintNow().hex);
    if (token !== selToken) return;
    R.player.setPaint(paintNow().hex);
    selBusy = false; showSelect();
    FX.garage(CARS[key].sound);   // its engine starting or revving, if it has a recording
  }
  // the engine's recordings and rev range (fx.js): idle, redline, top speed (km/h, for the tank's tracks)
  function voiceFor(key) {
    const S = specs[key], t = S.tune || RaceCar.TUNE[key];
    FX.engineVoice(CARS[key].sound, S.rig === 'hover' ? 3000 : S.rig === 'tracked' ? 700 : 900, t.redline, t.vmax ? t.vmax * 3.6 : 250);
  }
  function pickPaint(i) { FX.ui('pick'); const n = PAINTS.length; paintIdx = paintFor[carKey] = (i + n) % n; if (!selBusy) R.player.setPaint(paintNow().hex); showSelect(); }
  // another junction: the page again with ?level= (the car and paint kept), once the music has faded out
  // (the menu song picks up where it was)
  function pickLevel(key) {
    if (key === LEVEL || !DestructionLevel.LEVELS[key] || state !== 'select') return;
    FX.ui('move');
    try { localStorage.setItem('destruction-level', key); localStorage.setItem('destruction-choice', JSON.stringify({ car: carKey, paint: paintIdx })); } catch (e) { /* not kept */ }
    const u = new URL(location.href); u.searchParams.set('level', key); Music.leave(() => { location.href = u.toString(); });
  }
  function updateSelect(inp) {
    if (inp.nav.y) { selRow = (selRow + inp.nav.y + 3) % 3; showSelect(); FX.ui('move'); }
    if (inp.nav.x && selRow === 0) { const keys = Object.keys(CARS); chooseCar(keys[(keys.indexOf(carKey) + inp.nav.x + keys.length) % keys.length]); }
    else if (inp.nav.x && selRow === 2) { const keys = Object.keys(DestructionLevel.LEVELS); pickLevel(keys[(keys.indexOf(LEVEL) + inp.nav.x + keys.length) % keys.length]); }
    else if (inp.nav.x) pickPaint(paintIdx + inp.nav.x);
    if (inp.start) startAttempt();
  }
  // preroll (s, optional; the trailer recorder): the countdown starts that long before the start, the
  // traffic already flowing
  function startAttempt(preroll) {
    if (selBusy) return;
    if (state === 'select') FX.ui('ok');
    if (!TEST) { try { localStorage.setItem('destruction-choice', JSON.stringify({ car: carKey, paint: paintIdx })); } catch (e) { /* not kept */ } }
    resetAttempt();
    if (preroll > 3) { traffic.reset(-preroll); simT = -preroll; }
    state = 'countdown';
    $('#select').hidden = true; $('#hud').hidden = false;
    setupHud();
  }
  function retry() { if (state === 'select') return; startAttempt(); }
  function toSelect() { resetAttempt(); placeCar(SHOW); state = 'select'; $('#results').hidden = true; $('#hud').hidden = true; $('#select').hidden = false; showSelect(); }

  // ---------------------------------------------------------------- the run: driving down
  function handleContact(e) {
    const mine = e.a === me || e.b === me;
    if (!mine) return;
    if (e.kind === 'land') {
      if (e.vn > 3) { FX.thud(Math.min(40, e.vn * 5), [e.x, car.y, e.z]); RaceInput.rumble(Math.min(1, e.vn / 10), 0.5, 140); if (e.vn > 5) look.embers.spawn(e.x, car.y + 0.1, e.z, 14, 'spark', [car.vx * 0.2, 0.4, car.vz * 0.2]); }
      return;
    }
    if (state !== 'run') return;
    if (car.kind === 'tracked') { if (e.vn > (e.kind === 'car' ? 2 : 4)) triggerCrash(e); return; }   // the tank: its first real contact
    let d = RaceWorld.hitDamage(e, me);
    if (simT - hurtAt < 0.15) { const x = Math.max(0, d - hurtD); hurtD = Math.max(hurtD, d); d = x; } else if (d > 0) { hurtAt = simT; hurtD = d; }
    if (d > 0) health = Math.max(0, health - d);
    if (d >= 0.06 || health <= 0) { triggerCrash(e); return; }
    if (e.vn > 2) { FX.hit(Math.min(4e5, e.J * 40), [e.x, car.y + 0.5, e.z]); look.embers.spawn(e.x, car.y + 0.45, e.z, Math.min(40, 8 + e.vn * 3), 'spark', [e.nx * 2, 1.5, e.nz * 2]); }
  }
  function collectPickups(x, y, z, reach) {
    level.pickups.forEach((p, i) => {
      if (taken.has(i)) return;
      const py = level.groundAt(p.x, p.z).h + p.y;
      if (Math.hypot(x - p.x, y - py, z - p.z) > p.r + reach) return;
      taken.add(i);
      look.embers.spawn(p.x, py, p.z, 40, 'spark', [0, 1, 0]);
      if (p.kind === 'cash') { wrecks.pay(p.amount, 'BONUS', p.x, py, p.z, null); callout('+' + short(p.amount), '', 900); }
      else { wrecks.ledger.mult = Math.min(8, wrecks.ledger.mult * p.mult); callout('×' + p.mult + ' multiplier', '', 1100); }
      if (audio) FX.cash(true);
      if (TEST) testOut.events.push(['pickup', p.kind, p.mult || p.amount, +simT.toFixed(2)]);
    });
  }

  // ---------------------------------------------------------------- the camera after the crash
  const focus = { x: 0, z: 0, y: 0, init: false };
  let boomFocus = null;
  function pileupCamera(dt) {
    let x = 0, z = 0, w = 0;
    if (playerWreck) { x += playerWreck.p[0] * 2; z += playerWreck.p[2] * 2; w += 2; }
    for (const b of wrecks.bodies) { if (!b.awake || b.kind === 'chunk') continue; const s = Math.min(3, Math.hypot(...b.v) / 4); x += b.p[0] * s; z += b.p[2] * s; w += s; }
    if (boomFocus && boomFocus.t > 0) { boomFocus.t -= dt; x += boomFocus.x * 6; z += boomFocus.z * 6; w += 6; }
    if (w > 0) { x /= w; z /= w; } else { x = focus.x; z = focus.z; }
    if (!focus.init) { focus.x = x; focus.z = z; focus.init = true; }
    const k = 1 - Math.exp(-dt * 1.6);
    focus.x += (x - focus.x) * k; focus.z += (z - focus.z) * k;
    focus.y = level.terrain(focus.x, focus.z);
    camAngle += dt * 0.16;
    R.orbit(focus, camAngle, 17, 6.5, level);
  }

  // ---------------------------------------------------------------- touch screens
  const upright = window.matchMedia('(orientation: portrait)');
  if (TOUCH) {
    RaceInput.bindTouch($('#touch'));
    window.addEventListener('pointerdown', () => { if (!audio) { FX.initAudio(); audio = true; } });
    if (document.fullscreenEnabled) {
      $('#btn-full').hidden = false;
      $('#btn-full').addEventListener('click', () => {
        if (document.fullscreenElement) { document.exitFullscreen(); return; }
        document.documentElement.requestFullscreen({ navigationUI: 'hide' }).then(() => screen.orientation && screen.orientation.lock && screen.orientation.lock('landscape')).catch(() => {});
      });
    }
  }
  // the pause menu (Esc, P, the controller's Menu button, the HUD's menu button or a phone's II):
  // carry on, retry, quit to the select screen, or leave for the other game mode or home
  function setPaused(on) { paused = on; $('#pause').hidden = !on; if (on) RaceInput.menuReset(); FX.ui('back'); }
  $('#btn-resume').addEventListener('click', () => { if (upright.matches && TOUCH) return; setPaused(false); });
  $('#btn-retry').addEventListener('click', () => { setPaused(false); retry(); });
  $('#btn-quit').addEventListener('click', () => { setPaused(false); toSelect(); });
  $('#btn-menu').addEventListener('click', () => { if (PAUSABLE.includes(state)) setPaused(true); });
  // a clicked button lets go of the keyboard focus (Enter or Space would press it again)
  document.querySelectorAll('#pause .btn, #results .btn, #btn-menu').forEach((b) => b.addEventListener('click', () => b.blur()));

  // ---------------------------------------------------------------- the loop
  let acc = 0, last = performance.now(), audio = false, prevSpin = 0, paused = false, stepN = 0, boostHeld = false;
  const PAUSABLE = ['countdown', 'run', 'impact', 'pileup'];
  let input = { steer: 0, throttle: 0, brake: 0 };
  // scripted attempts (?test=): full throttle down the right lane (ramp), the left (plain, tbone),
  // boosting from the start (tanker)
  function testInput() {
    const lane = TEST === 'ramp' ? -5.25 : -1.75, c = car;
    const steer = Math.max(-0.4, Math.min(0.4, (c.x - lane) * 0.25 - Math.sin(c.h - Math.PI / 2) * 1.2));
    return { throttle: 1, steer, boost: TEST === 'tanker' || TEST === 'ramp' ? boost > 0.01 : false };
  }
  // a director (the trailer recorder, tools/destruction-trailer.js) can drive the player and place the
  // camera; both stay null in the game
  const director = { input: null, camera: null };
  function playerInput() {
    if (state !== 'run') return { brake: 1 };
    if (director.input) return director.input(STEP);
    if (TEST) return testInput();
    return Object.assign({}, input, { boost: !!input.boost && boost > 0.01 });
  }
  function frame(now) {
    const dtReal = Math.min(0.1, (now - last) / 1000); last = now;
    if (TEST) testOut.frames.push([state, Math.round(dtReal * 1000)]);
    input = RaceInput.poll(dtReal);
    if (input.any && !audio) { FX.initAudio(); audio = true; }
    if (input.pause && PAUSABLE.includes(state)) setPaused(!paused);
    else if (paused) RaceInput.menu($('#pause'), input);   // arrows or the d-pad, Enter or A
    if (TOUCH) {
      const show = ['countdown', 'run', 'impact', 'pileup'].includes(state);
      if ($('#touch').hidden === show) $('#touch').hidden = !show;
      if (upright.matches && show && !paused) setPaused(true);
    }
    // the music (js/music.js): the menu song on the select screen, the junction's own song from the
    // countdown, the results song from the tally; quieter and muffled while paused or in the slow-motion impact
    Music.play(state === 'select' ? 'menu' : state === 'tally' || state === 'results' ? 'results' : 'destruction:' + LEVEL);
    Music.preload('destruction:' + LEVEL, 'results');
    Music.duck(paused ? 0.35 : state === 'impact' ? 0.5 : 1, paused || state === 'impact');
    if (state === 'select') updateSelect(input);
    if (state === 'results') { if (input.reset) retry(); else RaceInput.menu($('#results'), input); }   // Enter or A: the highlighted button (Retry first)
    else if (input.reset && ['countdown', 'run', 'impact', 'pileup', 'tally'].includes(state) && !paused) retry();
    const scale = slowmo > 0 ? 0.35 : 1;
    if (slowmo > 0) slowmo -= dtReal;
    const dt = dtReal * scale;
    if (!paused && state !== 'select' && state !== 'results') {
      // the countdown runs on the junction's clock (the traffic is already moving): Go at t = 0, so
      // every attempt starts from the same street
      if (state === 'countdown') {
        const n = Math.ceil(-simT - 1e-6);
        if (n !== countdown && n > 0 && n <= 3) { callout(String(n), '', 800); if (audio) FX.count(false); }
        countdown = n;
      }
      // the junction's own time: real time, but the impact's playback pace while the solver runs it
      let gameDt = dt;
      if (state === 'impact') gameDt = updateImpact(dtReal);
      if (state === 'pileup') handT += dt;
      acc += gameDt;
      if (state === 'run' || state === 'pileup') FX.setTimeScale(scale);
      while (acc >= STEP) {
        if (state === 'countdown' && simT > -STEP / 2) {
          state = 'run'; me.frozen = false; callout('Go!', '', 800); if (audio) { FX.count(true); FX.engineStart(); }
          if (TEST) (testOut.go = testOut.go || []).push(traffic.vehicles.length + '/' + traffic.vehicles.reduce((a, v) => a + v.s * (v.id + 1), 0).toFixed(6));
        }
        stepN++; acc -= STEP; simT += STEP;
        const obstacles = wrecks.bodies.filter(b => b.kind !== 'chunk' && b.kind !== 'proxy').map(b => ({ x: b.p[0], z: b.p[2], r: Math.max(b.hi[0] - b.lo[0], b.hi[2] - b.lo[2]) * 0.45 }))
          .concat(state === 'impact' ? crashUnits.filter(U => U.proxy).map(U => ({ x: U.proxy.p[0], z: U.proxy.p[2], r: 2.2 })) : []);
        traffic.step(STEP, simT - STEP, obstacles);
        const ev = world.step(STEP, (b) => b === me ? playerInput() : (b.traffic && !b.kinematic ? { brake: 0.6 } : null));
        for (const e of ev) handleContact(e);
        // light touches leave a traffic car free in the world: it's a wreck now
        for (const v of traffic.vehicles.concat(parked).slice()) if (!v.body.kinematic) wreckVehicle(v, 3);
        if (state === 'run') {
          tRun += STEP;
          if (car.boosting) boost = Math.max(0, boost - 0.2 * STEP);
          collectPickups(car.x, car.y + 0.7, car.z, 1.2);
          if (tRun > 30) { toast('No crash: retry for a score', 2500); startTally(); break; }
        }
        // the pile-up (120 Hz)
        if (stepN % 2 === 0 && state !== 'run' && state !== 'countdown') {
          const drivers = traffic.vehicles.concat(parked).map(driverBox);
          // the solver's cars run into traffic: those are wrecks now
          for (const U of crashUnits) if (U.proxy && U.proxy.p[1] > -40) for (const d of drivers) if (Math.hypot(d.x - U.proxy.p[0], d.z - U.proxy.p[2]) < d.hl + 2.6 && boxHit(d, U.proxy)) wreckVehicle(d.ref, Math.hypot(d.vx - U.proxy.v[0], d.vz - U.proxy.v[2]));
          const res = wrecks.step(STEP * 2, traffic.vehicles.concat(parked).map(driverBox));
          for (const t of res.touches) if (t.driver.ref && (traffic.vehicles.includes(t.driver.ref) || parked.includes(t.driver.ref))) wreckVehicle(t.driver.ref, t.vn * 1.2 * t.body.m / (t.body.m + t.driver.ref.body.car.m), [t.body.p[0], t.body.p[1], t.body.p[2]]);
          for (const ev2 of res.events) wreckEvent(ev2);
          if (playerWreck) collectPickups(playerWreck.p[0], playerWreck.p[1], playerWreck.p[2], 1.6);
        }
        // pumps going up
        for (let i = pending.length - 1; i >= 0; i--) if (pending[i].t <= simT) {
          const p = pending.splice(i, 1)[0], [Rr, v0] = W.BLAST.pump;
          onExplode({ kind: 'pump', x: p.x, y: p.y, z: p.z, r: Rr, v0, source: null });
          wrecks.ledger.explosions++;
          wrecks.pay(VALUES.explode.pump, 'PUMP BOOM', p.x, p.y + 2, p.z, null);
        }
        // props: driven into by the cars and by the wrecks
        const bodies = world.bodies.concat(adapterList());
        for (const h of props.step(STEP, bodies)) propHit(h);
      }
      if (state === 'pileup') {
        // the Crashbreaker: the boost button, once it's ready
        const press = !!input.boost && !boostHeld;
        boostHeld = !!input.boost;
        if ((press || (TEST && handT > 3)) && cbReady && !cbUsed && TEST !== 'plain') crashbreaker();
        const sinceCash = simT - lastCash;
        if ((handT > 7 && sinceCash > 4) || handT > 25) startTally();
      }
    }
    if (state === 'tally') updateTally(dtReal);
    // (scripted: how the wrecks carried on from the solver's last frame: their speed and place 50 ms on)
    if (TEST && testOut.hand && !testOut.handOff && simT - testOut.hand[0].t >= 0.05) testOut.handOff = testOut.hand.map(h => {
      const dt = simT - h.t, b = h.b;
      return { dp: +Math.hypot(b.p[0] - h.p[0] - h.v[0] * dt, b.p[2] - h.p[2] - h.v[2] * dt).toFixed(3), dv: +Math.hypot(b.v[0] - h.v[0], b.v[2] - h.v[2]).toFixed(2), v: +Math.hypot(h.v[0], h.v[2]).toFixed(2), dt: +dt.toFixed(3) };
    });
    // the cars that went through the solver: their shape, moved as their wrecks
    for (const b of wrecks.bodies) if (b.model) placeModel(b);
    for (const ch of chunks) placeChunk(ch);
    if (state === 'pileup' || state === 'tally') for (const U of crashUnits) U.model.updateDestruction(tPlayEnd + handT, U.view.frames.t.length - 1, U.view.frames.t.length - 1, 0), reposeChunks(U);
    // the player's car before the crash, and the camera
    if (state === 'select' || state === 'countdown' || state === 'run') {
      const p = car.pose, spinNow = car.wheels[2].spin;
      R.drawPlayer({ x: p.x, z: p.z, h: p.heading, pitch: car.pitch + car.gPitch, roll: (car.kind === 'bike' ? -car.lean : car.roll) + car.gRoll, lift: car.y, steer: car.steer, wheelie: car.wheelie, car }, spinNow - prevSpin);
      prevSpin = spinNow;
      if (state === 'select') { selT += dtReal; R.orbit({ x: car.x, z: car.z, y: car.y }, car.h + 0.35 + 0.3 * Math.sin(selT * 0.35), 6.4 * Math.max(1, specs[carKey].length / 4.86), 1.5, level); }
      else R.follow({ x: p.x, z: p.z, h: p.heading, y: car.y, speed: car.speed, boost: car.boosting }, dtReal);
    } else if (state === 'pileup') pileupCamera(dtReal);
    drawVehicles();
    R.drawProps();
    // fires on the burning wrecks, the lights of the traffic
    const fires = [];
    for (const b of wrecks.bodies) if (b.burn >= 0 && b.kind !== 'chunk' && b.kind !== 'proxy') {
      const L = b.hi[0] - b.lo[0], f = W.rot(b.q, [(b.lo[0] + b.hi[0]) / 2 + L * 0.25, 0, 0]);
      fires.push({ x: b.p[0] + f[0], y: b.p[1] + f[1], z: b.p[2] + f[2], level: Math.min(1, 0.4 + b.burn * 0.4) * (b.exploded ? 1.3 : 1), size: Math.min(4, L * 0.38), seed: b.id * 31 + 7 });
    }
    const lights = traffic.vehicles.map(v => { const d = driverBox(v); return { x: d.x, z: d.z, y: d.y, h: d.h, len: d.hl * 2, wid: d.hw * 2, heavy: !!traffic.HEAVY[v.type] }; });
    look.update(state === 'tally' || state === 'results' ? dtReal : dt, fires, lights, taken);
    if (audio) {
      const fireNear = fires.reduce((m, f) => Math.max(m, f.level * Math.max(0, 1 - Math.hypot(f.x - R.camera.position.x, f.z - R.camera.position.z) / 70)), 0);
      FX.fireUpdate(Math.min(1, fireNear), 0);
      FX.ambience(state === 'select' ? 0.6 : 1);
      // the lorries, buses and tankers nearest the camera idle where they are (recorded sounds only)
      const cam = R.camera.position;
      FX.trafficIdle(traffic.vehicles.filter((v) => traffic.HEAVY[v.type]).map((v) => { const c = v.body.car; return { x: c.x, y: c.y + 1, z: c.z, kmh: Math.hypot(c.vx, c.vz) * 3.6, d: Math.hypot(c.x - cam.x, c.z - cam.z) }; })
        .filter((v) => v.d < 45).sort((a, b) => a.d - b.d));
      if (state === 'run' || state === 'countdown') FX.engineUpdate(car.forward * 3.6, Math.max(car.throttle, input.throttle || 0), state === 'countdown' ? 900 + 4500 * (input.throttle || 0) : car.rpm);
    }
    if (director.camera) director.camera(dtReal, state);
    updatePopups(dtReal);
    if (wrecks) hud(dtReal);
    look.render();
    requestAnimationFrame(frame);
  }
  // does driving box d overlap the stand-in's footprint?
  function boxHit(d, P) {
    const f = W.rot(P.q, [1, 0, 0]), h = Math.atan2(f[2], f[0]), a = { x: P.p[0], z: P.p[2], hx: (P.hi[0] - P.lo[0]) / 2, hz: (P.hi[2] - P.lo[2]) / 2, angle: h }, b = { x: d.x, z: d.z, hx: d.hl, hz: d.hw, angle: d.h };
    const axes = [[Math.cos(a.angle), Math.sin(a.angle)], [-Math.sin(a.angle), Math.cos(a.angle)], [Math.cos(b.angle), Math.sin(b.angle)], [-Math.sin(b.angle), Math.cos(b.angle)]];
    for (const [ux, uz] of axes) {
      const ra = a.hx * Math.abs(Math.cos(a.angle) * ux + Math.sin(a.angle) * uz) + a.hz * Math.abs(-Math.sin(a.angle) * ux + Math.cos(a.angle) * uz);
      const rb = b.hx * Math.abs(Math.cos(b.angle) * ux + Math.sin(b.angle) * uz) + b.hz * Math.abs(-Math.sin(b.angle) * ux + Math.cos(b.angle) * uz);
      if (Math.abs((b.x - a.x) * ux + (b.z - a.z) * uz) > ra + rb) return false;
    }
    return true;
  }
  // the wrecks as the props see cars (props.js reads a car's box, speed and mass)
  function adapterList() {
    if (!wrecks) return [];
    const out = [];
    for (const b of wrecks.bodies) {
      if (!b.awake || b.kind === 'chunk' || b.kind === 'proxy' || Math.abs(b.v[0]) + Math.abs(b.v[2]) < 0.3) continue;
      let A = adapters.get(b);
      if (!A) {
        const L = b.hi[0] - b.lo[0], Wd = b.hi[2] - b.lo[2];
        A = { car: { spec: { xMin: -L / 2, length: L, width: Wd }, cgX: 0, m: b.m, applyImpulse: (px, pz, Jx, Jz) => wrecks.applyImpulse(b, [px - b.p[0], A.car.y + 0.5 - b.p[1], pz - b.p[2]], [Jx, 0, Jz]) }, kinematic: false, frozen: false, reach: Math.hypot(L, Wd) / 2, wreck: b };
        adapters.set(b, A);
      }
      const f = W.rot(b.q, [1, 0, 0]), c = W.rot(b.q, [(b.lo[0] + b.hi[0]) / 2, 0, (b.lo[2] + b.hi[2]) / 2]);
      Object.assign(A.car, { x: b.p[0] + c[0], z: b.p[2] + c[2], h: Math.atan2(f[2], f[0]), vx: b.v[0], vz: b.v[2], y: b.p[1] - (b.hi[1] - b.lo[1]) / 2 });
      out.push(A);
    }
    return out;
  }
  function propHit(h) {
    const pos = [h.x, h.y, h.z];
    if (h.prop.T.metal) { FX.clank(Math.min(30, h.prop.T.m / 4) * Math.min(1, h.vrel / 12), pos); look.embers.spawn(h.x, h.y, h.z, Math.min(18, 3 + Math.round(h.vrel)), 'spark', [0, 0.5, 0]); }
    else FX.hit(Math.min(8000, h.prop.T.m * h.vrel * 20), pos);
    if (h.first) knocked(h.prop, h, pos);
  }
  // what the pile-up reports
  function wreckEvent(e) {
    if (e.type === 'cash') { popup(e.amount, e.label, e.x, e.y, e.z, e.ref); lastCash = simT; if (TEST) testOut.events.push(['cash', Math.round(e.amount), e.label]); }
    else if (e.type === 'explode') { boomFocus = { x: e.x, z: e.z, t: 2 }; onExplodeVisual(e); }
    else if (e.type === 'hit' && e.dv > 6) { const d = R.camera.position.distanceTo(PV.set(e.x, e.y, e.z)); if (d < 90) FX.crunch(Math.min(1, e.dv / 20) * Math.max(0.3, 1 - d / 90), [e.x, e.y, e.z]); look.embers.spawn(e.x, e.y, e.z, Math.min(30, 4 + Math.round(e.dv)), 'spark', [0, 0.6, 0]); look.shake(Math.min(0.5, e.dv / 40), e.x, e.y, e.z); }
    else if (e.type === 'ignite') { if (e.body.kind === 'tanker') callout('It\'s going to blow!', 'cb', 900); }
  }
  // an explosion from inside the pile-up (a totalled vehicle or a tanker): the wrecks have had their
  // push; here the rest of the world gets it, and the show
  function onExplodeVisual(e) {
    const size = e.kind === 'tanker' ? 1.15 : e.kind === 'crashbreaker' ? 0.95 : e.kind === 'bus' || e.kind === 'truck' ? 0.6 : 0.42;
    look.blast(e.x, e.y, e.z, e.r, size);
    FX.explosion(size, [e.x, e.y, e.z]);
    RaceInput.rumble(Math.min(1, size), Math.min(1, size), 400 + 400 * size);
    if (e.kind === 'tanker') { slowmo = 0.7; callout('Tanker boom!', 'huge', 1400); }
    else if (size > 0.5) callout('Boom!', '', 900);
    for (const v of traffic.vehicles.concat(parked).slice()) { const c = v.body.car; if (Math.hypot(c.x - e.x, c.z - e.z) < e.r) { const b = wreckVehicle(v, 0); wrecks.explode(e.x, e.y, e.z, e.r, e.v0, null, null, true, b); } }
    blastProps(e.x, e.y, e.z, e.r, e.v0);
    if (TEST) testOut.events.push(['explode', e.kind, +simT.toFixed(2)]);
  }
  // the models the solver deformed, moved as their wrecks: (the wreck's pose now) x (its pose at the
  // hand-over)^-1, in the crash's lifted frame
  const MA = new T.Matrix4(), MB = new T.Matrix4(), QA = new T.Quaternion(), VA = new T.Vector3();
  function placeModel(b) {
    const lift = crash ? crash.lift : 0, g = b.model.group;
    MA.compose(VA.set(b.p[0], b.p[1] - lift, b.p[2]), QA.set(b.q[0], b.q[1], b.q[2], b.q[3]), S1);
    MB.compose(VA.set(b.hand.p[0], b.hand.p[1], b.hand.p[2]), QA.set(b.hand.q[0], b.hand.q[1], b.hand.q[2], b.hand.q[3]), S1).invert();
    g.matrix.multiplyMatrices(MA, MB); g.matrixWorldNeedsUpdate = true;
  }
  function placeChunk(ch) {
    const b = ch.b, lift = crash ? crash.lift : 0;
    // its rotation since the hand-over, about where it was
    const dq = W.qmul(b.q, [0, 0, 0, 1]);
    QA.set(dq[0], dq[1], dq[2], dq[3]);
    ch.g.quaternion.copy(QA).multiply(ch.gq);
    VA.set(ch.gp.x - ch.p0[0], ch.gp.y - ch.p0[1], ch.gp.z - ch.p0[2]).applyQuaternion(QA);
    ch.g.position.set(b.p[0] + VA.x, b.p[1] - lift + VA.y, b.p[2] + VA.z);
  }
  function reposeChunks(U) { for (const ch of chunks) placeChunk(ch); }

  // ---------------------------------------------------------------- start
  async function start() {
    $('#loading').textContent = 'Building the junction…';
    const workerMode = RaceCrash.prepare();
    await R.preparePlayer(carKey, specs[carKey], paintNow().hex);
    await R.prepareCars(['lexus', 'mustang'], 72);
    look.prepareHeavy(traffic.HEAVY, 16);
    look.patchCars(specs);
    R.prepareProps(props);
    await R.prepareWreck('lexus', specs.lexus);
    await R.prepareWreck('mustang', specs.mustang);
    for (const m of [R.wrecks.lexus, R.wrecks.mustang]) m.warm(R.renderer, R.camera);
    resetAttempt();
    drawVehicles();
    look.warm();
    await workerMode;
    $('#loading').hidden = true;
    voiceFor(carKey);
    // the results' buttons (also after a scripted ?test attempt, which has no select screen)
    $('#btn-again').addEventListener('click', () => { $('#btn-again').blur(); retry(); });
    $('#btn-car').addEventListener('click', () => { $('#btn-car').blur(); toSelect(); });
    setupHud();
    if (TEST) { $('#hud').hidden = false; state = 'countdown'; }
    else { buildSelect(); showSelect(); placeCar(SHOW); $('#hud').hidden = true; $('#select').hidden = false; state = 'select'; }
    requestAnimationFrame((t) => { last = t; frame(t); });
  }
  start().catch((err) => { $('#loading').textContent = 'Could not start: ' + err.message; console.error(err); });

  return { level, world, traffic, look, R, director, get wrecks() { return wrecks; }, get car() { return car; }, get state() { return state; }, get crash() { return crash; }, get simT() { return simT; }, get boost() { return boost; }, retry,
    start: startAttempt, popupsFor: () => updatePopups(0), get playerWreck() { return playerWreck; }, crashFocus: PT, get focus() { return focus; } };
})();
