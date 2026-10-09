/* The Hurricane Brawl game's match: storms moving over the globe, feeding on the terrain, brawling,
 * using their special moves and wrecking cities, until the time runs out. The most damage wins.
 *
 * Fixed steps of 1/60 s (step(inputs)); the same seed and inputs give the same match.
 *
 * A storm (storms.js for each type's numbers):
 *   energy   0-100, starts at 60. The terrain under its centre adds or takes energy every second;
 *            boost (x1.9 speed) costs 6 a second; at 0 the storm is gone (KO) and comes back 4 s
 *            later at a place that suits it, with 50 and 2.5 s of shield
 *   size     its radius grows with the square root of its energy, from rMin to rMax
 *   motion   on the sphere: it steers toward the direction it's given (its acceleration sets how
 *            quickly), carried by the prevailing winds, plus any knock-back (fading at 2.5/s)
 *   damage   every city and 1° cell of countryside within its radius loses a share of what is left of
 *            it every second: power x energy/100 x (1 - (d/r)^2) x the type's multiplier for that place,
 *            so a city hit again gives less; the storm is credited with what was lost (in US$)
 * A brawl: two storms closer than 0.7 x the sum of their radii orbit each other (the Fujiwhara
 *   effect: counter-clockwise in the north, clockwise in the south) and drain each other, each at
 *   12/s x its energy/100 x the matchup (x1.5 or x0.7) x the size ratio^0.5 x how deep the overlap is;
 *   the one draining the other faster takes in 40% of what the other loses. Ramming (boosting or dashing in faster
 *   than 250 km/s) hits harder and knocks the other back. A KO within 4 s of a hit is credited to
 *   the hitter, who takes in 25 energy.
 * Rebuilding: whatever is damaged gets 0.8% of what it lost back every second (half of it in about
 *   90 s), so a city wrecked early is worth hitting again later.
 * Energy surges: an orb every 18 s (two at most) gives the storm that reaches it 35 energy and
 *   five seconds at x1.3 speed.
 *
 * events: what happened this step, for the screen and the sound (cleared at the start of each step):
 *   { type: 'special', s, key }, { type: 'hit', a, b, amount, p }, { type: 'ko', s, by, p },
 *   { type: 'respawn', s }, { type: 'city', s, c, amount }, { type: 'devastated', s, c },
 *   { type: 'bolt', s, p }, { type: 'pickup', s, name }, { type: 'surge-spawn', id }, { type: 'brawl', a, b }
 *
 * DOM-free: global BrawlSim in the browser, module.exports in Node.
 */
