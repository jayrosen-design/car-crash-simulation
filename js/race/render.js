/* The Race game's renderer: the city, the cars and the cameras (three.js, WebGL).
 *
 * The city comes from the level (level.js): the street as a ribbon along the circuit with its lane
 * markings, kerbs and pavements; side-street stubs and their barriers; buildings merged into a few
 * meshes whose facades are drawn by a shader (floors, window bays, a shop front at street level,
 * some windows lit), plus street lights, trees and traffic signals as instanced meshes.
 *
 * Cars: the player's car is a CarModels instance (carmodel.js), skinned to its crash lattice, so it
 * can show the crash solver's damage without swapping models. Rivals and traffic share one merged
 * copy of each model, drawn as instances (one draw call per material), each with its own paint.
 *
 * Uses window.THREE (and the addons the page puts on window).
 */
const RaceRender = (() => {
  'use strict';
  const T = THREE;
  const UP = new T.Vector3(0, 1, 0), ZAXIS = new T.Vector3(0, 0, 1);

  function create(opts) {
    const { level, container } = opts;
    const renderer = new T.WebGLRenderer({ antialias: true, powerPreference: 'high-performance' });
    renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, opts.pixelRatio || 1.5));
    renderer.setSize(container.clientWidth, container.clientHeight);
    renderer.toneMapping = T.ACESFilmicToneMapping;
    renderer.toneMappingExposure = 1.0;
    renderer.shadowMap.enabled = true;
    renderer.shadowMap.type = T.PCFSoftShadowMap;
    container.appendChild(renderer.domElement);

    const scene = new T.Scene();
    const SKY = 0xc8b9a6, FOG = 0xbfb4a6;
    scene.background = new T.Color(SKY);
    scene.fog = new T.Fog(FOG, 220, 1700);
    const camera = new T.PerspectiveCamera(62, container.clientWidth / container.clientHeight, 0.1, 3000);
    camera.layers.enable(1);   // the CarModels meshes
    camera.layers.enable(2);   // sparks, dust and glass (FX.Particles)

    // light: a low late-afternoon sun and a warm-cool sky
    const hemi = new T.HemisphereLight(0xdfe7f2, 0x5a524a, 1.05);
    const sun = new T.DirectionalLight(0xffe3c2, 2.6);
    const SUN_DIR = new T.Vector3(-0.55, 0.52, -0.65).normalize();
    sun.castShadow = true;
    sun.shadow.mapSize.set(2048, 2048);
    Object.assign(sun.shadow.camera, { left: -70, right: 70, top: 70, bottom: -70, near: 1, far: 420 });
    sun.shadow.bias = -0.0004; sun.shadow.normalBias = 0.04;
    sun.shadow.camera.layers.enable(1);
    scene.add(hemi, sun, sun.target);

    // environment for reflections and ambient light: a photographed street (Poly Haven HDRI) when
    // media/race/assets.js is there, else a small sky-coloured scene with a bright sun patch
    const env = streetHDR(renderer) || (() => {
      const pm = new T.PMREMGenerator(renderer), room = new T.Scene();
      const sky = new T.Mesh(new T.SphereGeometry(50, 32, 16), new T.ShaderMaterial({ side: T.BackSide, depthWrite: false,
        uniforms: { sunDir: { value: SUN_DIR } },
        vertexShader: 'varying vec3 vD; void main(){ vD = normalize(position); gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0); }',
        fragmentShader: 'uniform vec3 sunDir; varying vec3 vD; void main(){ float h = vD.y; vec3 c = mix(vec3(0.42,0.39,0.36), vec3(0.78,0.74,0.69), smoothstep(-0.2, 0.02, h)); c = mix(c, vec3(0.45,0.58,0.78), smoothstep(0.02, 0.6, h)); float s = max(dot(normalize(vD), sunDir), 0.0); c += vec3(1.0,0.85,0.6) * (pow(s, 600.0) * 40.0 + pow(s, 8.0) * 0.4); gl_FragColor = vec4(c, 1.0); }' }));
      room.add(sky);
      const t = pm.fromScene(room, 0).texture;
      pm.dispose();
      return t;
    })();
    scene.environment = env;

    // sky dome (visible): the same gradient, with haze toward the horizon
    {
      const dome = new T.Mesh(new T.SphereGeometry(2600, 32, 16), new T.ShaderMaterial({ side: T.BackSide, depthWrite: false, fog: false,
        uniforms: { sunDir: { value: SUN_DIR } },
        vertexShader: 'varying vec3 vD; void main(){ vD = normalize(position); vec4 p = modelViewMatrix * vec4(position, 1.0); gl_Position = projectionMatrix * p; }',
        fragmentShader: 'uniform vec3 sunDir; varying vec3 vD; void main(){ float h = max(vD.y, 0.0); vec3 hor = vec3(0.80,0.74,0.66), zen = vec3(0.36,0.52,0.74); vec3 c = mix(hor, zen, pow(h, 0.55)); float s = max(dot(vD, sunDir), 0.0); c += vec3(1.0,0.82,0.55) * (pow(s, 900.0) * 6.0 + pow(s, 12.0) * 0.35); gl_FragColor = vec4(c, 1.0); }' }));
      dome.renderOrder = -1;
      scene.add(dome);
      scene.userData.dome = dome;
    }

    const city = new T.Group();
    scene.add(city);
    buildGround(city);
    buildStreet(city, level);
    buildBuildings(city, level);
    buildFurniture(city, level);
    buildStart(city, level);

    // ------------------------------------------------ cars
    const carMeshes = {};   // key -> instanced set
    async function prepareCars(keys, capacity) {
      for (const key of keys) carMeshes[key] = await instancedCar(key, capacity, scene);
    }
    // draw car `i` of model `key` (pose, steer, wheel spins, pitch and roll, paint)
    const M = new T.Matrix4(), Mw = new T.Matrix4(), Mr = new T.Matrix4(), Q = new T.Quaternion(), Qs = new T.Quaternion(), E = new T.Euler(), S1 = new T.Vector3(1, 1, 1), P = new T.Vector3(), O = new T.Vector3(), C = new T.Color();
    function carMatrix(out, x, z, h, pitch, roll, lift) {
      E.set(roll || 0, -h, pitch || 0, 'YXZ');   // yaw about up, then roll about forward, pitch about the side
      Q.setFromEuler(E);
      return out.compose(P.set(x, lift || 0, z), Q, S1);
    }
    /* st: { x, z, h (model origin and heading), pitch, roll, steer, spins: [FL, FR, RL, RR] (rad), paint } */
    function drawCar(key, i, st) {
      const set = carMeshes[key];
      if (!set) return;
      carMatrix(M, st.x, st.z, st.h, st.pitch, st.roll, st.lift);
      for (const im of set.body) im.setMatrixAt(i, M);
      if (st.paint !== undefined && set.paint) set.paint.setColorAt(i, C.setHex(st.paint));
      set.wheels.forEach((w, j) => {
        const steer = w.front ? (st.steer || 0) : 0, spin = st.spins ? st.spins[j] : 0;
        Q.setFromEuler(E.set(0, -steer, 0, 'XYZ')).multiply(Qs.setFromAxisAngle(ZAXIS, -spin));
        Mw.copy(M).multiply(w.local).multiply(Mr.compose(O, Q, S1));
        if (w.left) Mw.multiply(MIRROR);
        for (const im of set.wheelMeshes) im.setMatrixAt(4 * i + j, Mw);
      });
      set.used = Math.max(set.used, i + 1);
    }
    // after drawing this frame's cars: how many instances of each model to show
    function endCars() {
      for (const key in carMeshes) {
        const set = carMeshes[key];
        for (const im of set.body) { im.count = set.used; im.instanceMatrix.needsUpdate = true; }
        for (const im of set.wheelMeshes) { im.count = 4 * set.used; im.instanceMatrix.needsUpdate = true; }
        if (set.paint && set.paint.instanceColor) set.paint.instanceColor.needsUpdate = true;
        set.used = 0;
      }
    }

    // the player's car: a CarModels instance (skinned to its lattice, can show crash damage)
    let player = null;
    async function preparePlayer(key, spec, paint) {
      const lat = CrashPhysics.buildCar(spec.massKg, 'standard', spec);
      player = await CarModels.create(key, spec, lat, renderer);
      player.lat = lat;
      useEnv(player.group, env);
      scene.add(player.group);
      if (paint !== undefined) {
        player.group.traverse((o) => { if (o.isMesh && o.material && o.material.userData && o.material.userData.cls === 'paint') o.material.color.setHex(paint).convertSRGBToLinear(); });
      }
      return player;
    }
    const PM = new T.Matrix4();
    function drawPlayer(st, spinDelta) {
      if (!player) return;
      carMatrix(PM, st.x, st.z, st.h, st.pitch, st.roll);
      player.setRigid(PM, st.steer || 0, spinDelta || 0, UP, ZAXIS);
    }
    // a hidden deformable copy of a model, for the other car in a crash (made at load, so a crash
    // doesn't wait for the model to be decoded and skinned)
    const wrecks = {};
    async function prepareWreck(key, spec) {
      const lat = CrashPhysics.buildCar(spec.massKg, 'standard', spec);
      const m = await CarModels.create(key, spec, lat, renderer);
      m.lat = lat;
      useEnv(m.group, env);
      scene.add(m.group);
      m.group.visible = false;
      wrecks[key] = m;
      return m;
    }
    // a car model deformed by a crash frame: node positions of frames k and k2 blended by s, the
    // strain of frame k, the cabin axes (o, forward, up) for the wheels
    const BF = new T.Vector3(), BU = new T.Vector3(), BL = new T.Vector3(), BM = new T.Matrix4(), BQ = new T.Quaternion();
    function deform(model, view, k, k2, s, t) {
      const F = view.frames, ax = F.axes[k];
      BF.set(ax[3], ax[4], ax[5]).normalize(); BU.set(ax[6], ax[7], ax[8]).normalize(); BL.crossVectors(BF, BU).normalize();
      BQ.setFromRotationMatrix(BM.makeBasis(BF, BU, BL));
      model.setDeformed(F.pos[k], F.pos[k2], s, F.strain[k], BQ, ZAXIS);
      model.syncDestruction(view, t + 0.03, 2);   // what's about to break, two pieces a frame at most
      model.updateDestruction(t, k, k2, s);
    }
    // crash camera: orbit a point, kept out of the buildings
    function orbit(target, angle, radius, height, level) {
      let a = angle;
      for (let tries = 0; tries < 12; tries++) {
        const x = target.x + Math.cos(a) * radius, z = target.z + Math.sin(a) * radius;
        if (!level || !level.collidersNear(x, z, 0.5).some(o => o.box && insideBox(o, x, z, 0.6))) { camera.position.set(x, height, z); break; }
        a += 0.5;
        camera.position.set(target.x + Math.cos(a) * radius, height, target.z + Math.sin(a) * radius);
      }
      camera.lookAt(target.x, 0.7, target.z);
      if (Math.abs(camera.fov - 52) > 0.01) { camera.fov = cam.fov = 52; camera.updateProjectionMatrix(); }
      sun.position.set(target.x, 0, target.z).addScaledVector(SUN_DIR, 200);
      sun.target.position.set(target.x, 0, target.z); sun.target.updateMatrixWorld();
      cam.init = false;
      return a;
    }
    function insideBox(o, x, z, m) {
      const c = Math.cos(o.angle), s = Math.sin(o.angle), dx = x - o.x, dz = z - o.z;
      return Math.abs(dx * c + dz * s) < o.hx + m && Math.abs(-dx * s + dz * c) < o.hz + m;
    }

    // ------------------------------------------------ camera
    const cam = { mode: 'chase', pos: new T.Vector3(), look: new T.Vector3(), fov: 62, init: false, back: false };
    const tmp = new T.Vector3(), tgt = new T.Vector3();
    /* st: the followed car { x, z, h, speed, boost, yawRate }; dt: s */
    function follow(st, dt) {
      const c = Math.cos(st.h), s = Math.sin(st.h), sp = st.speed || 0;
      if (cam.mode === 'chase') {
        const back = cam.back ? -1 : 1, dist = 6.4 + Math.min(1.6, sp / 40), height = 2.15 + Math.min(0.5, sp / 120);
        tgt.set(st.x - c * dist * back, height, st.z - s * dist * back);
        if (!cam.init) { cam.pos.copy(tgt); cam.init = true; }
        const k = 1 - Math.exp(-dt * (cam.back ? 30 : 9));
        cam.pos.lerp(tgt, k);
        cam.look.set(st.x + c * 4 * back, 1.1, st.z + s * 4 * back);
      } else {   // bumper
        cam.pos.set(st.x + c * 1.2, 1.05, st.z + s * 1.2);
        cam.look.set(st.x + c * 30, 0.9, st.z + s * 30);
        cam.init = false;
      }
      camera.position.copy(cam.pos);
      camera.lookAt(cam.look);
      const fovT = 60 + Math.min(16, sp * 0.18) + (st.boost ? 6 : 0);
      cam.fov += (fovT - cam.fov) * (1 - Math.exp(-dt * 3));
      if (Math.abs(camera.fov - cam.fov) > 0.01) { camera.fov = cam.fov; camera.updateProjectionMatrix(); }
      // the sun's shadow box follows the camera's target
      tmp.set(st.x, 0, st.z);
      sun.position.copy(tmp).addScaledVector(SUN_DIR, 200);
      sun.target.position.copy(tmp);
      sun.target.updateMatrixWorld();
    }

    function resize() {
      const w = container.clientWidth, h = container.clientHeight;
      renderer.setSize(w, h);
      camera.aspect = w / h; camera.updateProjectionMatrix();
    }
    window.addEventListener('resize', resize);
    function render() { renderer.render(scene, camera); }

    return { renderer, scene, camera, sun, env, cam, prepareCars, drawCar, endCars, preparePlayer, drawPlayer, prepareWreck, wrecks, deform, orbit, get player() { return player; }, follow, render, resize };
  }

  const MIRROR = new T.Matrix4().makeScale(1, 1, -1);

  function useEnv(group, env) {
    group.traverse((o) => { if (o.isMesh && o.material && o.material.envMap) o.material.envMap = env; });
  }

  // ---------------------------------------------------------------- photo textures
  // CC0 scans from Poly Haven, packed as base64 JPEGs in media/race/assets.js by
  // tools/fetch-race-assets.py (window.RACE_ASSETS). The procedural textures below stand in when
  // that file is missing. PHOTO: each scan's real size, m.
  const PHOTO = { asphalt: 3, pavers: 1.8, concrete: 2, brick: 1, plaster: 3, stone: 2.09 };
  const photos = {};
  // a texture of photo `key` (copies share one image and one upload)
  function photoTex(key, color) {
    let p = photos[key];
    if (!p) {
      const img = new Image(), list = [];
      img.onload = () => list.forEach(t => { t.needsUpdate = true; });
      img.src = 'data:image/jpeg;base64,' + window.RACE_ASSETS[key];
      p = photos[key] = { img, list, base: null };
    }
    let t;
    if (!p.base) {
      t = p.base = new T.Texture(p.img);
      t.wrapS = t.wrapT = T.RepeatWrapping;
      t.colorSpace = color ? T.SRGBColorSpace : T.NoColorSpace;
      t.anisotropy = 8;
    } else t = p.base.clone();
    p.list.push(t);
    if (p.img.complete && p.img.naturalWidth) t.needsUpdate = true;
    return t;
  }
  // the maps of surface `name` for UVs in units of `uvMetres`: { map, normalMap, roughnessMap }, or
  // null without the photos
  function surface(name, uvMetres) {
    const A = window.RACE_ASSETS;
    if (!A || !A[name]) return null;
    const r = uvMetres / PHOTO[name], out = {};
    for (const [slot, key, color] of [['map', name, true], ['normalMap', name + '_n', false], ['roughnessMap', name + '_r', false]]) {
      if (!A[key]) continue;
      out[slot] = photoTex(key, color);
      out[slot].repeat.set(r, r);
    }
    return out;
  }
  // the street HDRI, prefiltered for image-based lighting, or null
  function streetHDR(renderer) {
    const b64 = window.RACE_ASSETS && window.RACE_ASSETS.sky_hdr;
    if (!b64 || !window.RGBELoader) return null;
    const bin = atob(b64), buf = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) buf[i] = bin.charCodeAt(i);
    const d = new window.RGBELoader().setDataType(T.HalfFloatType).parse(buf.buffer);
    const t = new T.DataTexture(d.data, d.width, d.height, T.RGBAFormat, d.type);
    t.colorSpace = T.LinearSRGBColorSpace; t.minFilter = t.magFilter = T.LinearFilter; t.generateMipmaps = false; t.flipY = true;
    t.mapping = T.EquirectangularReflectionMapping; t.needsUpdate = true;
    const pm = new T.PMREMGenerator(renderer), env = pm.fromEquirectangular(t).texture;
    pm.dispose(); t.dispose();
    return env;
  }

  // ---------------------------------------------------------------- procedural textures
  function canvasTex(w, h, draw, repeat) {
    const c = document.createElement('canvas'); c.width = w; c.height = h;
    draw(c.getContext('2d'), w, h);
    const t = new T.CanvasTexture(c);
    t.wrapS = t.wrapT = T.RepeatWrapping;
    t.colorSpace = T.SRGBColorSpace;
    t.anisotropy = 8;
    if (repeat) t.repeat.set(repeat[0], repeat[1]);
    return t;
  }
  function noise(ctx, w, h, base, amp, n) {
    ctx.fillStyle = base; ctx.fillRect(0, 0, w, h);
    const img = ctx.getImageData(0, 0, w, h), d = img.data;
    let s = 1234567;
    const rnd = () => (s = (s * 16807) % 2147483647) / 2147483647;
    for (let i = 0; i < d.length; i += 4) { const v = (rnd() - 0.5) * amp; d[i] += v; d[i + 1] += v; d[i + 2] += v; }
    ctx.putImageData(img, 0, 0);
    for (let i = 0; i < n; i++) { ctx.fillStyle = `rgba(0,0,0,${0.03 + rnd() * 0.06})`; const r = 4 + rnd() * 30; ctx.beginPath(); ctx.ellipse(rnd() * w, rnd() * h, r, r * (0.4 + rnd()), rnd() * 3, 0, 7); ctx.fill(); }
  }
  const TEX = {};
  function asphalt() { return TEX.asphalt || (TEX.asphalt = canvasTex(512, 512, (c, w, h) => noise(c, w, h, '#4b4c4f', 26, 60))); }
  function pavers() {
    return TEX.pavers || (TEX.pavers = canvasTex(256, 256, (c, w, h) => { noise(c, w, h, '#a29d95', 18, 10); c.strokeStyle = 'rgba(60,55,50,0.45)'; c.lineWidth = 2; for (let i = 0; i <= 4; i++) { c.beginPath(); c.moveTo(0, i * 64); c.lineTo(w, i * 64); c.stroke(); c.beginPath(); c.moveTo(i * 64, 0); c.lineTo(i * 64, h); c.stroke(); } }));
  }
  function concrete() { return TEX.concrete || (TEX.concrete = canvasTex(256, 256, (c, w, h) => noise(c, w, h, '#8f8c86', 20, 20))); }

  // ---------------------------------------------------------------- ground
  function buildGround(group) {
    const g = new T.PlaneGeometry(6000, 6000);
    g.rotateX(-Math.PI / 2);
    let maps = surface('concrete', 6000);
    if (!maps) { const tex = concrete().clone(); tex.needsUpdate = true; tex.repeat.set(600, 600); maps = { map: tex }; }
    const m = new T.Mesh(g, new T.MeshStandardMaterial({ ...maps, color: 0x9a958c, roughness: 0.95 }));
    m.position.y = -0.02; m.receiveShadow = true;
    group.add(m);
  }

  // ribbon along the circuit between lateral offsets l0..l1, at height y; u across, v along (metres)
  function ribbon(level, l0, l1, y, vScale, step = 2) {
    const C = level.circuit, N = Math.ceil(level.length / step), pos = [], uv = [], idx = [];
    for (let i = 0; i <= N; i++) {
      const s = Math.min(i * step, level.length), a = level.poseAt(s, l0), b = level.poseAt(s, l1);
      pos.push(a.x, y, a.z, b.x, y, b.z);
      uv.push(0, s / vScale, (l1 - l0) / vScale, s / vScale);
      if (i < N) { const k = 2 * i; idx.push(k, k + 1, k + 2, k + 1, k + 3, k + 2); }
    }
    const g = new T.BufferGeometry();
    g.setAttribute('position', new T.Float32BufferAttribute(pos, 3));
    g.setAttribute('uv', new T.Float32BufferAttribute(uv, 2));
    g.setIndex(idx);
    g.computeVertexNormals();
    // make sure normals point up whatever the winding
    const n = g.attributes.normal; for (let i = 0; i < n.count; i++) n.setXYZ(i, 0, 1, 0);
    return g;
  }

  // ---------------------------------------------------------------- the street
  function buildStreet(group, level) {
    const RH = level.roadHalf, WO = level.walkOut;
    const road = new T.Mesh(ribbon(level, -RH, RH, 0, 8), new T.MeshStandardMaterial({ ...(surface('asphalt', 8) || { map: asphalt() }), color: 0xffffff, roughness: 0.92 }));
    road.receiveShadow = true;
    group.add(road);
    // markings: double yellow centre line, dashed white lane lines, solid white edge lines
    const paint = (color) => new T.MeshStandardMaterial({ color, roughness: 0.7, polygonOffset: true, polygonOffsetFactor: -2, polygonOffsetUnits: -2 });
    const yellow = paint(0xd9b23a), white = paint(0xe9e9e6);
    for (const l of [-0.12, 0.12]) group.add(shadowed(new T.Mesh(ribbon(level, l - 0.06, l + 0.06, 0.004, 1), yellow)));
    for (const l of [-RH + 0.25, RH - 0.25]) group.add(shadowed(new T.Mesh(ribbon(level, l - 0.08, l + 0.08, 0.004, 1), white)));
    for (const l of [-3.5, 3.5]) group.add(shadowed(new T.Mesh(dashes(level, l, 0.07, 3, 9), white)));
    // kerbs and pavements (flush: the cars and the crash solver keep to flat ground)
    const kerb = new T.MeshStandardMaterial({ ...(surface('concrete', 1) || { map: concrete() }), color: 0xc9c5bd, roughness: 0.85 });
    const walk = new T.MeshStandardMaterial({ ...(surface('pavers', 4) || { map: pavers() }), color: 0xffffff, roughness: 0.9 });
    for (const sg of [-1, 1]) {
      group.add(shadowed(new T.Mesh(kerbStrip(level, sg * RH, sg * (RH + 0.25)), kerb)));
      const w = new T.Mesh(ribbon(level, sg > 0 ? RH + 0.25 : -WO, sg > 0 ? WO : -RH - 0.25, 0.02, 4), walk);
      w.receiveShadow = true;
      group.add(w);
    }
    // side streets: a stub of road with its barrier
    const stubMat = new T.MeshStandardMaterial({ ...(surface('asphalt', 8) || { map: asphalt() }), roughness: 0.92 });
    for (const q of level.sideStreets) {
      const p = level.poseAt(q.s, q.side * RH), hs = p.h + (q.side > 0 ? Math.PI / 2 : -Math.PI / 2);
      const g = new T.PlaneGeometry(q.width, 26); g.rotateX(-Math.PI / 2);
      const uv = g.attributes.uv; for (let i = 0; i < uv.count; i++) uv.setXY(i, uv.getX(i) * q.width / 8, uv.getY(i) * 26 / 8);   // in 8 m, like the road
      const m = new T.Mesh(g, stubMat);
      m.position.set(p.x + Math.cos(hs) * 13, 0.01, p.z + Math.sin(hs) * 13);
      m.rotation.y = -hs + Math.PI / 2;
      m.receiveShadow = true;
      group.add(m);
    }
  }
  const shadowed = (m) => { m.receiveShadow = true; return m; };
  function dashes(level, l, half, len, gap) {
    const pos = [], idx = [];
    for (let s = 0; s < level.length - len; s += len + gap) {
      const a0 = level.poseAt(s, l - half), a1 = level.poseAt(s, l + half), b0 = level.poseAt(s + len, l - half), b1 = level.poseAt(s + len, l + half), k = pos.length / 3;
      pos.push(a0.x, 0.004, a0.z, a1.x, 0.004, a1.z, b0.x, 0.004, b0.z, b1.x, 0.004, b1.z);
      idx.push(k, k + 1, k + 2, k + 1, k + 3, k + 2);
    }
    const g = new T.BufferGeometry();
    g.setAttribute('position', new T.Float32BufferAttribute(pos, 3));
    g.setAttribute('normal', new T.Float32BufferAttribute(new Array(pos.length).fill(0).map((_, i) => i % 3 === 1 ? 1 : 0), 3));
    g.setIndex(idx);
    return g;
  }
  function kerbStrip(level, l0, l1) {
    // a low bevelled strip: top at 0.08 m, a sloped face toward the road
    const top = ribbon(level, l0 + (l1 - l0) * 0.4, l1, 0.08, 1), face = ribbon(level, l0, l0 + (l1 - l0) * 0.4, 0.04, 1);
    return window.mergeGeometries([top, face]);
  }

  // ---------------------------------------------------------------- buildings
  // Facades by shader: uvM (metres along the wall, height), a per-building seed; floors 3.4 m, bays
  // 2.7 m; a taller shop front on the ground floor; some windows lit.
  // photo: the wall's scan and the tint over it (wall: the colour without the photos)
  const STYLES = [
    { wall: 0x9c8f82, photo: 'stone', tint: 0xe6ded2, frame: 0x3b3a38, glass: 0x2a3440, bay: 2.7, floor: 3.4, win: [0.22, 0.78, 0.28, 0.86] },   // stone office
    { wall: 0x8a4e3c, photo: 'brick', tint: 0xffffff, frame: 0x2d2622, glass: 0x26303a, bay: 2.4, floor: 3.1, win: [0.28, 0.72, 0.3, 0.84] },    // brick
    { wall: 0x5f6b77, photo: 'concrete', tint: 0x8a96a2, frame: 0x22282e, glass: 0x1f3448, bay: 1.6, floor: 3.8, win: [0.05, 0.95, 0.12, 0.94] },   // glass tower
    { wall: 0xb9b2a5, photo: 'plaster', tint: 0xf2ece2, frame: 0x55524c, glass: 0x2c3540, bay: 3.2, floor: 3.3, win: [0.2, 0.8, 0.32, 0.82] },     // plaster
  ];
  function facadeMaterial(style) {
    const st = STYLES[style], maps = surface(st.photo, 6);
    const m = new T.MeshStandardMaterial({ color: maps ? st.tint : st.wall, roughness: 0.85, metalness: 0.0, ...(maps || { map: concrete() }) });
    m.onBeforeCompile = (sh) => {
      sh.uniforms.uGlass = { value: new T.Color(st.glass) }; sh.uniforms.uFrame = { value: new T.Color(st.frame) };
      sh.uniforms.uCell = { value: new T.Vector2(st.bay, st.floor) }; sh.uniforms.uWin = { value: new T.Vector4(...st.win) };
      sh.vertexShader = sh.vertexShader.replace('#include <common>', '#include <common>\nattribute vec2 uvM; attribute float seed; varying vec2 vUvM; varying float vSeed;')
        .replace('#include <uv_vertex>', '#include <uv_vertex>\nvUvM = uvM; vSeed = seed;');
      sh.fragmentShader = sh.fragmentShader.replace('#include <common>', `#include <common>
uniform vec3 uGlass; uniform vec3 uFrame; uniform vec2 uCell; uniform vec4 uWin; varying vec2 vUvM; varying float vSeed;
float hash2(vec2 p) { return fract(sin(dot(p, vec2(127.1, 311.7)) + vSeed * 17.31) * 43758.5453); }
float winMask; float frameMask; float litMask;`)
        .replace('#include <map_fragment>', `#include <map_fragment>
{
  vec2 cell = uCell; float ground = 4.6;
  vec2 q = vec2(vUvM.x, vUvM.y - ground);
  vec2 g = q / cell, f = fract(g), id = floor(g);
  float upper = step(0.0, q.y);
  float w = step(uWin.x, f.x) * step(f.x, uWin.y) * step(uWin.z, f.y) * step(f.y, uWin.w) * upper;
  // shop front: a wide glazed band on the ground floor, with piers
  float sf = fract(vUvM.x / 6.0);
  float shop = (1.0 - upper) * step(0.55, vUvM.y) * step(vUvM.y, 3.7) * step(0.08, sf) * step(sf, 0.92);
  winMask = max(w, shop);
  float fr = upper * (1.0 - w) * step(uWin.x - 0.05, f.x) * step(f.x, uWin.y + 0.05) * step(uWin.z - 0.05, f.y) * step(f.y, uWin.w + 0.05);
  frameMask = fr + (1.0 - upper) * step(3.7, vUvM.y) * step(vUvM.y, 4.1);
  litMask = step(0.78, hash2(id)) * w + shop * step(0.5, hash2(vec2(floor(vUvM.x / 6.0), 7.0)));
  float shade = 0.85 + 0.3 * hash2(vec2(vSeed, 3.0));
  diffuseColor.rgb *= shade;
  diffuseColor.rgb = mix(diffuseColor.rgb, uFrame, clamp(frameMask, 0.0, 1.0));
  diffuseColor.rgb = mix(diffuseColor.rgb, uGlass * (0.7 + 0.6 * hash2(id + 3.0)), winMask);
}`)
        .replace('#include <roughnessmap_fragment>', '#include <roughnessmap_fragment>\nroughnessFactor = mix(roughnessFactor, 0.06, winMask);')
        .replace('#include <normal_fragment_maps>', '#include <normal_fragment_maps>\nnormal = normalize(mix(normal, nonPerturbedNormal, clamp(winMask + frameMask, 0.0, 1.0)));')
        .replace('#include <metalnessmap_fragment>', '#include <metalnessmap_fragment>\nmetalnessFactor = mix(metalnessFactor, 0.85, winMask);')
        .replace('#include <emissivemap_fragment>', '#include <emissivemap_fragment>\ntotalEmissiveRadiance += litMask * vec3(1.0, 0.8, 0.55) * 0.05;');
    };
    m.customProgramCacheKey = () => 'facade' + style;
    return m;
  }
  function buildBuildings(group, level) {
    const byStyle = STYLES.map(() => ({ pos: [], nrm: [], uv: [], uvM: [], seed: [], idx: [] })), roof = { pos: [], nrm: [], idx: [] };
    const all = level.buildings.map(b => [b, true]).concat(level.skyline.map(b => [b, false]));
    let n = 0;
    for (const [b] of all) {
      const A = byStyle[b.style % STYLES.length], c = Math.cos(b.angle), s = Math.sin(b.angle), sd = (n++ * 0.6180339) % 1;
      const corner = (u, w) => [b.x + c * u * b.hx - s * w * b.hz, b.z + s * u * b.hx + c * w * b.hz];
      const P = [corner(-1, -1), corner(1, -1), corner(1, 1), corner(-1, 1)];
      for (let e = 0; e < 4; e++) {
        const a = P[e], d = P[(e + 1) % 4], len = Math.hypot(d[0] - a[0], d[1] - a[1]);
        const nx = (d[1] - a[1]) / len, nz = -(d[0] - a[0]) / len;   // outward for this winding
        const k = A.pos.length / 3;
        A.pos.push(a[0], 0, a[1], d[0], 0, d[1], d[0], b.height, d[1], a[0], b.height, a[1]);
        for (let v = 0; v < 4; v++) { A.nrm.push(nx, 0, nz); A.seed.push(sd); }
        A.uv.push(0, 0, len / 6, 0, len / 6, b.height / 6, 0, b.height / 6);
        A.uvM.push(0, 0, len, 0, len, b.height, 0, b.height);
        A.idx.push(k, k + 2, k + 1, k, k + 3, k + 2);
      }
      const k = roof.pos.length / 3;
      for (const p of P) { roof.pos.push(p[0], b.height, p[1]); roof.nrm.push(0, 1, 0); }
      roof.idx.push(k, k + 2, k + 1, k, k + 3, k + 2);
    }
    STYLES.forEach((st, i) => {
      const A = byStyle[i];
      if (!A.pos.length) return;
      const g = new T.BufferGeometry();
      g.setAttribute('position', new T.Float32BufferAttribute(A.pos, 3));
      g.setAttribute('normal', new T.Float32BufferAttribute(A.nrm, 3));
      g.setAttribute('uv', new T.Float32BufferAttribute(A.uv, 2));
      g.setAttribute('uvM', new T.Float32BufferAttribute(A.uvM, 2));
      g.setAttribute('seed', new T.Float32BufferAttribute(A.seed, 1));
      g.setIndex(A.idx);
      const mesh = new T.Mesh(g, facadeMaterial(i));
      mesh.material.side = T.DoubleSide;
      mesh.castShadow = true; mesh.receiveShadow = true;
      group.add(mesh);
    });
    const rg = new T.BufferGeometry();
    rg.setAttribute('position', new T.Float32BufferAttribute(roof.pos, 3));
    rg.setAttribute('normal', new T.Float32BufferAttribute(roof.nrm, 3));
    rg.setIndex(roof.idx);
    const rm = new T.Mesh(rg, new T.MeshStandardMaterial({ color: 0x55534f, roughness: 0.95, side: T.DoubleSide }));
    rm.castShadow = true; rm.receiveShadow = true;
    group.add(rm);
  }

  // ---------------------------------------------------------------- street furniture (instanced)
  function instanced(geo, mat, list, place, shadow = true) {
    const im = new T.InstancedMesh(geo, mat, Math.max(1, list.length));
    const m = new T.Matrix4();
    list.forEach((o, i) => { place(o, m); im.setMatrixAt(i, m); });
    im.count = list.length;
    im.castShadow = shadow; im.receiveShadow = true;
    return im;
  }
  function buildFurniture(group, level) {
    const metal = new T.MeshStandardMaterial({ color: 0x3c4146, metalness: 0.6, roughness: 0.45 });
    const at = (x, z, h, y = 0) => new T.Matrix4().makeRotationY(-h).setPosition(x, y, z);
    // street lights: a pole, an arm over the road, a lamp
    const pole = new T.CylinderGeometry(0.09, 0.13, 8, 10); pole.translate(0, 4, 0);
    const arm = new T.BoxGeometry(2.2, 0.08, 0.08); arm.translate(1.1, 7.9, 0);
    const head = new T.BoxGeometry(0.7, 0.14, 0.32); head.translate(2.1, 7.82, 0);
    group.add(instanced(pole, metal, level.lamps, (o, m) => m.copy(at(o.x, o.z, o.h))));
    group.add(instanced(arm, metal, level.lamps, (o, m) => m.copy(at(o.x, o.z, o.h))));
    group.add(instanced(head, new T.MeshStandardMaterial({ color: 0x222222, emissive: 0xfff1d6, emissiveIntensity: 0.6 }), level.lamps, (o, m) => m.copy(at(o.x, o.z, o.h)), false));
    // trees: trunk and a cluster of leafy blobs
    const bark = new T.MeshStandardMaterial({ color: 0x4a3b2e, roughness: 0.95 });
    const leaf = leafMaterial();
    const trunk = new T.CylinderGeometry(0.12, 0.2, 3.2, 7); trunk.translate(0, 1.6, 0);
    const crown = treeCrown();
    group.add(instanced(trunk, bark, level.trees, (o, m) => m.copy(at(o.x, o.z, o.seed)).scale(new T.Vector3(o.size, o.size, o.size))));
    const crowns = instanced(crown, leaf, level.trees, (o, m) => m.copy(at(o.x, o.z, o.seed)).scale(new T.Vector3(o.size, o.size, o.size)));
    level.trees.forEach((o, i) => crowns.setColorAt(i, new T.Color().setHSL(0.26 + 0.03 * Math.sin(o.seed * 7.1), 0.5, 0.26 + 0.04 * Math.cos(o.seed * 3.3))));
    group.add(crowns);
    // traffic signals at the side streets: post, arm, head (lights red: the side streets are closed)
    const spost = new T.CylinderGeometry(0.1, 0.12, 6, 8); spost.translate(0, 3, 0);
    const shead = new T.BoxGeometry(0.35, 1.0, 0.35); shead.translate(0, 4.3, 0);
    group.add(instanced(spost, metal, level.signals, (o, m) => m.copy(at(o.x, o.z, o.h))));
    group.add(instanced(shead, new T.MeshStandardMaterial({ color: 0x1b1d1f, emissive: 0x401010, roughness: 0.5 }), level.signals, (o, m) => m.copy(at(o.x, o.z, o.h))));
    // barriers across the side streets: red and white concrete blocks
    const block = new T.BoxGeometry(1.9, 1.0, 0.6); block.translate(0, 0.5, 0);
    const blocks = [];
    for (const b of level.barriers) for (let i = 0; i < Math.round(b.len / 2); i++) { const u = (i + 0.5) * 2 - b.len / 2; blocks.push({ x: b.x + Math.cos(b.angle) * u, z: b.z + Math.sin(b.angle) * u, h: b.angle, red: i % 2 }); }
    group.add(instanced(block, new T.MeshStandardMaterial({ color: 0xd8d4cc, roughness: 0.8 }), blocks.filter(b => !b.red), (o, m) => m.copy(at(o.x, o.z, o.h))));
    group.add(instanced(block, new T.MeshStandardMaterial({ color: 0xb23a2e, roughness: 0.8 }), blocks.filter(b => b.red), (o, m) => m.copy(at(o.x, o.z, o.h))));
  }

  // leaves: value noise over the crown darkens gaps between clumps and tilts the normals, so the
  // blobs read as foliage in the sun
  function leafMaterial() {
    const m = new T.MeshStandardMaterial({ color: 0xffffff, vertexColors: true, roughness: 0.8 });
    m.onBeforeCompile = (sh) => {
      sh.vertexShader = sh.vertexShader.replace('#include <common>', '#include <common>\nvarying vec3 vLeafP;')
        .replace('#include <begin_vertex>', '#include <begin_vertex>\nvLeafP = position;');
      sh.fragmentShader = sh.fragmentShader.replace('#include <common>', `#include <common>
varying vec3 vLeafP;
float lh(vec3 p) { return fract(sin(dot(p, vec3(127.1, 311.7, 74.7))) * 43758.5453); }
float lnoise(vec3 p) {
  vec3 i = floor(p), f = fract(p); f = f * f * (3.0 - 2.0 * f);
  return mix(mix(mix(lh(i), lh(i + vec3(1, 0, 0)), f.x), mix(lh(i + vec3(0, 1, 0)), lh(i + vec3(1, 1, 0)), f.x), f.y),
             mix(mix(lh(i + vec3(0, 0, 1)), lh(i + vec3(1, 0, 1)), f.x), mix(lh(i + vec3(0, 1, 1)), lh(i + vec3(1, 1, 1)), f.x), f.y), f.z);
}`)
        .replace('#include <color_fragment>', '#include <color_fragment>\ndiffuseColor.rgb *= 0.4 + 0.9 * (0.6 * lnoise(vLeafP * 3.5) + 0.4 * lnoise(vLeafP * 9.0));')
        .replace('#include <normal_fragment_maps>', '#include <normal_fragment_maps>\nnormal = normalize(normal + 0.7 * (vec3(lnoise(vLeafP * 7.0), lnoise(vLeafP * 7.0 + 11.3), lnoise(vLeafP * 7.0 + 23.1)) - 0.5));');
    };
    m.customProgramCacheKey = () => 'leaf';
    return m;
  }

  // a tree's crown: a cluster of lumpy blobs (the lumps a function of position, so the faces stay
  // joined), smooth normals, darker underneath and inside
  function treeCrown() {
    let s = 9;
    const r = () => (s = (s * 16807) % 2147483647) / 2147483647;
    const lump = (x, y, z) => 1 + 0.12 * Math.sin(x * 3.1 + y * 1.7) * Math.cos(z * 2.9 - y * 2.3) + 0.06 * Math.sin(x * 7.3 - z * 6.1 + y * 5.2);
    const parts = [];
    for (let b = 0; b < 7; b++) {
      const rad = b === 0 ? 1.55 : 0.85 + r() * 0.55, a = r() * 6.283, d = b === 0 ? 0 : 0.75 + r() * 0.55;
      const cx = Math.cos(a) * d, cy = 4.1 + (b === 0 ? 0.3 : (r() - 0.35) * 1.3), cz = Math.sin(a) * d;
      const g = new T.IcosahedronGeometry(rad, 2), p = g.attributes.position, n = new Float32Array(p.count * 3), c = new Float32Array(p.count * 3);
      for (let i = 0; i < p.count; i++) {
        const x = p.getX(i), y = p.getY(i), z = p.getZ(i), k = lump(x + cx, y + cy, z + cz), len = Math.hypot(x, y, z);
        p.setXYZ(i, cx + x * k, cy + y * k * 0.85, cz + z * k);
        n[3 * i] = x / len; n[3 * i + 1] = y / len; n[3 * i + 2] = z / len;
        const shade = 0.45 + 0.4 * (0.5 + 0.5 * y / len) + 0.15 * Math.min(1, Math.hypot(cx, cz) / 1.3);   // light on top and outside
        c[3 * i] = c[3 * i + 1] = c[3 * i + 2] = shade;
      }
      g.setAttribute('normal', new T.BufferAttribute(n, 3));
      g.setAttribute('color', new T.BufferAttribute(c, 3));
      g.deleteAttribute('uv');
      parts.push(g);
    }
    return window.mergeVertices(window.mergeGeometries(parts));   // shared corners: a sixth of the vertices
  }

  // ---------------------------------------------------------------- start/finish
  function buildStart(group, level) {
    const p = level.poseAt(level.start.s, 0);
    const line = canvasTex(256, 32, (c, w, h) => { for (let i = 0; i < 16; i++) for (let j = 0; j < 2; j++) { c.fillStyle = (i + j) % 2 ? '#111' : '#eee'; c.fillRect(i * 16, j * 16, 16, 16); } });
    line.wrapS = T.RepeatWrapping; line.repeat.set(1, 1);
    const g = new T.PlaneGeometry(1.6, level.roadHalf * 2); g.rotateX(-Math.PI / 2);
    const m = new T.Mesh(g, new T.MeshStandardMaterial({ map: line, roughness: 0.6, polygonOffset: true, polygonOffsetFactor: -3 }));
    m.position.set(p.x, 0.006, p.z); m.rotation.y = -p.h + Math.PI / 2;
    m.receiveShadow = true;
    group.add(m);
    // gantry over the street
    const steel = new T.MeshStandardMaterial({ color: 0x30353b, metalness: 0.7, roughness: 0.4 });
    const legs = new T.Group();
    for (const sg of [-1, 1]) { const leg = new T.Mesh(new T.BoxGeometry(0.4, 7, 0.4), steel); leg.position.set(0, 3.5, sg * (level.roadHalf + 1)); leg.castShadow = true; legs.add(leg); }
    const beam = new T.Mesh(new T.BoxGeometry(0.6, 1.2, level.roadHalf * 2 + 2.4), new T.MeshStandardMaterial({ color: 0x1d2024, emissive: 0x0c2a4a, roughness: 0.5 }));
    beam.position.y = 7; beam.castShadow = true; legs.add(beam);
    legs.position.set(p.x, 0, p.z); legs.rotation.y = -p.h;
    group.add(legs);
    // tell CarModels / colliders nothing: the gantry legs stand beyond the kerbs
  }

  // ---------------------------------------------------------------- instanced cars
  // one merged copy of model `key`: the body by material class, the wheel (tyre and rim) separately
  async function instancedCar(key, capacity, scene) {
    const b64 = window.CAR_ASSETS[key], bin = atob(b64), buf = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) buf[i] = bin.charCodeAt(i);
    const draco = new DRACOLoader(); draco.setDecoderPath('https://cdn.jsdelivr.net/npm/three@0.170.0/examples/jsm/libs/draco/gltf/');
    const loader = new GLTFLoader(); loader.setDRACOLoader(draco);
    const gltf = await new Promise((res, rej) => loader.parse(buf.buffer, '', res, rej));
    const phys = window.CAR_PHYS[key], mats = phys.materials || {};
    const body = {}, wheel = {};
    gltf.scene.updateMatrixWorld(true);
    gltf.scene.traverse((o) => {
      if (!o.isMesh) return;
      let top = o; while (top.parent && !/^(RIGID_|DEFORM_|BRITTLE_|BREAKAWAY_)/.test(top.name)) top = top.parent;
      const info = mats[o.material.name] || { cls: 'paint', color: [0.5, 0.5, 0.5] };
      const g = o.geometry.clone(); g.applyMatrix4(o.matrixWorld);
      for (const k of Object.keys(g.attributes)) if (k !== 'position' && k !== 'normal') g.deleteAttribute(k);
      const dest = /RIGID_Mech_Wheel/.test(top.name) ? wheel : body;
      const id = info.cls === 'paint' ? 'paint' : info.cls + ':' + o.material.name;
      (dest[id] = dest[id] || { info, list: [] }).list.push(g);
    });
    const env = scene.environment;
    const make = (groups, count) => Object.entries(groups).map(([id, { info, list }]) => {
      const g = window.mergeGeometries(list);
      const col = new T.Color().setRGB(info.color[0], info.color[1], info.color[2], T.LinearSRGBColorSpace);
      let mat;
      switch (info.cls) {
        case 'paint': mat = new T.MeshPhysicalMaterial({ color: 0xffffff, metalness: 0.35, roughness: 0.38, clearcoat: 1, clearcoatRoughness: 0.08, envMap: env }); break;
        case 'chrome': mat = new T.MeshStandardMaterial({ color: 0xd8dde3, metalness: 1, roughness: 0.16, envMap: env }); break;
        case 'glass': mat = new T.MeshPhysicalMaterial({ color: 0x0d141c, roughness: 0.04, transparent: true, opacity: 0.5, envMap: env, depthWrite: false }); break;
        case 'light': mat = new T.MeshStandardMaterial({ color: col, emissive: col.clone().multiplyScalar(info.emit ? 0.35 : 0.08), roughness: 0.15, envMap: env }); break;
        case 'tire': mat = new T.MeshStandardMaterial({ color: 0x141517, roughness: 0.92 }); break;
        case 'rim': mat = new T.MeshStandardMaterial({ color: col, metalness: 0.9, roughness: 0.28, envMap: env }); break;
        default: mat = new T.MeshStandardMaterial({ color: col, metalness: info.metal > 0.5 ? 0.8 : 0.1, roughness: Math.max(0.3, info.rough || 0.5), envMap: env });
      }
      const im = new T.InstancedMesh(g, mat, count);
      im.castShadow = info.cls !== 'glass'; im.receiveShadow = true;
      im.frustumCulled = false;
      im.count = 0;
      if (info.cls === 'paint') { im.instanceColor = new T.InstancedBufferAttribute(new Float32Array(3 * count).fill(1), 3); }
      scene.add(im);
      return im;
    });
    const bodyMeshes = make(body, capacity), wheelMeshes = make(wheel, capacity * 4);
    const hubs = phys.hubs;
    const wheels = ['FL', 'FR', 'RL', 'RR'].map(k => ({ key: k, front: k[0] === 'F', left: k[1] === 'L', local: new T.Matrix4().makeTranslation(hubs[k][0], hubs[k][1], hubs[k][2]) }));
    return { body: bodyMeshes, wheelMeshes, wheels, paint: bodyMeshes.find(m => m.instanceColor), used: 0 };
  }

  return { create };
})();
