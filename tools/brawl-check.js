/* Checks for the Hurricane Brawl game's DOM-free parts, in Node:
 *   node tools/brawl-check.js           all checks
 *   node tools/brawl-check.js brawl     only checks whose name contains "brawl"
 *
 * earth:      the mask decodes to its size; a third of the cells are land; known places have the
 *             terrain they should (London, the mid-Pacific, the Sahara, Antarctica ...); every city is
 *             on land or within 60 km of it; the countryside is worth 30% of the cities
 * queries:    citiesNear and ruralNear find exactly what a search of everything finds, near the poles
 *             and across 180° too; along, toward and dist agree
 * motion:     a storm steered east stays on the sphere and moves at its speed (plus the wind); boost
 *             is x1.9 and costs energy
 * terrain:    a hurricane gains over warm ocean and loses over land; a tornado the other way
 * damage:     a storm parked on Tokyo wrecks it, the damage credited is what Tokyo lost (rebuilding
 *             aside), health stays in 0-1, and the storms' totals add up to the Earth's
 * brawl:      two equal storms drain each other equally; the matchup favours the one that beats the
 *             other; storms locked together orbit counter-clockwise in the north and clockwise in the
 *             south (the Fujiwhara effect); a KO after a hit is credited and the storm comes back 4 s
 *             later with 50 energy and a shield
 * specials:   each type's move does what it says to a rival placed for it, and nothing out of reach
 * match:      a full three-minute match with six AI storms at each level: no NaN, every storm scores,
 *             it ends on time, and the same seed gives the same match
 * balance:    over six matches, each type's average damage is within x0.5-x2 of the mean (printed)
 * Exits non-zero on any failure.
 */
'use strict';
const path = require('path');
global.BRAWL_EARTH_DATA = require(path.join(__dirname, '../js/brawl/earth-data.js'));
global.BrawlEarth = require(path.join(__dirname, '../js/brawl/earth.js'));
global.BrawlStorms = require(path.join(__dirname, '../js/brawl/storms.js'));
global.BrawlSim = require(path.join(__dirname, '../js/brawl/sim.js'));
global.BrawlAI = require(path.join(__dirname, '../js/brawl/ai.js'));
const E = BrawlEarth, S = BrawlStorms, Sim = BrawlSim, AI = BrawlAI;
const filter = process.argv[2];
let failures = 0;
const check = (name, ok, detail) => { console.log(`=== ${name}: ${detail} ${ok ? 'OK' : 'PROBLEM'}`); if (!ok) failures++; };
const want = (name) => !filter || name.includes(filter);
const fmt = (v) => '$' + (v / 1e12).toFixed(2) + 'T';

// a match with the given storms, each placed (lat, lon) with energy E, and no AI
function setup(list, seed = 1) {
  const sim = Sim.create({ seed, duration: 600, storms: list.map((o, i) => ({ type: o.type, name: 'T' + i, color: '#fff' })) });
  list.forEach((o, i) => {
    const s = sim.storms[i];
    s.p = E.vec(o.lat, o.lon); s.heading = E.east(s.p); s.E = o.E == null ? 80 : o.E; s.r = Sim.radius(s.def, s.E);
    s.shield = 0; s.cool = 0;
  });
  return sim;
}
const run = (sim, secs, inputs = () => []) => { for (let t = 0; t < secs * 60 && !sim.over; t++) sim.step(inputs(t)); };

