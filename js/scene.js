/* Three.js scene: test track, barrier / brick wall, deformable car body, interior, dummy,
 * approach-path gizmo, cameras (main + onboard picture-in-picture). Uses window.THREE and
 * window.OrbitControls set up by index.html. The lab car's body is built here; imported cars
 * come from carmodel.js (CarModels).
 *
 * Each car on show is a slot: its body (the lab car's or an imported model), its interior and its
 * dummy. The main slot is the one the simulator uses and the cameras follow; the labs add a second
 * one (createSlot) for a second car. */
const Scene3D = (() => {
  'use strict';
  const T = THREE, P = CrashPhysics, OC = CrashOccupant, Veh = CrashVehicles;
  const PT = OC.PARTICLES;
  const V = (x = 0, y = 0, z = 0) => new T.Vector3(x, y, z);
  const UP = V(0, 1, 0), YAXIS = V(0, 1, 0), ZAXIS = V(0, 0, 1);
  const SUN_OFFSET = V(-20, 15, -13);   // sun position relative to the shadow focus (late afternoon, 32 degrees up)
  const SUN_DIR = SUN_OFFSET.clone().normalize();

  let renderer, scene, camera, pipCam, controls, sun, container, raycaster;
  let pathGroup, handle, rigidBarrier, wallGroup, wallMesh, wallLayout, particles;
  let strainMode = false, xray = false;
  let camMode = 'setup', camSmoothed = null, camInit = false;
  let follow = null, followAt = null;   // the point the free camera follows (default: the main car's cabin)
  let onAngleDrag = null, dragging = false, pipRect = null;
  let main = null;
  const slots = [];

  // ---------------------------------------------------------------- setup
  function init(el) {
    container = el;
    renderer = new T.WebGLRenderer({ antialias: true });
    renderer.setPixelRatio(Math.min(2, window.devicePixelRatio || 1));
    renderer.shadowMap.enabled = true;
    renderer.shadowMap.type = T.PCFSoftShadowMap;
    renderer.toneMapping = T.ACESFilmicToneMapping;
    renderer.toneMappingExposure = 1.05;
    el.appendChild(renderer.domElement);

    scene = new T.Scene();
    scene.background = new T.Color(0xd9c3ad);
    scene.fog = new T.Fog(0xd6c2ae, 110, 520);
    camera = new T.PerspectiveCamera(45, 1, 0.1, 2000);
    camera.layers.enable(1); camera.layers.enable(2);
    // layers: 0 the world, 1 car bodies, 2 effects (particles, fire), 3 the glow layer (bloom)
    pipCam = new T.PerspectiveCamera(52, 4 / 3, 0.02, 400);   // no car body (layer 1)
    pipCam.layers.enable(2);
    controls = new OrbitControls(camera, renderer.domElement);
    controls.enableDamping = true;
    controls.maxPolarAngle = Math.PI * 0.495;
    controls.maxDistance = 400;
    raycaster = new T.Raycaster();

    scene.add(new T.HemisphereLight(0xc9d6ea, 0x5b4c42, 0.95));
    sun = new T.DirectionalLight(0xffe0bd, 2.7);
    sun.castShadow = true;
    sun.shadow.mapSize.set(2048, 2048);
    const sc = sun.shadow.camera;
    sc.left = -14; sc.right = 14; sc.top = 14; sc.bottom = -14; sc.near = 1; sc.far = 80;
    sc.layers.enable(1);
    sun.shadow.bias = -0.0002;
    sun.shadow.normalBias = 0.03;   // removes shadow acne (self-shadow stripes) on large flat faces
    scene.add(sun, sun.target);

    buildSky(); buildGround(); buildFacility(); buildPath();
    main = makeSlot();
    slots.push(main);
    buildBarriers();
    particles = new FX.Particles(scene);

    renderer.domElement.addEventListener('pointerdown', onPointerDown);
    renderer.domElement.addEventListener('pointermove', onPointerMove);
    window.addEventListener('pointerup', () => { if (dragging) { dragging = false; controls.enabled = camMode === 'setup' || camMode === 'free'; } });
    resize();
    window.addEventListener('resize', resize);
  }

  // the size drawn: the page's, or a fixed size while a video is being saved (setFixedSize)
  let fixedSize = null;
  const viewSize = () => fixedSize || { w: container.clientWidth, h: container.clientHeight };
  function setFixedSize(w, h) {
    fixedSize = w ? { w, h } : null;
    renderer.setPixelRatio(fixedSize ? 1 : Math.min(2, window.devicePixelRatio || 1));
    resize();
  }
  function resize() {
    const { w, h } = viewSize();
    renderer.setSize(w, h, false);
    camera.aspect = w / h;
    camera.fov = camera.aspect < 1 ? 65 : 45;   // portrait screens need a wider vertical view
    camera.updateProjectionMatrix();
  }

  function canvasTexture(w, h, draw, repeat) {
    const c = document.createElement('canvas'); c.width = w; c.height = h;
    draw(c.getContext('2d'), w, h);
    const t = new T.CanvasTexture(c);
    t.colorSpace = T.SRGBColorSpace;
    if (repeat) { t.wrapS = t.wrapT = T.RepeatWrapping; t.repeat.set(repeat[0], repeat[1]); }
    t.anisotropy = 4;
    return t;
  }

  // ---------------------------------------------------------------- the test track
  // Late afternoon: a warm low sun over an open-air crash-test track. The sky is a shader dome; the
  // same sky (with the track and the buildings as bands) is rendered into an environment map, so
  // car paint, chrome and glass reflect it (the imported models get it through CarModels).
  const SKY_FRAG = 'uniform vec3 sunDir; varying vec3 vD; void main(){ float h = max(vD.y, 0.0); vec3 hor = vec3(0.98,0.80,0.64), mid = vec3(0.72,0.78,0.88), zen = vec3(0.30,0.45,0.70); vec3 c = mix(hor, mid, smoothstep(0.0, 0.18, h)); c = mix(c, zen, smoothstep(0.15, 0.85, h)); float s = max(dot(vD, sunDir), 0.0); c += vec3(1.0,0.78,0.52) * (pow(s, 700.0) * 4.0 + pow(s, 14.0) * 0.45 + pow(s, 3.0) * 0.08); c = mix(c, vec3(0.62,0.54,0.48), smoothstep(0.0, -0.06, vD.y)); gl_FragColor = vec4(c, 1.0); }';
  const ENV_FRAG = 'uniform vec3 sunDir; varying vec3 vD; void main(){ vec3 d = normalize(vD); float h = d.y; vec3 c = mix(vec3(0.24,0.22,0.21), vec3(0.95,0.78,0.62), smoothstep(-0.25, 0.0, h)); c = mix(c, vec3(0.70,0.77,0.88), smoothstep(0.02, 0.25, h)); c = mix(c, vec3(0.34,0.48,0.72), smoothstep(0.25, 0.9, h)); float band = step(0.0, h) * (1.0 - smoothstep(0.03, 0.09, h)); c = mix(c, vec3(0.30,0.29,0.30), band * 0.7); float s = max(dot(d, sunDir), 0.0); c += vec3(1.0,0.8,0.55) * (pow(s, 400.0) * 40.0 + pow(s, 10.0) * 0.6); gl_FragColor = vec4(c, 1.0); }';
  const DOME_VERT = 'varying vec3 vD; void main(){ vD = normalize(position); gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0); }';
  function buildSky() {
    const dome = new T.Mesh(new T.SphereGeometry(1500, 32, 16), new T.ShaderMaterial({ side: T.BackSide, depthWrite: false, fog: false,
      uniforms: { sunDir: { value: SUN_DIR } }, vertexShader: DOME_VERT, fragmentShader: SKY_FRAG }));
    dome.renderOrder = -1;
    scene.add(dome);
    const pm = new T.PMREMGenerator(renderer), room = new T.Scene();
    room.add(new T.Mesh(new T.SphereGeometry(50, 32, 16), new T.ShaderMaterial({ side: T.BackSide, depthWrite: false,
      uniforms: { sunDir: { value: SUN_DIR } }, vertexShader: DOME_VERT, fragmentShader: ENV_FRAG })));
    const env = pm.fromScene(room, 0).texture;
    pm.dispose();
    scene.environment = env;
    if (window.CarModels && CarModels.useEnvironment) CarModels.useEnvironment(env);
  }

  // concrete slabs (4 m, with joints), worn and patched, with a normal map for the surface grain
  function buildGround() {
    const N = 2048, slabs = 4, size = 16;   // the texture covers 16 x 16 m: 4 x 4 slabs
    const rnd = (() => { let a = 7; return () => { a = (a * 16807) % 2147483647; return a / 2147483647; }; })();
    const height = new Float32Array(N * N);
    const tex = canvasTexture(N, N, (c, w, h) => {
      c.fillStyle = '#8d8a85'; c.fillRect(0, 0, w, h);
      // per-slab tone, mottling, stains and the joints
      for (let i = 0; i < slabs; i++) for (let j = 0; j < slabs; j++) { const v = rnd() * 16 - 8; c.fillStyle = `rgba(${120 + v},${117 + v},${112 + v},0.55)`; c.fillRect(i * w / slabs, j * h / slabs, w / slabs, h / slabs); }
      for (let k = 0; k < 30000; k++) { const v = 95 + rnd() * 70, r = 1 + rnd() * 2.5; c.fillStyle = `rgba(${v},${v - 2},${v - 6},${0.25 + rnd() * 0.35})`; c.fillRect(rnd() * w, rnd() * h, r, r); }
      for (let k = 0; k < 12; k++) { const g = c.createRadialGradient(0, 0, 0, 0, 0, 1), x = rnd() * w, y = rnd() * h, r = 60 + rnd() * 220; g.addColorStop(0, 'rgba(60,56,52,0.1)'); g.addColorStop(1, 'rgba(60,56,52,0)'); c.save(); c.translate(x, y); c.scale(r, r * (0.5 + rnd())); c.fillStyle = g; c.beginPath(); c.arc(0, 0, 1, 0, 6.3); c.fill(); c.restore(); }
      // tyre marks
      for (let k = 0; k < 3; k++) { c.strokeStyle = `rgba(30,30,32,${0.04 + rnd() * 0.05})`; c.lineWidth = 7 + rnd() * 5; c.beginPath(); const y = rnd() * h; c.moveTo(0, y); c.bezierCurveTo(w * 0.3, y + rnd() * 80 - 40, w * 0.6, y + rnd() * 80 - 40, w, y + rnd() * 60 - 30); c.stroke(); }
      c.fillStyle = 'rgba(40,38,36,0.85)';
      for (let i = 0; i <= slabs; i++) { c.fillRect(i * w / slabs - 2, 0, 4, h); c.fillRect(0, i * h / slabs - 2, w, 4); }
      // the height field for the normal map: grain, and the joints cut in
      const img = c.getImageData(0, 0, w, h).data;
      for (let p = 0; p < N * N; p++) height[p] = img[4 * p] / 255 + (rnd() - 0.5) * 0.08;
    }, [1200 / size, 1200 / size]);
    const nrm = canvasTexture(N, N, (c, w, h) => {
      const id = c.createImageData(w, h), d = id.data, H = (x, y) => height[((y + h) % h) * w + ((x + w) % w)];
      for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
        const dx = (H(x + 1, y) - H(x - 1, y)) * 2.2, dy = (H(x, y + 1) - H(x, y - 1)) * 2.2, l = Math.hypot(dx, dy, 1), p = 4 * (y * w + x);
        d[p] = (-dx / l * 0.5 + 0.5) * 255; d[p + 1] = (dy / l * 0.5 + 0.5) * 255; d[p + 2] = (1 / l * 0.5 + 0.5) * 255; d[p + 3] = 255;
      }
      c.putImageData(id, 0, 0);
    }, [1200 / size, 1200 / size]);
    nrm.colorSpace = T.NoColorSpace;
    const ground = new T.Mesh(new T.PlaneGeometry(1200, 1200), new T.MeshStandardMaterial({ map: tex, normalMap: nrm, normalScale: new T.Vector2(0.6, 0.6), roughness: 0.88, metalness: 0, envMapIntensity: 0.5 }));
    ground.rotation.x = -Math.PI / 2;
    ground.receiveShadow = true;
    scene.add(ground);
    // the photogrammetry grid painted round the impact zone (1 m squares), faint
    const grid = canvasTexture(512, 512, (c, w, h) => {
      c.clearRect(0, 0, w, h); c.strokeStyle = 'rgba(245,245,240,0.22)'; c.lineWidth = 2;
      for (let i = 0; i <= 16; i++) { const p = i * w / 16; c.beginPath(); c.moveTo(p, 0); c.lineTo(p, h); c.stroke(); c.beginPath(); c.moveTo(0, p); c.lineTo(w, p); c.stroke(); }
      c.strokeStyle = 'rgba(255,196,0,0.7)'; c.lineWidth = 5; c.strokeRect(3, 3, w - 6, h - 6);
    });
    const gridMesh = new T.Mesh(new T.PlaneGeometry(16, 16), new T.MeshStandardMaterial({ map: grid, transparent: true, roughness: 0.8, depthWrite: false, polygonOffset: true, polygonOffsetFactor: -1 }));
    gridMesh.rotation.x = -Math.PI / 2; gridMesh.position.set(-8, 0.005, 0); gridMesh.receiveShadow = true;
    scene.add(gridMesh);
  }

  // the facility round the track, well clear of every test: the test hall behind the barrier,
  // floodlight masts, a fence, and low buildings on the horizon
  function buildFacility() {
    const g = new T.Group(), M = (c, r = 0.85, m = 0) => new T.MeshStandardMaterial({ color: c, roughness: r, metalness: m });
    const box = (w, h, d, x, y, z, mat, shadow = true) => { const b = new T.Mesh(new T.BoxGeometry(w, h, d), mat); b.position.set(x, y, z); b.castShadow = shadow; b.receiveShadow = true; g.add(b); return b; };
    // the hall: corrugated cladding, a big door, a band of windows, a hazard stripe
    const clad = canvasTexture(256, 256, (c, w, h) => { for (let x = 0; x < w; x += 16) { const gr = c.createLinearGradient(x, 0, x + 16, 0); gr.addColorStop(0, '#9fa7ae'); gr.addColorStop(0.5, '#c9cfd4'); gr.addColorStop(1, '#8f979e'); c.fillStyle = gr; c.fillRect(x, 0, 16, h); } }, [12, 2]);
    const hall = M(0xffffff, 0.55, 0.35); hall.map = clad;
    box(60, 14, 18, 25, 7, -80, hall);
    box(16, 9, 0.4, 25, 4.5, -70.8, M(0x3b4148, 0.6, 0.4));               // the door
    box(50, 1.6, 0.3, 25, 11.2, -70.85, M(0x1d2a38, 0.15, 0.6));          // windows
    const stripe = canvasTexture(256, 32, (c, w, h) => { c.fillStyle = '#ffc400'; c.fillRect(0, 0, w, h); c.fillStyle = '#16171a'; for (let x = -h; x < w; x += 32) { c.beginPath(); c.moveTo(x, h); c.lineTo(x + 16, h); c.lineTo(x + 16 + h, 0); c.lineTo(x + h, 0); c.fill(); } }, [20, 1]);
    const sm = M(0xffffff, 0.7); sm.map = stripe;
    box(60, 0.6, 0.32, 25, 0.3, -70.75, sm, false);
    box(62, 0.8, 20, 25, 14.4, -80, M(0x5d646b, 0.7, 0.3));              // roof edge
    // a second, lower building and a control tower
    box(26, 8, 14, 20, 4, 58, M(0xb9b2a6), true);
    box(26, 0.5, 4, 20, 8.25, 50.5, M(0x2a3644, 0.2, 0.5), false);
    box(5, 18, 5, -30, 9, 46, M(0xa9a39a), true);
    box(6.2, 2.4, 6.2, -30, 19.2, 46, M(0x22303e, 0.15, 0.6), true);
    // floodlight masts, lit
    const lampMat = new T.MeshStandardMaterial({ color: 0xfff6e0, emissive: 0xfff1d0, emissiveIntensity: 2.5 });
    for (const [x, z] of [[-60, -34], [-60, 34], [10, -40], [10, 40], [44, -34], [44, 34]]) {
      box(0.5, 24, 0.5, x, 12, z, M(0x6b7076, 0.5, 0.6));
      const head = box(2.6, 1.2, 0.5, x, 24.4, z, M(0x2c3034, 0.4, 0.5));
      const lamp = new T.Mesh(new T.PlaneGeometry(2.3, 0.9), lampMat); lamp.position.set(x, 24.4, z + (z > 0 ? -0.26 : 0.26)); lamp.rotation.y = z > 0 ? Math.PI : 0; lamp.layers.enable(3); g.add(lamp);
      head.rotation.x = z > 0 ? 0.25 : -0.25;
    }
    // a perimeter fence: posts, rails and mesh (one instanced set each)
    const postGeo = new T.CylinderGeometry(0.05, 0.05, 2.4, 6), posts = [], R = 112;
    for (let a = 0; a < 360; a += 1.5) { const r = a * Math.PI / 180; posts.push([Math.cos(r) * R, Math.sin(r) * R * 0.85]); }
    const pm = new T.InstancedMesh(postGeo, M(0x7a7f85, 0.5, 0.7), posts.length), m4 = new T.Matrix4();
    posts.forEach(([x, z], i) => { m4.makeTranslation(x, 1.2, z); pm.setMatrixAt(i, m4); });
    pm.castShadow = false; g.add(pm);
    const mesh = canvasTexture(64, 64, (c, w, h) => { c.clearRect(0, 0, w, h); c.strokeStyle = 'rgba(150,155,160,0.9)'; c.lineWidth = 2; c.beginPath(); c.moveTo(0, 0); c.lineTo(w, h); c.moveTo(w, 0); c.lineTo(0, h); c.stroke(); }, [800, 24]);
    const fenceMat = new T.MeshStandardMaterial({ map: mesh, transparent: true, alphaTest: 0.3, side: T.DoubleSide, roughness: 0.6, metalness: 0.5 });
    const ring = new T.Mesh(new T.CylinderGeometry(R, R, 2.2, 160, 1, true), fenceMat); ring.scale.z = 0.85; ring.position.y = 1.1; g.add(ring);
    // the horizon: low buildings and trees as dark silhouettes in the haze
    const pal = [0x5f6670, 0x6e675f, 0x56605c, 0x7a7068, 0x4f5862].map((c) => M(c, 0.95)), tree = M(0x3e4a36, 1);
    for (let k = 0; k < 90; k++) {
      const a = (k / 90) * Math.PI * 2 + 0.03 * Math.sin(k * 7.1), r = 240 + 110 * ((k * 37) % 11) / 11, x = Math.cos(a) * r, z = Math.sin(a) * r;
      if (k % 3 === 0) { const tr = new T.Mesh(new T.SphereGeometry(6 + (k % 5) * 1.5, 10, 8), tree); tr.scale.y = 1.3; tr.position.set(x, 5 + (k % 4), z); g.add(tr); continue; }
      const hgt = 6 + ((k * 53) % 17) * 1.2, w = 16 + ((k * 29) % 13) * 3;
      box(w, hgt, w * 0.6, x, hgt / 2, z, pal[k % pal.length], false).rotation.y = Math.atan2(z, x);
    }
    scene.add(g);
  }

  // ---------------------------------------------------------------- approach path + gizmo
  function buildPath() {
    pathGroup = new T.Group();
    scene.add(pathGroup);
    handle = new T.Mesh(new T.SphereGeometry(0.45, 24, 16), new T.MeshStandardMaterial({ color: 0x4f9cf0, emissive: 0x16365c, roughness: 0.4 }));
    handle.castShadow = true;
    scene.add(handle);
  }
  function setPath(angle, distance, visible) {
    pathGroup.clear();
    pathGroup.visible = visible; handle.visible = visible;
    const len = distance + 12;
    const lane = new T.Mesh(new T.PlaneGeometry(len, 3.6), new T.MeshStandardMaterial({ color: 0x7c8088, roughness: 0.9 }));
    lane.rotation.x = -Math.PI / 2; lane.position.set(-len / 2, 0.02, 0); lane.receiveShadow = true;
    pathGroup.add(lane);
    const dashMat = new T.MeshBasicMaterial({ color: 0xf0e442 });
    for (let x = -1.5; x > -distance; x -= 3) {
      const d = new T.Mesh(new T.PlaneGeometry(1.5, 0.12), dashMat);
      d.rotation.x = -Math.PI / 2; d.position.set(x - 0.75, 0.04, 0);
      pathGroup.add(d);
    }
    const arrow = new T.Mesh(new T.ConeGeometry(0.5, 1.4, 20), new T.MeshBasicMaterial({ color: 0xf0e442 }));
    arrow.rotation.z = -Math.PI / 2; arrow.position.set(-0.9, 0.3, 0);
    pathGroup.add(arrow);
    pathGroup.rotation.y = -angle;
    // handle sits just behind the car's starting position
    handle.position.set(-Math.cos(angle) * (distance + 7), 0.45, -Math.sin(angle) * (distance + 7));
  }
  function screenOf(v) {
    const p = v.clone().project(camera), r = renderer.domElement.getBoundingClientRect();
    return [(p.x + 1) / 2 * r.width + r.left, (1 - p.y) / 2 * r.height + r.top];
  }
  function onPointerDown(e) {
    if (!handle.visible || !onAngleDrag) return;
    const [sx, sy] = screenOf(handle.position);
    if (Math.hypot(sx - e.clientX, sy - e.clientY) < 28) { dragging = true; controls.enabled = false; e.preventDefault(); }
  }
  function onPointerMove(e) {
    if (handle.visible && !dragging) {
      const [sx, sy] = screenOf(handle.position);
      renderer.domElement.style.cursor = Math.hypot(sx - e.clientX, sy - e.clientY) < 28 ? 'grab' : '';
    }
    if (!dragging) return;
    const r = renderer.domElement.getBoundingClientRect();
    raycaster.setFromCamera({ x: (e.clientX - r.left) / r.width * 2 - 1, y: -(e.clientY - r.top) / r.height * 2 + 1 }, camera);
    const hit = raycaster.ray.intersectPlane(new T.Plane(UP, 0), V());
    if (!hit || hit.x > -2) return;
    const deg = Math.atan2(-hit.z, -hit.x) * 180 / Math.PI;
    onAngleDrag(Math.max(-45, Math.min(45, Math.round(deg))));
  }

  // ---------------------------------------------------------------- barriers
  function buildBarriers() {
    rigidBarrier = new T.Group();
    // cast concrete: formwork panels (1.2 m), their tie holes, mottling and a darker stained foot
    const rnd = (() => { let a = 11; return () => { a = (a * 16807) % 2147483647; return a / 2147483647; }; })();
    const castTex = canvasTexture(512, 256, (c, w, h) => {
      c.fillStyle = '#a3a4a3'; c.fillRect(0, 0, w, h);
      for (let k = 0; k < 6000; k++) { const v = 130 + rnd() * 60; c.fillStyle = `rgba(${v},${v},${v - 4},0.35)`; c.fillRect(rnd() * w, rnd() * h, 1.5, 1.5); }
      for (let k = 0; k < 10; k++) { const g = c.createRadialGradient(0, 0, 0, 0, 0, 1); g.addColorStop(0, 'rgba(70,70,68,0.14)'); g.addColorStop(1, 'rgba(70,70,68,0)'); c.save(); c.translate(rnd() * w, rnd() * h); c.scale(30 + rnd() * 60, 20 + rnd() * 40); c.fillStyle = g; c.beginPath(); c.arc(0, 0, 1, 0, 6.3); c.fill(); c.restore(); }
      const foot = c.createLinearGradient(0, h * 0.7, 0, h); foot.addColorStop(0, 'rgba(60,58,55,0)'); foot.addColorStop(1, 'rgba(60,58,55,0.35)'); c.fillStyle = foot; c.fillRect(0, 0, w, h);
      c.strokeStyle = 'rgba(70,70,70,0.45)'; c.lineWidth = 2;
      for (let x = 0; x <= w; x += w / 4) { c.beginPath(); c.moveTo(x, 0); c.lineTo(x, h); c.stroke(); }
      c.beginPath(); c.moveTo(0, h / 2); c.lineTo(w, h / 2); c.stroke();
      c.fillStyle = 'rgba(40,40,40,0.6)';
      for (let x = w / 8; x < w; x += w / 4) for (const y of [h / 4, 3 * h / 4]) { c.beginPath(); c.arc(x - 20, y, 3, 0, 6.3); c.arc(x + 20, y, 3, 0, 6.3); c.fill(); }
    }, [1, 1]);
    const concrete = new T.MeshStandardMaterial({ color: 0xffffff, map: castTex, roughness: 0.92 });
    // The steel plate's front face is the physical barrier face (x = 0). The block starts behind
    // the plate so no two faces share a plane (coplanar faces z-fight and flicker).
    const block = new T.Mesh(new T.BoxGeometry(2.96, 2.4, 2 * P.RIGID_BARRIER.halfWidth), concrete);
    block.position.set(1.52, 1.2, 0); block.castShadow = block.receiveShadow = true;
    // the face: a steel wall of load cells (square plates, bolted), as on a real rigid barrier
    const cellTex = canvasTexture(512, 256, (c, w, h) => {
      c.fillStyle = '#3b4148'; c.fillRect(0, 0, w, h);
      const n = 8, m = 4, cw = w / n, ch = h / m;
      for (let i = 0; i < n; i++) for (let j = 0; j < m; j++) {
        const x = i * cw + 3, y = j * ch + 3, g = c.createLinearGradient(x, y, x + cw, y + ch);
        g.addColorStop(0, '#6d7680'); g.addColorStop(1, '#4f575f'); c.fillStyle = g; c.fillRect(x, y, cw - 6, ch - 6);
        c.fillStyle = '#2a2f35'; for (const [u, v] of [[8, 8], [cw - 14, 8], [8, ch - 14], [cw - 14, ch - 14]]) c.fillRect(x + u, y + v, 4, 4);
      }
    }, [1, 1]);
    const plate = new T.Mesh(new T.BoxGeometry(0.04, 1.9, 2 * P.RIGID_BARRIER.halfWidth - 0.4), new T.MeshStandardMaterial({ map: cellTex, roughness: 0.45, metalness: 0.55 }));
    plate.position.set(0.02, 1.0, 0); plate.receiveShadow = true;
    const stripeTex = canvasTexture(256, 32, (c, w, h) => {
      c.fillStyle = '#f0c419'; c.fillRect(0, 0, w, h); c.fillStyle = '#1b1b1b';
      for (let x = -h; x < w; x += 32) { c.beginPath(); c.moveTo(x, h); c.lineTo(x + 16, h); c.lineTo(x + 16 + h, 0); c.lineTo(x + h, 0); c.fill(); }
    }, [16, 1]);
    const stripe = new T.Mesh(new T.BoxGeometry(0.05, 0.25, 2 * P.RIGID_BARRIER.halfWidth), new T.MeshStandardMaterial({ map: stripeTex, roughness: 0.7 }));
    stripe.position.set(0.0, 2.295, 0);   // top edge at 2.42, just above the block's top face
    rigidBarrier.add(block, plate, stripe);
    scene.add(rigidBarrier);

    wallGroup = new T.Group();
    wallLayout = P.buildWall('standard');
    const nb = wallLayout.nb;
    wallMesh = new T.InstancedMesh(new T.BoxGeometry(1, 1, 1), new T.MeshStandardMaterial({ roughness: 0.85 }), nb);
    wallMesh.castShadow = wallMesh.receiveShadow = true;
    wallMesh.frustumCulled = false;
    const c = new T.Color();
    for (let b = 0; b < nb; b++) {
      c.setHSL(0.03 + Math.random() * 0.02, 0.45 + Math.random() * 0.15, 0.30 + Math.random() * 0.08);
      wallMesh.setColorAt(b, c);
    }
    wallGroup.add(wallMesh);
    for (const s of [-1, 1]) {
      const pillar = new T.Mesh(new T.BoxGeometry(0.45, 2.7, 0.45), concrete);
      pillar.position.set(P.WALL.thick / 2, 1.35, s * (P.WALL.halfWidth + 0.225)); pillar.castShadow = pillar.receiveShadow = true;
      wallGroup.add(pillar);
    }
    const footing = new T.Mesh(new T.BoxGeometry(0.5, 0.06, 2 * P.WALL.halfWidth + 0.9), concrete);
    footing.position.set(P.WALL.thick / 2, 0.0, 0); footing.receiveShadow = true;
    wallGroup.add(footing);
    scene.add(wallGroup);
    resetBricks();
  }
  function setBarrier(mode) { rigidBarrier.visible = mode === 'rigid'; wallGroup.visible = mode === 'brick'; }
  const mtx = new T.Matrix4(), qtmp = new T.Quaternion(), vtmp = V(), stmp = V();
  function resetBricks() {
    const L = wallLayout;
    for (let b = 0; b < L.nb; b++) {
      vtmp.set(L.center[3 * b], L.center[3 * b + 1], L.center[3 * b + 2]);
      stmp.set(2 * L.half[3 * b] * 0.99, 2 * L.half[3 * b + 1] * 0.96, 2 * L.half[3 * b + 2] * 0.985);
      qtmp.identity();
      wallMesh.setMatrixAt(b, mtx.compose(vtmp, qtmp, stmp));
    }
    wallMesh.instanceMatrix.needsUpdate = true;
  }
  // poses: Float32Array of 7 per brick (pos, quat), optionally blended with `next` by s.
  function setBricks(poses, next, s) {
    const L = wallLayout;
    const qa = new T.Quaternion(), qb = new T.Quaternion();
    for (let b = 0; b < L.nb; b++) {
      const o = 7 * b;
      if (next) {
        vtmp.set(poses[o] + (next[o] - poses[o]) * s, poses[o + 1] + (next[o + 1] - poses[o + 1]) * s, poses[o + 2] + (next[o + 2] - poses[o + 2]) * s);
        qa.set(poses[o + 3], poses[o + 4], poses[o + 5], poses[o + 6]); qb.set(next[o + 3], next[o + 4], next[o + 5], next[o + 6]);
        qtmp.slerpQuaternions(qa, qb, s);
      } else {
        vtmp.set(poses[o], poses[o + 1], poses[o + 2]);
        qtmp.set(poses[o + 3], poses[o + 4], poses[o + 5], poses[o + 6]);
      }
      stmp.set(2 * L.half[3 * b] * 0.99, 2 * L.half[3 * b + 1] * 0.96, 2 * L.half[3 * b + 2] * 0.985);
      wallMesh.setMatrixAt(b, mtx.compose(vtmp, qtmp, stmp));
    }
    wallMesh.instanceMatrix.needsUpdate = true;
  }

  // ---------------------------------------------------------------- shared helpers
  const smooth = (a, b, x) => { const t = Math.max(0, Math.min(1, (x - a) / (b - a))); return t * t * (3 - 2 * t); };
  function bodyBottom(u) { return (u < 0.3 || u > P.CAR.length - 0.3) ? 0.30 : 0.22; }
  function halfWidth(u, y) {
    const L = P.CAR.length;
    let hw = 0.9 - 0.33 * Math.max(0, y - 0.98);
    if (u > L - 0.55) hw *= 1 - 0.11 * Math.pow((u - (L - 0.55)) / 0.55, 2);
    if (u < 0.45) hw *= 1 - 0.08 * Math.pow((0.45 - u) / 0.45, 2);
    return hw;
  }
  function poseMatrix(x, z, heading) {
    const c = Math.cos(heading), s = Math.sin(heading);
    return new T.Matrix4().makeBasis(V(c, 0, s), UP, V(-s, 0, c)).setPosition(x, 0, z);
  }
  const RAMP = [[0, 0xc9ced6], [0.12, 0xf0e442], [0.35, 0xe69f00], [1, 0xa8380a]].map(([t, h]) => [t, new T.Color(h)]);
  function ramp(t, out) {
    t = Math.max(0, Math.min(1, t));
    for (let k = 1; k < RAMP.length; k++) if (t <= RAMP[k][0]) return out.copy(RAMP[k - 1][1]).lerp(RAMP[k][1], (t - RAMP[k - 1][0]) / (RAMP[k][0] - RAMP[k - 1][0]));
    return out.copy(RAMP[RAMP.length - 1][1]);
  }
  function std(color, rough = 0.6, metal = 0) { return new T.MeshStandardMaterial({ color, roughness: rough, metalness: metal }); }
  // Orient a Y-aligned mesh of base length `base` from a to b.
  function placeSeg(mesh, a, b, base) {
    const d = V().subVectors(b, a), len = d.length();
    mesh.position.copy(a).addScaledVector(d, 0.5);
    if (len > 1e-6) mesh.quaternion.setFromUnitVectors(YAXIS, d.divideScalar(len));
    mesh.scale.y = len / base;
  }
  function headTexture() {
    return canvasTexture(256, 128, (c, w, h) => {
      c.fillStyle = '#e2b33a'; c.fillRect(0, 0, w, h);
      for (const cx of [w * 0.25, w * 0.75]) {
        const cy = h * 0.5, r = 16;
        c.fillStyle = '#ffffff'; c.beginPath(); c.arc(cx, cy, r, 0, Math.PI * 2); c.fill();
        c.fillStyle = '#111111';
        c.beginPath(); c.moveTo(cx, cy); c.arc(cx, cy, r, 0, Math.PI / 2); c.fill();
        c.beginPath(); c.moveTo(cx, cy); c.arc(cx, cy, r, Math.PI, Math.PI * 1.5); c.fill();
      }
    });
  }
  function twoBone(s, target, a, b, pole) {
    const d = V().subVectors(target, s), dist = Math.min(d.length(), a + b - 1e-3);
    d.normalize();
    const hand = s.clone().addScaledVector(d, dist);
    const x = (a * a - b * b + dist * dist) / (2 * dist), h = Math.sqrt(Math.max(0, a * a - x * x));
    const bend = pole.clone().addScaledVector(d, -pole.dot(d)).normalize();
    const elbow = s.clone().addScaledVector(d, x).addScaledVector(bend, h);
    return { elbow, hand };
  }
  const INJ_BASE = new T.Color(0xe2b33a);
  function injuryColor(r, out) {
    if (r < 0.5) return out.set(0x7fa6c9).lerp(new T.Color(0xf0e442), r / 0.5);
    if (r < 1) return out.set(0xf0e442).lerp(new T.Color(0xe69f00), (r - 0.5) / 0.5);
    return out.set(0xd55e00);
  }

  // ---------------------------------------------------------------- a car slot
  function makeSlot() {
    let spec = P.CAR, HP = P.CAR.hPoint, I = OC.INTERIOR;   // current vehicle, its H-point and interior
    let carModel, labLattice, body, bodyGeo, bodyRest, embIdx, embW, baseColors, bodyMat, glassMat, carRig;
    let imported = null;                 // CarModels instance of the current imported car, or null
    const importedCache = {};            // key -> promise of a CarModels instance
    const wheels = [];
    let interior, bag, steering, column, curtain = null;
    const dummy = {}, straps = {};
    let lastStrain = null, visible = true, onboardSide = -1;   // onboard camera outside the driver's door (-1) or the far one (+1)
    const crumpleU = { uStrainMode: { value: 0 }, uCrumple: { value: CarModels.CRUMPLE_DEPTH } };   // the lab car's crumple shading
    let deformed = null;                 // { X, X2, s }: the node positions on show while the car is deformed
    const ctx = { o: V(), f: V(1, 0, 0), u: V(0, 1, 0), l: V(0, 0, 1), f0: V(1, 0, 0), l0: V(0, 0, 1) };

    // -------------------------------------------------------------- car body
    function buildCar() {
      carModel = P.buildCar(1500, 'standard');
      const L = P.CAR.length;
      const g = new T.BoxGeometry(1, 1, 1, 64, 12, 18);
      const pos = g.attributes.position, n = pos.count;
      const box = Float32Array.from(pos.array);
      const col = new Float32Array(3 * n);
      const ax = P.axles();
      const paint = new T.Color(0x2f5f9e), trim = new T.Color(0x1d2024), lamp = new T.Color(0xf4f1e6), tail = new T.Color(0xa3221b), grille = new T.Color(0x2a2e33);
      for (let i = 0; i < n; i++) {
        const bx = box[3 * i], by = box[3 * i + 1], bz = box[3 * i + 2];
        const u = (bx + 0.5) * L, top = P.topHeight(u), bot = bodyBottom(u), t = by + 0.5;
        let y = bot + t * (top - bot);
        const side = Math.abs(bz) * 2;
        y -= 0.05 * Math.pow(side, 8) * Math.pow(t, 2);
        const hw = halfWidth(u, y) * (1 - 0.035 * Math.pow(t, 10) * Math.pow(side, 2));
        const x = u - L / 2, z = bz * 2 * hw;
        pos.setXYZ(i, x, y, z);
        let c = paint;
        const az = Math.abs(z);
        const front = Math.abs(bx - 0.5) < 1e-6, rear = Math.abs(bx + 0.5) < 1e-6, sideFace = Math.abs(Math.abs(bz) - 0.5) < 1e-6;
        // straight colour bands only: curved boundaries look jagged with per-vertex colours
        if ((front || rear) && y < 0.42) c = trim;
        if (sideFace && y < 0.3) c = trim;
        if (front && y > 0.52 && y < 0.64 && az > 0.42 && az < 0.78) c = lamp;
        if (front && y > 0.36 && y < 0.5 && az < 0.42) c = grille;
        if (rear && y > 0.72 && y < 0.88 && az > 0.45) c = tail;
        col.set([c.r, c.g, c.b], 3 * i);
      }
      g.setAttribute('color', new T.BufferAttribute(col, 3));
      baseColors = Float32Array.from(col);
      // split faces into body and glass groups
      const idx = g.index.array, bodyTris = [], glassTris = [];
      for (let k = 0; k < idx.length; k += 3) {
        const a = idx[k], b = idx[k + 1], c = idx[k + 2];
        const cx = (pos.getX(a) + pos.getX(b) + pos.getX(c)) / 3 + L / 2, cy = (pos.getY(a) + pos.getY(b) + pos.getY(c)) / 3;
        const topFace = [a, b, c].every(v => Math.abs(box[3 * v + 1] - 0.5) < 1e-6);
        const sideFace = [a, b, c].every(v => Math.abs(Math.abs(box[3 * v + 2]) - 0.5) < 1e-6);
        let glass = false;
        if (topFace && ((cx > 2.74 && cx < 3.30) || (cx > 0.80 && cx < 1.26))) glass = true;
        if (sideFace && cx > 0.95 && cx < 3.2 && cy > 1.0 && cy < P.topHeight(cx) - 0.04 && !(cx > 2.0 && cx < 2.1)) glass = true;
        (glass ? glassTris : bodyTris).push(a, b, c);
      }
      g.setIndex(bodyTris.concat(glassTris));
      g.clearGroups(); g.addGroup(0, bodyTris.length, 0); g.addGroup(bodyTris.length, glassTris.length, 1);
      g.computeVertexNormals();
      bodyGeo = g;
      bodyRest = Float32Array.from(pos.array);
      embIdx = new Int32Array(8 * n); embW = new Float32Array(8 * n);
      for (let i = 0; i < n; i++) embed(bodyRest[3 * i], bodyRest[3 * i + 1], bodyRest[3 * i + 2], embIdx, embW, 8 * i);
      bodyMat = new T.MeshStandardMaterial({ vertexColors: true, roughness: 0.38, metalness: 0.3 });
      // crumple folds and damaged paint where the metal yielded (the same shading as the imported cars)
      g.setAttribute('aRest', new T.BufferAttribute(Float32Array.from(bodyRest), 3));
      g.setAttribute('aStrain', new T.BufferAttribute(new Float32Array(n), 1));
      g.setAttribute('aComp', new T.BufferAttribute(new Float32Array(3 * n), 3));
      CarModels.crumpleMaterial(bodyMat, crumpleU);
      glassMat = new T.MeshStandardMaterial({ color: 0x16202b, roughness: 0.06, metalness: 0.5, transparent: true, opacity: 0.5 });
      body = new T.Mesh(g, [bodyMat, glassMat]);
      body.castShadow = true; body.layers.set(1); body.frustumCulled = false;
      carRig = new T.Group(); carRig.matrixAutoUpdate = false;
      carRig.add(body);
      // wheels
      const tireGeo = new T.CylinderGeometry(P.CAR.wheelRadius, P.CAR.wheelRadius, 0.22, 28); tireGeo.rotateX(Math.PI / 2);
      const rimGeo = new T.CylinderGeometry(0.2, 0.2, 0.225, 20); rimGeo.rotateX(Math.PI / 2);
      const tireMat = new T.MeshStandardMaterial({ color: 0x17181a, roughness: 0.9 }), rimMat = new T.MeshStandardMaterial({ color: 0xb8bec6, roughness: 0.35, metalness: 0.8 });
      const spokeGeo = new T.BoxGeometry(0.36, 0.05, 0.23);
      for (const wx of [ax.rearX, ax.frontX]) for (const s of [-1, 1]) {
        const w = new T.Group();
        const tire = new T.Mesh(tireGeo, tireMat), rim = new T.Mesh(rimGeo, rimMat);
        const sp1 = new T.Mesh(spokeGeo, tireMat), sp2 = sp1.clone(); sp2.rotation.z = Math.PI / 2;
        for (const m of [tire, rim, sp1, sp2]) { m.castShadow = true; m.layers.set(1); w.add(m); }
        const hub = V(wx, P.CAR.wheelRadius, s * 0.78);
        const ei = new Int32Array(8), ew = new Float32Array(8);
        embed(hub.x, hub.y, hub.z, ei, ew, 0);
        wheels.push({ group: w, hub, ei, ew, front: wx > 0, spin: 0 });
        carRig.add(w);
      }
      scene.add(carRig);
    }
    // Trilinear weights of a point in the lattice cell that contains it (or the nearest complete cell).
    function embed(x, y, z, outI, outW, o) {
      const C = P.CAR, m = carModel, nx = C.nx, ny = C.ny, nz = C.nz;
      const fi = (x + C.latHalfL) / m.sx, fj = (y - C.yBottom) / m.sy, fk = (z + C.latHalfW) / m.sz;
      const i = Math.max(0, Math.min(nx - 2, Math.floor(fi))), k = Math.max(0, Math.min(nz - 2, Math.floor(fk)));
      let j = Math.max(0, Math.min(ny - 2, Math.floor(fj)));
      const node = (a, b, c) => m.grid[(a * ny + b) * nz + c];
      for (; j >= 0; j--) {
        let ok = true;
        for (let c = 0; c < 8 && ok; c++) if (node(i + (c & 1), j + ((c >> 1) & 1), k + ((c >> 2) & 1)) < 0) ok = false;
        if (ok) break;
      }
      if (j < 0) j = 0;
      const tx = fi - i, ty = fj - j, tz = fk - k;
      for (let c = 0; c < 8; c++) {
        const di = c & 1, dj = (c >> 1) & 1, dk = (c >> 2) & 1;
        outI[o + c] = Math.max(0, node(i + di, j + dj, k + dk));
        outW[o + c] = (di ? tx : 1 - tx) * (dj ? ty : 1 - ty) * (dk ? tz : 1 - tz);
      }
    }
    // Car as a rigid body (setup / approach).
    function setCarRigid(pose, steer, spinDelta) {
      deformed = null;
      if (imported) {
        imported.setRigid(poseMatrix(pose.x, pose.z, pose.heading), steer, spinDelta, UP, ZAXIS);
        const c = Math.cos(pose.heading), s = Math.sin(pose.heading), c0 = carModel.cabinRest;
        setCabinFrame([pose.x + c * c0[0] - s * c0[2], c0[1], pose.z + s * c0[0] + c * c0[2]], [c, 0, s], [0, 1, 0]);
        return;
      }
      if (!carRig.userData.rigid) {
        bodyGeo.attributes.position.array.set(bodyRest);
        bodyGeo.attributes.position.needsUpdate = true;
        bodyGeo.attributes.color.array.set(baseColors);
        bodyGeo.attributes.color.needsUpdate = true;
        bodyGeo.attributes.aStrain.array.fill(0); bodyGeo.attributes.aStrain.needsUpdate = true;
        bodyGeo.computeVertexNormals();
        carRig.userData.rigid = true;
        lastStrain = null;
      }
      carRig.matrix.copy(poseMatrix(pose.x, pose.z, pose.heading));
      carRig.matrixWorldNeedsUpdate = true;
      for (const w of wheels) {
        w.spin += spinDelta || 0;
        w.group.position.copy(w.hub);
        w.group.quaternion.setFromAxisAngle(UP, w.front ? (steer || 0) * -1 : 0).multiply(new T.Quaternion().setFromAxisAngle(ZAXIS, -w.spin));
      }
      const c = Math.cos(pose.heading), s = Math.sin(pose.heading), c0 = carModel.cabinRest;
      setCabinFrame([pose.x + c * c0[0] - s * c0[2], c0[1], pose.z + s * c0[0] + c * c0[2]], [c, 0, s], [0, 1, 0]);
    }
    // Deformed car from lattice node positions (world). strain: per-node Uint8 or null.
    function setCarDeformed(X, X2, s, strain) {
      deformed = { X, X2, s };
      if (imported) {
        imported.setDeformed(X, X2, s, strain, new T.Quaternion().setFromRotationMatrix(new T.Matrix4().makeBasis(ctx.f, ctx.u, ctx.l)), ZAXIS);
        return;
      }
      if (carRig.userData.rigid !== false) { carRig.matrix.identity(); carRig.matrixWorldNeedsUpdate = true; carRig.userData.rigid = false; }
      const pos = bodyGeo.attributes.position.array, n = pos.length / 3;
      const blend = X2 && s > 0;
      for (let i = 0; i < n; i++) {
        let x = 0, y = 0, z = 0;
        for (let c = 0; c < 8; c++) {
          const a = 3 * embIdx[8 * i + c], w = embW[8 * i + c];
          if (blend) { x += w * (X[a] + (X2[a] - X[a]) * s); y += w * (X[a + 1] + (X2[a + 1] - X[a + 1]) * s); z += w * (X[a + 2] + (X2[a + 2] - X[a + 2]) * s); }
          else { x += w * X[a]; y += w * X[a + 1]; z += w * X[a + 2]; }
        }
        pos[3 * i] = x; pos[3 * i + 1] = y; pos[3 * i + 2] = z;
      }
      bodyGeo.attributes.position.needsUpdate = true;
      bodyGeo.computeVertexNormals();
      if (strain !== lastStrain || strainMode !== carRig.userData.strainMode) {
        paintStrain(strain); lastStrain = strain; carRig.userData.strainMode = strainMode;
      }
      const q = new T.Quaternion().setFromRotationMatrix(new T.Matrix4().makeBasis(ctx.f, ctx.u, ctx.l));
      for (const w of wheels) {
        let x = 0, y = 0, z = 0;
        for (let c = 0; c < 8; c++) { const a = 3 * w.ei[c], wt = w.ew[c]; x += wt * X[a]; y += wt * X[a + 1]; z += wt * X[a + 2]; }
        w.group.position.set(x, y, z);
        w.group.quaternion.copy(q).multiply(new T.Quaternion().setFromAxisAngle(ZAXIS, -w.spin));
      }
    }
    function paintStrain(strain) {
      const col = bodyGeo.attributes.color.array, n = col.length / 3, c = new T.Color(), st = bodyGeo.attributes.aStrain.array;
      for (let i = 0; i < n; i++) {
        let s = 0;
        if (strain) for (let k = 0; k < 8; k++) s += embW[8 * i + k] * strain[embIdx[8 * i + k]];
        s = Math.max(0, s / 255);
        st[i] = s;   // the shader darkens and folds the damaged metal from this
        if (strainMode) { ramp(Math.sqrt(s), c); col[3 * i] = c.r; col[3 * i + 1] = c.g; col[3 * i + 2] = c.b; }
        else { col[3 * i] = baseColors[3 * i]; col[3 * i + 1] = baseColors[3 * i + 1]; col[3 * i + 2] = baseColors[3 * i + 2]; }
      }
      bodyGeo.attributes.color.needsUpdate = true; bodyGeo.attributes.aStrain.needsUpdate = true;
    }
    function applyStrainMode() { glassMat.opacity = strainMode ? 0.2 : (xray ? 0.08 : 0.5); crumpleU.uStrainMode.value = strainMode ? 1 : 0; if (imported) imported.setStrainMode(strainMode); }
    function applyXray() {
      if (imported) imported.setXray(xray);
      bodyMat.transparent = xray; bodyMat.opacity = xray ? 0.16 : 1; bodyMat.depthWrite = !xray; bodyMat.needsUpdate = true;
      glassMat.opacity = xray ? 0.08 : (strainMode ? 0.2 : 0.5);
      for (const w of wheels) w.group.children.forEach(m => { m.material.transparent = xray; m.material.opacity = xray ? 0.3 : 1; });
    }

    // -------------------------------------------------------------- interior + dummy (car-local)
    function setCabinFrame(o, f, u) {
      ctx.o.set(o[0], o[1], o[2]); ctx.f.set(f[0], f[1], f[2]).normalize(); ctx.u.set(u[0], u[1], u[2]).normalize();
      ctx.l.crossVectors(ctx.f, ctx.u).normalize();
      const R = new T.Matrix4().makeBasis(ctx.f, ctx.u, ctx.l);
      const c0 = carModel.cabinRest;
      interior.matrix.copy(R).setPosition(ctx.o).multiply(new T.Matrix4().makeTranslation(-c0[0], -c0[1], -c0[2]));
      interior.matrixWorldNeedsUpdate = true;
    }
    const local = (x2, y2, z) => V(HP[0] + x2, HP[1] + y2, HP[2] + (z || 0));
    function buildInterior() {
      interior = new T.Group(); interior.matrixAutoUpdate = false;
      interior.visible = visible;
      scene.add(interior);
      const seatMat = std(0x30353d, 0.9);
      const cushion = new T.Mesh(new T.BoxGeometry(0.52, 0.12, 0.54), seatMat); cushion.position.copy(local(0.02, -0.12));
      const th = 22 * Math.PI / 180, dir = [-Math.sin(th), Math.cos(th)], nrm = [Math.cos(th), Math.sin(th)];
      const back = new T.Mesh(new T.BoxGeometry(0.12, 0.8, 0.52), seatMat);
      back.position.copy(local(dir[0] * 0.38 - nrm[0] * 0.17, dir[1] * 0.38 - nrm[1] * 0.17)); back.rotation.z = th;
      const rest = new T.Mesh(new T.BoxGeometry(0.1, 0.22, 0.28), seatMat);
      rest.position.copy(local(dir[0] * 0.86 - nrm[0] * 0.14, dir[1] * 0.86 - nrm[1] * 0.14)); rest.rotation.z = th;
      // dash: the lab car's, or tucked under the windshield base of an imported car
      const dash = new T.Mesh(new T.BoxGeometry(0.55, 0.24, 1.5), std(0x25292f, 0.8));
      dash.position.copy(spec.interior ? local(I.wsA[0] - 0.36, I.wsA[1] - 0.16) : local(0.97, 0.32)).setZ(0);
      const floor = new T.Mesh(new T.BoxGeometry(2.4, 0.03, 1.6), std(0x1d2024, 0.95)); floor.position.copy(local(-0.05, -0.30)).setZ(0);
      const colN = V(I.col[0], I.col[1], 0).normalize();
      steering = new T.Group();
      const rim = new T.Mesh(new T.TorusGeometry(I.rimR, 0.018, 10, 36), std(0x16181b, 0.7));
      rim.quaternion.setFromUnitVectors(ZAXIS, colN);
      const hubM = new T.Mesh(new T.CylinderGeometry(0.07, 0.07, 0.05, 20), std(0x22262b, 0.7));
      hubM.quaternion.setFromUnitVectors(YAXIS, colN);
      steering.add(rim, hubM);
      steering.position.copy(local(I.hub[0], I.hub[1]));
      column = new T.Mesh(new T.CylinderGeometry(0.03, 0.03, 0.42, 12), std(0x22262b, 0.7));
      placeSeg(column, local(I.hub[0], I.hub[1]), local(I.hub[0] - 0.42 * I.col[0], I.hub[1] - 0.42 * I.col[1]), 0.42);
      bag = new T.Mesh(new T.SphereGeometry(1, 24, 16), new T.MeshStandardMaterial({ color: 0xece8de, roughness: 0.85, transparent: true, opacity: 0.93 }));
      bag.position.copy(local(I.hub[0] + I.bagOffset * I.col[0], I.hub[1] + I.bagOffset * I.col[1]));
      bag.rotation.z = Math.atan2(I.col[1], I.col[0]);
      bag.visible = false;
      for (const m of [cushion, back, rest, dash, floor, rim, hubM, column, bag]) { m.castShadow = true; m.receiveShadow = true; }
      interior.add(cushion, back, rest, dash, floor, steering, column, bag);
      const strapMat = std(0x25292e, 0.8);
      for (const name of ['s1', 's2', 's3', 'l1', 'l2', 'l3']) {
        straps[name] = new T.Mesh(new T.BoxGeometry(0.05, 1, 0.008), strapMat);
        interior.add(straps[name]);
      }
      if (curtain) { scene.remove(curtain.mesh); curtain.geo.dispose(); curtain.mesh.material.dispose(); }
      curtain = null;
    }
    function buildDummy() {
      const skin = std(0xe2b33a, 0.55), joint = std(0x2a2b2e, 0.6);
      const mk = (geo, mat, base) => { const m = new T.Mesh(geo, mat.clone()); m.castShadow = true; m.userData.base = base; interior.add(m); return m; };
      dummy.pelvis = mk(new T.BoxGeometry(0.26, 0.17, 0.36), skin);
      dummy.torso = mk(new T.CapsuleGeometry(0.12, 0.4, 6, 14), skin, 0.4);
      dummy.neck = mk(new T.CapsuleGeometry(0.045, 0.1, 4, 10), joint, 0.1);
      dummy.head = mk(new T.SphereGeometry(0.1, 24, 18), new T.MeshStandardMaterial({ map: headTexture(), roughness: 0.5 }));
      dummy.face = mk(new T.BoxGeometry(0.03, 0.08, 0.1), joint);
      for (const s of ['L', 'R']) {
        dummy['upper' + s] = mk(new T.CapsuleGeometry(0.045, 0.24, 4, 10), skin, 0.24);
        dummy['fore' + s] = mk(new T.CapsuleGeometry(0.04, 0.24, 4, 10), skin, 0.24);
        dummy['hand' + s] = mk(new T.SphereGeometry(0.045, 12, 10), joint);
        dummy['thigh' + s] = mk(new T.CapsuleGeometry(0.075, 0.36, 4, 12), skin, 0.36);
        dummy['shin' + s] = mk(new T.CapsuleGeometry(0.055, 0.36, 4, 12), skin, 0.36);
        dummy['foot' + s] = mk(new T.BoxGeometry(0.24, 0.08, 0.1), joint);
      }
    }
    /* pose: { p3: [x, y, z] of the dummy's 15 particles in the H-point frame (occupant.js), bagR,
     *         hub: [dx, dy, dz] the steering wheel hub's move and col: the column's direction (both
     *         optional: column intrusion), belt, curtain, injury: { head, neck, chest } ratios or null } */
    const restQ = (() => {   // each segment's rest orientation, to turn its mesh from
      const R = OC.restPose(), f = segFrames(R);
      return { pelvis: f.pelvis.clone().invert(), torso: f.torso.clone().invert() };
    })();
    function segFrames(P) {
      const p = (i) => V(P[3 * i], P[3 * i + 1], P[3 * i + 2]);
      const basis = (f, u, l) => new T.Quaternion().setFromRotationMatrix(new T.Matrix4().makeBasis(f, u, l));
      // pelvis: across the hips, and up toward the sacrum
      let l = p(PT.HR).sub(p(PT.HL)).normalize(), u = p(PT.SAC).sub(p(PT.HL).add(p(PT.HR)).multiplyScalar(0.5));
      u.addScaledVector(l, -u.dot(l)).normalize();
      const pelvis = basis(V().crossVectors(u, l), u, l);
      // torso: up the spine, across the shoulders
      u = p(PT.T1).sub(p(PT.SAC)).normalize(); l = p(PT.SHR).sub(p(PT.SHL)); l.addScaledVector(u, -l.dot(u)).normalize();
      const torso = basis(V().crossVectors(u, l), u, l);
      return { pelvis, torso };
    }
    function setDummy(p) {
      const P = p.p3, L = (i, dz = 0) => local(P[3 * i], P[3 * i + 1], P[3 * i + 2] + dz);
      const f = segFrames(P), qP = f.pelvis.clone().multiply(restQ.pelvis), qT = f.torso.clone().multiply(restQ.torso);
      const hl = L(PT.HL), hr = L(PT.HR), sac = L(PT.SAC), t1 = L(PT.T1);
      dummy.pelvis.position.copy(hl).add(hr).multiplyScalar(0.5).add(V(-0.03, 0.02, 0).applyQuaternion(qP));
      dummy.pelvis.quaternion.copy(qP);
      // torso: a wide capsule up the spine, turned with the chest
      const tUp = V(0, 1, 0).applyQuaternion(f.torso);
      const ta = sac.clone().addScaledVector(tUp, 0.06), tb = t1.clone().addScaledVector(tUp, -0.05);
      dummy.torso.position.copy(ta).add(tb).multiplyScalar(0.5);
      dummy.torso.quaternion.copy(f.torso);
      dummy.torso.scale.set(1.0, ta.distanceTo(tb) / 0.4, 1.55);
      const oc = L(PT.OC);
      placeSeg(dummy.neck, t1, oc, 0.1);
      const hf = L(PT.HF), hb = L(PT.HB), hc = hf.clone().add(hb).multiplyScalar(0.5);
      const fwd = V().subVectors(hf, hb).normalize(), upv = V().subVectors(hc, oc);
      upv.addScaledVector(fwd, -upv.dot(fwd)).normalize();
      const side = V().crossVectors(fwd, upv).normalize();
      const hq = new T.Quaternion().setFromRotationMatrix(new T.Matrix4().makeBasis(fwd, upv, side));
      dummy.head.position.copy(hc);
      // sphere UVs put u = 0.25 / 0.75 (the target decals) on local +z / -z, i.e. the head's sides
      dummy.head.quaternion.copy(hq);
      dummy.face.position.copy(hc).addScaledVector(fwd, 0.095).addScaledVector(upv, -0.01);
      dummy.face.quaternion.copy(hq);
      // the steering column, moved by intrusion, with the wheel and airbag on it
      const col0 = V(I.col[0], I.col[1], 0).normalize(), col = p.col ? V(p.col[0], p.col[1], p.col[2]).normalize() : col0;
      const hub = local(I.hub[0] + (p.hub ? p.hub[0] : 0), I.hub[1] + (p.hub ? p.hub[1] : 0), p.hub ? p.hub[2] : 0);
      steering.position.copy(hub);
      steering.quaternion.setFromUnitVectors(col0, col);
      placeSeg(column, hub, hub.clone().addScaledVector(col, -0.42), 0.42);
      bag.position.copy(hub).addScaledVector(col, I.bagOffset);
      bag.quaternion.setFromUnitVectors(V(1, 0, 0), col);
      // arms reach for the rim
      const rimUp = V(0, 1, 0).addScaledVector(col, -col.y).normalize(), across = V().crossVectors(col, rimUp).normalize();
      for (const [s, sz] of [['L', -1], ['R', 1]]) {
        const sh = L(sz < 0 ? PT.SHL : PT.SHR);
        const target = hub.clone().addScaledVector(rimUp, 0.11).addScaledVector(col, 0.04).addScaledVector(across, sz * 0.16);
        const { elbow, hand } = twoBone(sh, target, 0.29, 0.29, V(0, -1, sz * 0.8));
        placeSeg(dummy['upper' + s], sh, elbow, 0.24); placeSeg(dummy['fore' + s], elbow, hand, 0.24);
        dummy['hand' + s].position.copy(hand);
        // legs, from the dummy's hips, knees and ankles
        const hip = L(sz < 0 ? PT.HL : PT.HR), knee = L(sz < 0 ? PT.KL : PT.KR), ankle = L(sz < 0 ? PT.AL : PT.AR);
        placeSeg(dummy['thigh' + s], hip, knee, 0.36); placeSeg(dummy['shin' + s], knee, ankle, 0.36);
        dummy['foot' + s].position.copy(ankle).add(V(0.08, -0.03, 0));
      }
      // restraints, along the same paths as the occupant model's belts
      const beltOn = !!p.belt;
      for (const k in straps) straps[k].visible = beltOn;
      if (beltOn) {
        const bp = OC.beltPaths(P, I), Lp = (q) => local(q[0], q[1], q[2]);
        const sp = bp.shoulder.map(Lp), lp = bp.lap.map(Lp);
        sp[1].addScaledVector(V(0, 1, 0).applyQuaternion(f.torso), 0.03);   // over the top of the collarbone
        placeSeg(straps.s1, sp[0], sp[1], 1); placeSeg(straps.s2, sp[1], sp[2], 1); placeSeg(straps.s3, sp[2], sp[3], 1);
        placeSeg(straps.l1, lp[0], lp[1], 1); placeSeg(straps.l2, lp[1], lp[2], 1); placeSeg(straps.l3, lp[2], lp[3], 1);
      }
      bag.visible = p.bagR > 0.005;
      if (bag.visible) bag.scale.set(p.bagR * 0.75, p.bagR * 1.05, p.bagR * 1.15);
      setCurtain(p.curtain || 0);
      // injury heatmap (no flashing; colour plus the results panel text)
      const inj = p.injury, c = new T.Color();
      const tint = (mesh, r) => { if (r == null) mesh.material.color.copy(mesh.userData.orig || (mesh.userData.orig = mesh.material.color.clone())); else { mesh.userData.orig = mesh.userData.orig || mesh.material.color.clone(); mesh.material.color.copy(injuryColor(r, c)); } };
      tint(dummy.head, inj ? inj.head : null);
      tint(dummy.neck, inj ? inj.neck : null);
      tint(dummy.torso, inj ? inj.chest : null);
      tint(dummy.pelvis, inj ? inj.pelvis : null);
    }
    // Side curtain airbag on the driver's side (0 = stowed in the roof rail, 1 = full): a quilted
    // fabric cushion shaped from the car's side windows, unrolling down just inside the glass. Its
    // points are carried by the lattice like the body, so the crushed side pushes it in with the door.
    const CURTAIN = { nu: 56, nv: 14, gap: 0.035, thick: 0.10, below: 0.07 };
    function curtainShape() {
      // the driver-side window band: x range, top and bottom edge at x, the glass surface z(x, y)
      const panes = (spec.parts || []).filter(p => /^BRITTLE_Glass[FRQ]L$/.test(p.name) && p.corners);
      if (panes.length) {
        const pts = [].concat(...panes.map(p => p.corners));
        // least-squares plane z = a + b x + c y through the corners
        const A = [[0, 0, 0], [0, 0, 0], [0, 0, 0]], r = [0, 0, 0];
        for (const [x, y, z] of pts) { const row = [1, x, y]; for (let i = 0; i < 3; i++) { r[i] += row[i] * z; for (let j = 0; j < 3; j++) A[i][j] += row[i] * row[j]; } }
        const det3 = (M) => M[0][0] * (M[1][1] * M[2][2] - M[1][2] * M[2][1]) - M[0][1] * (M[1][0] * M[2][2] - M[1][2] * M[2][0]) + M[0][2] * (M[1][0] * M[2][1] - M[1][1] * M[2][0]);
        const D = det3(A), sol = [0, 1, 2].map(c => det3(A.map((row, i) => row.map((v, j) => j === c ? r[i] : v))) / D);
        // the panes' outlines sliced at x: lowest and highest edge crossing
        const slice = (x) => {
          let lo = Infinity, hi = -Infinity;
          for (const p of panes) {
            const c = p.corners;
            for (let e = 0; e < c.length; e++) {
              const a = c[e], b = c[(e + 1) % c.length];
              if ((x - a[0]) * (x - b[0]) > 0 || a[0] === b[0]) continue;
              const y = a[1] + (b[1] - a[1]) * (x - a[0]) / (b[0] - a[0]);
              lo = Math.min(lo, y); hi = Math.max(hi, y);
            }
          }
          return hi > lo ? [lo, hi] : null;
        };
        const xs = pts.map(p => p[0]);
        return { x0: Math.min(...xs) + 0.01, x1: Math.max(...xs) - 0.01, slice, z: (x, y) => sol[0] + sol[1] * x + sol[2] * y };
      }
      // the procedural car: its side glass band (see buildCar)
      const L = P.CAR.length;
      return { x0: 0.97 - L / 2, x1: 3.18 - L / 2, slice: (x) => [1.0, P.topHeight(x + L / 2) - 0.04], z: (x, y) => -halfWidth(x + L / 2, y) };
    }
    function buildCurtain() {
      const S = curtainShape(), nu = CURTAIN.nu, nv = CURTAIN.nv, per = nu * nv;
      // window top and bottom per column, the gaps between panes (pillars) filled in
      const cols = [];
      for (let i = 0; i < nu; i++) { const x = S.x0 + (S.x1 - S.x0) * i / (nu - 1); cols.push({ x, s: S.slice(x) }); }
      for (let i = 0; i < nu; i++) if (!cols[i].s) {
        let a = i - 1, b = i + 1;
        while (a >= 0 && !cols[a].s) a--;
        while (b < nu && !cols[b].s) b++;
        const sa = a >= 0 ? cols[a].s : cols[b].s, sb = b < nu ? cols[b].s : sa, w = a >= 0 && b < nu ? (i - a) / (b - a) : 0;
        cols[i].s = [sa[0] + (sb[0] - sa[0]) * w, sa[1] + (sb[1] - sa[1]) * w];
      }
      const geo = new T.BufferGeometry(), pos = new Float32Array(3 * 2 * per), idx = [];
      for (let f = 0; f < 2; f++) for (let i = 0; i < nu - 1; i++) for (let j = 0; j < nv - 1; j++) {
        const a = f * per + i * nv + j, b = a + nv;
        if (f) idx.push(a, a + 1, b, b, a + 1, b + 1); else idx.push(a, b, a + 1, b, b + 1, a + 1);
      }
      geo.setAttribute('position', new T.BufferAttribute(pos, 3).setUsage(T.DynamicDrawUsage));
      const uv = new Float32Array(2 * 2 * per);
      for (let f = 0; f < 2; f++) for (let i = 0; i < nu; i++) for (let j = 0; j < nv; j++) { const o = 2 * (f * per + i * nv + j); uv[o] = cols[i].x / 0.06; uv[o + 1] = j / (nv - 1) * 0.5 / 0.06; }
      geo.setAttribute('uv', new T.BufferAttribute(uv, 2));
      geo.setIndex(idx);
      // light nylon with a faint weave
      const weave = canvasTexture(64, 64, (c, w, h) => {
        c.fillStyle = '#f1efe9'; c.fillRect(0, 0, w, h);
        for (let k = 0; k < w; k += 2) { c.fillStyle = k % 4 ? 'rgba(0,0,0,0.035)' : 'rgba(255,255,255,0.05)'; c.fillRect(k, 0, 1, h); c.fillRect(0, k, w, 1); }
      }, [1, 1]);
      const mat = new T.MeshStandardMaterial({ color: 0xffffff, map: weave, roughness: 0.78, metalness: 0, side: T.DoubleSide });
      const mesh = new T.Mesh(geo, mat);
      mesh.castShadow = true; mesh.receiveShadow = true; mesh.frustumCulled = false; mesh.matrixAutoUpdate = false;
      mesh.visible = false;
      scene.add(mesh);
      const nCh = Math.max(4, Math.round((S.x1 - S.x0) / 0.2));
      return { mesh, geo, pos, S, cols, nu, nv, per, nCh, idx8: new Int32Array(8), tt: new Float64Array(3), pa: [0, 0, 0], pb: [0, 0, 0], v: V(), spec };
    }
    function setCurtain(f) {
      if (!f && !curtain) return;
      if (!curtain || curtain.spec !== spec) { if (curtain) { scene.remove(curtain.mesh); curtain.geo.dispose(); curtain.mesh.material.dispose(); } curtain = buildCurtain(); }
      const C = curtain;
      C.mesh.visible = f > 0.01 && visible;
      if (!C.mesh.visible) return;
      const unroll = Math.min(1, f * 1.3), infl = Math.max(0, Math.min(1, (f - 0.08) / 0.92)), e = 0.01;
      const lat = carModel, M = interior.matrix;
      for (let i = 0; i < C.nu; i++) {
        const u = i / (C.nu - 1), x = C.cols[i].x, [yb, yt] = C.cols[i].s;
        const top = yt - 0.012, bot = yb - CURTAIN.below;
        const tube = Math.pow(Math.abs(Math.sin(Math.PI * u * C.nCh)), 0.6);
        for (let j = 0; j < C.nv; j++) {
          const v = j / (C.nv - 1), y = top - (top - bot) * v * unroll;
          const T0 = CURTAIN.thick * infl * tube * Math.pow(Math.sin(Math.PI * v), 0.5);
          // inward normal of the glass surface (toward +z, the car's centre)
          const z = C.S.z(x, y), dzx = (C.S.z(x + e, y) - C.S.z(x - e, y)) / (2 * e), dzy = (C.S.z(x, y + e) - C.S.z(x, y - e)) / (2 * e);
          const nl = Math.hypot(dzx, dzy, 1), nx = -dzx / nl, ny = -dzy / nl, nz = 1 / nl;
          for (let face = 0; face < 2; face++) {
            const d = CURTAIN.gap + (face ? T0 : -0.25 * T0), lx = x + nx * d, ly = y + ny * d, lz = z + nz * d, o = 3 * (face * C.per + i * C.nv + j);
            if (deformed) {
              P.embedPoint(lat, lx, ly, lz, C.idx8, 0, C.tt, 0, null);
              P.embeddedPos(deformed.X, C.idx8, 0, C.tt, 0, C.pa);
              if (deformed.X2 && deformed.s > 0) { P.embeddedPos(deformed.X2, C.idx8, 0, C.tt, 0, C.pb); for (let k = 0; k < 3; k++) C.pa[k] += (C.pb[k] - C.pa[k]) * deformed.s; }
              C.pos[o] = C.pa[0]; C.pos[o + 1] = C.pa[1]; C.pos[o + 2] = C.pa[2];
            } else {
              C.v.set(lx, ly, lz).applyMatrix4(M);
              C.pos[o] = C.v.x; C.pos[o + 1] = C.v.y; C.pos[o + 2] = C.v.z;
            }
          }
        }
      }
      C.geo.attributes.position.needsUpdate = true;
      C.geo.computeVertexNormals();
    }
    function onboardPose(cam) {
      cam.position.copy(local(0.18, 0.5, 1.65 * onboardSide)).applyMatrix4(interior.matrix);
      cam.up.copy(ctx.u);
      cam.lookAt(local(0.2, 0.42, 0).applyMatrix4(interior.matrix));
    }

    // -------------------------------------------------------------- vehicle choice
    // Switches the car shown and the lattice it is skinned to; rebuilds the interior around the
    // new H-point. Imported models are parsed once per slot and kept.
    async function setVehicle(key) {
      const sp = Veh.get(key);
      if (sp === spec && (key === 'lab' ? !imported : imported && imported.key === key)) return;
      spec = sp;
      HP = sp.hPoint; I = OC.interiorFor(sp.interior);
      let next = null;
      if (key !== 'lab') {
        if (!importedCache[key]) importedCache[key] = CarModels.create(key, sp, P.buildCar(sp.massKg, 'standard', sp), renderer);
        next = await importedCache[key];
        if (spec !== sp) return;          // switched again while loading
      }
      if (imported) imported.group.visible = false;
      imported = next;
      carModel = next ? next.lat : labLattice;
      carRig.visible = !next && visible;
      if (next) {
        if (!next.group.parent) scene.add(next.group);
        next.group.visible = visible;
        next.setStrainMode(strainMode); next.setXray(xray);
      }
      scene.remove(interior);
      interior.traverse((o) => { if (o.isMesh) { o.geometry.dispose(); o.material.dispose(); } });
      for (const k in dummy) delete dummy[k];
      for (const k in straps) delete straps[k];
      buildInterior(); buildDummy();
    }
    function setVisible(on) {
      visible = on;
      carRig.visible = on && !imported;
      if (imported) imported.group.visible = on;
      interior.visible = on;
      if (curtain && !on) curtain.mesh.visible = false;
    }

    buildCar(); buildInterior(); buildDummy();
    labLattice = carModel;
    return {
      ctx, setCarRigid, setCarDeformed, setCabinFrame, setDummy, setVehicle, setVisible, onboardPose,
      setOnboardSide(sd) { onboardSide = sd; },
      applyStrainMode, applyXray,
      // destruction of an imported car during playback (see CarModels)
      setDestruction(result) { if (imported && result && result.vehicle === imported.key) imported.prepareDestruction(result); },
      updateDestruction(t, k, k2, s) { if (imported) imported.updateDestruction(t, k, k2, s); },
      // windshield hits from the occupant model: { t, mag, p: car-local point }
      setHeadStrikes(list) { if (imported) imported.setHeadStrikes(list); },
      local, get interior() { return interior; }, get hPoint() { return HP; }, get spec() { return spec; },
      get vehicleModel() { return imported; }, get lattice() { return carModel; }, get visible() { return visible; },
    };
  }
  function createSlot() { const s = makeSlot(); slots.push(s); s.applyStrainMode(); s.applyXray(); return s; }

  function setStrainMode(on) { strainMode = on; for (const s of slots) s.applyStrainMode(); }
  function setXray(on) { xray = on; for (const s of slots) s.applyXray(); }

  // ---------------------------------------------------------------- cameras + render
  // The free camera orbits with the mouse and follows the car (or the point setFollow gives): each
  // frame it moves by as much as the followed point did, so the view the viewer chose is kept.
  // opts: f0 (approach direction), frame { pos, target } to start from, or from: a tracking
  // view's name ('side', 'front', 'quarter', 'chase') to start from.
  function setCameraMode(mode, opts = {}) {
    const ctx = main.ctx;
    if (mode !== camMode) camInit = false;
    camMode = mode;
    controls.enabled = mode === 'setup' || mode === 'free';
    camera.up.set(0, 1, 0);
    if (opts.f0) { ctx.f0.copy(opts.f0); ctx.l0.set(-opts.f0.z, 0, opts.f0.x); }
    camera.layers.set(0); camera.layers.enable(2);
    if (mode !== 'onboard') camera.layers.enable(1);
    if (mode === 'free') {
      followAt = followPoint().clone();
      if (opts.from) { const v = trackView(opts.from); camera.position.copy(v.pos); controls.target.copy(v.look); }
      else if (!opts.frame) controls.target.copy(followAt);
      controls.update();
    }
    if (opts.frame) { camera.position.copy(opts.frame.pos); controls.target.copy(opts.frame.target); controls.update(); }
  }
  function setFollow(fn) { follow = fn || null; if (camMode === 'free') followAt = followPoint().clone(); }
  function followPoint() { return follow ? follow() : main.ctx.o; }
  // camera position and aim of the tracking views, from the main car's cabin frame
  function trackView(name) {
    const ctx = main.ctx, o = ctx.o;
    switch (name) {
      case 'chase': return { pos: o.clone().addScaledVector(ctx.f, -9).add(V(0, 3.2, 0)), look: o.clone().addScaledVector(ctx.f, 5).add(V(0, 0.6, 0)) };
      case 'front': return { pos: o.clone().addScaledVector(ctx.l0, -6).addScaledVector(ctx.f0, 0.6).add(V(0, 2.6, 0)), look: o.clone().addScaledVector(ctx.f0, 1.2) };
      case 'quarter': return { pos: o.clone().addScaledVector(ctx.l0, -6.4).addScaledVector(ctx.f0, 1.4).add(V(0, 2.3, 0)), look: o.clone().addScaledVector(ctx.f0, 0.9).add(V(0, 0.35, 0)) };
      case 'top': return { pos: o.clone().add(V(0, 13, 0)).addScaledVector(ctx.f0, -0.01), look: o.clone() };
      default: return { pos: o.clone().addScaledVector(ctx.l0, -7.5).add(V(0, 0.9, 0)), look: o.clone().add(V(0, 0.3, 0)) };   // side
    }
  }
  function updateCamera(dt) {
    const ctx = main.ctx;
    const k = camInit ? 1 - Math.exp(-dt * 5) : 1;
    camInit = true;
    let pos = null, look = null;
    switch (camMode) {
      case 'chase': case 'side': case 'front':
        ({ pos, look } = trackView(camMode)); break;
      case 'top':
        camera.up.copy(ctx.f0);
        ({ pos, look } = trackView('top')); break;
      case 'onboard':
        main.onboardPose(camera); return;
      case 'free': {
        // follow the point, smoothed like the tracking views so the crash's shaking doesn't shake the view
        const p = followPoint();
        if (!followAt) followAt = p.clone();
        const before = followAt.clone();
        followAt.lerp(p, k);
        const d = followAt.clone().sub(before);
        camera.position.add(d); controls.target.add(d);
        controls.update(); return;
      }
      default:
        controls.update(); return;
    }
    if (!camSmoothed || k === 1) camSmoothed = { pos: pos.clone(), look: look.clone() };
    camSmoothed.pos.lerp(pos, k); camSmoothed.look.lerp(look, k);
    camera.position.copy(camSmoothed.pos);
    camera.lookAt(camSmoothed.look);
  }
  // Camera shake, set by the replay every frame (cinematic.js): an amount (1 is strong), the replay
  // time, which drives the wobble so it slows down in slow motion, and the world direction of the
  // deceleration, along which most of it goes. Off when the viewer prefers reduced motion.
  const shk = { on: !(window.matchMedia && matchMedia('(prefers-reduced-motion: reduce)').matches), amp: 0, target: 0, t: 0, dir: V(1, 0, 0), off: V(), roll: 0 };
  function setShake(amount, t, dir) {
    shk.target = shk.on ? Math.max(0, amount) : 0; shk.t = t || 0;
    if (dir) shk.dir.set(dir[0], 0, dir[2]).normalize();
  }
  // a smooth wobble in -1..1 (three incommensurate sines), at replay time t
  const wob = (t, ph) => (Math.sin(2 * Math.PI * 23 * t + ph) + 0.6 * Math.sin(2 * Math.PI * 37 * t + 2.1 * ph) + 0.35 * Math.sin(2 * Math.PI * 61 * t + 3.7 * ph)) / 1.95;
  function applyShake(dt) {
    shk.amp += (shk.target - shk.amp) * (1 - Math.exp(-dt * 10));
    if (shk.amp < 0.002 || camMode === 'onboard') return false;
    const look = camMode === 'free' || camMode === 'setup' ? controls.target : (camSmoothed ? camSmoothed.look : main.ctx.o);
    const a = shk.amp * 0.010 * camera.position.distanceTo(look), side = V().crossVectors(shk.dir, UP);
    shk.off.copy(shk.dir).multiplyScalar(a * wob(shk.t, 0)).addScaledVector(side, 0.45 * a * wob(shk.t, 1.3)).addScaledVector(UP, 0.35 * a * wob(shk.t, 2.9));
    shk.roll = 0.014 * shk.amp * wob(shk.t, 4.4);
    camera.position.add(shk.off); camera.rotateZ(shk.roll);
    return true;
  }
  // Bloom: a glow around fire, embers and hot sparks. Their glow twins (layer 3) are drawn into a
  // half-size buffer over the solid scene drawn in black, so the car and barrier hide what is behind
  // them; that is blurred down a chain of ever smaller buffers and back up (dual-filter blur) and
  // added on top of the frame. Runs only while something glows.
  let bloom = null;
  function buildBloom() {
    const VS = 'varying vec2 vUv; void main() { vUv = uv; gl_Position = vec4(position.xy, 0.0, 1.0); }';
    const mat = (fs, additive) => new T.ShaderMaterial({ vertexShader: VS, fragmentShader: fs, depthTest: false, depthWrite: false,
      uniforms: { src: { value: null }, texel: { value: new T.Vector2() }, strength: { value: 1 } }, blending: additive ? T.AdditiveBlending : T.NoBlending, transparent: !!additive });
    const DOWN = `uniform sampler2D src; uniform vec2 texel; varying vec2 vUv;
      void main() { gl_FragColor = (4.0 * texture2D(src, vUv) + texture2D(src, vUv - texel) + texture2D(src, vUv + texel)
        + texture2D(src, vUv + vec2(texel.x, -texel.y)) + texture2D(src, vUv - vec2(texel.x, -texel.y))) / 8.0; }`;
    const UP = `uniform sampler2D src; uniform vec2 texel; uniform float strength; varying vec2 vUv;
      void main() { vec2 t = texel;
        vec4 s = texture2D(src, vUv + vec2(-2.0 * t.x, 0.0)) + texture2D(src, vUv + vec2(2.0 * t.x, 0.0)) + texture2D(src, vUv + vec2(0.0, 2.0 * t.y)) + texture2D(src, vUv + vec2(0.0, -2.0 * t.y))
          + 2.0 * (texture2D(src, vUv + vec2(-t.x, t.y)) + texture2D(src, vUv + t) + texture2D(src, vUv + vec2(t.x, -t.y)) + texture2D(src, vUv - t));
        gl_FragColor = vec4(s.rgb / 12.0 * strength, 1.0); }`;
    const quad = new T.Mesh(new T.PlaneGeometry(2, 2));
    quad.frustumCulled = false;
    return { quad, cam: new T.OrthographicCamera(-1, 1, 1, -1, 0, 1), down: mat(DOWN), up: mat(UP, true), black: new T.MeshBasicMaterial({ color: 0x000000 }),
      glow: null, levels: [], w: 0, h: 0, swap: [] };
  }
  function bloomPass(B, m, src, dst) {
    m.uniforms.src.value = src.texture; m.uniforms.texel.value.set(1 / src.width, 1 / src.height);
    B.quad.material = m;
    renderer.setRenderTarget(dst);
    renderer.render(B.quad, B.cam);
  }
  function renderBloom(w, h) {
    if (!scene.children.some(o => o.visible && o.layers.mask === 8)) return;
    const B = bloom || (bloom = buildBloom()), pr = renderer.getPixelRatio();
    const W = Math.max(8, Math.round(w * pr / 2)), H = Math.max(8, Math.round(h * pr / 2));
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
    // the solid scene in black (car bodies in a black that deforms with them; overlays left out)
    scene.background = null; scene.fog = null;
    camera.layers.set(0); camera.layers.enable(1);
    const sw = B.swap; sw.length = 0;
    scene.traverseVisible(o => {
      if (!o.isMesh && !o.isLine) return;
      if (o.material.transparent && !o.material.depthWrite) { sw.push(o, null); o.visible = false; return; }
      sw.push(o, o.material); o.material = o.userData.blackMat || B.black;
    });
    renderer.render(scene, camera);
    for (let i = 0; i < sw.length; i += 2) { if (sw[i + 1]) sw[i].material = sw[i + 1]; else sw[i].visible = true; }
    // what glows, hidden where the scene is in front of it
    camera.layers.set(3);
    renderer.render(scene, camera);
    camera.layers.mask = mask; scene.background = bg; scene.fog = fog;
    // blur down, then back up adding each level, then add onto the frame
    let src = B.glow;
    for (const L of B.levels) { bloomPass(B, B.down, src, L); src = L; }
    B.up.uniforms.strength.value = 1;
    for (let i = B.levels.length - 1; i > 0; i--) bloomPass(B, B.up, B.levels[i], B.levels[i - 1]);
    B.up.uniforms.strength.value = 1.1;
    renderer.setViewport(0, 0, w, h);
    bloomPass(B, B.up, B.levels[0], null);
    renderer.setClearColor(clear, clearA); renderer.autoClear = autoClear; renderer.shadowMap.autoUpdate = shadows;
  }
  function render(dt, showPip, bottomInset) {
    updateCamera(dt);
    const shaking = applyShake(dt);
    FX.listen(camera.position, camera.getWorldDirection(V()), camera.up);
    const ctx = main.ctx;
    // Keep the shadow frustum on the action, snapped to whole shadow-map texels in the light's
    // own frame; sliding it by fractions of a texel every frame makes shadows shimmer.
    const L = SUN_OFFSET.clone().normalize(), right = V().crossVectors(UP, L).normalize(), up2 = V().crossVectors(L, right);
    const texel = (sun.shadow.camera.right - sun.shadow.camera.left) / sun.shadow.mapSize.x;
    const snap = (v) => Math.round(v / texel) * texel;
    const c = V().addScaledVector(right, snap(ctx.o.dot(right))).addScaledVector(up2, snap(ctx.o.dot(up2))).addScaledVector(L, ctx.o.dot(L));
    sun.target.position.copy(c); sun.position.copy(c).add(SUN_OFFSET);
    const { w, h } = viewSize(), pr = renderer.getPixelRatio();
    particles.setScale(pr * h / (2 * Math.tan(camera.fov * Math.PI / 360)));
    renderer.setScissorTest(false);
    renderer.setViewport(0, 0, w, h);
    renderer.render(scene, camera);
    renderBloom(w, h);
    if (shaking) { camera.rotateZ(-shk.roll); camera.position.sub(shk.off); }
    pipRect = null;
    if (showPip && camMode !== 'onboard') {
      // on a short screen (a phone held sideways) no taller than about a quarter of it
      const pw = Math.round(Math.min(360, w * 0.28, h < 600 ? h * 0.25 / 0.75 : Infinity)), ph = Math.round(pw * 0.75), px = 12, py = (bottomInset || 0) + 12;
      main.onboardPose(pipCam);
      pipCam.aspect = pw / ph; pipCam.updateProjectionMatrix();
      renderer.setScissorTest(true);
      renderer.setScissor(px, py, pw, ph); renderer.setViewport(px, py, pw, ph);
      renderer.render(scene, pipCam);
      renderer.setScissorTest(false);
      pipRect = { left: px, top: h - py - ph, width: pw, height: ph };
    }
  }

  return {
    init, resize, setFixedSize, render, setPath, setBarrier, setBricks, resetBricks,
    setCarRigid: (...a) => main.setCarRigid(...a), setCarDeformed: (...a) => main.setCarDeformed(...a), setCabinFrame: (...a) => main.setCabinFrame(...a),
    setVehicle: (key) => main.setVehicle(key),
    setDestruction: (r) => main.setDestruction(r), updateDestruction: (...a) => main.updateDestruction(...a), setHeadStrikes: (l) => main.setHeadStrikes(l),
    setDummy: (p) => main.setDummy(p), setStrainMode, setXray, setCameraMode, setFollow, createSlot, setShake,
    get shakeEnabled() { return shk.on; }, set shakeEnabled(on) { shk.on = on; if (!on) shk.target = 0; },
    get main() { return main; }, get slots() { return slots; },
    get particles() { return particles; }, get pipRect() { return pipRect; }, get cabin() { return main.ctx; },
    get vehicleModel() { return main.vehicleModel; }, get renderer() { return renderer; }, get scene() { return scene; },
    get camera() { return camera; }, get controls() { return controls; }, get camMode() { return camMode; },
    get hPoint() { return main.hPoint; },
    get wallLayout() { return wallLayout; },
    onAngleDrag(fn) { onAngleDrag = fn; },
    canvasTexture,
  };
})();
