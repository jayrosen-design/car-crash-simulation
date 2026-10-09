/* The Race game's other drivers: civilian traffic and the seven rivals.
 *
 * Traffic keeps to its lanes, two each way, following the Intelligent Driver Model (Treiber,
 * Hennecke & Helbing 2000): it eases toward its own cruising speed and brakes for whatever is ahead
 * in its lane, keeping a safe time gap. It is placed along the lane (kinematic) until something hits
 * it; then it is a free car that brakes to a stop. Cars are added ahead of the player and removed
 * behind, so the street is busy wherever the race is.
 *
 * Rivals drive the same car physics as the player. They follow a racing line (a lane, moved toward
 * the inside of each corner) at a speed the corner allows: v = sqrt(mu g / k), with braking points
 * worked backwards along the circuit. Steering is pure pursuit toward a point ahead on that line.
 * When traffic blocks their lane they pick the clearest lane, the oncoming ones included. Their pace
 * stretches and shrinks with their distance to the player (rubber-banding), and they boost on the
 * straights. The aggressive ones pick fights, as in Burnout 3: they close in on a car alongside,
 * the player first, and slam into it, and they move across to block a player catching them.
 *
 * DOM-free: global RaceAI in the browser, module.exports in Node.
 */
const RaceAI = (() => {
  'use strict';
  const G = 9.81;
  const PALETTE = [0xe8e8e6, 0x111214, 0x9aa0a6, 0x55595e, 0x1d2f4f, 0x7a1418, 0xc9bfa8, 0x2f4a3a, 0x3d5a80, 0x8a8d91, 0xdedad0, 0x262a30];

  // ---------------------------------------------------------------- the speed the circuit allows
  function speedProfile(level, mu, brake) {
    const C = level.circuit, N = C.N, v = new Float64Array(N);
    // curvature smoothed over 12 m, the corner speed from it
    for (let i = 0; i < N; i++) {
      let k = 0; for (let d = -6; d <= 6; d++) k += Math.abs(C.k[(i + d + N) % N]);
      k /= 13;
      v[i] = k > 1e-5 ? Math.min(90, Math.sqrt(mu * G / k)) : 90;
    }
    // braking: no faster than the next point's speed allows (twice round, for the wrap)
    for (let pass = 0; pass < 2; pass++) for (let i = N - 1; i >= 0; i--) { const j = (i + 1) % N; v[i] = Math.min(v[i], Math.sqrt(v[j] * v[j] + 2 * brake * 1)); }
    return v;
  }

  // ---------------------------------------------------------------- traffic
  function createTraffic(level, world, opts = {}) {
    const R = CrashLevel.rng(opts.seed || 99), cars = [], L = level.length;
    const specs = opts.specs;   // { lexus, mustang }
    // a car every 150-260 m in each lane ahead (about 40% fewer than the first 90-170 m: the street
    // was so busy the player crashed into traffic too often)
    const AHEAD = opts.ahead || 520, BEHIND = opts.behind || 140, GAP = opts.gap || [150, 260];
    function spawn(lane, s, v) {
      const key = R() < 0.6 ? 'lexus' : 'mustang';
      const car = RaceCar.create(specs[key]);
      const body = world.add(car, { kind: 'traffic', kinematic: true });
      const t = { body, key, lane, dir: lane > 0 ? 1 : -1, s, v, v0: (13 + R() * 6) * (opts.speedScale || 1), paint: PALETTE[Math.floor(R() * PALETTE.length)], free: 0 };
      body.traffic = t;
      place(t);
      cars.push(t);
      return t;
    }
    function place(t) {
      const p = level.poseAt(t.s, t.lane), h = t.dir > 0 ? p.h : p.h + Math.PI;
      t.body.car.setKinematic(p.x, p.z, h, t.v, t.dir * t.v * p.k);
    }
    // lane occupancy: who is ahead of t in its lane (traffic, and racers in the lane)
    function leaderGap(t, racers) {
      let gap = Infinity, vl = 0;
      for (const o of cars) {
        if (o === t || o.lane !== t.lane) continue;
        const d = t.dir * level.wrapDiff(o.s, t.s);
        if (d > 0 && d < gap) { gap = d; vl = o.body.kinematic ? o.v : Math.abs(o.body.car.speed); }
      }
      for (const b of racers) {
        const f = b.track;
        if (!f || Math.abs(f.l - t.lane) > 1.8) continue;
        const d = t.dir * level.wrapDiff(f.s, t.s);
        if (d > 0 && d < gap) { gap = d; vl = Math.max(0, t.dir * (b.car.vx * Math.cos(f.h) + b.car.vz * Math.sin(f.h))); }
      }
      return { gap: gap - 5, vl };
    }
    /* the step: move the lane-bound cars (IDM), add and remove around the focus (circuit distance) */
    function step(dt, focusS, racers) {
      for (const t of cars) {
        if (!t.body.kinematic) {   // hit: a free car, braking to a stop
          t.free += dt;
          const f = level.nearest(t.body.car.pose.x, t.body.car.pose.z);
          t.s = f.s; t.l = f.l;
          continue;
        }
        const { gap, vl } = leaderGap(t, racers);
        // Intelligent Driver Model: a = a (1 - (v/v0)^4 - (s*/s)^2), s* = s0 + vT + v dv / (2 sqrt(ab))
        const a = 1.6, b = 3.0, s0 = 4, T = 1.4, dv = t.v - vl;
        const sStar = s0 + t.v * T + t.v * dv / (2 * Math.sqrt(a * b));
        let acc = a * (1 - Math.pow(t.v / t.v0, 4) - (gap < Infinity ? Math.pow(Math.max(0, sStar) / Math.max(0.5, gap), 2) : 0));
        acc = Math.max(-9, acc);
        t.v = Math.max(0, t.v + acc * dt);
        t.s = ((t.s + t.dir * t.v * dt) % L + L) % L;
        place(t);
      }
      // keep the lanes filled around the focus
      for (const lane of level.lanes) {
        const dir = lane > 0 ? 1 : -1;
        const inLane = cars.filter(t => t.lane === lane && t.body.kinematic).map(t => level.wrapDiff(t.s, focusS)).sort((x, y) => x - y);
        let far = inLane.length ? inLane[inLane.length - 1] : -BEHIND;
        // ahead of the focus: add cars up to the horizon
        while (far < AHEAD - GAP[0]) {
          far += (GAP[0] + R() * (GAP[1] - GAP[0])) * (dir > 0 ? 1.45 : 1);   // sparser with the race, busier oncoming
          if (far < 60 && opts.clearStart) continue;
          if (far > AHEAD) break;
          spawn(lane, ((focusS + far) % L + L) % L, 12 + R() * 5);
        }
      }
      // remove what fell far behind (or was hit and sat still a while)
      for (let i = cars.length - 1; i >= 0; i--) {
        const t = cars[i], d = level.wrapDiff(t.s, focusS);
        if (d < -BEHIND || d > AHEAD + 60 || (t.free > 6)) remove(i);
      }
    }
    function remove(i) {
      const t = cars[i];
      world.bodies.splice(world.bodies.indexOf(t.body), 1);
      world.bodies.forEach((b, k) => { b.id = k; });
      cars.splice(i, 1);
    }
    // clear the road ahead (the player's respawn): no traffic within d metres ahead in any lane
    function clearAhead(s, d) {
      for (let i = cars.length - 1; i >= 0; i--) { const r = level.wrapDiff(cars[i].s, s); if (r > -15 && r < d) remove(i); }
    }
    return { cars, step, clearAhead, remove: (t) => { const i = cars.indexOf(t); if (i >= 0) remove(i); } };
  }

  // ---------------------------------------------------------------- rivals
  function createRivals(level, world, opts) {
    const R = CrashLevel.rng(opts.seed || 7), L = level.length;
    const prof = speedProfile(level, 0.78, 8.0);
    const rivals = [];
    for (const g of opts.grid) {
      const car = RaceCar.create(opts.specs[g.key]);
      car.place(g.x, g.z, g.h, 0);
      const body = world.add(car, { kind: 'rival' });
      const r = { body, key: g.key, name: g.name, paint: g.paint, skill: g.skill, lane: g.lane, l: g.lane, laneT: g.lane, boost: 0.4, boosting: false,
        stuck: 0, wreck: 0, prog: { i: -1, s: g.s, prevS: g.s, lap: 1, dist: 0, done: false, time: 0 },
        aggr: g.aggr || 0, att: { state: 'idle', t: 0, target: null } };   // aggression 0..1 and the attack in hand
      body.rival = r;
      rivals.push(r);
    }
    // What's on the road around rival r: every other car's circuit distance ahead (d), lateral
    // offset (l) and speed along the circuit (va; oncoming cars negative)
    function obstacles(r, f, ctx) {
      const out = [];
      const add = (b, s, l) => { const d = level.wrapDiff(s, f.s); if (d < -8 || d > 260) return; const h = level.poseAt(s, 0).h; out.push({ d, l, va: b.car.vx * Math.cos(h) + b.car.vz * Math.sin(h) }); };
      for (const t of ctx.traffic.cars) add(t.body, t.s, t.body.kinematic ? t.lane : (t.l !== undefined ? t.l : t.lane));
      for (const o of rivals) if (o !== r && o.body.track && !o.body.ghost) add(o.body, o.body.track.s, o.body.track.l);
      if (ctx.player && ctx.player.track && !ctx.player.ghost && !ctx.player.frozen) add(ctx.player, ctx.player.track.s, ctx.player.track.l);
      return out;
    }
    // Attacks, after Burnout 3's aggression: when the game allows it (ctx.attack(r)), an aggressive
    // rival picks a car near it (the player first, if no one else is after them), closes in
    // alongside, swings out, then steers into it for up to 1.2 s, and cools down (longer after a slam
    // that landed, shorter the more aggressive it is). Returns what the attack asks of the driving
    // this step ({ l: a lateral offset to hold, or aim: a point to steer at; v: a speed }) or null.
    const ACTIVE = { close: 1, windup: 1, slam: 1 };
    const attacking = (o, target) => !!ACTIVE[o.att.state] && (!target || o.att.target === target);
    function attack(r, f, dt, ctx, bend) {
      const A = r.att;
      A.t -= dt;
      if (A.state === 'cool') { if (A.t <= 0) { A.state = 'idle'; A.t = 0.25; } return null; }
      if (A.state === 'idle') {
        if (A.t > 0) return null;
        A.t = 0.25;
        if (!(r.aggr > 0) || bend || r.body.car.forward < 20 || !ctx.attack || !ctx.attack(r)) return null;
        // the nearest car within 30 m (ahead: it catches up; behind: it lets it come alongside), at
        // speed; the player counts 20 m nearer
        let best = null, bs = Infinity;
        const cand = (b, bonus) => {
          if (!b || !b.track || b.ghost || b.frozen || b.wrecked || b.car.speed < 18) return;
          const d = level.wrapDiff(b.track.s, f.s), dl = Math.abs(b.track.l - r.l);
          if (d < -30 || d > 30 || dl > 8) return;
          if (Math.abs(d) + dl - bonus < bs) { bs = Math.abs(d) + dl - bonus; best = b; }
        };
        if (ctx.player && !rivals.some(o => o !== r && attacking(o, ctx.player))) cand(ctx.player, 20);
        for (const o of rivals) if (o !== r && !(o.wreck > 0)) cand(o.body, 0);
        if (!best || R() > r.aggr * 0.35) return null;
        A.state = 'close'; A.target = best; A.t = 8;
      }
      const T = A.target, tc = T.car, tf = T.track;
      const d = tf ? level.wrapDiff(tf.s, f.s) : 0;
      if (!tf || T.ghost || T.frozen || T.wrecked || d < -40 || d > 80 || (A.state === 'close' && A.t <= 0)) { standDown(r, false); return null; }
      let side = Math.sign(r.l - tf.l) || 1;
      const vT = Math.max(0, tc.forward);
      if (A.state === 'close') {
        if (Math.abs(d) < 3.5 && Math.abs(tf.l - r.l) < 4.5) { A.state = 'windup'; A.t = 0.4; A.side = side; }
        // catching up (or easing off for it): its own lanes through the traffic; within 15 m, a lane
        // over from the target, on whichever side is clearer
        const v = vT + Math.max(-6, Math.min(10, d * 0.6));
        if (Math.abs(d) >= 15) return { v };
        const free = (sd) => { const l = tf.l + sd * 3.4; return Math.abs(l) > 6 ? -1 : timeFree(r.obs || [], l, v) - (sd === side ? 0 : 0.3); };
        if (free(-side) > free(side)) side = -side;
        return { l: tf.l + side * 3.4, v };
      }
      side = A.side || side;   // swinging out and slamming: from the side it came alongside on
      if (A.state === 'windup') {
        if (A.t <= 0) { A.state = 'slam'; A.t = 1.2; }
        return { l: Math.max(-6.2, Math.min(6.2, tf.l + side * 4.6)), v: vT + d * 0.6, swing: true };
      }
      if (A.t <= 0) { standDown(r, false); return null; }
      const lead = 0.1 * r.body.car.speed;   // steer at where the target will be
      return { aim: { x: tc.x + Math.cos(tc.h) * lead, z: tc.z + Math.sin(tc.h) * lead }, v: vT + 3 };
    }
    // the attack is over: it landed on its target, or it hit something else (or ran out of time)
    function standDown(r, landed) { r.att.state = 'cool'; r.att.t = landed ? 4 + 8 * (1 - r.aggr) : 3; r.att.target = null; }
    // seconds before rival r (speed v) would reach the nearest car in lane l (4 if nothing within reach)
    function timeFree(obs, l, v) {
      let ttc = 4;
      for (const o of obs) {
        if (Math.abs(o.l - l) > 2.3 || o.d <= -2) continue;
        const closing = v - o.va;
        if (o.d < 6) { ttc = Math.min(ttc, 0.3); continue; }
        if (closing > 0) ttc = Math.min(ttc, o.d / closing);
      }
      return ttc;
    }
    /* driving input for rival r this step */
    function drive(r, dt, ctx) {
      const car = r.body.car, p = car.pose, f = level.nearest(p.x, p.z, r.prog.i);
      r.prog.i = f.i;
      r.body.track = f;
      if (r.wreck > 0) return { brake: 0.6, handbrake: 1 };
      // shunted hard: control lost for a moment (the rear lets go), as in Burnout
      if (r.stagger > 0) { r.stagger -= dt; return { throttle: 0.3, steer: r.kick || 0, handbrake: r.stagger > 0.35 ? 1 : 0 }; }
      const v = car.speed, fwd = car.forward;
      // lane choice: stay, unless another lane gives clearly more time before reaching a car
      r.laneTimer = (r.laneTimer || 0) - dt;
      const obs = (r.obsTimer = (r.obsTimer || 0) - dt) <= 0 || !r.obs ? (r.obs = obstacles(r, f, ctx), r.obsTimer = 0.05, r.obs) : r.obs;
      // judge the lanes at the speed the rival wants to go, not the speed it has slowed to behind a car
      const vWant = Math.max(fwd, Math.min(62, prof[level.sampleAt(f.s + 25)] * r.skill));
      const here = timeFree(obs, r.l, vWant);
      const slowAhead = obs.some(o => Math.abs(o.l - r.l) < 2.2 && o.d > 0 && o.d < 70 && o.va < vWant - 3);
      // in a bend, change lanes only to avoid a crash (a change mid-corner carries the car wide)
      const bend = Math.abs(f.k) > 0.004 || Math.abs(level.poseAt(f.s + 30, 0).k) > 0.004;
      const atk = r.att ? attack(r, f, dt, ctx, bend) : null;
      // an aggressive rival with the player close behind and catching it moves across to block
      const P = ctx.player, dp = !atk && r.aggr > 0.5 && !bend && P && P.track && ctx.attack && ctx.attack(r) ? level.wrapDiff(P.track.s, f.s) : 0;
      if (atk && atk.l !== undefined) r.laneT = atk.l;
      else if (dp < -4 && dp > -25 && P.car.forward > fwd + 1) { r.laneT = Math.max(-5.25, Math.min(5.25, P.track.l)); r.laneTimer = 1; }
      else if (bend ? here < 1.0 : (r.laneTimer <= 0 || here < 2.2 || slowAhead || (r.l < 0 && timeFree(obs, 1.75, vWant) > 2.5))) {
        let best = r.laneT, bestScore = -Infinity;
        for (const l of [5.25, 1.75, -1.75, -5.25]) {
          if (l < 0 && obs.some(o => Math.abs(o.l - l) < 2.3 && o.va < -1 && o.d > 0 && o.d < 300)) continue;   // oncoming cars in that lane: no
          const score = timeFree(obs, l, vWant) + (l > 0 ? 1.5 : 0) + (Math.abs(l - r.laneT) < 0.1 ? 0.6 : 0) - Math.abs(l - r.l) * 0.06 + (Math.abs(l - r.lane) < 0.1 ? 0.3 : 0);
          if (score > bestScore) { bestScore = score; best = l; }
        }
        r.laneT = best; r.laneTimer = 0.4 + R() * 0.6;
      }
      r.l += Math.max(-3.6 * dt, Math.min(3.6 * dt, r.laneT - r.l));
      // aim at a point ahead on the line, moved toward the inside of the corner (but off the kerb,
      // where the street lights stand)
      // (swinging out for a slam: a short look-ahead, to get out there in time)
      const Ld = atk && atk.swing ? 9 : Math.max(7, Math.min(32, 0.4 * v + 5));
      const ahead = level.poseAt(f.s + Ld, 0), k = level.poseAt(f.s + Ld * 0.6, 0).k;
      let kMax = 0; for (let d = 0; d <= Ld + 10; d += 4) kMax = Math.max(kMax, Math.abs(level.poseAt(f.s + d, 0).k));
      const cut = Math.max(-1.5, Math.min(1.5, k * 140));
      // bends: keep to the middle lanes, clear of the kerbs (eased, so the line doesn't jump at a bend's end)
      r.edge = r.edge === undefined ? 4.8 : r.edge + ((kMax > 0.004 ? 3.6 : 4.8) - r.edge) * (1 - Math.exp(-dt / 0.7));
      const edge = atk && atk.swing ? 6.2 : r.edge;   // swinging out for a slam: wide, nearly to the kerb
      const lt = Math.max(-edge, Math.min(edge, r.l + cut));
      // (a slam steers straight at its target instead)
      const tx = atk && atk.aim ? atk.aim.x : ahead.x - Math.sin(ahead.h) * lt, tz = atk && atk.aim ? atk.aim.z : ahead.z + Math.cos(ahead.h) * lt;
      const c = Math.cos(car.h), s = Math.sin(car.h), dx = tx - p.x, dz = tz - p.z;
      const alpha = Math.atan2(-dx * s + dz * c, dx * c + dz * s);
      // pure pursuit, plus a correction for the car's offset from the line here (pure pursuit alone
      // settles wide of the line in a long bend, as the car understeers)
      const lHere = Math.max(-edge, Math.min(edge, r.l + Math.max(-1.5, Math.min(1.5, f.k * 140))));
      const delta = atk && atk.aim ? Math.atan(2 * car.L * Math.sin(alpha) / Math.max(3, Math.hypot(dx, dz)))   // a slam: sharply, at its target
        : Math.atan(2 * car.L * Math.sin(alpha) / Ld) + Math.max(-0.04, Math.min(0.04, 0.015 * (lHere - f.l)));
      const lock = car.tune.steer / (1 + Math.max(0, Math.abs(fwd)) / 14) + 0.035;
      const steer = Math.max(-1, Math.min(1, delta / lock));
      // pace: the slowest the profile asks for over the next half second, scaled by skill and the
      // rubber band; the corner speed is for the centre line, and an inside lane is a tighter radius
      const rel = ctx.player ? ctx.lead(r) : 0;   // m ahead of the player (+) or behind (-)
      const band = rel > 220 ? 0.9 : rel > 90 ? 0.96 : rel < -260 ? 1.08 : rel < -120 ? 1.04 : 1;
      let vp = Infinity;
      for (let d = 2; d <= Math.max(6, fwd * 0.5); d += 3) {
        const q = level.poseAt(f.s + d, 0);
        vp = Math.min(vp, prof[level.sampleAt(f.s + d)] * Math.sqrt(Math.max(0.5, Math.min(1.2, 1 - lt * q.k))));
      }
      let vt = Math.min(vp * r.skill * band, (car.tune.power > 150e3 ? 66 : 62) * band);
      if (atk) vt = Math.min(Math.max(0, atk.v), vp);   // an attack sets the pace, within what the road allows
      // car-following: something slower ahead in this lane that we'd reach before stopping: match it
      for (const o of obs) {
        if (Math.abs(o.l - r.l) > 2.2 || o.d < 0) continue;
        const closing = fwd - o.va, stopD = closing > 0 ? closing * closing / (2 * 6.5) + 7 + fwd * 0.3 : 0;
        if (closing > 0 && o.d < stopD) vt = Math.min(vt, Math.max(0, o.va));
      }
      // boost on a long straight while still short of the target speed (more when behind)
      r.boost = Math.min(1, r.boost + dt * 0.035);
      let straight = true;
      if (r.boost > 0.05) for (let d = 0; d <= 160 && straight; d += 10) if (Math.abs(level.poseAt(f.s + d, 0).k) > 0.003) straight = false;
      r.boosting = r.boost > 0.05 && straight && fwd < vt - 3 && fwd > 25 && (rel < 50 || R() < 0.002);
      if (r.boosting) r.boost = Math.max(0, r.boost - dt * 0.22);
      // speed control: firm braking whenever over the target, throttle by how far under it
      let throttle = 0, brake = 0;
      const err = vt - fwd;
      if (err > 0.5) throttle = Math.min(1, 0.3 + err * 0.3);
      else if (err < -0.5) brake = Math.min(1, 0.25 - err * 0.35);
      else throttle = 0.2;
      // stuck (against something) or facing the wrong way: back on the road
      r.stuck = (fwd < 2 && ctx.racing) || Math.cos(car.h - f.h) < -0.2 ? r.stuck + dt : 0;
      return { steer, throttle, brake, boost: r.boosting };
    }
    // progress round the circuit and laps (as the player's)
    function track(r, t, laps) {
      const pr = r.prog, f = r.body.track;
      if (!f || pr.done) return;
      let ds = level.wrapDiff(f.s, pr.prevS);
      if (Math.abs(ds) > 50) ds = 0;
      pr.dist += ds; pr.prevS = f.s;
      const rel = level.wrapDiff(f.s, level.start.s);
      if (ds > 0 && rel >= 0 && rel < ds + 0.01 && pr.dist > L * 0.8) {
        pr.lap++; pr.dist = 0;
        if (pr.lap > laps) { pr.done = true; pr.time = t; }
      }
    }
    // put rival r back on the road at circuit distance s
    function respawn(r, s) {
      const p = level.poseAt(s, r.lane);
      r.body.car.place(p.x, p.z, p.h, 12);
      r.body.ghost = 2; r.body.wrecked = false; r.wreck = 0; r.stuck = 0; r.l = r.laneT = r.lane;
      if (r.att) standDown(r, false);
      r.prog.prevS = s;
    }
    // drive another body the same way (the player's car once the player has finished)
    function adopt(body, lane, skill) {
      return { body, lane, l: lane, laneT: lane, skill, boost: 0, boosting: false, stuck: 0, wreck: 0, prog: { i: -1, s: 0, prevS: 0, lap: 1, dist: 0, done: false, time: 0 } };
    }
    return { rivals, drive, track, respawn, adopt, standDown, attacking, profile: prof };
  }

  // A near miss: the player's car passes traffic car t (lane-bound, untouched) side by side with
  // less than 1.2 m between them, at least 10 m/s faster and itself over 15 m/s (54 km/h). Called
  // every few steps; keeps its state on t. Returns 'near', 'oncoming' (t drives the other way) or null.
  const NEAR_GAP = 1.2;
  function nearMiss(car, t) {
    if (!t.body.kinematic || t.touched) { t.nm = null; return null; }
    const o = t.body.car, dx = o.x - car.x, dz = o.z - car.z;
    if (dx * dx + dz * dz > 400) { t.nm = null; return null; }
    const c = Math.cos(car.h), s = Math.sin(car.h);
    const along = dx * c + dz * s, gap = Math.abs(-dx * s + dz * c) - car.spec.width / 2 - o.spec.width / 2;
    if (Math.abs(along) < car.spec.length / 2 + o.spec.length / 2 + 1) { t.nm = t.nm ? Math.min(t.nm, gap) : gap; return null; }
    if (t.nm === null || t.nm === undefined || along > 0) return null;
    const min = t.nm, rel = Math.hypot(car.vx - o.vx, car.vz - o.vz);
    t.nm = null;
    if (min > 0.05 && min < NEAR_GAP && rel > 10 && car.speed > 15) return t.dir < 0 ? 'oncoming' : 'near';
    return null;
  }

  return { createTraffic, createRivals, speedProfile, nearMiss, NEAR_GAP, PALETTE };
})();
if (typeof module === 'object' && module.exports) module.exports = RaceAI;