if (want('earth')) {
  const land = E.mask.reduce((n, v) => n + (v === 1), 0) / E.mask.length;
  check('earth-mask', E.mask.length === E.MW * E.MH && land > 0.28 && land < 0.37, `${E.MW} x ${E.MH} cells, ${(land * 100).toFixed(1)}% land`);
  const places = [
    ['London', 51.5, -0.1, 'plains'], ['mid-Pacific', 0, -150, 'warm'], ['Sahara', 23, 10, 'desert'], ['Antarctica', -80, 0, 'ice'],
    ['Kansas', 38, -98, 'plains'], ['Amazon', -3, -60, 'jungle'], ['Siberia', 62, 100, 'tundra'], ['North Atlantic', 50, -30, 'cold'],
    ['Gulf of Mexico', 25, -90, 'warm'], ['Lake Victoria', -1, 33, 'lake'], ['Greenland', 72, -40, 'ice'], ['off California', 30, -125, 'sea'],
    ['Philippine Sea', 18, 130, 'warm'], ['Outback', -25, 133, 'desert'], ['Perth', -31.9, 115.9, 'plains'],
  ];
  const wrong = places.filter(([, la, lo, k]) => E.TERRAINS[E.terrainAt(E.vec(la, lo))].key !== k);
  check('earth-terrain', !wrong.length, `${places.length - wrong.length} of ${places.length} places right` + (wrong.length ? ': wrong ' + wrong.map(w => `${w[0]} (${E.TERRAINS[E.terrainAt(E.vec(w[1], w[2]))].key})`).join(', ') : ''));
  // each city has land (in the full mask) within 60 km
  const landNear = (c) => {
    const dy = 60 / 111.2, dx = dy / Math.cos(c.lat * E.DEG);
    for (let la = c.lat - dy; la <= c.lat + dy; la += 180 / E.MH) for (let lo = c.lon - dx; lo <= c.lon + dx; lo += 360 / E.MW * Math.max(1, Math.cos(c.lat * E.DEG))) if (E.maskAt(la, lo) === 1 && E.dist(c.p, E.vec(la, lo)) <= 60) return true;
    return false;
  };
  const far = E.cities.filter(c => !landNear(c));
  check('earth-cities', E.cities.length > 800 && far.length === 0, `${E.cities.length} cities, ${far.length} more than 60 km from land` + (far.length ? ': ' + far.slice(0, 5).map(c => c.name).join(', ') : ''));
  check('earth-values', Math.abs(E.ruralTotal / E.cityValue - 0.3) < 1e-9, `cities ${fmt(E.cityValue)}, countryside ${fmt(E.ruralTotal)} (${(E.ruralTotal / E.cityValue * 100).toFixed(1)}%)`);
}

if (want('queries')) {
  const rnd = E.rng(42);
  const pts = [E.vec(89.5, 10), E.vec(-88, -170), E.vec(10, 179.5), E.vec(-35, -179.9), E.vec(60, 0)];
  for (let i = 0; i < 40; i++) pts.push(E.vec(Math.asin(rnd() * 2 - 1) / E.DEG, rnd() * 360 - 180));
  let bad = 0, n = 0;
  for (const p of pts) for (const km of [150, 700, 2600]) {
    const a = new Set(), b = new Set();
    E.citiesNear(p, km, (c) => a.add(c.i));
    for (const c of E.cities) if (E.dist(p, c.p) <= km) b.add(c.i);
    const ra = new Set(), rb = new Set();
    E.ruralNear(p, km, (i) => ra.add(i));
    for (let i = 0; i < E.RW * E.RH; i++) if (E.ruralValue[i] && E.dist(p, [E.ruralP[i * 3], E.ruralP[i * 3 + 1], E.ruralP[i * 3 + 2]]) <= km - 1e-6) rb.add(i);
    const same = (x, y) => x.size === y.size && [...x].every(v => y.has(v));
    // the countryside: a cell within float rounding of the edge may go either way
    const close = (x, y) => [...y].every(v => x.has(v)) && x.size - y.size <= 2;
    if (!same(a, b) || !close(ra, rb)) bad++;
    n += b.size;
  }
  check('queries-near', bad === 0, `${pts.length} points x 3 radii (${n} cities found in all), ${bad} different from a full search`);
  let worst = 0;
  for (let i = 0; i < 200; i++) {
    const p = E.vec(Math.asin(rnd() * 2 - 1) / E.DEG, rnd() * 360 - 180), u = E.turn(p, E.north(p), rnd() * 6.283), d = rnd() * 9000;
    const q = E.along(p, u, d);
    worst = Math.max(worst, Math.abs(E.dist(p, q) - d), d > 1 && d < 19000 ? E.len(E.add(E.toward(p, q), u, -1)) * 1000 : 0);
  }
  check('queries-geometry', worst < 0.01, `along / dist / toward agree within ${worst.toExponential(1)} km`);
}

