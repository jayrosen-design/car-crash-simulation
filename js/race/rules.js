/* The Race game's rules for slams and takedowns, after Burnout 3's.
 *
 * A slam never wrecks a car by itself. A contact between the player and a rival is a rub, a light
 * slam or a full slam, by how hard the player drove into it (the approach speed along the contact
 * normal) and where it landed: the player's nose into the rival's tail is a shunt (rear), anything
 * else a side slam. A full slam puts the rival out of control for a moment (the game does that) and
 * makes it fragile: for a second, any solid touch wrecks it. For two seconds after any contact with
 * the player, a hard hit on something wrecks it (the window). A wreck in the window is credited to
 * the player half a second later, unless the player has crashed meanwhile. A slammed rival that
 * touches something and comes through the window is "Takedown denied". Takedowns close together are doubles, and
 * several within half a minute a spree. A rival that wrecks with no contact while the player is
 * tailgating it is a psyche-out.
 *
 * The numbers are this game's own, tuned to its 240 Hz world (world.js) and real gravity.
 *
 * DOM-free: global RaceRules in the browser, module.exports in Node.
 */
const RaceRules = (() => {
  'use strict';
  const SLAM = {
    rear: { light: 3, full: 7 },     // m/s along the contact normal: the player's nose into a rival's tail
    side: { light: 2.5, full: 5 },   // anything else
  };
  const COOLDOWN = 1.0;    // s: no new slam between the same two cars
  const WINDOW = 2.0;      // s after a contact in which the rival's wreck is the player's
  const FRAGILE = 1.0;     // s after a full slam in which any solid touch wrecks the rival
  const FRAGILE_VN = 1.5;  // m/s: a solid touch
  const SHOVED_VN = 7;     // m/s: a hard enough hit to wreck a rival within the window
  const COMMIT = 0.5;      // s from the wreck to the takedown counting
  const DOUBLE = 1.5;      // s between two takedowns for a double
  const SPREE = 30;        // s: takedowns within this make a spree (three or more)
  const TAIL = 7;          // m: tailgating, for a psyche-out
  const TAIL_T = 1.0;      // s: how recently

  // where a point lies along a car's box: -1 at its tail, +1 at its nose
  function along(c, x, z) {
    const s = c.spec, off = s.xMin + s.length / 2 - c.cgX, ch = Math.cos(c.h), sh = Math.sin(c.h);
    return ((x - c.x - ch * off) * ch + (z - c.z - sh * off) * sh) / (s.length / 2);
  }
  /* A contact event e (world.js, kind 'car') between bodies att and vic, att driving into vic:
   * { type: 'rear'|'side', full } or null (a rub) */
  function classify(e, att, vic) {
    const rear = along(att.car, e.x, e.z) > 0.5 && along(vic.car, e.x, e.z) < -0.5;
    const T = rear ? SLAM.rear : SLAM.side;
    if (e.vn < T.light) return null;
    return { type: rear ? 'rear' : 'side', full: e.vn >= T.full };
  }
  // which of a contact's two cars drove into the other: the one that was moving toward it faster
  const attacker = (e) => (e.ua >= e.ub ? e.a : e.b);

  function create() {
    const st = new Map();   // rival -> its state
    const S = (r) => { let s = st.get(r); if (!s) st.set(r, s = { hitAt: -1e9, slamAt: -1e9, fragileUntil: -1e9, armed: false, touched: false, tailAt: -1e9 }); return s; };
    const pending = [];     // wrecks waiting to count: { r, at, psyche }
    const done = [];        // times of the takedowns that counted
    let crashedAt = -1e9;
    return {
      /* a contact between the player (body me) and rival r at time t: records the hit; returns the
       * player's slam on the rival ({ type, full }) or null (a rub, the rival's own hit, or too soon
       * after the last slam between them) */
      contact(e, me, r, t) {
        const s = S(r);
        s.hitAt = t;
        if (attacker(e) !== me || t - s.slamAt < COOLDOWN) return null;
        const slam = classify(e, me, r.body);
        if (!slam) return null;
        s.slamAt = t;
        if (slam.full) { s.fragileUntil = t + FRAGILE; s.armed = true; s.touched = false; }
        return slam;
      },
      /* rival r touched something other than the player (event e) at time t: whether it wrecks (a
       * crash anyway, or a solid touch while fragile, or a hard one within the window). A slammed
       * rival that survives a touch is denied when its window ends (update). */
      rivalContact(e, r, t) {
        const s = S(r);
        if (e.crash || (t < s.fragileUntil && e.vn > FRAGILE_VN) || (t - s.hitAt < WINDOW && e.vn > SHOVED_VN)) return true;
        if (s.armed && t - s.slamAt < WINDOW && e.vn > 0.5) s.touched = true;
        return false;
      },
      // whether the player touched rival r within the window (a spin-out then is a wreck the player caused)
      hitRecently: (r, t) => t - S(r).hitAt < WINDOW,
      // the player is close behind or beside rival r (body me): tailgating
      tail(me, r, t) {
        const a = me.car, b = r.body.car, dx = a.x - b.x, dz = a.z - b.z;
        if (dx * dx + dz * dz < TAIL * TAIL && dx * Math.cos(b.h) + dz * Math.sin(b.h) < 1 && a.speed > 15 && b.speed > 15) S(r).tailAt = t;
      },
      /* rival r wrecked at time t: whether the player gets it (then it counts in COMMIT s, by update) */
      wrecked(r, t) {
        const s = S(r);
        s.armed = false; s.touched = false; s.fragileUntil = -1e9;
        const hit = t - s.hitAt < WINDOW, psyche = !hit && t - s.tailAt < TAIL_T;
        if (!hit && !psyche) return false;
        pending.push({ r, at: t + COMMIT, psyche });
        return true;
      },
      playerCrashed(t) { crashedAt = t; },
      /* what happens at time t: takedowns that count ({ kind: 'takedown', r, psyche, double, spree };
       * spree: how many within SPREE s, this one included) and slammed rivals that touched something
       * and came through their window ({ kind: 'denied', r }) */
      update(t) {
        const out = [];
        for (let i = pending.length - 1; i >= 0; i--) {
          const p = pending[i];
          if (crashedAt > p.at - COMMIT) { pending.splice(i, 1); continue; }   // the player crashed after the wreck
          if (t < p.at) continue;
          pending.splice(i, 1);
          const double = done.length > 0 && t - done[done.length - 1] < DOUBLE;
          done.push(t);
          out.push({ kind: 'takedown', r: p.r, psyche: p.psyche, double, spree: done.filter(d => t - d < SPREE).length });
        }
        for (const [r, s] of st) if (s.armed && t - s.slamAt >= WINDOW) {
          s.armed = false;
          if (s.touched) out.push({ kind: 'denied', r });
          s.touched = false;
        }
        return out;
      },
    };
  }
  return { create, classify, attacker, along, SLAM, WINDOW, FRAGILE, COMMIT, DOUBLE, SPREE };
})();
if (typeof module === 'object' && module.exports) module.exports = RaceRules;
