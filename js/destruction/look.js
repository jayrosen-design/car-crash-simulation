/* The Destruction mode's look: dusk, the heavy vehicles, dents, explosions and fire, the glow.
 *
 * DUSK: the light for RaceRender.create (a low orange sun down Harbor Blvd, a violet-blue sky, warm
 * haze, more windows lit).
 *
 * create(R, level, opts) adds to the Race renderer's scene:
 * - the bus, the box truck and the gas tanker: built from boxes and cylinders, one instanced set
 *   each (one draw call per material), painted per instance;
 * - dents: every instanced vehicle (and the Race renderer's instanced cars) gets per-instance crush
 *   amounts (front, rear, left, right, roof) and a scorch, applied in the vertex and fragment
 *   shaders: the end that hit something is squashed back, a side pushed in, a roof flattened;
 * - the junction's dressing: the gas station's canopy and kiosk, neon signs, light pools under the
 *   street lights, the traffic lights' lamps, steam from the manholes, the pickups;
 * - headlights and tail lights on the traffic;
 * - explosions: a fireball, a column of smoke, a shockwave over the ground, a flash, embers and
 *   blackened bits flying, a scorch mark left behind, and a shake of the camera;
 * - burning wrecks: flames and smoke that follow each wreck;
 * - a few point lights (a fixed pool, so no shader is rebuilt when a fire starts) given to the
 *   brightest fires and blasts;
 * - bloom: the glow of the fire, sparks and neon (the simulator's selective bloom, scene.js), off
 *   on touch screens.
 * Every effect is a function of time since it started (seeded per particle), as in fire.js.
 *
 * Uses window.THREE, FX (fx.js) and CrashFire's sprites (fire.js).
 */
