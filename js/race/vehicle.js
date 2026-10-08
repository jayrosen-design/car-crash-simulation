/* The Race game's driving physics: one car as a rigid body on flat ground (x, z position, heading,
 * velocity, yaw rate) on four tyres.
 *
 * Tyres: the lateral force follows Pacejka's Magic Formula in the slip angle, F = D sin(C atan(B a -
 * E (B a - atan(B a)))), with D = mu Fz; drive and brake forces share each tyre's grip with it (the
 * friction ellipse). Wheel loads shift with acceleration and cornering (weight transfer through the
 * centre of gravity's height). At low speed the lateral force is capped at what stops the wheel's
 * sideways slide in one step, which keeps the slip angle's 0/0 from chattering. The engine is
 * power-limited (an automatic gearbox only sets the revs, for the sound); boost raises the power.
 * Brakes have ABS; the handbrake locks the rear wheels. Steering lock narrows with speed, and an
 * assist steers into a slide, as arcade racers do. Pitch and roll are drawn, not simulated.
 *
 * Conventions (js/physics.js): heading h points along (cos h, sin h); car-local x forward, z right;
 * yaw rate = dh/dt, positive turning right. The pose (x, z) is the car model's origin; the body
 * moves about its centre of gravity, cgX ahead of that origin.
 *
 * DOM-free: global RaceCar in the browser, module.exports in Node.
 */
