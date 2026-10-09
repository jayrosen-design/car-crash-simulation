/* The Race game's score: points for driving dangerously, after Burnout 3's.
 *
 * Single events score at once: slams, takedowns (more for a double, a spree, a revenge takedown or a
 * psyche-out), a lucky escape, props knocked over. Near misses chain: each one within 2.5 s of the
 * last counts one more time over (the second double, the third triple ...), and the chain is
 * banked when it runs out. Driving in the oncoming lanes, drifting and flying are runs, paid by the
 * metre once they're long enough (40, 20 and 5 m; then the metres before count too), banked when
 * they end. A crash loses whatever isn't banked yet. The runs also fill the boost, by the metre,
 * from the same point on.
 *
 * The numbers are this game's own. DOM-free: global RaceScore in the browser, module.exports in Node.
 */
const RaceScore = (() => {
  'use strict';
  const POINTS = { near: 50, oncoming: 80, slam: 25, fullSlam: 100, takedown: 500, double: 500, spree: 250, revenge: 1000, psyche: 750, lucky: 150, prop: 10 };
  const RUNS = {
    oncoming: { min: 40, pts: 2, boost: 0.0035 },   // per metre in the oncoming lanes
    drift: { min: 20, pts: 3, boost: 0.007 },       // per metre drifting
    air: { min: 5, pts: 5, boost: 0.004 },          // per metre in the air
  };
  const CHAIN = 2.5;   // s between near misses to keep a chain going
  const LABEL = { near: 'Near misses', oncoming: 'Oncoming lanes', drift: 'Drifting', air: 'Air', slam: 'Slams', takedown: 'Takedowns', lucky: 'Lucky escapes', prop: 'Street furniture' };

  function create() {
    let score = 0, chain = null;
    const totals = {};   // kind -> { n, pts }
    const runs = {};     // kind -> metres so far in the run under way
    const bank = (kind, pts, n = 1) => { const T = totals[kind] || (totals[kind] = { n: 0, pts: 0 }); T.n += n; T.pts += pts; score += pts; return pts; };
    return {
      get score() { return score; },
      get chain() { return chain ? chain.n : 0; },
      // the run under way of each kind (metres, once past its minimum; else 0)
      run: (kind) => (runs[kind] >= RUNS[kind].min ? runs[kind] : 0),
      /* a near miss at time t ('near' or 'oncoming'): into the chain; returns its place in the chain */
      nearMiss(kind, t) {
        if (!chain || t - chain.last > CHAIN) chain = { n: 0, pts: 0, last: t };
        chain.n++; chain.last = t; chain.pts += POINTS[kind] * chain.n;
        return chain.n;
      },
      /* a slam ({ full }), a takedown ({ double, spree, revenge, psyche }), a lucky escape or a prop:
       * banked at once; returns the points */
      slam: (full) => bank('slam', full ? POINTS.fullSlam : POINTS.slam),
      takedown(td) {
        let p = td.psyche ? POINTS.psyche : POINTS.takedown;
        if (td.double) p += POINTS.double;
        if (td.spree >= 3) p += POINTS.spree * (td.spree - 2);
        if (td.revenge) p += POINTS.revenge;
        return bank('takedown', p);
      },
      lucky: () => bank('lucky', POINTS.lucky),
      prop: () => bank('prop', POINTS.prop),
      /* this step, run `kind` is on (or not) and covered `m` metres: returns the boost it earns (none
       * before its minimum, then the metres so far at once); when it ends, it's banked: returns
       * { boost: 0, banked: points } then */
      step(kind, on, m) {
        const R = RUNS[kind];
        if (!on) {
          const got = runs[kind] >= R.min ? bank(kind, Math.round(runs[kind] * R.pts)) : 0;
          runs[kind] = 0;
          return { boost: 0, banked: got };
        }
        const before = runs[kind] || 0;
        runs[kind] = before + m;
        if (runs[kind] < R.min) return { boost: 0, banked: 0 };
        return { boost: (before < R.min ? runs[kind] : m) * R.boost, banked: 0 };
      },
      /* at time t: a near-miss chain that has run out is banked: returns { n, pts } then, else null */
      update(t) {
        if (!chain || t - chain.last <= CHAIN) return null;
        const c = chain; chain = null;
        bank('near', c.pts, c.n);
        return { n: c.n, pts: c.pts };
      },
      // the player crashed: what isn't banked is lost (the chain, the runs under way)
      crashed() { chain = null; for (const k in runs) runs[k] = 0; },
      // the finish: anything still under way is banked
      finish(t) { this.update(t + CHAIN + 1); for (const k in RUNS) this.step(k, false, 0); },
      /* the breakdown: [{ kind, label, n, pts }] in a fixed order, only the kinds that scored */
      breakdown: () => Object.keys(LABEL).filter(k => totals[k]).map(k => ({ kind: k, label: LABEL[k], n: totals[k].n, pts: totals[k].pts })),
    };
  }
  return { create, POINTS, RUNS, CHAIN };
})();
if (typeof module === 'object' && module.exports) module.exports = RaceScore;
