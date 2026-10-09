/* The Hurricane Brawl game's rival storms: one controller per storm, giving the same inputs a player
 * would (a direction, boost, special, aim).
 *
 * Every think (0.3-0.9 s by level) it picks what to do, in this order:
 *   flee      from a rival that would beat it (energy x matchup x size), if it's close
 *   refuel    below 30 energy: to the nearest place within 1,500 km that feeds its type
 *   hunt      a rival it would beat (by x1.4, x1.15 or x1 by level), within 1,500-2,600 km
 *             (it leads the rival's motion)
 *   surge     an energy orb within 2,000 km, if it has room for the energy
 *   raid      otherwise the city worth most to it: what is left of it, by the type's multiplier,
 *             over (1 + (d / 1200 km)^2), and only if the energy it expects to have on arrival (the
 *             terrain on the way, at its speed) is at least 15; less if another storm is there
 * Between thinks it steers at its goal, around hostile terrain when its energy is low, and eases
 * off over the city it is wrecking. Specials: each type has its rule for when it pays (a rival in
 * reach, or enough cities), used with the level's probability.
 *
 * Levels: breeze (slow to think, wild aim, sparing with specials), gale, tempest.
 *
 * DOM-free: global BrawlAI in the browser, module.exports in Node.
 */
const BrawlAI = (() => {
  'use strict';
  const E = BrawlEarth, S = BrawlStorms, Sim = BrawlSim;
  const { dot, dist, toward, along, turn, add, scale, norm } = E;
  const LEVELS = {
    breeze: { label: 'Breeze', think: 0.9, special: 0.45, aimErr: 450, boost: 0.4, caution: 0.7, hunt: 1.4, reach: 1500 },
    gale: { label: 'Gale', think: 0.5, special: 0.8, aimErr: 200, boost: 0.8, caution: 1, hunt: 1.15, reach: 2200 },
    tempest: { label: 'Tempest', think: 0.3, special: 1, aimErr: 80, boost: 1, caution: 1.2, hunt: 1, reach: 2600 },
  };
  const gainAt = (s, p) => s.def.gain[E.TERRAINS[E.terrainAt(p)].key];
  const strength = (x, y) => Math.max(1, x.E) * S.matchup(x.type, y.type) * Math.sqrt(x.r / y.r);

  function create(sim, index, level) {
    const L = LEVELS[level] || LEVELS.gale;
    const me = sim.storms[index];
    const rand = sim.rand;
    let wait = rand() * L.think;
    const plan = { mode: 'raid', goal: null, target: null, city: null, boost: false };

    function pickCity() {
      let best = null, bs = 0;
      const t0 = me.def.speed;
      for (const c of E.cities) {
        const left = c.value * sim.cityH[c.i];
        if (left < 1e9) continue;
        const d = dist(me.p, c.p);
        if (d > 9000) continue;
        // the terrain on the way: three points along the great circle
        const u = toward(me.p, c.p);
        let g = 0;
        for (const f of [0.33, 0.66, 1]) g += gainAt(me, f === 1 ? c.p : along(me.p, u, d * f));
        g /= 3;
        const arrive = me.E + g * d / t0;
        if (arrive < 15 && d > me.r) continue;
        let score = left * Sim.cityMod(me.def, c.terrain, c.coastal) / (1 + (d / 1200) * (d / 1200)) * (arrive > 40 ? 1 : 0.5);
        for (const o of sim.storms) if (o !== me && o.alive && dist(o.p, c.p) < 600) score *= 0.6;
        if (score > bs) { bs = score; best = c; }
      }
      return best;
    }
    // the best place to feed within 1,500 km
    function refuelPoint() {
      let best = null, bs = -1e9;
      for (let n = 0; n < 12; n++) {
        const u = turn(me.p, me.heading, n * Math.PI / 6);
        for (const d of [300, 700, 1100, 1500]) {
          const q = along(me.p, u, d), g = gainAt(me, q);
          const score = g - d / 500;
          if (g > 0 && score > bs) { bs = score; best = q; }
        }
      }
      return best;
    }
    // a direction that keeps clear of terrain that would drain it, near the wanted one
    function aroundTerrain(u) {
      if (me.E > 55 || gainAt(me, along(me.p, u, 500)) >= -2) return u;
      let best = u, bs = -1e9;
      for (let n = -4; n <= 4; n++) {
        const w = turn(me.p, u, n * Math.PI / 9);
        const score = gainAt(me, along(me.p, w, 500)) + 3 * dot(w, u);
        if (score > bs) { bs = score; best = w; }
      }
      return best;
    }

    function think() {
      plan.special = false; plan.aim = null; plan.dir = null;
      let threat = null, td = 1e9, prey = null, pd = 1e9;
      for (const o of sim.storms) {
        if (o === me || !o.alive) continue;
        const d = dist(me.p, o.p);
        const mine = strength(me, o), theirs = strength(o, me);
        if (theirs > mine * 1.3 && d < 1400 * L.caution && d < td) { threat = o; td = d; }
        if (!o.shield && mine > theirs * L.hunt && d < L.reach && d < pd) { prey = o; pd = d; }
      }
      plan.target = null; plan.goal = null; plan.city = null;
      if (threat && me.shield <= 0) { plan.mode = 'flee'; plan.target = threat; }
      else if (me.E < 30 && (plan.goal = refuelPoint())) plan.mode = 'refuel';
      else if (prey) { plan.mode = 'hunt'; plan.target = prey; }
      else {
        const g = me.E < 85 && sim.surges.find(q => dist(me.p, q.p) < 2000);
        if (g) { plan.mode = 'surge'; plan.goal = g.p; }
        else { plan.mode = 'raid'; plan.city = pickCity(); plan.goal = plan.city ? plan.city.p : refuelPoint(); }
      }
      const goalD = plan.target ? dist(me.p, plan.target.p) : plan.goal ? dist(me.p, plan.goal) : 0;
      const gainHere = gainAt(me, me.p);
      plan.boost = rand() < L.boost && (
        (plan.mode === 'hunt' && goalD < 1600 && me.E > 30) ||
        (plan.mode === 'flee' && me.E > 25) ||
        ((plan.mode === 'raid' || plan.mode === 'surge') && goalD > 2500 && me.E > 65 && gainHere >= 0));
      if (me.cool <= 0 && rand() < L.special) special();
    }

    // does the special pay now? (sets plan.special, plan.aim, plan.dir)
    function special() {
      const key = me.def.special.key;
      const rivals = sim.storms.filter(o => o !== me && o.alive && !o.shield);
      const near = (km) => rivals.find(o => dist(me.p, o.p) < km);
      const ahead = (km, deg) => rivals.find(o => { const d = dist(me.p, o.p); return d < km && dot(toward(me.p, o.p), me.heading) > Math.cos(deg * E.DEG); });
      const cities = (p, km, minH) => { let n = 0; E.citiesNear(p, km, (c) => { if (sim.cityH[c.i] > minH) n++; }); return n; };
      if (key === 'surge') plan.special = !!near(me.r * 2.2) || cities(me.p, me.r * 2.4, 0.5) >= 3;
      else if (key === 'whiteout') plan.special = !!near(me.r * 2.2) || cities(me.p, me.r * 2.4, 0.5) >= 4;
      else if (key === 'firestorm') plan.special = !!near(me.r * 1.4) || cities(me.p, me.r * 1.6, 0.4) >= 3;
      else if (key === 'dash') {
        const o = ahead(me.def.speed * 2.6, 30);
        if (o) { plan.special = true; plan.dir = toward(me.p, o.p); }
        else if (plan.city && dist(me.p, plan.city.p) < 900 && sim.cityH[plan.city.i] > 0.5) { plan.special = true; plan.dir = toward(me.p, plan.city.p); }
      } else if (key === 'haboob') {
        const o = ahead(1900, 30);
        if (o) { plan.special = true; plan.dir = toward(me.p, o.p); }
        else plan.special = cities(along(me.p, me.heading, 1000), 900, 0.5) >= 3;
      } else if (key === 'lightning') {
        let o = null, od = Sim.RANGE;
        for (const x of rivals) { const d = dist(me.p, x.p); if (d < od) { od = d; o = x; } }
        let aim = o ? o.p : null;
        if (!aim) {
          let bv = 5e10;
          E.citiesNear(me.p, Sim.RANGE, (c) => { const v = c.value * sim.cityH[c.i]; if (v > bv) { bv = v; aim = c.p; } });
        }
        if (aim) { plan.special = true; plan.aim = along(aim, turn(aim, E.north(aim), rand() * 6.283), rand() * L.aimErr); }
      }
    }

    function input(dt) {
      if (!me.alive) { wait = 0; return {}; }
      wait -= dt;
      let special = false;
      if (wait <= 0) { wait += L.think; think(); special = plan.special; }
      let goal = plan.goal, mag = 1;
      if (plan.target && plan.target.alive) {
        const t = plan.target;
        goal = plan.mode === 'flee' ? along(me.p, toward(t.p, me.p), 1000)
          : add(t.p, t.vel, Math.min(2, dist(me.p, t.p) / me.def.speed) * 0.5 / E.R);
      }
      if (!goal) return { boost: false };
      let u = toward(me.p, norm(goal));
      if (plan.mode !== 'hunt') u = aroundTerrain(u);
      if (plan.mode === 'raid' && plan.city && dist(me.p, plan.city.p) < me.r * 0.3) mag = 0.2;
      const out = { dir: special && plan.dir ? plan.dir : u, mag, boost: plan.boost, special, aim: special ? plan.aim : null };
      return out;
    }
    return { input, plan, get mode() { return plan.mode; } };
  }
  return { create, LEVELS };
})();
if (typeof module === 'object' && module.exports) module.exports = BrawlAI;