const RaceCar = (() => {
  'use strict';
  const G = 9.81, RHO = 1.2;
  // per model: drive layout and tuning (arcade: brisk, high top speed)
  const TUNE = {
    lexus: { power: 150e3, cdA: 0.97, drive: [0.45, 0.55], grip: 1.05, hcg: 0.64, steer: 0.52, gears: [3.6, 2.2, 1.55, 1.18, 0.95, 0.78], final: 3.5, redline: 6600 },
    mustang: { power: 158e3, cdA: 0.84, drive: [0, 1], grip: 1.08, hcg: 0.5, steer: 0.55, gears: [3.0, 2.0, 1.5, 1.2, 1.0, 0.8], final: 3.55, redline: 7200 },
  };
  const BOOST = 1.65;          // power multiplier while boosting
  // Magic Formula shape (lateral): the rear tyres a little stiffer and grippier than the front, so the
  // car understeers gently at the limit instead of spinning (as road cars are set up)
  const MF = { front: { B: 8.5, C: 1.45, E: 0.25, mu: 1 }, rear: { B: 11, C: 1.45, E: 0.25, mu: 1.1 } };

  function create(spec, opts = {}) {
    const tune = TUNE[spec.key] || TUNE.lexus;
    const hubs = spec.hubs, frontX = hubs.FL[0], rearX = hubs.RL[0], L = frontX - rearX;
    const cgX = rearX + 0.52 * L, a = frontX - cgX, b = cgX - rearX, track = 2 * Math.abs(hubs.FL[2]);
    const m = opts.massKg || spec.massKg, Izz = m * (spec.length * spec.length + spec.width * spec.width) / 12 * 0.95;
    const R = spec.wheelRadius;
    // wheels relative to the centre of gravity: [x, z, front?, drive share]
    const W = [[a, -track / 2, true], [a, track / 2, true], [-b, -track / 2, false], [-b, track / 2, false]].map(([x, z, f]) => ({
      x, z, front: f, Fz: 0, slip: 0, Fy: 0, Fx: 0, spin: 0, omega: 0, skid: 0 }));
    const car = {
      spec, key: spec.key, m, Izz, L, a, b, cgX, track, R, tune, wheels: W,
      // state at the centre of gravity
      x: 0, z: 0, h: 0, vx: 0, vz: 0, yaw: 0,
      steer: 0, throttle: 0, brake: 0, handbrake: 0, boosting: false,
      ax: 0, ay: 0,            // local acceleration (forward, right), filtered: weight transfer and body lean
      pitch: 0, roll: 0, pv: 0, rv: 0,
      gear: 1, rpm: 900, reverse: false, odometer: 0,
      drift: 0,                // 0..1: how much the car is sliding (for boost and sound)
      sideSlip: 0,             // body slip angle (rad)
      // the model's origin (the pose the renderer and the crash solver use)
      get pose() { const c = Math.cos(car.h), s = Math.sin(car.h); return { x: car.x - c * cgX, z: car.z - s * cgX, heading: car.h }; },
      get speed() { return Math.hypot(car.vx, car.vz); },
      get forward() { return car.vx * Math.cos(car.h) + car.vz * Math.sin(car.h); },
      place(x, z, h, speed) {   // put the model's origin at (x, z) facing h, moving forward
        const c = Math.cos(h), s = Math.sin(h);
        car.x = x + c * cgX; car.z = z + s * cgX; car.h = h;
        car.vx = c * (speed || 0); car.vz = s * (speed || 0); car.yaw = 0; car.ax = car.ay = 0;
        car.pitch = car.roll = car.pv = car.rv = 0; car.steer = 0;
      },
      // driven along a path by someone else (traffic): place the model's origin and set the motion
      setKinematic(x, z, h, speed, yaw) {
        const c = Math.cos(h), s = Math.sin(h);
        car.x = x + c * cgX; car.z = z + s * cgX; car.h = h;
        car.vx = c * speed; car.vz = s * speed; car.yaw = yaw || 0;
        for (const w of W) w.spin += speed / R / 240;
      },
      // velocity of the model's origin (for the crash hand-over)
      originVelocity() { const c = Math.cos(car.h), s = Math.sin(car.h), px = -c * cgX, pz = -s * cgX; return [car.vx - car.yaw * pz, car.vz + car.yaw * px]; },
      step, applyImpulse,
    };

    // input: { steer -1..1 (right +), throttle 0..1, brake 0..1, handbrake 0..1, boost bool }
    function step(dt, inp) {
      const c = Math.cos(car.h), s = Math.sin(car.h);
      let vx = car.vx * c + car.vz * s, vz = -car.vx * s + car.vz * c;   // local: forward, right
      const v = Math.hypot(vx, vz);
      // steering: lock narrows with speed; assist steers into a slide
      const lock = tune.steer / (1 + Math.max(0, Math.abs(vx)) / 14) + 0.035;
      const slideAngle = v > 3 ? Math.atan2(vz, Math.abs(vx)) : 0;
      let target = (inp.steer || 0) * lock + (v > 8 ? 0.55 * slideAngle * (1 - Math.abs(inp.steer || 0) * 0.5) : 0);
      target = Math.max(-0.6, Math.min(0.6, target));
      const rate = 2.6 * dt;
      car.steer += Math.max(-rate, Math.min(rate, target - car.steer));
      // reverse when the brake is held at a standstill
      if (vx < 0.5 && (inp.brake || 0) > 0.5 && (inp.throttle || 0) < 0.1) car.reverse = true;
      if ((inp.throttle || 0) > 0.1 || vx > 1) car.reverse = false;
      const thr = car.reverse ? (inp.brake || 0) : (inp.throttle || 0), brk = car.reverse ? 0 : (inp.brake || 0);
      car.throttle = thr; car.brake = brk; car.handbrake = inp.handbrake || 0; car.boosting = !!inp.boost && !car.reverse;
      // engine: power-limited drive force, shared between the driven wheels
      const power = tune.power * (car.boosting ? BOOST : 1);
      let drive = thr * Math.min(m * G * 0.95, power / Math.max(4, Math.abs(vx)));
      if (car.reverse) drive = -thr * Math.min(m * G * 0.5, 40e3 / Math.max(3, Math.abs(vx)));
      // wheel loads: static plus the transfer from the last step's acceleration
      const hc = tune.hcg, mg = m * G;
      const front = mg * b / car.L - m * car.ax * hc / car.L, rear = mg * a / car.L + m * car.ax * hc / car.L;
      const latF = m * car.ay * hc / car.track * 0.55, latR = m * car.ay * hc / car.track * 0.45;
      W[0].Fz = Math.max(0, front / 2 - latF); W[1].Fz = Math.max(0, front / 2 + latF);
      W[2].Fz = Math.max(0, rear / 2 - latR); W[3].Fz = Math.max(0, rear / 2 + latR);
      // tyre forces (local frame)
      let Fx = 0, Fz = 0, Tq = 0, slideSum = 0;
      const sinD = Math.sin(car.steer), cosD = Math.cos(car.steer);
      for (const w of W) {
        // velocity of the contact patch: v + yaw x p (yaw turns x toward z)
        const px = w.x, pz = w.z, wvx = vx - car.yaw * pz, wvz = vz + car.yaw * px;
        const sd = w.front ? sinD : 0, cd = w.front ? cosD : 1;
        const vl = cd * wvx + sd * wvz, vs = -sd * wvx + cd * wvz;      // along and across the wheel
        const tyre = w.front ? MF.front : MF.rear;
        const mu = tune.grip * tyre.mu * (w.front ? 1 : (car.handbrake > 0.5 ? 0.42 : 1));
        const Fmax = mu * w.Fz;
        // longitudinal: drive, brakes (ABS: up to the grip), rolling resistance, handbrake
        let fl = drive * (w.front ? tune.drive[0] : tune.drive[1]) / 2;
        const sgn = vl > 0.05 ? 1 : vl < -0.05 ? -1 : 0;
        fl -= sgn * (brk * Fmax * (w.front ? 1.1 : 0.9) + 0.012 * w.Fz);
        if (!w.front && car.handbrake > 0.5) fl -= sgn * Fmax * 0.75;
        if (Math.abs(fl) > Fmax) fl = Math.sign(fl) * Fmax;
        // lateral: Magic Formula in the slip angle, within what's left of the grip (friction ellipse)
        const alpha = Math.atan2(vs, Math.abs(vl) + 0.5);
        const Ba = tyre.B * alpha;
        let fs = -Fmax * Math.sin(tyre.C * Math.atan(Ba - tyre.E * (Ba - Math.atan(Ba))));
        const left = Math.sqrt(Math.max(0, Fmax * Fmax - fl * fl));
        if (Math.abs(fs) > left) fs = Math.sign(fs) * left;
        // low speed: never more than stops the sideways slide this step
        const cap = (w.Fz / G) * Math.abs(vs) / dt;
        if (Math.abs(fs) > cap) fs = Math.sign(fs) * cap;
        w.slip = alpha; w.Fx = fl; w.Fy = fs;
        w.skid = Math.min(1, Math.max(Math.abs(alpha) > 0.12 ? (Math.abs(alpha) - 0.12) * 4 : 0, Math.abs(fl) / (Fmax || 1) > 0.95 && brk > 0.3 ? 0.6 : 0));
        slideSum += w.skid;
        // to the car's frame, and the yaw moment about the centre of gravity
        const fx = cd * fl - sd * fs, fz = sd * fl + cd * fs;
        Fx += fx; Fz += fz; Tq += px * fz - pz * fx;
        // wheel spin (drawn): rolling, or locked under the handbrake
        w.omega = (!w.front && car.handbrake > 0.5) ? 0 : vl / R;
        w.spin += w.omega * dt;
      }
      // aerodynamic drag
      const drag = 0.5 * RHO * tune.cdA * v;
      Fx -= drag * vx; Fz -= drag * vz;
      // integrate (semi-implicit Euler), in the local frame then back to the world
      const axL = Fx / m, azL = Fz / m;
      vx += axL * dt; vz += azL * dt;
      car.yaw += Tq / Izz * dt;
      // arcade stability control: hold the yaw rate near what the steering asks for (plus a margin), and
      // damp it a little when not steering, so the car tracks straight; off under the handbrake
      if (car.handbrake < 0.5) {
        const want = vx * Math.tan(car.steer) / car.L;
        const lim = Math.min(Math.abs(want) * 1.25 + 0.15, 0.95 * tune.grip * G / Math.max(3, v) + 0.05);   // no tighter than the grip allows
        if (Math.abs(car.yaw) > lim) car.yaw += (Math.sign(car.yaw) * lim - car.yaw) * (1 - Math.exp(-6 * dt));
        if (Math.abs(inp.steer || 0) < 0.05) car.yaw *= Math.exp(-1.2 * dt);
      }
      car.vx = vx * c - vz * s; car.vz = vx * s + vz * c;
      car.x += car.vx * dt; car.z += car.vz * dt;
      car.h += car.yaw * dt;
      car.odometer += v * dt;
      // filtered accelerations felt in the car (tyre and drag forces / mass): weight transfer, body lean
      const k = 1 - Math.exp(-dt / 0.08);
      car.ax += (axL - car.ax) * k;
      car.ay += (azL - car.ay) * k;
      // body pitch and roll (drawn): a damped spring driven by the accelerations
      const pt = -car.ax * 0.0045, rt = car.ay * 0.006;
      car.pv += ((pt - car.pitch) * 120 - car.pv * 14) * dt; car.pitch += car.pv * dt;
      car.rv += ((rt - car.roll) * 100 - car.rv * 12) * dt; car.roll += car.rv * dt;
      car.sideSlip = v > 2 ? Math.atan2(vz, Math.abs(vx)) : 0;
      car.drift = Math.min(1, slideSum / 2);
      // gearbox: revs from the road speed (for the sound)
      const gr = tune.gears, wheelRpm = Math.abs(vx) / R * 60 / (2 * Math.PI);
      let rpm = wheelRpm * gr[car.gear - 1] * tune.final;
      if (rpm > tune.redline - 300 && car.gear < gr.length) car.gear++;
      else if (rpm < 2600 && car.gear > 1) car.gear--;
      rpm = wheelRpm * gr[car.gear - 1] * tune.final;
      car.rpm = Math.max(900 + 1400 * thr * (car.gear === 1 ? 1 : 0.4), Math.min(tune.redline, rpm));
    }

    // an impulse J (N s, world) at world point (px, pz)
    function applyImpulse(px, pz, Jx, Jz) {
      car.vx += Jx / m; car.vz += Jz / m;
      const rx = px - car.x, rz = pz - car.z;
      car.yaw += (rx * Jz - rz * Jx) / Izz;
    }
    return car;
  }

  return { create, TUNE, BOOST, G };
})();
if (typeof module === 'object' && module.exports) module.exports = RaceCar;