const BrawlSim = (() => {
  'use strict';
  const E = BrawlEarth, S = BrawlStorms, R = E.R;
  const { dot, len, norm, cross, add, scale, tangent, toward, along, turn, dist } = E;
  const DT = 1 / 60;
  const MAX_E = 100, START_E = 60, RESPAWN_E = 50, RESPAWN = 4, SHIELD = 2.5;
  const BOOST = { mul: 1.9, cost: 6, min: 10 };
  const CONTACT = 0.7;
  const BRAWL = { drain: 12, absorb: 0.4, orbit: 220, ram: 250, ramHit: 10, knock: 700, pairCool: 0.7 };
  const KO = { credit: 4, gain: 25 };
  const SURGE = { first: 10, every: 18, max: 2, energy: 35, time: 5, speed: 1.3, names: ['Heat dome', 'Jet streak', 'Marine heatwave', 'Moisture plume'] };
  const DASH = { time: 0.9, speed: 3.2, damage: 2.5, hit: 2.2 };
  const REBUILD = 0.008;   // the share of what was lost that comes back each second

  // the prevailing winds at p (km/s, eastward positive): easterly trades, westerlies further out
  const windAt = (p) => { const lat = Math.asin(Math.max(-1, Math.min(1, p[1]))); return scale(E.east(p), -60 * Math.cos(3 * lat)); };
  const gainAt = (type, p) => S.TYPES[type].gain[E.TERRAINS[E.terrainAt(p)].key];
  const radius = (def, en) => def.rMin + (def.rMax - def.rMin) * Math.sqrt(Math.max(0, en) / MAX_E);

  // how hard a storm type hits a city (or a cell of countryside) there
  function cityMod(def, terrain, coastal) {
    const h = def.hits;
    let m = h[E.TERRAINS[terrain].key] || 1;
    if (coastal && h.coastal) m *= h.coastal;
    else if (!coastal && h.land) m *= h.land;
    return m;
  }
  let ruralCoastal = null;
  const ruralIsCoastal = () => {
    if (ruralCoastal) return ruralCoastal;
    ruralCoastal = new Uint8Array(E.RW * E.RH);
    for (let i = 0; i < ruralCoastal.length; i++) if (E.ruralValue[i]) ruralCoastal[i] = E.coastKmAt([E.ruralP[i * 3], E.ruralP[i * 3 + 1], E.ruralP[i * 3 + 2]]) < 100 ? 1 : 0;
    return ruralCoastal;
  };

  // where each type can start: 2° points with |lat| <= 62 where it gains 3/s or more, the best-placed
  // 35% of them (by the value of the cities within 2,500 km)
  let spawnPoints = null;
  function spawnsFor(type) {
    if (!spawnPoints) {
      spawnPoints = {};
      const pts = [];
      const cmin = Math.cos(2500 / R);
      for (let lat = -61; lat <= 61; lat += 2) for (let lon = -179; lon < 180; lon += 2) {
        const p = E.vec(lat, lon);
        let near = 0;
        for (const c of E.cities) if (dot(p, c.p) >= cmin) near += c.value;
        pts.push({ p, near, terrain: E.terrainAt(p) });
      }
      for (const k of S.ORDER) {
        const def = S.TYPES[k];
        const ok = pts.filter(q => def.gain[E.TERRAINS[q.terrain].key] >= 3).sort((a, b) => b.near - a.near);
        spawnPoints[k] = ok.slice(0, Math.max(8, Math.round(ok.length * 0.35))).map(q => q.p);
      }
    }
    return spawnPoints[type];
  }

  /* opts: { storms: [{ type, name, color, ai }], seed, duration (s) } */
  function create(opts) {
    const rand = E.rng(opts.seed == null ? 1 : opts.seed);
    const duration = opts.duration || 180;
    const nC = E.cities.length;
    const cityH = new Float32Array(nC).fill(1);
    const ruralH = new Float32Array(E.RW * E.RH).fill(1);
    const ruralBy = new Int8Array(E.RW * E.RH).fill(-1);   // the storm that last damaged each cell
    const coastalCell = ruralIsCoastal();
    const events = [], effects = [], surges = [];
    const pairs = new Map();   // 'a,b' -> { touching, cool }
    let time = 0, total = 0, over = false, nextSurge = SURGE.first, nextId = 1, ticks = 0;

    function spawnPoint(type, self) {
      const list = spawnsFor(type);
      const others = storms.filter(o => o !== self && o.alive && o.p).map(o => o.p);
      for (let tries = 0, minD = 3500; tries < 60; tries++) {
        const p = list[Math.floor(rand() * list.length)];
        if (others.every(q => dist(p, q) >= minD)) return p.slice();
        if (tries % 15 === 14) minD *= 0.7;
      }
      return list[Math.floor(rand() * list.length)].slice();
    }

    const storms = [];
    opts.storms.forEach((o, i) => {
      const def = S.TYPES[o.type];
      const s = {
        i, type: o.type, def, name: o.name, color: o.color, ai: !!o.ai,
        p: null, v: [0, 0, 0], k: [0, 0, 0], vel: [0, 0, 0], heading: [0, 0, 0],
        E: START_E, r: radius(def, START_E), alive: true, respawn: 0, shield: SHIELD,
        cool: 2, dashT: 0, slowT: 0, slow: 1, surgeT: 0, boosting: false,
        terrain: 0, gain: 0, lastHit: null, accum: new Map(),
        stats: { damage: 0, cityDamage: new Float64Array(nC), kos: 0, downs: 0, peak: 0, rams: 0, specials: 0, devastated: 0 },
      };
      storms.push(s);
      s.p = spawnPoint(o.type, s);
      s.heading = E.east(s.p);
      s.terrain = E.terrainAt(s.p); s.gain = def.gain[E.TERRAINS[s.terrain].key];
    });

    // ------------------------------------------------------------ damage to the Earth
    function credit(s, amount) { s.stats.damage += amount; total += amount; }
    function hitCity(s, c, x) {
      const h = cityH[c.i];
      if (h <= 0 || x <= 0) return 0;
      const nh = h * Math.exp(-x), amount = c.value * (h - nh);
      cityH[c.i] = nh;
      credit(s, amount);
      s.stats.cityDamage[c.i] += amount;
      const a = (s.accum.get(c.i) || 0) + amount;
      if (a >= Math.max(2e9, 0.03 * c.value)) { events.push({ type: 'city', s: s.i, c: c.i, amount: a }); s.accum.delete(c.i); } else s.accum.set(c.i, a);
      if (h >= 0.3 && nh < 0.3) { s.stats.devastated++; events.push({ type: 'devastated', s: s.i, c: c.i }); }
      return amount;
    }
    function hitRural(s, i, x) {
      const h = ruralH[i];
      if (h <= 0 || x <= 0) return 0;
      const nh = h * Math.exp(-x), amount = E.ruralValue[i] * (h - nh);
      ruralH[i] = nh;
      ruralBy[i] = s.i;
      credit(s, amount);
      return amount;
    }
    // a storm's footprint: rate(d) per second at distance d, for dt seconds, cities and countryside
    function sweep(s, p, r, rate, dt, ruralShare = 0.8) {
      E.citiesNear(p, r, (c, d) => { const f = rate(d); if (f > 0) hitCity(s, c, f * cityMod(s.def, c.terrain, c.coastal) * dt); });
      E.ruralNear(p, r, (i, d) => { const f = rate(d); if (f > 0) hitRural(s, i, f * ruralShare * cityMod(s.def, E.ruralTerrain[i], coastalCell[i]) * dt); });
    }
    // flush what each storm has piled up on cities since its last event (after a burst)
    function flush(s) { for (const [c, a] of s.accum) if (a > 1e8) events.push({ type: 'city', s: s.i, c, amount: a }); s.accum.clear(); }

    // ------------------------------------------------------------ hits between storms
    function drain(x, y, amount, kind) {
      if (!y.alive || y.shield > 0 || amount <= 0) return 0;
      y.E -= amount;
      y.lastHit = { by: x.i, t: time };
      if (kind) events.push({ type: 'hit', a: x.i, b: y.i, amount, kind, p: norm(add(x.p, y.p)) });
      return amount;
    }
    // push y away from point q (or along direction u at y) at speed
    function knock(y, q, speed) {
      if (!y.alive || y.shield > 0) return;
      const u = scale(toward(y.p, q), -1);
      y.k = add(y.k, u, speed);
    }

    // ------------------------------------------------------------ special moves
    function cast(s, inp) {
      const I = s.E / MAX_E, key = s.def.special.key;
      s.cool = s.def.special.cooldown;
      s.stats.specials++;
      events.push({ type: 'special', s: s.i, key });
      if (key === 'surge') {
        effects.push({ id: nextId++, kind: 'surge', owner: s.i, p: s.p.slice(), t: 0, dur: 1, r0: s.r * 0.6, r1: s.r * 2.4, prev: 0, I, hit: new Set() });
      } else if (key === 'dash') {
        s.dashT = DASH.time;
        if (inp.dir && len(inp.dir) > 0.1) s.heading = norm(tangent(s.p, inp.dir));
        effects.push({ id: nextId++, kind: 'dash', owner: s.i, t: 0, dur: DASH.time });
      } else if (key === 'whiteout') {
        effects.push({ id: nextId++, kind: 'whiteout', owner: s.i, t: 0, dur: 5, I, r: s.r * 2.4 });
      } else if (key === 'haboob') {
        const u = inp.dir && len(inp.dir) > 0.1 ? norm(tangent(s.p, inp.dir)) : s.heading.slice();
        effects.push({ id: nextId++, kind: 'haboob', owner: s.i, p: along(s.p, u, s.r * 0.6), u, t: 0, dur: 1.4, speed: 1500, half: s.r * 1.8, I, hit: new Set(), cities: new Set(), cells: new Set() });
      } else if (key === 'lightning') {
        const target = lightningTarget(s, inp.aim);
        const bolts = [0.15, 0.4, 0.65].map((at, n) => ({ at, done: false, p: n === 0 ? target : along(target, turn(target, E.north(target), rand() * 6.283), 60 + rand() * 120) }));
        effects.push({ id: nextId++, kind: 'lightning', owner: s.i, target, t: 0, dur: 0.9, I, bolts });
      } else if (key === 'firestorm') {
        const patches = [s.p.slice()];
        for (let n = 0; n < 6; n++) patches.push(along(s.p, turn(s.p, s.heading, n * Math.PI / 3), s.r * 1.4));
        effects.push({ id: nextId++, kind: 'fire', owner: s.i, patches, pr: s.r * 0.75, t: 0, dur: 7, I });
      }
    }
    const RANGE = 2600;
    function lightningTarget(s, aim) {
      if (aim) {
        const d = dist(s.p, aim);
        return d <= RANGE ? norm(aim) : along(s.p, toward(s.p, aim), RANGE);
      }
      // the nearest rival in range, else 1,200 km ahead
      let best = null, bd = RANGE;
      for (const o of storms) if (o !== s && o.alive) { const d = dist(s.p, o.p); if (d < bd) { bd = d; best = o; } }
      return best ? best.p.slice() : along(s.p, s.heading, 1200);
    }

    function stepEffects() {
      for (let n = effects.length - 1; n >= 0; n--) {
        const f = effects[n], s = storms[f.owner];
        f.t += DT;
        if (f.kind === 'surge') {
          const Rn = f.r0 + (f.r1 - f.r0) * Math.pow(Math.min(1, f.t / f.dur), 0.6);
          for (const y of storms) {
            if (y === s || !y.alive || f.hit.has(y.i)) continue;
            const d = dist(f.p, y.p);
            if (d < Rn + y.r * 0.3) { f.hit.add(y.i); drain(s, y, 20 * f.I * S.matchup(s.type, y.type), 'surge'); knock(y, f.p, 700 * (1 - 0.5 * d / f.r1)); }
          }
          // the ring floods what it passes over (coastal cities most: the type's multiplier)
          const prev = f.prev;
          sweep(s, f.p, Rn, (d) => d >= prev ? 0.2 * f.I * (1 - 0.5 * d / f.r1) : 0, 1, 0.6);
          f.prev = Rn;
          if (f.t >= f.dur) flush(s);
        } else if (f.kind === 'whiteout') {
          if (!s.alive) { effects.splice(n, 1); continue; }
          f.r = s.r * 2.4;
          for (const y of storms) {
            if (y === s || !y.alive) continue;
            if (dist(s.p, y.p) < f.r) { y.slowT = Math.max(y.slowT, 0.3); y.slow = Math.min(y.slow, 0.45); if (drain(s, y, 5 * S.matchup(s.type, y.type) * DT)) s.E += DT; }
          }
          sweep(s, s.p, f.r, (d) => 0.05 * f.I * (1 - d / f.r), DT);
        } else if (f.kind === 'haboob') {
          const step = f.speed * DT;
          f.p = along(f.p, f.u, step);
          f.u = norm(tangent(f.p, f.u));
          const side = cross(f.p, f.u);
          const rel = (q) => { const w = add(q, f.p, -1); return [dot(w, f.u) * R, dot(w, side) * R]; };
          for (const y of storms) {
            if (y === s || !y.alive || f.hit.has(y.i)) continue;
            const [a, c] = rel(y.p);
            if (Math.abs(a) < 200 + y.r * 0.3 && Math.abs(c) < f.half + y.r * 0.3) {
              f.hit.add(y.i);
              drain(s, y, 16 * f.I * S.matchup(s.type, y.type), 'haboob');
              y.k = add(y.k, tangent(y.p, f.u), 650);
              y.slowT = Math.max(y.slowT, 1.5); y.slow = Math.min(y.slow, 0.7);
            }
          }
          E.citiesNear(f.p, f.half + 200, (c) => {
            if (f.cities.has(c.i)) return;
            const [a, b] = rel(c.p);
            if (Math.abs(a) < 200 && Math.abs(b) < f.half) { f.cities.add(c.i); hitCity(s, c, 0.25 * f.I * cityMod(s.def, c.terrain, c.coastal)); }
          });
          E.ruralNear(f.p, f.half + 200, (i) => {
            if (f.cells.has(i)) return;
            const [a, b] = rel([E.ruralP[i * 3], E.ruralP[i * 3 + 1], E.ruralP[i * 3 + 2]]);
            if (Math.abs(a) < 200 && Math.abs(b) < f.half) { f.cells.add(i); hitRural(s, i, 0.2 * f.I * cityMod(s.def, E.ruralTerrain[i], coastalCell[i])); }
          });
          if (f.t >= f.dur) flush(s);
        } else if (f.kind === 'lightning') {
          for (const b of f.bolts) {
            if (b.done || f.t < b.at) continue;
            b.done = true;
            events.push({ type: 'bolt', s: s.i, p: b.p });
            for (const y of storms) {
              if (y === s || !y.alive) continue;
              const d = dist(b.p, y.p);
              if (d < 320 + y.r * 0.3) { drain(s, y, 9 * f.I * S.matchup(s.type, y.type), 'bolt'); knock(y, b.p, 250); }
            }
            sweep(s, b.p, 240, (d) => 0.22 * f.I * (1 - 0.6 * d / 240), 1, 0.75);
            flush(s);
          }
        } else if (f.kind === 'fire') {
          for (const y of storms) {
            if (y === s || !y.alive) continue;
            if (f.patches.some(q => dist(q, y.p) < f.pr + y.r * 0.3)) drain(s, y, 6 * S.matchup(s.type, y.type) * DT);
          }
          for (const q of f.patches) sweep(s, q, f.pr, (d) => 0.1 * f.I * (1 - (d / f.pr) * (d / f.pr)), DT, 0.75);
          if (f.t >= f.dur) flush(s);
        }
        if (f.t >= f.dur) effects.splice(n, 1);
      }
    }

    // ------------------------------------------------------------ one step
    function step(inputs) {
      events.length = 0;
      if (over) return;
      time += DT;
      // energy surges
      if (time >= nextSurge) {
        nextSurge += SURGE.every;
        if (surges.length < SURGE.max) {
          for (let tries = 0; tries < 40; tries++) {
            const p = E.vec(Math.asin(rand() * 2 - 1) / E.DEG * 0.66, rand() * 360 - 180);
            if (storms.every(s => !s.alive || dist(p, s.p) > 1500)) { const id = nextId++; surges.push({ id, p, name: SURGE.names[Math.floor(rand() * SURGE.names.length)], t: time }); events.push({ type: 'surge-spawn', id }); break; }
          }
        }
      }
      for (const s of storms) {
        if (!s.alive) {
          s.respawn -= DT;
          if (s.respawn <= 0) {
            s.alive = true; s.p = spawnPoint(s.type, s); s.E = RESPAWN_E; s.shield = SHIELD;
            s.v = [0, 0, 0]; s.k = [0, 0, 0]; s.heading = E.east(s.p); s.dashT = 0; s.slowT = 0; s.cool = Math.min(s.cool, 2);
            s.terrain = E.terrainAt(s.p); s.gain = s.def.gain[E.TERRAINS[s.terrain].key]; s.r = radius(s.def, s.E);
            events.push({ type: 'respawn', s: s.i });
          }
          continue;
        }
        const inp = inputs[s.i] || {};
        s.cool = Math.max(0, s.cool - DT); s.shield = Math.max(0, s.shield - DT); s.dashT = Math.max(0, s.dashT - DT); s.surgeT = Math.max(0, s.surgeT - DT);
        s.slowT = Math.max(0, s.slowT - DT); if (!s.slowT) s.slow = 1;
        s.terrain = E.terrainAt(s.p);
        s.gain = s.def.gain[E.TERRAINS[s.terrain].key];
        s.E += s.gain * DT;
        if (inp.special && s.cool <= 0) cast(s, inp);
        s.boosting = !!inp.boost && s.E > BOOST.min && !s.dashT;
        if (s.boosting) s.E -= BOOST.cost * DT;
        let dir = inp.dir ? tangent(s.p, inp.dir) : [0, 0, 0];
        const dl = len(dir);
        dir = dl > 1e-6 ? scale(dir, 1 / dl) : [0, 0, 0];
        let mag = dl > 1e-6 ? Math.max(0, Math.min(1, inp.mag == null ? 1 : inp.mag)) : 0;
        let speed = s.def.speed * (s.boosting ? BOOST.mul : 1) * (s.surgeT > 0 ? SURGE.speed : 1);
        if (s.dashT > 0) { dir = s.heading; mag = 1; speed = s.def.speed * DASH.speed; }
        speed *= s.slowT > 0 ? s.slow : 1;
        const a = 1 - Math.exp(-s.def.accel * (s.dashT > 0 ? 4 : 1) * DT);
        s.v = add(s.v, add(scale(dir, speed * mag), s.v, -1), a);
        if (mag > 0.1) s.heading = norm(add(s.heading, add(dir, s.heading, -1), Math.min(1, 8 * DT)));
        s.k = scale(s.k, Math.exp(-2.5 * DT));
        s.vel = add(add(s.v, s.k), windAt(s.p), s.def.drift);
        // along the surface, then carry the vectors into the new tangent plane
        const moved = norm(add(s.p, s.vel, DT / R));
        const carry = (w) => { const l = len(w); if (l < 1e-9) return [0, 0, 0]; const t = tangent(moved, w), lt = len(t); return lt < 1e-9 ? [0, 0, 0] : scale(t, l / lt); };
        s.p = moved; s.v = carry(s.v); s.k = carry(s.k); s.heading = norm(carry(s.heading));
        if (len(s.heading) < 0.5) s.heading = E.east(s.p);
        s.r = radius(s.def, s.E);
      }
      // brawls
      for (let i = 0; i < storms.length; i++) for (let j = i + 1; j < storms.length; j++) {
        const a = storms[i], b = storms[j], key = i + ',' + j;
        let pr = pairs.get(key);
        if (!pr) { pr = { touching: false, cool: 0 }; pairs.set(key, pr); }
        pr.cool = Math.max(0, pr.cool - DT);
        if (!a.alive || !b.alive) { pr.touching = false; continue; }
        const d = dist(a.p, b.p), reach = (a.r + b.r) * CONTACT;
        if (d >= reach) { pr.touching = false; continue; }
        const ov = 1 - d / reach;
        if (!pr.touching) events.push({ type: 'brawl', a: i, b: j });
        pr.touching = true;
        const mid = norm(add(a.p, b.p)), hemi = mid[1] < 0 ? -1 : 1;
        const dealt = [];
        for (const [x, y] of [[a, b], [b, a]]) {
          const tm = toward(x.p, mid);
          const orbit = scale(cross(x.p, tm), -hemi);
          x.k = add(x.k, orbit, BRAWL.orbit * ov * 3 * DT);
          if (d < reach * 0.35) x.k = add(x.k, tm, -300 * DT);   // not right on top of each other
          const m = S.matchup(x.type, y.type), size = Math.max(0.6, Math.min(1.6, Math.sqrt(x.r / y.r)));
          dealt.push(drain(x, y, BRAWL.drain * (x.E / MAX_E) * m * size * ov * (y.dashT > 0 ? 0.5 : 1) * (x.dashT > 0 ? 1.5 : 1) * DT));
        }
        // the one winning the exchange takes in part of what the other loses
        if (dealt[0] > dealt[1]) a.E += dealt[0] * BRAWL.absorb; else if (dealt[1] > dealt[0]) b.E += dealt[1] * BRAWL.absorb;
        // a ram: boosting or dashing in fast
        if (!pr.cool) {
          const u = toward(a.p, b.p);
          const closing = dot(a.vel, u) - dot(b.vel, u);
          for (const [x, y] of [[a, b], [b, a]]) {
            if (!(x.boosting || x.dashT > 0) || Math.abs(closing) < BRAWL.ram) continue;
            const m = S.matchup(x.type, y.type);
            if (drain(x, y, BRAWL.ramHit * (x.E / MAX_E) * m * (x.dashT > 0 ? DASH.hit : 1), x.dashT > 0 ? 'dash' : 'ram')) {
              knock(y, x.p, BRAWL.knock * (x.dashT > 0 ? 1.15 : 1));
              knock(x, y.p, 200);
              x.stats.rams++;
              pr.cool = BRAWL.pairCool;
            }
          }
        }
      }
      stepEffects();
      // energy surges collected
      for (let n = surges.length - 1; n >= 0; n--) {
        const g = surges[n];
        const s = storms.find(o => o.alive && dist(o.p, g.p) < o.r * 0.6 + 150);
        if (s) { s.E += SURGE.energy; s.surgeT = SURGE.time; surges.splice(n, 1); events.push({ type: 'pickup', s: s.i, name: g.name, id: g.id }); }
      }
      // the damage each storm does where it is
      for (const s of storms) {
        if (!s.alive) continue;
        const I = Math.max(0, s.E) / MAX_E, pw = s.def.power * I * (s.dashT > 0 ? DASH.damage : 1), r = s.r;
        sweep(s, s.p, r, (d) => pw * (1 - (d / r) * (d / r)), DT);
      }
      // gone?
      for (const s of storms) {
        if (!s.alive) continue;
        s.E = Math.min(MAX_E, s.E);
        s.stats.peak = Math.max(s.stats.peak, S.category(s.E));
        if (s.E > 0) continue;
        s.alive = false; s.E = 0; s.respawn = RESPAWN; s.stats.downs++;
        flush(s);
        const by = s.lastHit && time - s.lastHit.t < KO.credit && s.lastHit.by !== s.i ? s.lastHit.by : -1;
        if (by >= 0 && storms[by].alive) { storms[by].stats.kos++; storms[by].E = Math.min(MAX_E, storms[by].E + KO.gain); }
        events.push({ type: 'ko', s: s.i, by, p: s.p.slice() });
      }
      // rebuilding: cities every step, the countryside every half second
      for (let c = 0; c < nC; c++) if (cityH[c] < 1) cityH[c] += (1 - cityH[c]) * REBUILD * DT;
      if (++ticks % 30 === 0) for (let c = 0; c < ruralH.length; c++) if (ruralH[c] < 1) ruralH[c] += (1 - ruralH[c]) * REBUILD * 30 * DT;
      if (time >= duration) { over = true; for (const s of storms) flush(s); }
    }

    const ranking = () => storms.slice().sort((a, b) => b.stats.damage - a.stats.damage);
    return {
      storms, events, effects, surges, cityH, ruralH, ruralBy, duration, step, ranking,
      get time() { return time; }, get total() { return total; }, get over() { return over; },
      get left() { return Math.max(0, duration - time); }, rand,
    };
  }

  return { create, DT, MAX_E, BOOST, CONTACT, BRAWL, SURGE, DASH, RESPAWN, REBUILD, windAt, gainAt, radius, cityMod, RANGE: 2600 };
})();
if (typeof module === 'object' && module.exports) module.exports = BrawlSim;
