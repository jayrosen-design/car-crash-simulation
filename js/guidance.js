/* Approach guidance (TRD §2.2): PID speed control plus pure-pursuit steering on a kinematic
 * bicycle model. Tracks the chosen approach line to the barrier and hands off at contact.
 * No dependencies (global CrashGuidance / Node module).
 *
 * World frame: barrier face at x = 0, the car approaches from -x. Heading psi is measured from
 * +x toward +z. The approach line passes through the barrier centre (0, 0) with direction
 * (cos angle, sin angle).
 */
(function (root) {
'use strict';

const G = 9.81;

/* cfg: { speed (m/s), angle (rad), massKg, wheelbase, rearToCenter, length, width } */
function createApproach(cfg) {
  const m = cfg.massKg, L = cfg.wheelbase;
  const dx = Math.cos(cfg.angle), dz = Math.sin(cfg.angle);    // path direction
  const nx = -dz, nz = dx;                                     // path left-normal
  const distance = Math.min(130, Math.max(30, 3 * cfg.speed));
  const offset = 0.6, headingErr = 4 * Math.PI / 180;          // start slightly off the line
  // rear-axle start position: car centre `distance` back from the barrier, plus a lateral offset
  const cx = -dx * (distance + cfg.length / 2) + nx * offset;
  const cz = -dz * (distance + cfg.length / 2) + nz * offset;
  const s = {
    psi: cfg.angle + headingErr,
    v: 0.8 * cfg.speed,
    delta: 0,
    rx: 0, rz: 0,
    integ: 0, vPrev: 0.8 * cfg.speed,
    force: 0, mode: 'track', t: 0,
    crossTrack: offset, headingError: headingErr, lookAhead: 0,
  };
  s.rx = cx - Math.cos(s.psi) * cfg.rearToCenter;
  s.rz = cz - Math.sin(s.psi) * cfg.rearToCenter;

  const Kp = 2.0 * m, Ki = 0.5 * m, Kd = 0.05 * m;
  const Fmax = 0.45 * m * G, Fbrake = 0.9 * m * G;
  const maxSteer = 0.6, steerRate = 1.5;

  function center() {
    return [s.rx + Math.cos(s.psi) * cfg.rearToCenter, s.rz + Math.sin(s.psi) * cfg.rearToCenter];
  }
  // Distance from the front bumper's leading corner to the barrier face (x = 0).
  function gap() {
    const x = center()[0], c = Math.cos(s.psi), sn = Math.sin(s.psi);
    const hl = cfg.length / 2, hw = cfg.width / 2;
    return -(x + c * hl + Math.abs(sn) * hw);
  }

  function step(dt) {
    s.t += dt;
    // speed loop (PID on velocity error, derivative on measurement, conditional integration)
    let F;
    if (s.mode === 'track') {
      const e = cfg.speed - s.v;
      const deriv = -(s.v - s.vPrev) / dt;
      const u = Kp * e + Ki * s.integ + Kd * deriv;
      F = Math.max(-Fbrake, Math.min(Fmax, u));
      if (F === u || Math.sign(e) !== Math.sign(u)) s.integ += e * dt;
    } else {
      F = s.v > 0 ? -Fbrake : 0;
    }
    s.vPrev = s.v;
    s.force = F;
    // lateral loop: pure pursuit toward a look-ahead point on the approach line
    const Ld = Math.min(25, Math.max(5, 0.9 * s.v));
    const along = s.rx * dx + s.rz * dz;
    const lx = dx * (along + Ld), lz = dz * (along + Ld);
    const vx = lx - s.rx, vz = lz - s.rz;
    const hx = Math.cos(s.psi), hz = Math.sin(s.psi);
    const alpha = Math.atan2(hx * vz - hz * vx, hx * vx + hz * vz);
    const cmd = Math.max(-maxSteer, Math.min(maxSteer, Math.atan(2 * L * Math.sin(alpha) / Ld)));
    s.delta += Math.max(-steerRate * dt, Math.min(steerRate * dt, cmd - s.delta));
    s.lookAhead = Ld;
    // vehicle: drive force minus aero drag and rolling resistance
    const resist = 0.5 * 1.2 * 0.7 * s.v * s.v + 0.012 * m * G;
    s.v = Math.max(0, s.v + (F - resist) / m * dt);
    const yawRate = s.v / L * Math.tan(s.delta);
    s.psi += yawRate * dt;
    s.rx += s.v * Math.cos(s.psi) * dt;
    s.rz += s.v * Math.sin(s.psi) * dt;
    s.yawRate = yawRate;
    s.crossTrack = s.rx * nx + s.rz * nz;
    s.headingError = Math.atan2(Math.sin(s.psi - cfg.angle), Math.cos(s.psi - cfg.angle));
  }

  return {
    state: s, center, gap, step, distance,
    brake() { s.mode = 'brake'; },
    pose() { const [x, z] = center(); return { x, z, heading: s.psi }; },
  };
}

const api = { createApproach };
root.CrashGuidance = api;
if (typeof module === 'object' && module.exports) module.exports = api;
})(typeof window !== 'undefined' ? window : globalThis);