if (want('motion')) {
  const sim = setup([{ type: 'supercell', lat: 30, lon: -40, E: 80 }]);
  const s = sim.storms[0];
  let maxErr = 0;
  const p0 = s.p.slice();
  run(sim, 6, () => [{ dir: E.east(s.p), mag: 1 }]);
  for (let t = 0; t < 60; t++) { sim.step([{ dir: E.east(s.p), mag: 1 }]); maxErr = Math.max(maxErr, Math.abs(E.len(s.p) - 1)); }
  const sp = E.len(s.vel), want = s.def.speed + E.dot(Sim.windAt(s.p), E.east(s.p)) * s.def.drift;
  check('motion-speed', maxErr < 1e-9 && Math.abs(sp - want) / want < 0.03, `on the sphere within ${maxErr.toExponential(1)}; ${sp.toFixed(0)} km/s, ${want.toFixed(0)} expected (speed and wind); moved ${E.dist(p0, s.p).toFixed(0)} km`);
  const e0 = s.E;
  for (let t = 0; t < 180; t++) sim.step([{ dir: E.east(s.p), mag: 1, boost: true }]);
  const bs = E.len(E.add(s.vel, Sim.windAt(s.p), -s.def.drift));
  check('motion-boost', Math.abs(bs / s.def.speed - Sim.BOOST.mul) < 0.06 && s.E < e0, `boosting at x${(bs / s.def.speed).toFixed(2)}; energy ${e0.toFixed(1)} -> ${s.E.toFixed(1)}`);
}

if (want('terrain')) {
  const gain = (type, lat, lon) => { const sim = setup([{ type, lat, lon, E: 50 }]); run(sim, 2, () => [{}]); return sim.storms[0].E - 50; };
  const hs = gain('hurricane', 15, -140), hl = gain('hurricane', 38, -98), ts = gain('tornado', 15, -140), tl = gain('tornado', 38, -98);
  check('terrain-energy', hs > 10 && hl < -8 && ts < -8 && tl > 10, `2 s: hurricane ${hs.toFixed(1)} over warm ocean, ${hl.toFixed(1)} over Kansas; tornado ${ts.toFixed(1)} and ${tl.toFixed(1)}`);
}

if (want('damage')) {
  const tokyo = E.cities.find(c => c.name === 'Tokyo');
  const sim = setup([{ type: 'tornado', lat: tokyo.lat, lon: tokyo.lon, E: 100 }]);
  const s = sim.storms[0];
  let inRange = true;
  for (let t = 0; t < 120; t++) {
    s.p = tokyo.p.slice(); s.v = [0, 0, 0]; s.k = [0, 0, 0];
    sim.step([{}]);
    for (const h of sim.cityH) if (!(h >= 0 && h <= 1)) inRange = false;
  }
  const lost = tokyo.value * (1 - sim.cityH[tokyo.i]), credited = s.stats.cityDamage[tokyo.i];
  check('damage-city', sim.cityH[tokyo.i] < 0.6 && credited >= lost && credited < lost * 1.01 && inRange, `2 s on Tokyo: ${(100 * (1 - sim.cityH[tokyo.i])).toFixed(0)}% wrecked, ${fmt(credited)} credited for ${fmt(lost)} lost (rebuilding gives some back)`);
  const m = setup([{ type: 'hurricane', lat: 20, lon: 125 }, { type: 'wildfire', lat: 48, lon: 5 }, { type: 'tornado', lat: 38, lon: -95 }], 3);
  const ais = m.storms.map((x, i) => AI.create(m, i, 'gale'));
  run(m, 40, () => ais.map(a => a.input(Sim.DT)));
  const sum = m.storms.reduce((a, x) => a + x.stats.damage, 0);
  check('damage-ledger', Math.abs(sum - m.total) / m.total < 1e-9 && m.total > 0, `40 s of three AI storms: ${fmt(m.total)}, the storms' own totals add up to ${fmt(sum)}`);
}