const DestructionLook = (() => {
  'use strict';
  const T = THREE;

  // ---------------------------------------------------------------- the light at dusk
  const DUSK = {
    sky: 0x2b2440, fog: 0x7d6273, fogNear: 90, fogFar: 1150, hemiSky: 0x8d8fd0, hemiGround: 0x3c2b28, hemi: 0.75,
    sun: 0xff8a4a, sunI: 2.4, sunDir: [-0.93, 0.16, 0.33], exposure: 0.92, hdr: false, windowGlow: '0.3', windowLit: '0.7',
    domeFrag: 'uniform vec3 sunDir; varying vec3 vD; void main(){ float h = max(vD.y, 0.0); vec3 hor = vec3(1.0,0.52,0.30), mid = vec3(0.55,0.32,0.52), zen = vec3(0.10,0.11,0.26); vec3 c = mix(hor, mid, smoothstep(0.0, 0.16, h)); c = mix(c, zen, smoothstep(0.12, 0.7, h)); float s = max(dot(vD, sunDir), 0.0); c += vec3(1.0,0.62,0.30) * (pow(s, 600.0) * 5.0 + pow(s, 10.0) * 0.55); c = mix(c, vec3(0.42,0.30,0.36), smoothstep(0.0, -0.05, vD.y)); gl_FragColor = vec4(c, 1.0); }',
    envFrag: 'uniform vec3 sunDir; varying vec3 vD; void main(){ float h = vD.y; vec3 c = mix(vec3(0.20,0.15,0.16), vec3(0.85,0.50,0.38), smoothstep(-0.2, 0.02, h)); c = mix(c, vec3(0.22,0.22,0.42), smoothstep(0.05, 0.6, h)); float s = max(dot(normalize(vD), sunDir), 0.0); c += vec3(1.0,0.6,0.3) * (pow(s, 400.0) * 30.0 + pow(s, 8.0) * 0.5); gl_FragColor = vec4(c, 1.0); }',
  };
  // the traffic's paints (sRGB)
  const PAINTS = [0xa3161f, 0x1d4fa3, 0xe9e9e6, 0x121315, 0x9ea3a8, 0xd9581c, 0xe6b81e, 0x1f6b43];
  const BUS_PAINTS = [0xd8a21c, 0xc22a22, 0x2a5fb0, 0x2d8a4e];
  const rnd = (i, k) => { let h = Math.imul(i ^ 0x9e3779b9, 0x85ebca6b) ^ Math.imul(k + 0x27d4eb2f, 0xc2b2ae35); h ^= h >>> 15; h = Math.imul(h, 0x2c1b3c6d); h ^= h >>> 12; return (h >>> 0) / 4294967296; };

  // ---------------------------------------------------------------- dents (a shader patch)
  // instance attributes dentA (front, rear, left, right crush 0..1) and dentB (roof, burnt, -, -);
  // uniforms: the model's box (centre, half sizes) in its own coordinates
  function dentPatch(mat, centre, half, name) {
    const prev = mat.onBeforeCompile;
    mat.onBeforeCompile = (sh, r) => {
      if (prev) prev(sh, r);
      sh.uniforms.uDentC = { value: new T.Vector3(...centre) }; sh.uniforms.uDentH = { value: new T.Vector3(...half) };
      sh.vertexShader = sh.vertexShader.replace('#include <common>', `#include <common>
attribute vec4 dentA; attribute vec4 dentB; uniform vec3 uDentC; uniform vec3 uDentH; varying float vBurnt; varying float vCrush;`)
        .replace('#include <begin_vertex>', `#include <begin_vertex>
{
  vec3 q = (transformed - uDentC) / uDentH;
  float wob = sin(transformed.x * 7.1 + transformed.y * 5.3) * sin(transformed.z * 6.7 - transformed.x * 3.1);
  float fr = dentA.x * smoothstep(0.25, 1.0, q.x), re = dentA.y * smoothstep(0.25, 1.0, -q.x);
  float le = dentA.z * smoothstep(0.15, 1.0, -q.z), ri = dentA.w * smoothstep(0.15, 1.0, q.z), ro = dentB.x * smoothstep(0.05, 1.0, q.y);
  transformed.x -= (fr - re) * uDentH.x * 0.34;
  transformed.z += (le - ri) * uDentH.z * 0.42;
  transformed.y -= ro * uDentH.y * 0.42 + (fr + re) * uDentH.y * 0.12 * max(q.y, 0.0);
  transformed += 0.07 * wob * (fr + re + le + ri + ro) * normal;
  vBurnt = dentB.y; vCrush = clamp(fr + re + le + ri + ro, 0.0, 1.0);
}`);
      sh.fragmentShader = sh.fragmentShader.replace('#include <common>', '#include <common>\nvarying float vBurnt; varying float vCrush;')
        .replace('#include <color_fragment>', `#include <color_fragment>
diffuseColor.rgb = mix(diffuseColor.rgb, vec3(0.045, 0.04, 0.035), clamp(vBurnt, 0.0, 0.92));
diffuseColor.rgb *= 1.0 - 0.25 * vCrush;`)
        .replace('#include <roughnessmap_fragment>', '#include <roughnessmap_fragment>\nroughnessFactor = mix(roughnessFactor, 0.95, clamp(vBurnt, 0.0, 1.0));');
    };
    mat.customProgramCacheKey = () => 'dent:' + name + ':' + (mat.type || '');
    mat.needsUpdate = true;
  }
  function addDentAttrs(geo, count) {
    if (geo.attributes.dentA) return;
    geo.setAttribute('dentA', new T.InstancedBufferAttribute(new Float32Array(4 * count), 4).setUsage(T.DynamicDrawUsage));
    geo.setAttribute('dentB', new T.InstancedBufferAttribute(new Float32Array(4 * count), 4).setUsage(T.DynamicDrawUsage));
  }

  // ---------------------------------------------------------------- the heavy vehicles' meshes
  // parts by material: [[geometry, material key], ...], the model's origin at its middle on the
  // ground, x along it
  function heavyParts(key, H) {
    const L = H.length, W = H.width, parts = { paint: [], white: [], glass: [], dark: [], metal: [], tank: [], head: [], tail: [], sign: [], tyre: [] };
    const box = (k, w, h, d, x, y, z) => { const g = new T.BoxGeometry(w, h, d); g.translate(x, y, z); parts[k].push(g); };
    const wheel = (x, z, r) => { const g = new T.CylinderGeometry(r, r, 0.32, 16); g.rotateX(Math.PI / 2); g.translate(x, r, z); parts.tyre.push(g); };
    const axles = (xs, r) => { for (const x of xs) for (const z of [-(W / 2 - 0.2), W / 2 - 0.2]) wheel(x, z, r); };
    const lamps = (xf, yH, yT) => {
      for (const z of [-(W / 2 - 0.3), W / 2 - 0.3]) { box('head', 0.06, 0.18, 0.32, xf + 0.02, yH, z); box('tail', 0.06, 0.24, 0.2, -L / 2 - 0.02, yT, z); }
    };
    if (key === 'bus') {
      box('paint', L, 1.0, W, 0, 0.85, 0);                       // lower body
      box('glass', L - 0.3, 1.15, W + 0.02, -0.1, 1.95, 0);        // the window band
      box('paint', 0.1, 1.15, W - 0.1, L / 2 - 0.08, 1.95, 0);    // (front pillar)
      box('white', L, 0.55, W, 0, 2.8, 0);                         // roof band
      box('glass', 0.08, 1.4, W - 0.25, L / 2 + 0.01, 1.85, 0);    // windscreen
      box('sign', 0.06, 0.32, W - 0.6, L / 2 + 0.03, 2.82, 0);     // destination sign
      box('dark', L - 0.4, 0.28, W - 0.2, 0, 0.36, 0);             // underside
      box('white', 2.6, 0.3, 1.2, -1.5, 3.2, 0);                   // the roof unit
      axles([L / 2 - 2.3, -L / 2 + 3.3], 0.52);
      lamps(L / 2, 0.75, 0.9);
    } else if (key === 'truck') {
      const cab = 2.3, xc = L / 2 - cab / 2;
      box('paint', cab, 1.5, W, xc, 1.25, 0);                      // the cab
      box('glass', 0.08, 0.9, W - 0.2, L / 2 + 0.01, 2.05, 0);
      box('paint', cab - 0.4, 0.9, W, xc - 0.2, 2.05, 0);
      box('glass', cab - 0.8, 0.7, W + 0.02, xc + 0.1, 2.1, 0);
      box('white', L - cab - 0.2, 2.9, W, -cab / 2 - 0.1, 2.0, 0);   // the box
      box('paint', L - cab - 0.2, 0.25, W + 0.03, -cab / 2 - 0.1, 1.3, 0);   // its stripe
      box('dark', L - 0.3, 0.35, W - 0.4, 0, 0.55, 0);             // chassis
      axles([L / 2 - 1.5, -L / 2 + 2.0, -L / 2 + 3.2], 0.48);
      lamps(L / 2, 0.85, 0.9);
    } else {   // tanker: tractor and a polished tank
      const cab = 2.9, xc = L / 2 - cab / 2;
      box('paint', cab, 1.7, W, xc, 1.4, 0);
      box('paint', 1.2, 0.9, W, xc + 0.5, 2.6, 0);
      box('glass', 0.08, 0.85, W - 0.2, L / 2 + 0.01, 2.45, 0);
      box('glass', 1.0, 0.65, W + 0.02, xc + 0.6, 2.5, 0);
      box('dark', L - 0.3, 0.4, 1.2, 0, 0.75, 0);                  // chassis
      const tl = L - cab - 0.5, tx = -cab / 2 - 0.15, r = 1.15;
      const tank = new T.CylinderGeometry(r, r, tl, 28, 1); tank.rotateZ(Math.PI / 2); tank.translate(tx, 2.25, 0); parts.tank.push(tank);
      for (const s of [-1, 1]) { const cap = new T.SphereGeometry(r, 24, 10, 0, Math.PI * 2, 0, Math.PI / 2); cap.scale(0.35, 1, 1); cap.rotateZ(-s * Math.PI / 2); cap.translate(tx + s * tl / 2, 2.25, 0); parts.tank.push(cap); }
      box('dark', tl * 0.6, 0.18, 0.5, tx, 3.43, 0);               // the catwalk on top
      for (const s of [-1, 1]) box('sign', 0.04, 0.5, 0.5, tx + s * (tl / 2 - 0.8), 2.25, 0);   // (placards: drawn on the sides below)
      for (const z of [-1.16, 1.16]) box('sign', 0.6, 0.6, 0.03, tx - tl * 0.3, 2.0, z);
      axles([L / 2 - 1.4, -L / 2 + 1.0, -L / 2 + 2.3, L / 2 - cab - 0.6], 0.52);
      lamps(L / 2, 0.9, 1.0);
    }
    return parts;
  }
  function heavyMaterials(env) {
    return {
      paint: new T.MeshPhysicalMaterial({ color: 0xffffff, metalness: 0.3, roughness: 0.42, clearcoat: 0.6, clearcoatRoughness: 0.2, envMap: env }),
      white: new T.MeshStandardMaterial({ color: 0xdcdad4, metalness: 0.1, roughness: 0.55, envMap: env }),
      glass: new T.MeshStandardMaterial({ color: 0x10161d, metalness: 0.6, roughness: 0.08, envMap: env }),
      dark: new T.MeshStandardMaterial({ color: 0x1b1c1e, roughness: 0.8 }),
      metal: new T.MeshStandardMaterial({ color: 0x8c9096, metalness: 0.9, roughness: 0.35, envMap: env }),
      tank: new T.MeshStandardMaterial({ color: 0xd6dbe0, metalness: 1.0, roughness: 0.18, envMap: env }),
      head: new T.MeshStandardMaterial({ color: 0xfff4dc, emissive: 0xfff0d0, emissiveIntensity: 2.0 }),
      tail: new T.MeshStandardMaterial({ color: 0x8a1010, emissive: 0xff2a1a, emissiveIntensity: 1.6 }),
      sign: new T.MeshStandardMaterial({ color: 0xf08a1a, emissive: 0xf07a10, emissiveIntensity: 0.9 }),
      tyre: new T.MeshStandardMaterial({ color: 0x141517, roughness: 0.92 }),
    };
  }

  // ---------------------------------------------------------------- textures drawn on a canvas
  function canvasTex(w, h, draw) {
    const c = document.createElement('canvas'); c.width = w; c.height = h;
    draw(c.getContext('2d'), w, h);
    const t = new T.CanvasTexture(c); t.colorSpace = T.SRGBColorSpace; t.anisotropy = 4;
    return t;
  }
  const radial = (stops) => canvasTex(128, 128, (g, w, h) => { const gr = g.createRadialGradient(w / 2, h / 2, 0, w / 2, h / 2, w / 2); for (const [p, c] of stops) gr.addColorStop(p, c); g.fillStyle = gr; g.fillRect(0, 0, w, h); });
  function neonTex(text, color) {
    return canvasTex(512, 128, (g, w, h) => {
      g.font = 'italic 800 84px "Barlow Condensed", "Arial Narrow", Arial, sans-serif'; g.textAlign = 'center'; g.textBaseline = 'middle';
      g.shadowColor = color; g.shadowBlur = 26; g.fillStyle = color;
      for (let i = 0; i < 3; i++) g.fillText(text, w / 2, h / 2 + 4);
      g.shadowBlur = 0; g.fillStyle = '#ffffff'; g.globalAlpha = 0.85; g.fillText(text, w / 2, h / 2 + 4);
    });
  }

  /* R: RaceRender; level: junction.js; opts: { touch } */
  function create(R, level, opts = {}) {
    const scene = R.scene, camera = R.camera, renderer = R.renderer, env = scene.environment;
    const touch = !!opts.touch;
    const group = new T.Group(); scene.add(group);

    // ------------------------------------------------ heavy vehicles: instanced sets
    const heavy = {};
    function prepareHeavy(specs, capacity) {
      const mats = heavyMaterials(env);
      for (const key of ['bus', 'truck', 'tanker']) {
        const H = specs[key], parts = heavyParts(key, H), meshes = [];
        for (const [mk, list] of Object.entries(parts)) {
          if (!list.length) continue;
          const g = window.mergeGeometries(list.map(x => x.index ? x.toNonIndexed() : x).map(x => { for (const k of Object.keys(x.attributes)) if (k !== 'position' && k !== 'normal' && k !== 'uv') x.deleteAttribute(k); if (!x.attributes.uv) x.setAttribute('uv', new T.Float32BufferAttribute(new Float32Array(2 * x.attributes.position.count), 2)); return x; }));
          addDentAttrs(g, capacity);
          const m = mats[mk].clone();
          if (mk !== 'head' && mk !== 'tail' && mk !== 'sign') dentPatch(m, [0, H.height / 2, 0], [H.length / 2, H.height / 2, H.width / 2], key + mk);
          const im = new T.InstancedMesh(g, m, capacity);
          im.castShadow = mk !== 'glass'; im.receiveShadow = true; im.frustumCulled = false; im.count = 0;
          im.instanceMatrix.setUsage(T.DynamicDrawUsage);
          im.userData.occluder = true;
          if (mk === 'paint') im.instanceColor = new T.InstancedBufferAttribute(new Float32Array(3 * capacity).fill(1), 3);
          scene.add(im);
          meshes.push(im);
        }
        heavy[key] = { meshes, paint: meshes.find(m => m.instanceColor), used: 0, H, geos: meshes.map(m => m.geometry) };
      }
    }
    // the Race renderer's cars get the same dents
    const carDent = {};
    function patchCars(specs) {
      for (const key of ['lexus', 'mustang']) {
        const set = R.carMeshes[key], S = specs[key], Hh = S.height || 1.5;
        if (!set) continue;
        const cap = set.body[0].instanceMatrix.count;
        for (const im of set.body) { addDentAttrs(im.geometry, cap); im.userData.occluder = true; if (im.material.userData.cls !== 'glass') dentPatch(im.material, [S.xMin + S.length / 2, Hh / 2, 0], [S.length / 2, Hh / 2, S.width / 2], key + im.material.uuid.slice(0, 4)); }
        for (const im of set.wheelMeshes) im.userData.occluder = true;
        carDent[key] = set.body.map(im => im.geometry);
      }
    }
    const C = new T.Color();
    function setDents(geos, i, d) {
      for (const g of geos) {
        const A = g.attributes.dentA, B = g.attributes.dentB;
        A.array[4 * i] = d[0]; A.array[4 * i + 1] = d[1]; A.array[4 * i + 2] = d[2]; A.array[4 * i + 3] = d[3];
        B.array[4 * i] = d[4]; B.array[4 * i + 1] = d[5] || 0;
      }
    }
    // draw heavy vehicle i of `key` with matrix M (origin: its middle on the ground); dents [f, r, l, rt, roof, burnt]
    function drawHeavy(key, i, M, paint, dents) {
      const set = heavy[key];
      if (!set) return;
      for (const im of set.meshes) im.setMatrixAt(i, M);
      if (paint !== undefined) set.paint.setColorAt(i, C.setHex(paint));
      setDents(set.geos, i, dents || ZERO);
      set.used = Math.max(set.used, i + 1);
    }
    const ZERO = [0, 0, 0, 0, 0, 0];
    const dentCar = (key, i, dents) => { if (carDent[key]) setDents(carDent[key], i, dents || ZERO); };
    function endHeavy() {
      for (const key in heavy) {
        const set = heavy[key];
        for (const im of set.meshes) { im.count = set.used; im.instanceMatrix.needsUpdate = true; }
        if (set.paint.instanceColor) set.paint.instanceColor.needsUpdate = true;
        for (const g of set.geos) { g.attributes.dentA.needsUpdate = true; g.attributes.dentB.needsUpdate = true; }
        set.used = 0;
      }
      for (const key in carDent) for (const g of carDent[key]) { g.attributes.dentA.needsUpdate = true; g.attributes.dentB.needsUpdate = true; }
    }

    // ------------------------------------------------ glow (bloom) sources and sprites
    const puffFlame = CrashFire.puffTexture('flame'), puffSmoke = CrashFire.puffTexture('smoke');
    const glowTex = radial([[0, 'rgba(255,255,255,1)'], [0.25, 'rgba(255,255,255,0.55)'], [1, 'rgba(255,255,255,0)']]);
    const smoke = CrashFire.sprites(scene, touch ? 900 : 1800, false, puffSmoke, 5);
    const flames = CrashFire.sprites(scene, touch ? 900 : 1800, true, puffFlame, 7, 0.6);
    const glows = CrashFire.sprites(scene, 600, true, glowTex, 8, 0.9);        // headlights, the flash, pickups
    const embers = new FX.Particles(scene, touch ? 1200 : 2500);

    // ------------------------------------------------ lights: a fixed pool
    const pool = [];
    for (let i = 0; i < (touch ? 2 : 4); i++) { const L = new T.PointLight(0xff7a2e, 0, 40, 1.6); L.castShadow = false; scene.add(L); pool.push(L); }

    // ------------------------------------------------ the junction's dressing
    const gs = level.gas;
    {
      // the canopy: a slab on four posts, lit underneath
      const cp = gs.canopy;
      const slab = new T.Mesh(new T.BoxGeometry(cp.hx * 2, 0.9, cp.hz * 2), new T.MeshStandardMaterial({ color: 0xe8e6e0, roughness: 0.5 }));
      slab.position.set(cp.x, cp.height + 0.45, cp.z); slab.castShadow = true; slab.receiveShadow = true; slab.userData.occluder = true; group.add(slab);
      const band = new T.Mesh(new T.BoxGeometry(cp.hx * 2 + 0.06, 0.38, cp.hz * 2 + 0.06), new T.MeshStandardMaterial({ color: 0xc8261e, emissive: 0xd8301e, emissiveIntensity: 0.8 }));
      band.position.set(cp.x, cp.height + 0.55, cp.z); group.add(band);
      const under = new T.Mesh(new T.PlaneGeometry(cp.hx * 2 - 0.4, cp.hz * 2 - 0.4), new T.MeshBasicMaterial({ color: 0xfff6e6 }));
      under.rotation.x = Math.PI / 2; under.position.set(cp.x, cp.height - 0.01, cp.z); group.add(under);
      const glowU = under.clone(); glowU.material = new T.MeshBasicMaterial({ color: 0x8a8070 }); glowU.layers.set(3); group.add(glowU);
      for (const [x, z] of [[21, 26], [21, 36], [39, 26], [39, 36]]) { const p = new T.Mesh(new T.CylinderGeometry(0.25, 0.25, cp.height, 12), new T.MeshStandardMaterial({ color: 0xd8d6d0, roughness: 0.5 })); p.position.set(x, cp.height / 2, z); p.castShadow = true; group.add(p); }
      // the canopy's light on the forecourt (a real light: fixed for the whole game)
      const L = new T.PointLight(0xfff0d8, 60, 30, 1.4); L.position.set(cp.x, cp.height - 0.6, cp.z); scene.add(L);
      // the kiosk's lit front and the price sign
      const k = gs.kiosk, win = new T.Mesh(new T.PlaneGeometry(k.hx * 1.6, 2.2), new T.MeshBasicMaterial({ color: 0xfff1cc }));
      win.position.set(k.x, 1.5, k.z - k.hz - 0.02); win.rotation.y = Math.PI; group.add(win);
    }
    // neon: signs on the buildings nearest the junction, facing the streets
    const NEON = [['DINER', '#ff3a6e'], ['HOTEL', '#38d7ff'], ['BAR', '#ff9b2e'], ['PIZZA', '#ffd23a'], ['OPEN 24H', '#62ff7a'], ['CINEMA', '#c66bff'], ['GAS', '#ff3a3a'], ['DONUTS', '#ff6bd2']];
    const neonList = [];
    {
      const near = level.buildings.filter(b => Math.hypot(b.x, b.z) < 120 && b !== gs.kiosk).sort((a, b) => Math.hypot(a.x, a.z) - Math.hypot(b.x, b.z)).slice(0, 7);
      near.forEach((b, i) => {
        // the face toward the nearer street
        const toMain = Math.abs(b.x) - b.hx, toHarbor = Math.abs(b.z) - b.hz;
        let x, z, ry;
        if (toMain < toHarbor) { x = b.x - Math.sign(b.x) * (b.hx + 0.08); z = b.z + (rnd(i, 3) - 0.5) * b.hz; ry = b.x > 0 ? -Math.PI / 2 : Math.PI / 2; }
        else { z = b.z - Math.sign(b.z) * (b.hz + 0.08); x = b.x + (rnd(i, 3) - 0.5) * b.hx; ry = b.z > 0 ? Math.PI : 0; }
        const [text, col] = NEON[i % NEON.length];
        neonList.push({ x, z, y: 6 + rnd(i, 5) * 6, ry, text, col });
      });
      neonList.push({ x: gs.kiosk.x, z: gs.kiosk.z - gs.kiosk.hz - 0.1, y: 3.4, ry: Math.PI, text: 'GAS · FOOD', col: '#ff3a3a' });
      for (const n of neonList) {
        const tex = neonTex(n.text, n.col);
        const m = new T.Mesh(new T.PlaneGeometry(7, 1.75), new T.MeshBasicMaterial({ map: tex, transparent: true, depthWrite: false, toneMapped: false }));
        m.position.set(n.x, level.terrain(n.x, n.z) + n.y, n.z); m.rotation.y = n.ry; group.add(m);
        const g = m.clone(); g.material = new T.MeshBasicMaterial({ map: tex, transparent: true, depthWrite: false, opacity: 0.8 }); g.layers.set(3); group.add(g);
      }
    }
    // pools of light under the street lights (one instanced decal)
    {
      const lamps = level.props.filter(p => p.type === 'lamp');
      const tex = radial([[0, 'rgba(255,214,150,0.55)'], [0.5, 'rgba(255,190,120,0.2)'], [1, 'rgba(255,170,100,0)']]);
      const g = new T.PlaneGeometry(1, 1); g.rotateX(-Math.PI / 2);
      const im = new T.InstancedMesh(g, new T.MeshBasicMaterial({ map: tex, transparent: true, depthWrite: false, blending: T.AdditiveBlending, polygonOffset: true, polygonOffsetFactor: -4 }), lamps.length);
      const M = new T.Matrix4();
      lamps.forEach((p, i) => { const off = 2.1, x = p.x + Math.cos(p.h) * off, z = p.z + Math.sin(p.h) * off; M.makeScale(13, 1, 13).setPosition(x, level.terrain(x, z) + 0.05, z); im.setMatrixAt(i, M); });
      im.renderOrder = 2; group.add(im);
    }
    // manholes that steam
    const vents = [[-3.5, -40], [4, 30], [-30, 5.5], [60, -6]].map(([x, z], i) => ({ x, z, seed: 300 + i }));

    // ------------------------------------------------ pickups: glowing icons
    const pickTex = {
      mult2: canvasTex(128, 128, (g, w, h) => { g.fillStyle = '#2b8cff'; g.beginPath(); g.arc(64, 64, 60, 0, 7); g.fill(); g.fillStyle = '#fff'; g.font = 'italic 900 64px Arial'; g.textAlign = 'center'; g.textBaseline = 'middle'; g.fillText('×2', 64, 68); }),
      mult4: canvasTex(128, 128, (g, w, h) => { g.fillStyle = '#b04cff'; g.beginPath(); g.arc(64, 64, 60, 0, 7); g.fill(); g.fillStyle = '#fff'; g.font = 'italic 900 64px Arial'; g.textAlign = 'center'; g.textBaseline = 'middle'; g.fillText('×4', 64, 68); }),
      cash: canvasTex(128, 128, (g, w, h) => { g.fillStyle = '#1fbf5a'; g.beginPath(); g.arc(64, 64, 60, 0, 7); g.fill(); g.fillStyle = '#fff'; g.font = '900 76px Arial'; g.textAlign = 'center'; g.textBaseline = 'middle'; g.fillText('$', 64, 70); }),
    };
    const pickMeshes = level.pickups.map((p) => {
      const tex = p.kind === 'cash' ? pickTex.cash : p.mult === 4 ? pickTex.mult4 : pickTex.mult2;
      const m = new T.Mesh(new T.PlaneGeometry(1.8, 1.8), new T.MeshBasicMaterial({ map: tex, transparent: true, side: T.DoubleSide, toneMapped: false }));
      const ring = new T.Mesh(new T.TorusGeometry(1.15, 0.07, 8, 40), new T.MeshBasicMaterial({ color: p.kind === 'cash' ? 0x6dffa0 : p.mult === 4 ? 0xe0a0ff : 0x9ccaff, toneMapped: false }));
      const g = new T.Group(); g.add(m, ring);
      const twin = ring.clone(); twin.layers.set(3); g.add(twin);
      g.position.set(p.x, level.groundAt(p.x, p.z).h + p.y, p.z); group.add(g);
      return g;
    });

    // ------------------------------------------------ explosions and fires (functions of time)
    const blasts = [];   // { x, y, z, r, size, t0, seed }
    let now = 0;
    const scorchTex = radial([[0, 'rgba(10,8,6,0.9)'], [0.55, 'rgba(14,10,8,0.6)'], [1, 'rgba(20,15,12,0)']]);
    const scorches = [];
    const ringMat = new T.MeshBasicMaterial({ color: 0xffb070, transparent: true, depthWrite: false, blending: T.AdditiveBlending, side: T.DoubleSide, toneMapped: false });
    const rings = [];
    for (let i = 0; i < 8; i++) { const g = new T.RingGeometry(0.82, 1, 72); g.rotateX(-Math.PI / 2); const m = new T.Mesh(g, ringMat.clone()); m.visible = false; m.layers.set(2); group.add(m); rings.push(m); }
    function blast(x, y, z, r, size) {
      const seed = blasts.length * 7 + 13;
      blasts.push({ x, y, z, r, size, t0: now, seed });
      // scorch on the ground (kept), embers and blackened bits flying now
      const s = new T.Mesh(new T.PlaneGeometry(1, 1).rotateX(-Math.PI / 2), new T.MeshBasicMaterial({ map: scorchTex, transparent: true, depthWrite: false, polygonOffset: true, polygonOffsetFactor: -5 }));
      const sc = Math.max(3, r * 0.45); s.scale.set(sc, 1, sc); s.position.set(x, level.terrain(x, z) + 0.06, z); s.renderOrder = 3; group.add(s); scorches.push(s);
      embers.spawn(x, y + 0.5, z, Math.round(70 * size), 'ember', [0, 1.2, 0]);
      embers.spawn(x, y + 0.5, z, Math.round(36 * size), 'debris', [0, 1.4, 0]);
      embers.spawn(x, y + 0.5, z, Math.round(40 * size), 'spark', [0, 1, 0]);
      const ring = rings.find(m => !m.visible) || rings[0];
      ring.visible = true; ring.userData = { t0: now, r, x, z, y: level.terrain(x, z) + 0.15 };
      shake(Math.min(1.6, size * 1.4), x, y, z);
    }

    // ------------------------------------------------ camera shake
    const shk = { on: !(window.matchMedia && matchMedia('(prefers-reduced-motion: reduce)').matches), amp: 0, t: 0, off: new T.Vector3(), roll: 0 };
    function shake(amount, x, y, z) {
      if (!shk.on) return;
      const d = x === undefined ? 0 : camera.position.distanceTo(new T.Vector3(x, y, z));
      shk.amp = Math.min(2, shk.amp + amount * Math.min(1, 40 / Math.max(10, d)));
    }
    const wob = (t, ph) => (Math.sin(2 * Math.PI * 13 * t + ph) + 0.6 * Math.sin(2 * Math.PI * 21 * t + 2.1 * ph) + 0.35 * Math.sin(2 * Math.PI * 37 * t + 3.7 * ph)) / 1.95;

    /* every frame. dt: s of game time; fires: [{ x, y, z, level 0..1, size (m), seed }];
     * lights: (brightest first, given the pool) ; traffic: [{ x, z, y, h, len, wid, heavy }] for
     * headlights; pickups taken: a Set of indices */
    function update(dt, fires, traffic, taken) {
      now += dt;
      smoke.begin(); flames.begin(); glows.begin();
      const lightsWanted = [];
      // explosions
      for (const b of blasts) {
        const a = now - b.t0, k = b.size;
        if (a > 12) continue;
        // the flash
        if (a < 0.25) { const f = 1 - a / 0.25; glows.add(b.x, b.y + 1, b.z, 6 * k * (1 + a * 3), 0, 1, 0.85, 0.55, 0.6 * f); lightsWanted.push([b.x, b.y + 2, b.z, 300 * k * f + 80 * k, 0xffb070]); }
        // the fireball: puffs flung out, slowing, rising, cooling
        const n = Math.round(26 + 34 * k);
        for (let i = 0; i < n; i++) {
          const life = 0.9 + 0.8 * rnd(i, b.seed);
          if (a > life) continue;
          const t = a / life, th = rnd(i, b.seed + 1) * 6.283, ph = Math.acos(2 * rnd(i, b.seed + 2) - 1) * 0.6, sp = (5 + 9 * rnd(i, b.seed + 3)) * (0.6 + 0.5 * k);
          const dist = sp * (1 - Math.exp(-a * 3.2)) / 3.2;
          const x = b.x + Math.sin(ph) * Math.cos(th) * dist, z = b.z + Math.sin(ph) * Math.sin(th) * dist, y = b.y + 0.5 + Math.cos(ph) * dist * 0.8 + a * a * 2.2;
          const s = (1.4 + 2.2 * rnd(i, b.seed + 4)) * (0.7 + 0.6 * k) * (0.5 + 1.3 * Math.min(1, a * 2.5));
          // (a hot yellow core for an instant, then orange and red: many of them add up, so each is faint)
          const cr = 1, cg = t < 0.1 ? 0.75 : t < 0.5 ? 0.62 - (t - 0.1) * 0.9 : 0.26 - (t - 0.5) * 0.3, cb = t < 0.1 ? 0.35 : Math.max(0.02, 0.16 - t * 0.3);
          flames.add(x, y, z, s, rnd(i, b.seed + 5) * 6.28 + a, cr, Math.max(0.06, cg), cb, Math.pow(1 - t, 1.4) * 0.5);
        }
        if (a < 1.2) lightsWanted.push([b.x, b.y + 3, b.z, 160 * k * (1 - a / 1.2), 0xff7a2e]);
        // the smoke column: dark, rising, spreading, for about 8 s
        const m = Math.round(16 + 26 * k);
        for (let i = 0; i < m; i++) {
          const tb = 0.15 + 1.6 * rnd(i, b.seed + 9), age = a - tb, life = 6 + 3 * rnd(i, b.seed + 10);
          if (age < 0 || age > life) continue;
          const t = age / life, r1 = rnd(i, b.seed + 11), r2 = rnd(i, b.seed + 12);
          const x = b.x + (r1 - 0.5) * 3 * k + age * 0.9, z = b.z + (r2 - 0.5) * 3 * k + age * 0.4, y = b.y + 1.5 + age * (2.2 + 1.5 * r2) * (1 - 0.3 * t);
          const g = 0.07 + 0.1 * t;
          smoke.add(x, y, z, (2 + 3 * r1) * (0.6 + 0.6 * k) * (1 + t * 2.5), r2 * 6.28 + age * 0.2, g, g * 0.95, g * 0.92, 0.6 * Math.sin(Math.PI * Math.min(1, t * 1.15 + 0.04)));
        }
      }
      // the shockwave rings
      for (const m of rings) {
        if (!m.visible) continue;
        const u = m.userData, a = now - u.t0;
        if (a > 0.7) { m.visible = false; continue; }
        const rr = u.r * 1.15 * (1 - Math.exp(-a * 6));
        m.scale.set(rr, 1, rr); m.position.set(u.x, u.y, u.z); m.material.opacity = 0.45 * (1 - a / 0.7);
      }
      // burning wrecks
      for (const f of fires) {
        const L = f.level, w = f.size, sd = f.seed;
        // flames: a continuous stream (birth n / rate), each a short life
        const rate = 46, life = 0.65;
        for (let n = Math.floor((now - life) * rate); n <= Math.floor(now * rate); n++) {
          const tb = n / rate, age = now - tb;
          if (age < 0 || age > life || rnd(n, sd) > 0.35 + 0.65 * L) continue;
          const a = age / life, r1 = rnd(n, sd + 1), r2 = rnd(n, sd + 2), r3 = rnd(n, sd + 3);
          const x = f.x + (r1 - 0.5) * w + age * 0.5, z = f.z + (r2 - 0.5) * w * 0.6 + age * 0.25, y = f.y + age * (1.4 + r3) * (0.7 + 0.5 * L);
          const s = (0.55 + 0.7 * r3) * (0.6 + 0.6 * L) * (w / 1.6) * (a < 0.25 ? 0.6 + 1.6 * a : 1.0 - 0.7 * (a - 0.25));
          flames.add(x, y, z, s, r1 * 6.28 + age * 2, 1, Math.max(0.1, 0.75 - a * 0.8), Math.max(0, 0.3 - a), (a < 0.1 ? a / 0.1 : 1 - (a - 0.1) / 0.9) * 0.7 * (0.5 + 0.5 * L));
        }
        const rs = 9, lifeS = 4.5;
        for (let n = Math.floor((now - lifeS) * rs); n <= Math.floor(now * rs); n++) {
          const tb = n / rs, age = now - tb;
          if (age < 0 || age > lifeS) continue;
          const a = age / lifeS, r1 = rnd(n, sd + 21), r2 = rnd(n, sd + 22);
          const g = 0.06 + 0.08 * a;
          smoke.add(f.x + (r1 - 0.5) * w + age * 0.8, f.y + 1 + age * (1.6 + r2), f.z + (r2 - 0.5) * w + age * 0.35, (0.9 + 0.6 * r1) * (w / 1.6) * (1 + a * 3), r2 * 6.28, g, g, g, 0.5 * Math.sin(Math.PI * Math.min(1, a * 1.1 + 0.05)) * (0.4 + 0.6 * L));
        }
        lightsWanted.push([f.x, f.y + 1.2, f.z, 25 * L * (w / 1.6) * (0.8 + 0.2 * Math.sin(now * 17 + sd)), 0xff7a2e]);
      }
      // manhole steam: slow white puffs
      for (const v of vents) {
        const rs = 3, lifeS = 4;
        for (let n = Math.floor((now - lifeS) * rs); n <= Math.floor(now * rs); n++) {
          const age = now - n / rs; if (age < 0 || age > lifeS) continue;
          const a = age / lifeS, r1 = rnd(n, v.seed), r2 = rnd(n, v.seed + 1);
          smoke.add(v.x + (r1 - 0.5) * 0.6 + age * 0.5, level.terrain(v.x, v.z) + 0.2 + age * 0.7, v.z + (r2 - 0.5) * 0.6 + age * 0.2, 0.8 + a * 2.5, r2 * 6.28, 0.75, 0.74, 0.78, 0.16 * Math.sin(Math.PI * a));
        }
      }
      // headlights and tail lights
      for (const v of traffic) {
        const c = Math.cos(v.h), s = Math.sin(v.h), fx = v.len / 2, w = v.wid / 2 - 0.3, y = v.y + (v.heavy ? 0.85 : 0.68);
        for (const side of [-1, 1]) {
          glows.add(v.x + c * (fx + 0.05) - s * side * w, y, v.z + s * (fx + 0.05) + c * side * w, 0.9, 0, 1, 0.92, 0.75, 0.55);
          glows.add(v.x - c * (fx + 0.05) - s * side * w, y + 0.1, v.z - s * (fx + 0.05) + c * side * w, 0.55, 0, 1, 0.12, 0.08, 0.6);
        }
      }
      // pickups: spinning and bobbing
      pickMeshes.forEach((g, i) => {
        g.visible = !taken.has(i);
        if (!g.visible) return;
        g.rotation.y = now * 2.2; const p = level.pickups[i];
        g.position.y = level.groundAt(p.x, p.z).h + p.y + 0.15 * Math.sin(now * 3 + i);
        glows.add(g.position.x, g.position.y, g.position.z, 3.4, 0, p.kind === 'cash' ? 0.4 : 0.6, p.kind === 'cash' ? 1 : 0.5, p.kind === 'cash' ? 0.5 : 1, 0.35);
      });
      smoke.end(); flames.end(); glows.end();
      embers.update(dt);
      embers.setScale(renderer.domElement.height / (2 * Math.tan(camera.fov * Math.PI / 360)));
      // the pool of lights: the brightest wanted
      lightsWanted.sort((a, b) => b[3] - a[3]);
      pool.forEach((L, i) => {
        const w = lightsWanted[i];
        if (!w) { L.intensity = 0; return; }
        L.position.set(w[0], w[1], w[2]); L.intensity = w[3]; L.color.setHex(w[4]);
      });
      shk.amp *= Math.exp(-dt * 2.2); shk.t += dt;
    }

    // ------------------------------------------------ bloom (scene.js renderBloom, for this scene)
    let bloom = null;
    function buildBloom() {
      const VS = 'varying vec2 vUv; void main() { vUv = uv; gl_Position = vec4(position.xy, 0.0, 1.0); }';
      const mat = (fs, additive) => new T.ShaderMaterial({ vertexShader: VS, fragmentShader: fs, depthTest: false, depthWrite: false,
        uniforms: { src: { value: null }, texel: { value: new T.Vector2() }, strength: { value: 1 } }, blending: additive ? T.AdditiveBlending : T.NoBlending, transparent: !!additive });
      const DOWN = `uniform sampler2D src; uniform vec2 texel; varying vec2 vUv;
        void main() { gl_FragColor = (4.0 * texture2D(src, vUv) + texture2D(src, vUv - texel) + texture2D(src, vUv + texel)
          + texture2D(src, vUv + vec2(texel.x, -texel.y)) + texture2D(src, vUv - vec2(texel.x, -texel.y))) / 8.0; }`;
      const UPS = `uniform sampler2D src; uniform vec2 texel; uniform float strength; varying vec2 vUv;
        void main() { vec2 t = texel;
          vec4 s = texture2D(src, vUv + vec2(-2.0 * t.x, 0.0)) + texture2D(src, vUv + vec2(2.0 * t.x, 0.0)) + texture2D(src, vUv + vec2(0.0, 2.0 * t.y)) + texture2D(src, vUv + vec2(0.0, -2.0 * t.y))
            + 2.0 * (texture2D(src, vUv + vec2(-t.x, t.y)) + texture2D(src, vUv + t) + texture2D(src, vUv + vec2(t.x, -t.y)) + texture2D(src, vUv - t));
          gl_FragColor = vec4(s.rgb / 12.0 * strength, 1.0); }`;
      const quad = new T.Mesh(new T.PlaneGeometry(2, 2)); quad.frustumCulled = false;
      return { quad, cam: new T.OrthographicCamera(-1, 1, 1, -1, 0, 1), down: mat(DOWN), up: mat(UPS, true), black: new T.MeshBasicMaterial({ color: 0x000000 }), glow: null, levels: [], w: 0, h: 0, swap: [] };
    }
    function pass(B, m, src, dst) {
      m.uniforms.src.value = src.texture; m.uniforms.texel.value.set(1 / src.width, 1 / src.height);
      B.quad.material = m; renderer.setRenderTarget(dst); renderer.render(B.quad, B.cam);
    }
    function renderBloom() {
      const B = bloom || (bloom = buildBloom()), w = renderer.domElement.width, h = renderer.domElement.height;
      const W = Math.max(8, Math.round(w / 2)), H = Math.max(8, Math.round(h / 2));
      if (W !== B.w || H !== B.h) {
        if (B.glow) { B.glow.dispose(); B.levels.forEach(L => L.dispose()); }
        B.glow = new T.WebGLRenderTarget(W, H, { type: T.HalfFloatType });
        B.levels = [];
        for (let lw = W >> 1, lh = H >> 1; lw >= 8 && lh >= 8 && B.levels.length < 5; lw >>= 1, lh >>= 1) B.levels.push(new T.WebGLRenderTarget(lw, lh, { type: T.HalfFloatType, depthBuffer: false }));
        B.w = W; B.h = H;
      }
      const autoClear = renderer.autoClear, shadows = renderer.shadowMap.autoUpdate, mask = camera.layers.mask, bg = scene.background, fog = scene.fog;
      const clear = renderer.getClearColor(new T.Color()), clearA = renderer.getClearAlpha();
      renderer.autoClear = false; renderer.shadowMap.autoUpdate = false;
      renderer.setRenderTarget(B.glow); renderer.setClearColor(0x000000, 1); renderer.clear();
      // the big solid things in black, so what's behind them doesn't glow through
      scene.background = null; scene.fog = null;
      camera.layers.set(0); camera.layers.enable(1);
      const sw = B.swap; sw.length = 0;
      scene.traverseVisible(o => {
        if (!o.isMesh) return;
        if (!o.userData.occluder && !(o.layers.mask & 2)) { sw.push(o, null); o.visible = false; return; }
        sw.push(o, o.material); o.material = o.userData.blackMat || B.black;
      });
      renderer.render(scene, camera);
      for (let i = 0; i < sw.length; i += 2) { if (sw[i + 1]) sw[i].material = sw[i + 1]; else sw[i].visible = true; }
      camera.layers.set(3);
      renderer.render(scene, camera);
      camera.layers.mask = mask; scene.background = bg; scene.fog = fog;
      let src = B.glow;
      for (const L of B.levels) { pass(B, B.down, src, L); src = L; }
      B.up.uniforms.strength.value = 1;
      for (let i = B.levels.length - 1; i > 0; i--) pass(B, B.up, B.levels[i], B.levels[i - 1]);
      B.up.uniforms.strength.value = 1.25;
      pass(B, B.up, B.levels[0], null);
      renderer.setClearColor(clear, clearA); renderer.autoClear = autoClear; renderer.shadowMap.autoUpdate = shadows;
    }
    // the buildings occlude the glow
    R.scene.traverse((o) => { if (o.isMesh && o.parent && o.parent !== scene && !o.isInstancedMesh && o.material && o.material.customProgramCacheKey && /facade/.test(o.material.customProgramCacheKey())) o.userData.occluder = true; });

    // draw the frame: shake, the scene, the glow
    const useBloom = !touch && !opts.noBloom;
    function render() {
      let shaken = false;
      if (shk.amp > 0.01) {
        const a = shk.amp * 0.12;
        shk.off.set(a * wob(shk.t, 0), 0.6 * a * wob(shk.t, 1.3), a * wob(shk.t, 2.9));
        shk.roll = 0.02 * shk.amp * wob(shk.t, 4.4);
        camera.position.add(shk.off); camera.rotateZ(shk.roll); camera.updateMatrixWorld();
        shaken = true;
      }
      FX.listen(camera.position, camera.getWorldDirection(new T.Vector3()), camera.up);
      renderer.setRenderTarget(null);
      renderer.render(scene, camera);
      if (useBloom) renderBloom();
      if (shaken) { camera.rotateZ(-shk.roll); camera.position.sub(shk.off); camera.updateMatrixWorld(); }
    }

    // once at load: every effect drawn (some drivers compile a shader only at its first draw)
    function warm() {
      const was = now;
      blast(camera.position.x + 30, 1, camera.position.z, 10, 0.5);
      update(0.05, [{ x: camera.position.x + 30, y: 1, z: camera.position.z, level: 1, size: 1.6, seed: 1 }], [{ x: 0, z: 0, y: 0, h: 0, len: 4.8, wid: 1.9 }], new Set());
      const culled = [];
      scene.traverse((o) => { if (o.frustumCulled && (o.isMesh || o.isPoints)) { o.frustumCulled = false; culled.push(o); } });
      renderer.compile(scene, camera);
      render();
      for (const o of culled) o.frustumCulled = true;
      reset(); now = was;
    }
    // back to the start of an attempt
    function reset() {
      blasts.length = 0;
      for (const s of scorches) { group.remove(s); s.geometry.dispose(); s.material.dispose(); }
      scorches.length = 0;
      for (const m of rings) m.visible = false;
      embers.clear(); smoke.hide(); flames.hide(); glows.hide();
      for (const L of pool) L.intensity = 0;
      shk.amp = 0;
    }

    return { prepareHeavy, patchCars, drawHeavy, dentCar, endHeavy, blast, shake, update, render, warm, reset, embers, pool, heavy, get now() { return now; } };
  }

  return { create, DUSK, PAINTS, BUS_PAINTS };
})();
