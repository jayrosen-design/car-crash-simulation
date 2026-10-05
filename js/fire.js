/* After the crash: steam and fire.
 *
 * assess(result, unit) decides from the recorded crash (no THREE; runs in Node too):
 *   steam  the front was crushed back to the radiator, so the hot coolant vents as steam;
 *   fire   the engine was driven back toward the firewall by ENGINE_BACK or more. That crushes the
 *          fuel rail, fuel and oil lines against the hot exhaust manifold at the back of the engine,
 *          the usual start of a crash fire in the engine bay.
 * Fuel-tank fires (mostly from rear impacts) are not modelled: no simulation here hits the rear.
 *
 * Effects(scene) draws flames, sooty smoke, embers, steam and a flickering firelight. Each particle
 * is a fixed function of the time since the replay ended (its birth time and random numbers come
 * from its index), so scrubbing back and replaying always shows the same fire.
 */
const CrashFire = (() => {
  'use strict';
  const ENGINE_BACK = 0.30;     // m the engine block moves back (cabin frame) before lines tear
  const RADIATOR = 0.25;        // m behind the front of the structure (or the engine's front, if nearer)
  const T_SMOKE = 0.3, T_FLAME = 1.2, T_FULL = 9;   // s after the crash: smoke, first flames, fully alight

  // ---------------------------------------------------------------- the rule
  function assess(res, u) {
    const U = res.units[u || 0], car = U.car, sp = U.spec, F = res.frames, AX = U.axes;
    if (sp.noEngine || !car.engine) return null;
    const off = res.units.length > 1 ? U.off : 0, rest = car.rest, cr = car.cabinRest, E = sp.engine;
    const front = [], eng = [];
    for (let a = 0; a < car.n; a++) {
      if (car.ghost[a]) continue;
      if (car.engine[a]) eng.push(a);
      if (car.ijk[3 * a] === sp.nx - 1 && Math.abs(rest[3 * a + 2]) <= E.zHalf + 1e-6 && rest[3 * a + 1] <= E.yMax) front.push(a);
    }
    if (!eng.length || !front.length) return null;
    // rearward displacement of node a in the cabin frame of frame f
    const back = (f, a) => {
      const X = F.pos[f], A = AX[f], b = 3 * (off + a);
      return rest[3 * a] - (cr[0] + (X[b] - A[0]) * A[3] + (X[b + 1] - A[1]) * A[4] + (X[b + 2] - A[2]) * A[5]);
    };
    const xMax = sp.xMin + sp.length, radiator = Math.min(RADIATOR, Math.max(0.08, xMax - 0.12 - (sp.xMin + E.u1)));
    let frontCrush = 0, engineBack = 0, tSteam = -1, tFire = -1;
    for (let f = 0; f < F.t.length; f++) {
      for (const a of front) frontCrush = Math.max(frontCrush, back(f, a));
      let s = 0;
      for (const a of eng) s += back(f, a);
      engineBack = Math.max(engineBack, s / eng.length);
      if (tSteam < 0 && frontCrush >= radiator) tSteam = F.t[f];
      if (tFire < 0 && engineBack >= ENGINE_BACK) tFire = F.t[f];
    }
    const steam = tSteam >= 0, fire = tFire >= 0;
    if (!steam && !fire) return { steam, fire, frontCrush, engineBack, radiator };
    // where: the engine block and the crushed front, world positions in frame k
    const mean = (f, list) => { const X = F.pos[f], p = [0, 0, 0]; for (const a of list) for (let d = 0; d < 3; d++) p[d] += X[3 * (off + a) + d] / list.length; return p; };
    function at(k) {
      const A = AX[k];
      return { engine: mean(k, eng), front: mean(k, front), f: [A[3], A[4], A[5]], u: [A[6], A[7], A[8]] };
    }
    return { steam, fire, frontCrush, engineBack, radiator, tSteam, tFire, at, unit: u || 0 };
  }

  // ---------------------------------------------------------------- the look
  // a seeded hash: the same particle always gets the same random numbers
  function rnd(i, k) { let h = Math.imul(i ^ 0x9e3779b9, 0x85ebca6b) ^ Math.imul(k + 0x27d4eb2f, 0xc2b2ae35); h ^= h >>> 15; h = Math.imul(h, 0x2c1b3c6d); h ^= h >>> 12; return (h >>> 0) / 4294967296; }
  const smooth = (a, b, x) => { const t = Math.max(0, Math.min(1, (x - a) / (b - a))); return t * t * (3 - 2 * t); };

  function puffTexture(kind) {
    const S = 128, c = document.createElement('canvas'); c.width = c.height = S;
    const g = c.getContext('2d');
    // a cluster of soft blobs: a ragged puff rather than a disc
    let seed = kind === 'flame' ? 7 : 3;
    const r = () => { seed = (seed * 16807) % 2147483647; return seed / 2147483647; };
    for (let i = 0; i < (kind === 'flame' ? 9 : 14); i++) {
      const a = r() * Math.PI * 2, d = r() * S * (kind === 'flame' ? 0.12 : 0.18), x = S / 2 + Math.cos(a) * d, y = S / 2 + Math.sin(a) * d * (kind === 'flame' ? 1.4 : 1), rad = S * (0.18 + r() * 0.16);
      const gr = g.createRadialGradient(x, y, 0, x, y, rad);
      gr.addColorStop(0, `rgba(255,255,255,${kind === 'flame' ? 0.55 : 0.38})`); gr.addColorStop(1, 'rgba(255,255,255,0)');
      g.fillStyle = gr; g.beginPath(); g.arc(x, y, rad, 0, Math.PI * 2); g.fill();
    }
    const t = new THREE.CanvasTexture(c);
    t.colorSpace = THREE.SRGBColorSpace;
    return t;
  }

  const VERT = `
attribute vec3 iPos;
attribute vec4 iCol;
attribute vec2 iSize;
varying vec2 vUv;
varying vec4 vCol;
void main() {
  vUv = uv; vCol = iCol;
  vec4 mv = modelViewMatrix * vec4(iPos, 1.0);
  float c = cos(iSize.y), s = sin(iSize.y);
  mv.xy += vec2(c * position.x - s * position.y, s * position.x + c * position.y) * iSize.x;
  gl_Position = projectionMatrix * mv;
}`;
  const FRAG = `
uniform sampler2D map;
varying vec2 vUv;
varying vec4 vCol;
void main() {
  vec4 t = texture2D(map, vUv);
  gl_FragColor = vec4(vCol.rgb, vCol.a * t.a);   // colours are given in display (sRGB) values
}`;
  // what a glowing sprite adds to the glow layer (scene.js blurs it into a bloom)
  const GLOW_FRAG = `
uniform sampler2D map;
uniform float glow;
varying vec2 vUv;
varying vec4 vCol;
void main() {
  vec4 t = texture2D(map, vUv);
  gl_FragColor = vec4(vCol.rgb * vCol.a * t.a * glow, 1.0);
}`;
  // camera-facing quads, one instance per particle; drawn on layer 2 (effects), and with glow > 0
  // also on layer 3 (the glow layer)
  function sprites(scene, max, additive, tex, order, glow) {
    const T = THREE, geo = new T.InstancedBufferGeometry();
    const base = new T.PlaneGeometry(1, 1);
    geo.index = base.index; geo.setAttribute('position', base.attributes.position); geo.setAttribute('uv', base.attributes.uv);
    const pos = new Float32Array(3 * max), col = new Float32Array(4 * max), size = new Float32Array(2 * max);
    geo.setAttribute('iPos', new T.InstancedBufferAttribute(pos, 3).setUsage(T.DynamicDrawUsage));
    geo.setAttribute('iCol', new T.InstancedBufferAttribute(col, 4).setUsage(T.DynamicDrawUsage));
    geo.setAttribute('iSize', new T.InstancedBufferAttribute(size, 2).setUsage(T.DynamicDrawUsage));
    geo.instanceCount = 0;
    const mat = new T.ShaderMaterial({ vertexShader: VERT, fragmentShader: FRAG, uniforms: { map: { value: tex } }, transparent: true, depthWrite: false, blending: additive ? T.AdditiveBlending : T.NormalBlending });
    const mesh = new T.Mesh(geo, mat);
    mesh.frustumCulled = false; mesh.renderOrder = order; mesh.layers.set(2);
    scene.add(mesh);
    let glowMesh = null;
    if (glow) {
      glowMesh = new T.Mesh(geo, new T.ShaderMaterial({ vertexShader: VERT, fragmentShader: GLOW_FRAG, uniforms: { map: { value: tex }, glow: { value: glow } }, transparent: true, depthWrite: false, blending: T.AdditiveBlending }));
      glowMesh.frustumCulled = false; glowMesh.layers.set(3);
      scene.add(glowMesh);
    }
    let n = 0;
    const show = (on) => { mesh.visible = on; if (glowMesh) glowMesh.visible = on; };
    return {
      begin() { n = 0; },
      add(x, y, z, s, rot, r, g, b, a) {
        if (n >= max || a <= 0.002 || s <= 0) return;
        pos[3 * n] = x; pos[3 * n + 1] = y; pos[3 * n + 2] = z; size[2 * n] = s; size[2 * n + 1] = rot;
        col[4 * n] = r; col[4 * n + 1] = g; col[4 * n + 2] = b; col[4 * n + 3] = a; n++;
      },
      end() { geo.instanceCount = n; for (const k of ['iPos', 'iCol', 'iSize']) geo.attributes[k].needsUpdate = true; show(n > 0); },
      hide() { geo.instanceCount = 0; show(false); },
      dispose() { scene.remove(mesh); mat.dispose(); if (glowMesh) { scene.remove(glowMesh); glowMesh.material.dispose(); } geo.dispose(); },
    };
  }

  function Effects(scene) {
    const T = THREE;
    const flameTex = puffTexture('flame'), smokeTex = puffTexture('smoke');
    const smoke = sprites(scene, 1400, false, smokeTex, 5), steamS = sprites(scene, 500, false, smokeTex, 6), flames = sprites(scene, 1600, true, flameTex, 7, 0.55), embers = sprites(scene, 300, true, flameTex, 8, 1);
    const light = new T.PointLight(0xff7a2e, 0, 14, 2);
    light.castShadow = false;
    scene.add(light);
    let list = [];   // [{ kind: 'fire' | 'steam', ...emitter geometry }]

    // haz: assess() results (with .at); k: the frame the cars rest in at the end
    function set(hazards, k) {
      list = [];
      for (const h of hazards || []) {
        if (!h || !(h.fire || h.steam)) continue;
        const P = h.at(k), f = P.f, up = P.u, l = [f[1] * up[2] - f[2] * up[1], f[2] * up[0] - f[0] * up[2], f[0] * up[1] - f[1] * up[0]];
        const add = (p, s, dx, dy, dz) => [p[0] + f[0] * dx + up[0] * dy + l[0] * dz * s, p[1] + f[1] * dx + up[1] * dy + l[1] * dz * s, p[2] + f[2] * dx + up[2] * dy + l[2] * dz * s];
        if (h.steam) list.push({ kind: 'steam', p: add(P.front, 1, -0.15, 0.45, 0), seed: 11 + list.length });
        if (h.fire) {
          // flames from the back of the engine bay (the exhaust side), across it, out of the wheel
          // arches, and from burning fluid pooling on the road under the engine
          const e = P.engine;
          list.push({ kind: 'fire', p: add(e, 1, -0.15, 0.30, 0), w: 0.30, seed: 21 + list.length, grow: 0 });
          list.push({ kind: 'fire', p: add(e, 1, 0.1, 0.22, -0.40), w: 0.20, seed: 31 + list.length, grow: 1.5 });
          list.push({ kind: 'fire', p: add(e, 1, 0.1, 0.22, 0.40), w: 0.20, seed: 41 + list.length, grow: 2.2 });
          list.push({ kind: 'fire', p: add(e, 1, -0.1, 0.0, 0), w: 0.28, seed: 51 + list.length, grow: 3.0, pool: true });
          list[list.length - 1].p[1] = 0.04;
        }
      }
      if (!list.length) hide();
    }
    function hide() { flames.hide(); smoke.hide(); embers.hide(); steamS.hide(); light.intensity = 0; }

    // tau: seconds since the replay ended (< 0: nothing yet); wind blows the smoke along +x, +z
    function update(tau) {
      if (!list.length || tau < 0) { hide(); return { fire: 0, steam: 0 }; }
      flames.begin(); smoke.begin(); embers.begin(); steamS.begin();
      let fireLevel = 0, steamLevel = 0, lx = 0, ly = 0, lz = 0, lw = 0;
      const wind = [0.55, 0, 0.25];
      for (const em of list) {
        if (em.kind === 'steam') {
          // hot coolant: strong at first, dying down over ~40 s
          const I = smooth(0, 0.6, tau) * (0.35 + 0.65 * Math.exp(-tau / 14));
          steamLevel = Math.max(steamLevel, I);
          const R = 34, life = 2.4;
          for (let n = Math.max(0, Math.floor((tau - life) * R)); n <= Math.floor(tau * R); n++) {
            const tb = n / R, age = tau - tb;
            if (age < 0 || age > life || rnd(n, em.seed) > I) continue;
            const a = age / life, r1 = rnd(n, em.seed + 1), r2 = rnd(n, em.seed + 2), r3 = rnd(n, em.seed + 3);
            const x = em.p[0] + (r1 - 0.5) * 0.5 + wind[0] * age * 0.6 + (r2 - 0.5) * age * 0.5, z = em.p[2] + (r3 - 0.5) * 0.5 + wind[2] * age * 0.6 + (r1 - 0.5) * age * 0.4;
            const y = em.p[1] + age * (1.0 - 0.2 * age) + r2 * 0.1;
            steamS.add(x, y, z, 0.2 + a * 0.9, r3 * 6.28 + age * 0.4, 0.93, 0.94, 0.95, 0.26 * Math.sin(Math.PI * Math.min(1, a * 1.15)) * (1 - a * 0.4));
          }
          continue;
        }
        // fire: smoke from oil on the hot exhaust first, then flames that grow until well alight
        const tg = tau - em.grow;
        const Iflame = smooth(T_FLAME, T_FULL, tg) * (em.pool ? 0.75 : 1);
        const Ismoke = smooth(T_SMOKE, T_SMOKE + 2, tau) * (0.35 + 0.65 * smooth(T_FLAME, T_FULL, tg));
        fireLevel = Math.max(fireLevel, Iflame);
        const w = em.w * (em.pool ? 0.6 + 0.8 * smooth(0, 14, tg) : 1);
        // flames: about a metre tall when well alight
        const R = 85, life = 0.75;
        if (Iflame > 0.01) for (let n = Math.max(0, Math.floor((tau - life) * R)); n <= Math.floor(tau * R); n++) {
          const tb = n / R, age = tau - tb, lf = life * (0.55 + 0.45 * rnd(n, em.seed + 9));
          if (age < 0 || age > lf || rnd(n, em.seed) > smooth(T_FLAME, T_FULL, tb - em.grow) * (em.pool ? 0.75 : 1)) continue;
          const a = age / lf, r1 = rnd(n, em.seed + 1), r2 = rnd(n, em.seed + 2), r3 = rnd(n, em.seed + 3), r4 = rnd(n, em.seed + 4);
          const ang = r1 * Math.PI * 2, rad = Math.sqrt(r2) * w;
          const sway = Math.sin(tb * 7 + r3 * 6) * 0.08 * a + Math.sin(tau * 3.1 + r4 * 4) * 0.05 * a;
          const x = em.p[0] + Math.cos(ang) * rad * (1 - 0.5 * a) + wind[0] * age * 0.5 + sway, z = em.p[2] + Math.sin(ang) * rad * (1 - 0.5 * a) + wind[2] * age * 0.5 + sway * 0.6;
          const y = em.p[1] + age * (0.55 + 0.6 * r4) * (0.6 + 0.4 * Iflame) + 0.05;
          const size = (0.16 + 0.26 * r3) * (0.6 + 0.4 * Iflame) * (a < 0.25 ? 0.6 + 1.6 * a : 1.0 - 0.75 * (a - 0.25));
          // white-yellow core -> orange -> deep red, fading
          const cr = 1.0, cg = a < 0.2 ? 0.82 - a * 1.2 : 0.58 - 0.5 * a, cb = a < 0.15 ? 0.45 - a * 2.4 : 0.08 * (1 - a);
          const alpha = (a < 0.1 ? a / 0.1 : 1 - (a - 0.1) / 0.9) * 0.55 * (0.5 + 0.5 * Iflame);
          flames.add(x, y, z, size, r4 * 6.28 + age * (r1 - 0.5) * 3, cr, Math.max(0.05, cg), Math.max(0, cb), alpha);
          lx += x * alpha; ly += y * alpha; lz += z * alpha; lw += alpha;
        }
        // smoke: dark and sooty, rising and spreading downwind
        const Rs = 26, lifeS = 5.5;
        if (Ismoke > 0.01) for (let n = Math.max(0, Math.floor((tau - lifeS) * Rs)); n <= Math.floor(tau * Rs); n++) {
          const tb = n / Rs, age = tau - tb;
          const Ib = smooth(T_SMOKE, T_SMOKE + 2, tb) * (0.35 + 0.65 * smooth(T_FLAME, T_FULL, tb - em.grow));
          if (age < 0 || age > lifeS || rnd(n, em.seed + 20) > Ib) continue;
          const a = age / lifeS, r1 = rnd(n, em.seed + 21), r2 = rnd(n, em.seed + 22), r3 = rnd(n, em.seed + 23);
          const rise = (0.7 + 0.5 * r1) * (0.6 + 0.4 * Ib);
          const x = em.p[0] + (r2 - 0.5) * w * 2 + wind[0] * age * (0.4 + 0.5 * a) + (r3 - 0.5) * age * 0.4;
          const z = em.p[2] + (r3 - 0.5) * w * 2 + wind[2] * age * (0.4 + 0.5 * a) + (r1 - 0.5) * age * 0.4;
          const y = em.p[1] + 0.5 + age * rise * (1 - 0.25 * a);
          const g = 0.09 + 0.12 * a + 0.08 * r2 * (1 - Ib);   // darker when the fire is big
          smoke.add(x, y, z, (0.3 + 0.25 * r1) * (1 + a * 3) * (0.6 + 0.4 * Ib), r3 * 6.28 + age * (r2 - 0.5) * 0.6, g, g * 0.96, g * 0.93, 0.5 * Math.sin(Math.PI * Math.min(1, a * 1.1 + 0.05)) * (1 - 0.5 * a));
        }
        // embers: sparks lifted by the flames
        const Re = 16, lifeE = 2.2;
        if (Iflame > 0.2) for (let n = Math.max(0, Math.floor((tau - lifeE) * Re)); n <= Math.floor(tau * Re); n++) {
          const tb = n / Re, age = tau - tb;
          if (age < 0 || age > lifeE || rnd(n, em.seed + 40) > smooth(T_FLAME + 1, T_FULL, tb - em.grow) * 0.8) continue;
          const a = age / lifeE, r1 = rnd(n, em.seed + 41), r2 = rnd(n, em.seed + 42), r3 = rnd(n, em.seed + 43);
          const x = em.p[0] + (r1 - 0.5) * w + wind[0] * age + Math.sin(age * 5 + r2 * 6) * 0.15, z = em.p[2] + (r2 - 0.5) * w + wind[2] * age + Math.cos(age * 4 + r3 * 6) * 0.15;
          const y = em.p[1] + 0.3 + age * (1.4 + 1.0 * r3) - 0.4 * age * age;
          embers.add(x, y, z, 0.03 + 0.02 * r1, 0, 1.0, 0.55 + 0.3 * r2, 0.15, 0.9 * (1 - a));
        }
      }
      flames.end(); smoke.end(); embers.end(); steamS.end();
      // the fire lights its surroundings, flickering
      if (lw > 0) {
        light.position.set(lx / lw, ly / lw + 0.2, lz / lw);
        const flicker = 0.75 + 0.15 * Math.sin(tau * 17.3) + 0.1 * Math.sin(tau * 31.7 + 1.3);
        light.intensity = 18 * fireLevel * flicker;
      } else light.intensity = 0;
      return { fire: fireLevel, steam: steamLevel };
    }
    return { set, update, hide, get active() { return list.length > 0; }, dispose() { hide(); flames.dispose(); smoke.dispose(); embers.dispose(); steamS.dispose(); scene.remove(light); } };
  }

  // the results note for a list of assess() results (multi: label them car A / car B by unit)
  function describe(list, multi) {
    const who = (h) => multi ? `Car ${h.unit ? 'B' : 'A'}: the` : 'The';
    return (list.some(h => h.fire) ? 'Fire. ' : 'Steam. ') + list.map(h => h.fire
      ? `${who(h)} engine was driven ${Math.round(h.engineBack * 100)} cm back toward the firewall, crushing the fuel and oil lines against the hot exhaust, so the engine bay catches fire after the crash.`
      : `${who(h)} front was crushed back to the radiator, so hot coolant vents as steam.`).join(' ') + ' Shown in real time once the replay ends.';
  }
  // live readout rows during the aftermath (levels from Effects.update)
  function liveRows(list, after, lv) {
    if (!(after > 0)) return [];
    const fire = list.some(h => h.fire);
    return [['After the crash', `${after.toFixed(1)} s`], fire ? ['Engine bay', lv.fire > 0.02 ? (lv.fire < 0.9 ? 'fire spreading' : 'on fire') : 'smoking', 'bad'] : ['Radiator', 'venting steam']];
  }

  const api = { ENGINE_BACK, RADIATOR, T_SMOKE, T_FLAME, T_FULL, assess, describe, liveRows, Effects };
  if (typeof module === 'object' && module.exports) module.exports = api;
  return api;
})();