if (want('brawl')) {
  // equal storms, side by side
  const eq = setup([{ type: 'blizzard', lat: 60, lon: 0, E: 70 }, { type: 'blizzard', lat: 60, lon: 6, E: 70 }]);
  run(eq, 0.5, () => [{}, {}]);
  const [a, b] = eq.storms;
  // the same terrain feeds both (cold ocean, or land): compare their drain only roughly
  check('brawl-equal', Math.abs(a.E - b.E) < 1.5 && a.E < 70 + 0.5 * 5, `two blizzards of 70: ${a.E.toFixed(1)} and ${b.E.toFixed(1)} after 0.5 s locked together`);
  // the matchup: a sandstorm beats a hurricane
  const mu = setup([{ type: 'sandstorm', lat: 20, lon: -50, E: 70 }, { type: 'hurricane', lat: 20, lon: -45, E: 70 }]);
  const g0 = [Sim.gainAt('sandstorm', mu.storms[0].p), Sim.gainAt('hurricane', mu.storms[1].p)];
  run(mu, 1, () => [{}, {}]);
  const dS = mu.storms[0].E - 70 - g0[0], dH = mu.storms[1].E - 70 - g0[1];
  check('brawl-matchup', dH < dS - 2, `1 s locked: the sandstorm's energy (terrain aside) ${dS.toFixed(1)}, the hurricane's ${dH.toFixed(1)}`);
  // Fujiwhara: the line between them turns counter-clockwise in the north, clockwise in the south
  const spin = (lat) => {
    const sim = setup([{ type: 'blizzard', lat, lon: -30, E: 90 }, { type: 'blizzard', lat, lon: -24, E: 90 }]);
    const [x, y] = sim.storms, ang = () => { const m = E.norm(E.add(x.p, y.p)), u = E.toward(m, y.p); return Math.atan2(E.dot(u, E.north(m)), E.dot(u, E.east(m))); };
    const a0 = ang();
    run(sim, 1, () => [{}, {}]);
    let d = ang() - a0; if (d > Math.PI) d -= 2 * Math.PI; if (d < -Math.PI) d += 2 * Math.PI;
    return d / E.DEG;
  };
  const n = spin(45), s = spin(-45);
  check('brawl-fujiwhara', n > 2 && s < -2, `in 1 s the pair turned ${n.toFixed(1)}° at 45° N and ${s.toFixed(1)}° at 45° S (positive is counter-clockwise)`);
  // a KO credited to the hitter, then the respawn
  const ko = setup([{ type: 'hurricane', lat: 15, lon: -140, E: 100 }, { type: 'wildfire', lat: 15, lon: -136, E: 15 }]);
  let koEv = null, back = null;
  for (let t = 0; t < 60 * 8 && !back; t++) {
    ko.step([{}, {}]);
    for (const e of ko.events) { if (e.type === 'ko' && !koEv) koEv = { ...e, t: ko.time }; if (e.type === 'respawn') back = { t: ko.time }; }
  }
  const w = ko.storms[1];
  check('brawl-ko', koEv && koEv.s === 1 && koEv.by === 0 && ko.storms[0].stats.kos === 1 && back && Math.abs(back.t - koEv.t - Sim.RESPAWN) < 0.05 && w.E > 40 && w.shield > 0,
    koEv ? `the wildfire went at ${koEv.t.toFixed(2)} s, credited to storm ${koEv.by}; back ${back ? (back.t - koEv.t).toFixed(2) : '–'} s later with ${w.E.toFixed(0)} energy` : 'no KO');
}

