/* The Race mode's crash smoke and fire: dark smoke pouring out of a crashed car's engine bay from the
 * first impact, and after a hard one (or a takedown) flames there too, with embers and a flickering
 * light; a puff of dust and smoke where it hit. Drawn with js/fire.js's sprites (layer 2, the flames
 * also on the glow layer).
 *
 * create(scene) -> {
 *   emit({ pos, fire, size }): a source that follows pos() (a function giving [x, y, z] in the world
 *     each frame, or null once there's nothing to follow); fire: flames too; size: the car's scale (1);
 *   burst(x, y, z, size): a puff at an impact;
 *   stop(): no more smoke from any source (what's in the air drifts away and fades);
 *   clear(): everything gone at once;
 *   update(dt): dt in game seconds (slow motion slows the smoke too) }
 */
const RaceSmoke = (() => {
  'use strict';
  function create(scene) {
    const T = THREE;
    const smoke = CrashFire.sprites(scene, 1400, false, CrashFire.puffTexture('smoke'), 5);
    const flames = CrashFire.sprites(scene, 900, true, CrashFire.puffTexture('flame'), 7, 0.55);
    const light = new T.PointLight(0xff7a2e, 0, 14, 2);
    light.castShadow = false;
    scene.add(light);
    const src = [], P = [];   // sources; particles { kind, x, y, z, vx, vy, vz, age, life, s, rot, spin, g }
    const wind = [0.6, 0, 0.3];
    let clock = 0;
    const R = Math.random;
    function emit(o) { const e = Object.assign({ t: 0, acc: 0, accF: 0, size: 1 }, o); src.push(e); return e; }
    function puff(kind, x, y, z, s, life, vy, g) {
      if (P.length > 2600) return;
      const a = R() * Math.PI * 2, sp = 0.25 + 0.4 * R();
      P.push({ kind, x, y, z, vx: Math.cos(a) * sp, vy, vz: Math.sin(a) * sp, age: 0, life, s, rot: R() * 6.28, spin: (R() - 0.5) * 1.2, g });
    }
    function burst(x, y, z, size = 1) {
      for (let i = 0; i < 26 * size; i++) puff('dust', x + (R() - 0.5) * 1.2, y + R() * 0.5, z + (R() - 0.5) * 1.2, 0.5 + 0.6 * R(), 1.6 + R(), 0.4 + R() * 1.2, 0.42 + 0.1 * R());
    }
    function stop() { for (const e of src) e.dead = true; }
    function clear() { src.length = 0; P.length = 0; smoke.hide(); flames.hide(); light.intensity = 0; }
    function update(dt) {
      clock += dt;
      for (let i = src.length - 1; i >= 0; i--) {
        const e = src[i], p = e.dead ? null : e.pos();
        if (!p) { src.splice(i, 1); continue; }
        e.t += dt;
        // smoke: thick at once, a column that keeps pouring; flames from 0.15 s, growing
        const ramp = Math.min(1, e.t / 0.4), sz = e.size;
        e.acc += dt * 34 * ramp;
        while (e.acc >= 1) {
          e.acc -= 1;
          const fire = e.fire && e.t > 0.15;
          puff('smoke', p[0] + (R() - 0.5) * 0.6 * sz, p[1] + 0.2 + R() * 0.2, p[2] + (R() - 0.5) * 0.6 * sz, (0.45 + 0.35 * R()) * sz, 3.2 + 1.8 * R(), 0.9 + 0.8 * R(), fire ? 0.06 + 0.06 * R() : 0.16 + 0.1 * R());
        }
        if (e.fire && e.t > 0.15) {
          const grow = Math.min(1, (e.t - 0.15) / 0.8);
          e.accF += dt * 90 * (0.4 + 0.6 * grow);
          while (e.accF >= 1) {
            e.accF -= 1;
            const a = R() * Math.PI * 2, rad = Math.sqrt(R()) * 0.45 * sz;
            P.push({ kind: 'flame', x: p[0] + Math.cos(a) * rad, y: p[1] + R() * 0.1, z: p[2] + Math.sin(a) * rad, vx: 0, vy: 1.0 + 0.9 * R(), vz: 0, age: 0, life: 0.45 + 0.4 * R(), s: (0.25 + 0.35 * R()) * (0.6 + 0.4 * grow) * sz, rot: R() * 6.28, spin: (R() - 0.5) * 3, g: 0 });
            if (R() < 0.08) P.push({ kind: 'ember', x: p[0] + (R() - 0.5) * 0.4, y: p[1] + 0.2, z: p[2] + (R() - 0.5) * 0.4, vx: (R() - 0.5) * 1.5, vy: 2 + 2 * R(), vz: (R() - 0.5) * 1.5, age: 0, life: 1.4 + R(), s: 0.04, rot: 0, spin: 0, g: 0 });
          }
        }
      }
      smoke.begin(); flames.begin();
      let lx = 0, ly = 0, lz = 0, lw = 0;
      for (let i = P.length - 1; i >= 0; i--) {
        const q = P[i];
        q.age += dt;
        if (q.age >= q.life) { P[i] = P[P.length - 1]; P.pop(); continue; }
        const a = q.age / q.life;
        if (q.kind === 'ember') { q.vy -= 3 * dt; } else if (q.kind === 'flame') { q.vx += wind[0] * dt * 0.8; q.vz += wind[2] * dt * 0.8; }
        else { q.vx += (wind[0] - q.vx) * dt * 0.6; q.vz += (wind[2] - q.vz) * dt * 0.6; q.vy *= 1 - dt * 0.25; }
        q.x += q.vx * dt; q.y += q.vy * dt; q.z += q.vz * dt; q.rot += q.spin * dt;
        if (q.kind === 'smoke') smoke.add(q.x, q.y, q.z, q.s * (1 + a * 3.2), q.rot, q.g, q.g * 0.96, q.g * 0.93, 0.62 * Math.sin(Math.PI * Math.min(1, a * 1.15 + 0.04)) * (1 - 0.4 * a));
        else if (q.kind === 'dust') smoke.add(q.x, q.y, q.z, q.s * (1 + a * 2.2), q.rot, q.g, q.g * 0.9, q.g * 0.8, 0.45 * (1 - a) * Math.min(1, a * 6));
        else if (q.kind === 'flame') {
          const cg = a < 0.2 ? 0.82 - a * 1.2 : 0.58 - 0.5 * a, cb = a < 0.15 ? 0.45 - a * 2.4 : 0.08 * (1 - a), alpha = (a < 0.1 ? a / 0.1 : 1 - (a - 0.1) / 0.9) * 0.6;
          flames.add(q.x, q.y, q.z, q.s * (a < 0.25 ? 0.6 + 1.6 * a : 1 - 0.7 * (a - 0.25)), q.rot, 1, Math.max(0.05, cg), Math.max(0, cb), alpha);
          lx += q.x * alpha; ly += q.y * alpha; lz += q.z * alpha; lw += alpha;
        } else flames.add(q.x, q.y, q.z, q.s, 0, 1, 0.6, 0.15, 0.9 * (1 - a));
      }
      smoke.end(); flames.end();
      if (lw > 0) {
        light.position.set(lx / lw, ly / lw + 0.2, lz / lw);
        light.intensity = Math.min(22, lw * 0.35) * (0.8 + 0.12 * Math.sin(clock * 17.3) + 0.08 * Math.sin(clock * 31.7 + 1.3));
      } else light.intensity = 0;
    }
    return { emit, burst, stop, clear, update, get active() { return src.length > 0 || P.length > 0; } };
  }
  return { create };
})();