if (want('specials')) {
  const results = [];
  // surge: a rival 1.5 radii away is hit and pushed away
  {
    const sim = setup([{ type: 'hurricane', lat: 15, lon: -140, E: 90 }, { type: 'tornado', lat: 15, lon: -140 + 1.5 * 700 / 111 / Math.cos(15 * E.DEG), E: 80 }]);
    const d0 = E.dist(sim.storms[0].p, sim.storms[1].p), e0 = sim.storms[1].E;
    sim.step([{ special: true }, {}]); run(sim, 1, () => [{}, {}]);
    const d1 = E.dist(sim.storms[0].p, sim.storms[1].p);
    results.push(['surge', d1 > d0 + 150 && sim.storms[1].E < e0 - 10, `rival pushed ${(d1 - d0).toFixed(0)} km, lost ${(e0 - sim.storms[1].E).toFixed(1)} energy`]);
  }
  // dash: three times the speed for 0.9 s
  {
    const sim = setup([{ type: 'tornado', lat: 38, lon: -100, E: 90 }]);
    const s = sim.storms[0];
    run(sim, 1, () => [{ dir: E.east(s.p), mag: 1 }]);
    const p0 = s.p.slice();
    sim.step([{ dir: E.east(s.p), special: true }]); run(sim, 0.9, () => [{ dir: E.east(s.p) }]);
    const went = E.dist(p0, s.p);
    results.push(['dash', went > s.def.speed * 0.9 * 2.3, `${went.toFixed(0)} km in 0.9 s (${(went / 0.9 / s.def.speed).toFixed(1)}x speed with the run-up)`]);
  }
  // whiteout: a rival inside crawls and drains; one outside doesn't
  {
    const sim = setup([{ type: 'blizzard', lat: 65, lon: 90, E: 90 }, { type: 'tornado', lat: 65, lon: 90 + 1100 / 111 / Math.cos(65 * E.DEG), E: 80 }, { type: 'supercell', lat: 65, lon: 90 + 3500 / 111 / Math.cos(65 * E.DEG), E: 80 }]);
    sim.step([{ special: true }, {}, {}]); run(sim, 1, () => [{}, {}, {}]);
    const [, x, y] = sim.storms;
    results.push(['whiteout', x.slowT > 0 && x.slow < 0.5 && y.slowT === 0, `rival 1,100 km away slowed to x${x.slow.toFixed(2)}; one 3,500 km away untouched`]);
  }
  // dust wall: hits a rival 1,000 km ahead, not one behind
  {
    const sim = setup([{ type: 'sandstorm', lat: 23, lon: 10, E: 90 }, { type: 'hurricane', lat: 23, lon: 10 + 1000 / 111 / Math.cos(23 * E.DEG), E: 80 }, { type: 'wildfire', lat: 23, lon: 10 - 1200 / 111 / Math.cos(23 * E.DEG), E: 80 }]);
    const e1 = sim.storms[1].E, e2 = sim.storms[2].E, g1 = Sim.gainAt('hurricane', sim.storms[1].p), g2 = Sim.gainAt('wildfire', sim.storms[2].p);
    sim.step([{ dir: E.east(sim.storms[0].p), special: true }, {}, {}]); run(sim, 1.5, () => [{}, {}, {}]);
    const lost1 = e1 + g1 * 1.5 - sim.storms[1].E, lost2 = e2 + g2 * 1.5 - sim.storms[2].E;
    results.push(['haboob', lost1 > 10 && Math.abs(lost2) < 1.5, `rival ahead lost ${lost1.toFixed(1)} energy (terrain aside), the one behind ${lost2.toFixed(1)}`]);
  }
  // lightning: a rival 2,000 km away is struck; aimed past 2,600 km it lands at 2,600 km
  {
    const sim = setup([{ type: 'supercell', lat: 0, lon: 0, E: 90 }, { type: 'tornado', lat: 0, lon: 2000 / 111, E: 80 }]);
    const e0 = sim.storms[1].E;
    sim.step([{ special: true, aim: sim.storms[1].p.slice() }, {}]); run(sim, 1, () => [{}, {}]);
    const sim2 = setup([{ type: 'supercell', lat: 0, lon: 0, E: 90 }]);
    sim2.step([{ special: true, aim: E.vec(0, 40) }]);
    const f = sim2.effects.find(x => x.kind === 'lightning');
    results.push(['lightning', e0 - sim.storms[1].E > 10 && Math.abs(E.dist(sim2.storms[0].p, f.target) - Sim.RANGE) < 5, `rival 2,000 km away lost ${(e0 - sim.storms[1].E).toFixed(1)}; aimed at 4,400 km it lands ${E.dist(sim2.storms[0].p, f.target).toFixed(0)} km away`]);
  }
  // firestorm: a rival sitting in the fire burns
  {
    const sim = setup([{ type: 'wildfire', lat: 48, lon: 5, E: 90 }, { type: 'blizzard', lat: 48, lon: 5 + 300 / 111 / Math.cos(48 * E.DEG), E: 80 }]);
    sim.step([{ special: true }, {}]);
    const y = sim.storms[1], p = y.p.slice(), e0 = y.E, g = Sim.gainAt('blizzard', p);
    run(sim, 2, () => { y.p = p.slice(); y.v = [0, 0, 0]; y.k = [0, 0, 0]; return [{}, {}]; });
    const lost = e0 + g * 2 - y.E;
    results.push(['firestorm', lost > 8, `rival in the fire lost ${lost.toFixed(1)} energy in 2 s (terrain aside)`]);
  }
  for (const [k, ok, d] of results) check('specials-' + k, ok, d);
}

if (want('match')) {
  const one = (seed, level) => {
    const sim = Sim.create({ seed, duration: 180, storms: S.ORDER.map((t, i) => ({ type: t, name: S.NAMES[i], color: S.COLORS[i], ai: true })) });
    const ais = sim.storms.map((s, i) => AI.create(sim, i, level));
    let steps = 0, nan = false;
    const t0 = Date.now();
    while (!sim.over) { sim.step(ais.map(a => a.input(Sim.DT))); steps++; if (sim.storms.some(s => s.p.some(Number.isNaN) || Number.isNaN(s.E))) nan = true; }
    const before = sim.total;
    sim.step(ais.map(a => a.input(Sim.DT)));
    return { sim, steps, nan, ms: Date.now() - t0, still: sim.total === before };
  };
  for (const level of Object.keys(AI.LEVELS)) {
    const r = one(7, level);
    const scored = r.sim.storms.every(s => s.stats.damage > 0);
    check('match-' + level, !r.nan && scored && r.steps === 180 * 60 && r.still, `6 storms, 3 min (${r.steps} steps, ${r.ms} ms): ${fmt(r.sim.total)}; ` + r.sim.ranking().map(s => `${s.type} ${fmt(s.stats.damage)}`).join(', '));
  }
  const a = one(11, 'gale').sim, b = one(11, 'gale').sim, c = one(12, 'gale').sim;
  const same = a.total === b.total && a.storms.every((s, i) => s.p.every((v, k) => v === b.storms[i].p[k]));
  check('match-determinism', same && c.total !== a.total, `seed 11 twice: ${fmt(a.total)} and ${fmt(b.total)}; seed 12: ${fmt(c.total)}`);
}

if (want('balance')) {
  const sum = {};
  const N = 6;
  for (let k = 0; k < N; k++) {
    const order = S.ORDER.slice(k).concat(S.ORDER.slice(0, k));
    const sim = Sim.create({ seed: 100 + k, duration: 180, storms: order.map((t, i) => ({ type: t, name: S.NAMES[i], color: S.COLORS[i], ai: true })) });
    const ais = sim.storms.map((s, i) => AI.create(sim, i, 'gale'));
    while (!sim.over) sim.step(ais.map(x => x.input(Sim.DT)));
    for (const s of sim.storms) sum[s.type] = (sum[s.type] || 0) + s.stats.damage / N;
  }
  const mean = Object.values(sum).reduce((x, y) => x + y, 0) / S.ORDER.length;
  const ratios = S.ORDER.map(t => sum[t] / mean);
  check('balance', ratios.every(r => r > 0.5 && r < 2), `${N} matches of all six: ` + S.ORDER.map((t, i) => `${t} ${fmt(sum[t])} (x${ratios[i].toFixed(2)})`).join(', '));
}

console.log(failures ? `\n${failures} problem(s)` : '\nall checks OK');
process.exit(failures ? 1 : 0);
