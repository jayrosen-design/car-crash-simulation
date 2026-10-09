/* The Hurricane Brawl game's 3D view (three.js): the Earth, the storms, their moves and the damage.
 *
 *   the Earth    one sphere with a texture made here from the land mask and the climate (sea by
 *                depth near the coast, land by terrain, with noise), lit by a sun that goes round
 *                once every two minutes; city lights at night, the sun's glint on the sea, a rim of
 *                atmosphere; a thin cloud layer; and a damage layer (1° cells, tinted by the storm
 *                type that did it: floods, torn ground, frost, dust, burn scars)
 *   the cities   points, bigger for bigger cities, glowing warm at night, turning red and dark as
 *                they are wrecked, flashing when hit
 *   the storms   discs bent onto the sphere with a swirling-cloud shader (spiral arms, an eye,
 *                differential rotation, counter-clockwise in the north and clockwise in the south),
 *                a tornado's funnel and wall cloud, a supercell's anvil and flashes, a fire front
 *                with its smoke, and swirling particles (debris, snow, dust, embers); a ring in each
 *                storm's colour round it, and its track over the last 90 s
 *   the moves    the surge's ring, the whiteout, the dust wall, lightning bolts, fire on the ground;
 *                arcs between brawling storms, sparks on hits, a burst on a KO; the energy orbs
 *   the camera   above your storm, tilted toward where "up" on the screen points (game.js moves it);
 *                shake on hits; bloom on the bright parts (?bloom=0 turns it off)
 * Shaders: one for all the discs, one for rings, one for walls, one for particles, one for funnels,
 * so every storm uses the same few programs.
 */
const BrawlRender = (() => {
  'use strict';
  const T = THREE, E = BrawlEarth, S = BrawlStorms, R = E.R;
  const q = new URLSearchParams(location.search);
  const v3 = (p) => new T.Vector3(p[0], p[1], p[2]);

  const NOISE = `
    float hash(vec2 p) { p = fract(p * vec2(123.34, 456.21)); p += dot(p, p + 45.32); return fract(p.x * p.y); }
    float vnoise(vec2 p) { vec2 i = floor(p), f = fract(p); vec2 u = f * f * (3.0 - 2.0 * f);
      return mix(mix(hash(i), hash(i + vec2(1.0, 0.0)), u.x), mix(hash(i + vec2(0.0, 1.0)), hash(i + vec2(1.0, 1.0)), u.x), u.y); }
    float fbm(vec2 p) { float s = 0.0, a = 0.5; for (int i = 0; i < 4; i++) { s += a * vnoise(p); p = p * 2.03 + 17.1; a *= 0.5; } return s; }
  `;
  // a mesh laid out at a point on the globe (local x and z along the surface, y up), bent onto the
  // sphere: each vertex goes out from the centre to 1 + uLift + y * uHeight
  const WRAP_VERT = `
    uniform float uLift, uHeight;
    varying vec2 vUv; varying vec3 vWN; varying float vY;
    void main() {
      vUv = uv; vY = position.y;
      vec4 w = modelMatrix * vec4(position.x, 0.0, position.z, 1.0);
      vec3 n = normalize(w.xyz);
      vWN = n;
      gl_Position = projectionMatrix * viewMatrix * vec4(n * (1.0 + uLift + position.y * uHeight), 1.0);
    }`;
  // swirling cloud (or dust, or fire) with spiral arms and an eye
  const DISC_FRAG = `
    uniform float uTime, uSpin, uArms, uTwist, uEye, uSolid, uAlpha, uDir, uSeed, uFlash, uGlow, uRing;
    uniform vec3 uColA, uColB, uSun;
    varying vec2 vUv; varying vec3 vWN;
    ${NOISE}
    float swirl(float a, float r, float lt) {
      float sa = uDir * a - uSpin * lt / (0.3 + r);
      vec2 sw = vec2(cos(sa), sin(sa)) * r;
      return fbm(sw * 3.0 + uSeed) * 0.65 + fbm(sw * 7.0 + uSeed * 1.7) * 0.35;
    }
    void main() {
      vec2 q = vUv * 2.0 - 1.0; float r = length(q);
      if (r > 1.0) discard;
      float a = atan(q.y, q.x);
      float ra = uDir * a - uSpin * uTime * 0.6;
      float arms = pow(0.5 + 0.5 * cos(uArms * (ra + uTwist * log(r + 0.03))), 1.6);
      // two layers of differentially rotating noise, each restarting while the other is shown
      float P = 5.0, f1 = fract(uTime / P), f2 = fract(uTime / P + 0.5);
      float n = mix(swirl(a, r, f1 * P), swirl(a, r, f2 * P + 1.7), abs(f1 * 2.0 - 1.0));
      float dens = mix(arms, 1.0, uSolid) * (0.3 + 0.95 * n);
      dens *= smoothstep(1.0, 0.5, r);
      if (uEye > 0.0) { dens *= smoothstep(uEye * 0.5, uEye * 1.05, r); dens += 0.7 * exp(-pow((r - uEye * 1.25) / 0.07, 2.0)); }
      if (uRing > 0.0) dens *= mix(0.2, 1.0, smoothstep(uRing - 0.3, uRing, r));
      dens = clamp(dens, 0.0, 1.0);
      vec3 col = mix(uColB, uColA, smoothstep(0.25, 0.95, dens));
      float lit = 0.32 + 0.9 * smoothstep(-0.2, 0.45, dot(vWN, uSun));
      col *= mix(lit, 1.0 + 1.6 * dens, uGlow);
      col += uFlash * vec3(0.75, 0.82, 1.0) * dens * 2.2;
      gl_FragColor = vec4(col, dens * uAlpha);
      #include <tonemapping_fragment>
      #include <colorspace_fragment>
    }`;
  // a ring: uWidth wide at the edge, with a softer inside; a notch of light toward local +z (ahead)
  const RING_FRAG = `
    uniform float uTime, uAlpha, uWidth, uFill, uNotch, uDash;
    uniform vec3 uColor;
    varying vec2 vUv;
    void main() {
      vec2 q = vUv * 2.0 - 1.0; float r = length(q);
      if (r > 1.0) discard;
      float a = atan(q.y, q.x);
      float band = exp(-pow((r - (1.0 - uWidth)) / uWidth, 2.0));
      if (uDash > 0.0) band *= 0.55 + 0.45 * step(0.0, sin(a * uDash + uTime * 2.0));
      float notch = uNotch * exp(-pow((a + 1.5708) / 0.18, 2.0)) * smoothstep(0.6, 1.0, r);
      float k = band + uFill * smoothstep(1.0 - uWidth, 0.0, r) * 0.35 + notch;
      gl_FragColor = vec4(uColor * (1.0 + notch), clamp(k, 0.0, 1.0) * uAlpha);
      #include <tonemapping_fragment>
      #include <colorspace_fragment>
    }`;
  // a wall of dust (the haboob, a sandstorm's front): x across, y up
  const WALL_FRAG = `
    uniform float uTime, uAlpha, uSeed;
    uniform vec3 uColA, uColB, uSun;
    varying vec2 vUv; varying vec3 vWN; varying float vY;
    ${NOISE}
    void main() {
      float n = fbm(vec2(vUv.x * 9.0 + uSeed, vY * 3.0 - uTime * 0.8)) * 0.7 + fbm(vec2(vUv.x * 23.0, vY * 7.0 - uTime * 1.6)) * 0.3;
      float edge = smoothstep(0.0, 0.18, vUv.x) * smoothstep(1.0, 0.82, vUv.x);
      float dens = clamp((n * 1.3 - vY * 0.9) * edge, 0.0, 1.0);
      float lit = 0.35 + 0.85 * smoothstep(-0.2, 0.45, dot(vWN, uSun));
      gl_FragColor = vec4(mix(uColB, uColA, n) * lit, dens * uAlpha);
      #include <tonemapping_fragment>
      #include <colorspace_fragment>
    }`;
  // a tornado's funnel (or a supercell's rain shaft): a cone, twisted and swaying
  const FUNNEL_VERT = `
    uniform float uTime, uSway;
    varying vec3 vL; varying vec3 vWN; varying vec3 vN; varying vec3 vView;
    void main() {
      vec3 p = position;
      p.x += sin(uTime * 1.3 + p.y * 3.0) * uSway * p.y;
      p.z += cos(uTime * 1.1 + p.y * 2.5) * uSway * p.y;
      vL = position;
      vec4 w = modelMatrix * vec4(p, 1.0);
      vWN = normalize(w.xyz);
      vN = normalize(mat3(modelMatrix) * normal);
      vView = normalize(cameraPosition - w.xyz);
      gl_Position = projectionMatrix * viewMatrix * w;
    }`;
  const FUNNEL_FRAG = `
    uniform float uTime, uAlpha, uSpeed;
    uniform vec3 uColA, uColB, uSun;
    varying vec3 vL; varying vec3 vWN; varying vec3 vN; varying vec3 vView;
    ${NOISE}
    void main() {
      float th = atan(vL.z, vL.x);
      float n = fbm(vec2(th * 2.0 + uTime * uSpeed - vL.y * 4.0, vL.y * 5.0 - uTime * 1.5));
      float edge = 0.45 + 0.55 * (1.0 - abs(dot(normalize(vN), vView)));
      float a = smoothstep(0.0, 0.04, vL.y) * smoothstep(1.0, 0.85, vL.y) * (0.6 + 0.6 * n) * edge;
      float lit = 0.35 + 0.8 * smoothstep(-0.2, 0.45, dot(vWN, uSun));
      gl_FragColor = vec4(mix(uColB, uColA, n) * lit, clamp(a, 0.0, 1.0) * uAlpha);
      #include <tonemapping_fragment>
      #include <colorspace_fragment>
    }`;
  // particles swirling round a storm (debris, snow, dust, embers), moved on the GPU
  const PART_VERT = `
    attribute vec4 aP;    // angle, radius (0-1), height (0-1), phase
    uniform float uTime, uSpin, uDir, uRise, uSize, uPx;
    uniform vec2 uScale;  // radius, height (globe units)
    varying float vA;
    void main() {
      float t = uTime + aP.w * 7.0;
      float ang = aP.x + uDir * uSpin * t / (0.3 + aP.y);
      float h = uRise == 0.0 ? aP.z : fract(aP.z + t * 0.12 * uRise);
      vec3 p = vec3(cos(ang) * aP.y * uScale.x, h * uScale.y, -sin(ang) * aP.y * uScale.x);
      vec4 mv = modelViewMatrix * vec4(p, 1.0);
      gl_Position = projectionMatrix * mv;
      gl_PointSize = uSize * uPx * (0.6 + aP.w * 0.8) / -mv.z;
      vA = uRise == 0.0 ? 1.0 : smoothstep(0.0, 0.1, h) * (1.0 - h);
    }`;
  const PART_FRAG = `
    uniform vec3 uColor; uniform float uAlpha;
    varying float vA;
    void main() {
      float d = length(gl_PointCoord - 0.5);
      if (d > 0.5) discard;
      gl_FragColor = vec4(uColor, smoothstep(0.5, 0.1, d) * vA * uAlpha);
      #include <tonemapping_fragment>
      #include <colorspace_fragment>
    }`;

  const DISC_GEO = new T.RingGeometry(0, 1, 96, 14).rotateX(-Math.PI / 2);
  const RING_GEO = new T.RingGeometry(0, 1, 160, 6).rotateX(-Math.PI / 2);
  const FUNNEL_GEO = new T.CylinderGeometry(1, 0.1, 1, 36, 24, true).translate(0, 0.5, 0);
  const SHAFT_GEO = new T.CylinderGeometry(1, 0.85, 1, 28, 8, true).translate(0, 0.5, 0);
  const WALL_GEO = (() => {
    // x from -1 to 1 (48 columns), y from 0 to 1 (6 rows); uv.x along it
    const g = new T.PlaneGeometry(2, 1, 48, 6).translate(0, 0.5, 0);
    return g;
  })();
  const color = (c) => new T.Color(c);
  const lin = (r, g, b) => new T.Color().setRGB(r, g, b, T.SRGBColorSpace);

  function create(container) {
    const renderer = new T.WebGLRenderer({ antialias: true, powerPreference: 'high-performance' });
    renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
    renderer.setSize(container.clientWidth, container.clientHeight);
    renderer.outputColorSpace = T.SRGBColorSpace;
    renderer.toneMapping = T.ACESFilmicToneMapping;
    renderer.toneMappingExposure = 1.05;
    container.appendChild(renderer.domElement);
    const scene = new T.Scene();
    scene.background = new T.Color(0x02040a);
    const camera = new T.PerspectiveCamera(45, container.clientWidth / container.clientHeight, 0.005, 200);
    camera.position.set(0, 0, 3.2);
    const uTime = { value: 0 }, uSun = { value: new T.Vector3(1, 0.3, 0.4).normalize() };
    const uPx = { value: 1 };

    // ---------------------------------------------------------------- the Earth's texture
    const W = E.MW, H = E.MH;
    const day = new Uint8Array(W * H * 4), sea = new Uint8Array(E.TW * E.TH * 4), mapImg = new Uint8ClampedArray(E.TW * E.TH * 4);
    {
      // a periodic value noise (period px across), for texture
      const lattice = new Float32Array(256 * 128);
      const rnd = E.rng(7);
      for (let i = 0; i < lattice.length; i++) lattice[i] = rnd();
      const noise = (x, y, f) => {
        const X = x * f, Y = y * f, ix = Math.floor(X), iy = Math.floor(Y), fx = X - ix, fy = Y - iy;
        const px = Math.round(256 * f);
        const L = (a, b) => lattice[((b % 128 + 128) % 128) * 256 + ((a % px + px) % px) % 256];
        const ux = fx * fx * (3 - 2 * fx), uy = fy * fy * (3 - 2 * fy);
        return (L(ix, iy) * (1 - ux) + L(ix + 1, iy) * ux) * (1 - uy) + (L(ix, iy + 1) * (1 - ux) + L(ix + 1, iy + 1) * ux) * uy;
      };
      // x, y in 0-256 / 0-128 lattice units over the globe
      const fbm = (x, y) => noise(x, y, 0.25) * 0.5 + noise(x, y, 0.5) * 0.25 + noise(x, y, 1) * 0.15 + noise(x, y, 2) * 0.1;
      // the colours blend smoothly from one terrain to the next, along borders warped by noise
      // (the climate's boxes would otherwise show as straight lines)
      const C = {
        jungle: [30, 74, 34], green: [80, 114, 56], dry: [146, 134, 86], desert: [208, 172, 118], dune: [180, 132, 84],
        taiga: [52, 76, 52], tundra: [102, 106, 86], ice: [234, 240, 246],
        tropicSea: [10, 50, 94], sea: [9, 38, 80], polarSea: [8, 30, 64], shallow: [24, 106, 138], seaIce: [214, 224, 236], lake: [24, 70, 110],
      };
      const ss = (a, b, v) => { const t = Math.max(0, Math.min(1, (v - a) / (b - a))); return t * t * (3 - 2 * t); };
      const soft = (v, a, b, w) => ss(a - w, a + w, v) * (1 - ss(b - w, b + w, v));
      const inBox = ([la0, la1, lo0, lo1], lat, lon) => soft(lat, la0, la1, 2.5) * soft(lon, lo0, lo1, 2.5);
      const mix = (c, d, t) => { for (let k = 0; k < 3; k++) c[k] += (d[k] - c[k]) * t; return c; };
      const TW = E.TW, TH = E.TH, B = E.BOXES;
      const landCol = new Float32Array(TW * TH * 3), seaCol = new Float32Array(TW * TH * 3);
      for (let y = 0; y < TH; y++) for (let x = 0; x < TW; x++) {
        const i = y * TW + x, lat0 = 90 - (y + 0.5) / 2, lon0 = (x + 0.5) / 2 - 180;
        const X = x / TW * 256, Y = y / TH * 128;
        const lat = lat0 + (fbm(X, Y) - 0.5) * 7, lon = lon0 + (fbm(X + 91, Y + 37) - 0.5) * 7, a = Math.abs(lat);
        const c = mix(C.green.slice(), C.dry, soft(a, 24, 40, 5));
        mix(c, C.jungle, 1 - ss(12, 23, a));
        mix(c, mix(C.taiga.slice(), C.tundra, ss(60, 68, a)), Math.max(ss(50, 58, a), inBox(B.tibet, lat, lon)));
        const coastKm = E.kind[i] === 1 ? E.coast[i] : 0;
        let wd = Math.max(...B.deserts.map(b => inBox(b, lat, lon)), inBox(B.outback, lat, lon) * ss(80, 220, coastKm));
        mix(c, mix(C.desert.slice(), C.dune, fbm(X * 3, Y * 3)), wd);
        mix(c, C.ice, Math.max(ss(-58, -62, lat0), ss(70, 74, lat), ...B.greenland.map(b => inBox(b, lat, lon))));
        landCol.set(c, i * 3);
        const s2 = mix(mix(C.tropicSea.slice(), C.sea, ss(18, 32, a)), C.polarSea, ss(38, 58, a));
        if (E.kind[i] === 0) mix(s2, C.shallow, Math.exp(-E.coast[i] / 140));
        mix(s2, C.seaIce, Math.max(ss(76, 80, lat0), ss(-66, -70, lat0)));
        seaCol.set(s2, i * 3);
      }
      const sample = (grid, fx, fy, out) => {
        const x0 = Math.floor(fx), y0 = Math.max(0, Math.min(TH - 2, Math.floor(fy))), tx = fx - x0, ty = Math.max(0, Math.min(1, fy - y0));
        for (let k = 0; k < 3; k++) {
          const g = (xx, yy) => grid[(yy * TW + ((xx % TW) + TW) % TW) * 3 + k];
          out[k] = (g(x0, y0) * (1 - tx) + g(x0 + 1, y0) * tx) * (1 - ty) + (g(x0, y0 + 1) * (1 - tx) + g(x0 + 1, y0 + 1) * tx) * ty;
        }
      };
      // the land's colour everywhere (rgb), and how much of each texel's neighbourhood is water (a, the
      // mask blurred over 5 texels), so the shader can draw a smooth coast at any zoom
      const wet = new Float32Array(W * H), tmp = new Float32Array(W * H), K = [1, 4, 6, 4, 1];
      for (let i = 0; i < W * H; i++) wet[i] = E.mask[i] === 1 ? 0 : 1;
      for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) { let v = 0; for (let k = -2; k <= 2; k++) v += K[k + 2] * wet[y * W + (x + k + W) % W]; tmp[y * W + x] = v / 16; }
      for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) { let v = 0; for (let k = -2; k <= 2; k++) v += K[k + 2] * tmp[Math.max(0, Math.min(H - 1, y + k)) * W + x]; wet[y * W + x] = v / 16; }
      const c = [0, 0, 0];
      for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
        const fx = (x + 0.5) / W * TW - 0.5, fy = (y + 0.5) / H * TH - 0.5;
        sample(landCol, fx, fy, c);
        const k = 0.72 + 0.6 * fbm(x / W * 256, y / H * 128);
        const o = (y * W + x) * 4;
        day[o] = Math.min(255, c[0] * k); day[o + 1] = Math.min(255, c[1] * k); day[o + 2] = Math.min(255, c[2] * k);
        day[o + 3] = Math.round(wet[y * W + x] * 255);
      }
      // the sea's colour, on the half-degree grid (lakes their own)
      for (let i = 0; i < TW * TH; i++) { const o = i * 4; if (E.kind[i] === 2) sea.set([24, 70, 110, 255], o); else sea.set([seaCol[i * 3], seaCol[i * 3 + 1], seaCol[i * 3 + 2], 255], o); }
      // the map's picture: land or sea by the cell's centre
      for (let i = 0; i < TW * TH; i++) { const g = E.kind[i] === 1 ? landCol : null, o = i * 4; if (g) mapImg.set([g[i * 3], g[i * 3 + 1], g[i * 3 + 2], 255], o); else mapImg.set(sea.subarray(o, o + 4), o); }
    }
    const dayTex = new T.DataTexture(day, W, H, T.RGBAFormat);
    dayTex.colorSpace = T.SRGBColorSpace; dayTex.generateMipmaps = true;
    dayTex.minFilter = T.LinearMipmapLinearFilter; dayTex.magFilter = T.LinearFilter;
    dayTex.wrapS = T.RepeatWrapping; dayTex.anisotropy = renderer.capabilities.getMaxAnisotropy();
    dayTex.needsUpdate = true;
    const seaTex = new T.DataTexture(sea, E.TW, E.TH, T.RGBAFormat);
    seaTex.colorSpace = T.SRGBColorSpace; seaTex.magFilter = T.LinearFilter; seaTex.minFilter = T.LinearFilter; seaTex.wrapS = T.RepeatWrapping;
    seaTex.needsUpdate = true;
    const dmg = new Uint8Array(E.RW * E.RH * 4);
    const dmgTex = new T.DataTexture(dmg, E.RW, E.RH, T.RGBAFormat);
    dmgTex.colorSpace = T.SRGBColorSpace; dmgTex.magFilter = T.LinearFilter; dmgTex.minFilter = T.LinearFilter; dmgTex.wrapS = T.RepeatWrapping;
    dmgTex.needsUpdate = true;

    const earth = new T.Mesh(new T.SphereGeometry(1, 192, 96), new T.ShaderMaterial({
      uniforms: { uDay: { value: dayTex }, uSea: { value: seaTex }, uDmg: { value: dmgTex }, uSun },
      vertexShader: `
        varying vec2 vUv; varying vec3 vN; varying vec3 vW;
        void main() { vUv = uv; vN = normalize(position); vW = (modelMatrix * vec4(position, 1.0)).xyz; gl_Position = projectionMatrix * viewMatrix * vec4(vW, 1.0); }`,
      fragmentShader: `
        uniform sampler2D uDay, uSea, uDmg; uniform vec3 uSun;
        varying vec2 vUv; varying vec3 vN; varying vec3 vW;
        void main() {
          vec2 uv = vec2(vUv.x, 1.0 - vUv.y);      // the textures' first row is the north
          vec4 d = texture2D(uDay, uv);
          float fw = max(fwidth(d.a) * 0.8, 0.03);
          float water = smoothstep(0.5 - fw, 0.5 + fw, d.a);
          vec3 n = normalize(vN);
          vec4 dm = texture2D(uDmg, uv);
          vec3 col = mix(d.rgb, texture2D(uSea, uv).rgb, water);
          col = mix(col, dm.rgb, dm.a * (1.0 - water * 0.75));
          float sd = dot(n, uSun), light = smoothstep(-0.12, 0.3, sd);
          vec3 lit = col * (0.08 + 1.1 * max(sd, 0.0));
          vec3 night = col * 0.16 + vec3(0.012, 0.02, 0.045);
          col = mix(night, lit, light);
          vec3 v = normalize(cameraPosition - vW);
          float spec = pow(max(dot(n, normalize(uSun + v)), 0.0), 300.0) * water * light;
          col += vec3(1.0, 0.92, 0.8) * spec * 0.22;
          float rim = pow(1.0 - max(dot(n, v), 0.0), 5.0);
          col += vec3(0.28, 0.52, 1.0) * rim * (0.08 + 0.4 * light);
          col += vec3(0.9, 0.45, 0.2) * exp(-pow(sd / 0.08, 2.0)) * 0.05;   // a warm terminator
          gl_FragColor = vec4(col, 1.0);
          #include <tonemapping_fragment>
          #include <colorspace_fragment>
        }`,
    }));
    scene.add(earth);

    // the atmosphere's glow
    const atmo = new T.Mesh(new T.SphereGeometry(1.045, 96, 48), new T.ShaderMaterial({
      uniforms: { uSun },
      vertexShader: `varying vec3 vN; varying vec3 vW; void main() { vN = normalize(position); vW = (modelMatrix * vec4(position, 1.0)).xyz; gl_Position = projectionMatrix * viewMatrix * vec4(vW, 1.0); }`,
      fragmentShader: `uniform vec3 uSun; varying vec3 vN; varying vec3 vW;
        void main() { vec3 v = normalize(cameraPosition - vW); float f = pow(max(0.0, 0.62 + dot(vN, v)), 3.0) * 1.1;
          float l = 0.2 + 0.9 * smoothstep(-0.3, 0.5, dot(vN, uSun));
          gl_FragColor = vec4(vec3(0.3, 0.55, 1.0) * f * l, 1.0);
          #include <tonemapping_fragment>
          #include <colorspace_fragment>
        }`,
      side: T.BackSide, blending: T.AdditiveBlending, transparent: true, depthWrite: false,
    }));
    scene.add(atmo);

    // thin clouds
    let clouds = null;
    if (q.get('clouds') !== '0') {
      const CW = 1024, CH = 512, cl = new Uint8Array(CW * CH * 4), rnd = E.rng(11);
      const L = new Float32Array(64 * 32); for (let i = 0; i < L.length; i++) L[i] = rnd();
      const nz = (x, y, f) => { const X = x * f, Y = y * f, ix = Math.floor(X), iy = Math.floor(Y), fx = X - ix, fy = Y - iy, P = 64 * f / 4;
        const g = (a, b) => L[(((b % 32) + 32) % 32) * 64 + (((a % P) + P) % P)];
        const ux = fx * fx * (3 - 2 * fx), uy = fy * fy * (3 - 2 * fy);
        return (g(ix, iy) * (1 - ux) + g(ix + 1, iy) * ux) * (1 - uy) + (g(ix, iy + 1) * (1 - ux) + g(ix + 1, iy + 1) * ux) * uy; };
      for (let y = 0; y < CH; y++) for (let x = 0; x < CW; x++) {
        const X = x / CW * 64, Y = y / CH * 32;
        const n = nz(X, Y, 0.25) * 0.5 + nz(X, Y, 0.5) * 0.25 + nz(X, Y, 1) * 0.15 + nz(X, Y, 2) * 0.1;
        const lat = Math.abs(90 - (y + 0.5) / CH * 180), band = 0.8 + 0.2 * Math.cos(lat / 90 * Math.PI * 3);
        const o = (y * CW + x) * 4;
        cl[o] = cl[o + 1] = cl[o + 2] = 255;
        cl[o + 3] = Math.max(0, Math.min(255, (n * band - 0.56) / 0.22 * 255));
      }
      const ct = new T.DataTexture(cl, CW, CH, T.RGBAFormat);
      ct.wrapS = T.RepeatWrapping; ct.magFilter = T.LinearFilter; ct.minFilter = T.LinearMipmapLinearFilter; ct.generateMipmaps = true; ct.needsUpdate = true;
      clouds = new T.Mesh(new T.SphereGeometry(1.011, 128, 64), new T.ShaderMaterial({
        uniforms: { uTex: { value: ct }, uSun, uOff: { value: 0 } },
        vertexShader: `varying vec2 vUv; varying vec3 vN; void main() { vUv = uv; vN = normalize(position); gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0); }`,
        fragmentShader: `uniform sampler2D uTex; uniform vec3 uSun; uniform float uOff; varying vec2 vUv; varying vec3 vN;
          void main() { float a = texture2D(uTex, vec2(vUv.x + uOff, 1.0 - vUv.y)).a; float l = smoothstep(-0.15, 0.35, dot(vN, uSun));
            gl_FragColor = vec4(vec3(0.95) * (0.08 + 0.95 * l), a * 0.32 * (0.35 + 0.65 * l));
            #include <tonemapping_fragment>
            #include <colorspace_fragment>
          }`,
        transparent: true, depthWrite: false,
      }));
      clouds.renderOrder = 1;
      scene.add(clouds);
    }

    // stars and the sun
    {
      const n = 3500, pos = new Float32Array(n * 3), col = new Float32Array(n * 3), rnd = E.rng(3);
      for (let i = 0; i < n; i++) {
        const z = rnd() * 2 - 1, a = rnd() * Math.PI * 2, s = Math.sqrt(1 - z * z);
        pos.set([Math.cos(a) * s * 80, z * 80, Math.sin(a) * s * 80], i * 3);
        const b = 0.35 + rnd() * rnd() * 1.4, tint = rnd();
        col.set([b * (tint < 0.2 ? 0.8 : 1), b * 0.95, b * (tint > 0.8 ? 0.75 : 1)], i * 3);
      }
      const g = new T.BufferGeometry();
      g.setAttribute('position', new T.BufferAttribute(pos, 3));
      g.setAttribute('color', new T.BufferAttribute(col, 3));
      scene.add(new T.Points(g, new T.PointsMaterial({ size: 1.6, sizeAttenuation: false, vertexColors: true, depthWrite: false })));
    }
    const glowTex = (() => {
      const c = document.createElement('canvas'); c.width = c.height = 128;
      const x = c.getContext('2d'), g = x.createRadialGradient(64, 64, 0, 64, 64, 64);
      g.addColorStop(0, 'rgba(255,255,255,1)'); g.addColorStop(0.2, 'rgba(255,255,255,0.55)'); g.addColorStop(0.5, 'rgba(255,255,255,0.12)'); g.addColorStop(1, 'rgba(255,255,255,0)');
      x.fillStyle = g; x.fillRect(0, 0, 128, 128);
      const t = new T.CanvasTexture(c); t.colorSpace = T.SRGBColorSpace; return t;
    })();
    const sprite = (c, opacity = 1) => new T.Sprite(new T.SpriteMaterial({ map: glowTex, color: c, transparent: true, opacity, blending: T.AdditiveBlending, depthWrite: false }));
    const sun = sprite(lin(1, 0.92, 0.78).multiplyScalar(2.2));
    sun.scale.setScalar(9);
    scene.add(sun);

    // ---------------------------------------------------------------- cities
    const NC = E.cities.length;
    const cityGeo = new T.BufferGeometry();
    {
      const pos = new Float32Array(NC * 3), size = new Float32Array(NC);
      E.cities.forEach((c, i) => { pos.set(c.p.map(x => x * 1.0015), i * 3); size[i] = 2.2 + 2.4 * Math.log10(c.pop / 2e5); });
      cityGeo.setAttribute('position', new T.BufferAttribute(pos, 3));
      cityGeo.setAttribute('aSize', new T.BufferAttribute(size, 1));
      cityGeo.setAttribute('aH', new T.BufferAttribute(new Float32Array(NC).fill(1), 1));
      cityGeo.setAttribute('aFlash', new T.BufferAttribute(new Float32Array(NC), 1));
    }
    const cityFlash = cityGeo.attributes.aFlash.array, cityHealth = cityGeo.attributes.aH.array;
    const cities = new T.Points(cityGeo, new T.ShaderMaterial({
      uniforms: { uSun, uPx },
      vertexShader: `
        attribute float aSize, aH, aFlash; uniform vec3 uSun; uniform float uPx;
        varying float vH, vNight, vFlash;
        void main() {
          vH = aH; vFlash = aFlash;
          vNight = smoothstep(0.12, -0.18, dot(normalize(position), uSun));
          vec4 mv = modelViewMatrix * vec4(position, 1.0);
          gl_Position = projectionMatrix * mv;
          gl_PointSize = min(aSize * uPx * (0.55 + 0.7 * vNight) * (1.0 + aFlash * 0.8) / -mv.z, 16.0 * uPx / 2.9);
        }`,
      fragmentShader: `
        varying float vH, vNight, vFlash;
        void main() {
          float d = length(gl_PointCoord - 0.5);
          if (d > 0.5) discard;
          vec3 ok = mix(vec3(1.0, 0.88, 0.62), vec3(1.0, 0.8, 0.45), vNight);
          vec3 c = mix(vec3(1.0, 0.18, 0.04), ok, smoothstep(0.25, 0.9, vH)) * mix(0.35, 1.0, smoothstep(0.05, 0.5, vH));
          c *= mix(0.9, 2.2, vNight);
          c += vec3(1.0, 0.6, 0.3) * vFlash * 2.5;
          float a = smoothstep(0.5, 0.15, d) * mix(0.6, 1.0, max(vNight, vFlash));
          gl_FragColor = vec4(c, a);
          #include <tonemapping_fragment>
          #include <colorspace_fragment>
        }`,
      transparent: true, depthWrite: false,
    }));
    scene.add(cities);

    // ---------------------------------------------------------------- materials
    function discMat(o) {
      return new T.ShaderMaterial({
        uniforms: {
          uTime, uSun, uLift: { value: o.lift || 0.004 }, uHeight: { value: 0 },
          uSpin: { value: o.spin ?? 1 }, uArms: { value: o.arms ?? 2 }, uTwist: { value: o.twist ?? 1.5 }, uEye: { value: o.eye || 0 },
          uSolid: { value: o.solid ?? 0.3 }, uAlpha: { value: o.alpha ?? 0.9 }, uDir: { value: 1 }, uSeed: { value: Math.random() * 50 },
          uFlash: { value: 0 }, uGlow: { value: o.glow || 0 }, uRing: { value: o.ring || 0 },
          uColA: { value: lin(...o.a) }, uColB: { value: lin(...o.b) },
        },
        vertexShader: WRAP_VERT, fragmentShader: DISC_FRAG, transparent: true, depthWrite: false,
        blending: o.additive ? T.AdditiveBlending : T.NormalBlending,
      });
    }
    function ringMat(c, o = {}) {
      return new T.ShaderMaterial({
        uniforms: { uTime, uLift: { value: o.lift || 0.0018 }, uHeight: { value: 0 }, uColor: { value: c instanceof T.Color ? c : color(c) }, uAlpha: { value: o.alpha ?? 0.7 }, uWidth: { value: o.width || 0.04 }, uFill: { value: o.fill || 0 }, uNotch: { value: o.notch || 0 }, uDash: { value: o.dash || 0 } },
        vertexShader: WRAP_VERT, fragmentShader: RING_FRAG, transparent: true, depthWrite: false, blending: o.additive ? T.AdditiveBlending : T.NormalBlending,
      });
    }
    function partMat(o) {
      return new T.ShaderMaterial({
        uniforms: { uTime, uPx, uSpin: { value: o.spin ?? 1 }, uDir: { value: 1 }, uRise: { value: o.rise || 0 }, uSize: { value: o.size || 6 }, uScale: { value: new T.Vector2(0.05, 0.01) }, uColor: { value: lin(...o.c) }, uAlpha: { value: o.alpha ?? 0.8 } },
        vertexShader: PART_VERT, fragmentShader: PART_FRAG, transparent: true, depthWrite: false, blending: o.additive ? T.AdditiveBlending : T.NormalBlending,
      });
    }
    function partGeo(n, r0, r1, h1) {
      const g = new T.BufferGeometry(), a = new Float32Array(n * 4), rnd = E.rng(n * 13 + Math.floor(r0 * 100));
      for (let i = 0; i < n; i++) a.set([rnd() * 6.283, r0 + (r1 - r0) * Math.sqrt(rnd()), rnd() * h1, rnd()], i * 4);
      g.setAttribute('aP', new T.BufferAttribute(a, 4));
      g.setAttribute('position', new T.BufferAttribute(new Float32Array(n * 3), 3));
      g.boundingSphere = new T.Sphere(new T.Vector3(), 1e3);
      return g;
    }
    function funnelMat(o) {
      return new T.ShaderMaterial({
        uniforms: { uTime, uSun, uSway: { value: o.sway ?? 0.18 }, uSpeed: { value: o.speed ?? 6 }, uAlpha: { value: o.alpha ?? 0.9 }, uColA: { value: lin(...o.a) }, uColB: { value: lin(...o.b) } },
        vertexShader: FUNNEL_VERT, fragmentShader: FUNNEL_FRAG, transparent: true, depthWrite: false, side: T.DoubleSide,
      });
    }
    function wallMat(o) {
      return new T.ShaderMaterial({
        uniforms: { uTime, uSun, uLift: { value: 0 }, uHeight: { value: o.height || 0.03 }, uAlpha: { value: o.alpha ?? 0.85 }, uSeed: { value: Math.random() * 40 }, uColA: { value: lin(...o.a) }, uColB: { value: lin(...o.b) } },
        vertexShader: WRAP_VERT, fragmentShader: WALL_FRAG, transparent: true, depthWrite: false, side: T.DoubleSide,
      });
    }
    const mesh = (geo, mat, order = 3) => { const m = new T.Mesh(geo, mat); m.renderOrder = order; m.frustumCulled = false; return m; };

    // ---------------------------------------------------------------- the storms
    // each part: { obj, k (its size, in storm radii), kind } updated from the storm every frame
    function stormView(s) {
      const group = new T.Group();
      const parts = [];
      const add = (obj, k, extra = {}) => { group.add(obj); parts.push(Object.assign({ obj, k }, extra)); return obj; };
      const disc = (o, k, extra) => add(mesh(DISC_GEO, discMat(o), o.order || 3), k, Object.assign({ disc: true }, extra));
      const parts3 = (o, k) => { const p = new T.Points(partGeo(o.n, o.r0 ?? 0.1, o.r1 ?? 1, o.h ?? 1), partMat(o)); p.renderOrder = 6; p.frustumCulled = false; return add(p, k, { part: true, hk: o.hk || 0.02 }); };
      const t = s.type;
      if (t === 'hurricane') {
        disc({ a: [0.97, 0.98, 1], b: [0.4, 0.48, 0.6], spin: 1, arms: 2, twist: 1.8, eye: 0.085, solid: 0.12, alpha: 0.97, lift: 0.004 }, 1);
        disc({ a: [1, 1, 1], b: [0.7, 0.75, 0.84], spin: 1.4, arms: 3, twist: 1, eye: 0.155, solid: 0.55, alpha: 0.75, lift: 0.009, order: 4 }, 0.55);
      } else if (t === 'tornado') {
        disc({ a: [0.62, 0.52, 0.4], b: [0.34, 0.27, 0.2], spin: 2.5, arms: 4, twist: 1.2, solid: 0.3, alpha: 0.6, lift: 0.002 }, 1);
        add(mesh(FUNNEL_GEO, funnelMat({ a: [0.52, 0.5, 0.5], b: [0.17, 0.16, 0.16], alpha: 1 }), 5), 0.55, { funnel: true });
        disc({ a: [0.5, 0.52, 0.56], b: [0.17, 0.19, 0.23], spin: 0.8, arms: 1, twist: 1, solid: 0.7, alpha: 0.85, order: 7 }, 1.35, { top: true });
        parts3({ n: 160, c: [0.45, 0.36, 0.26], spin: 3, rise: 1, size: 5, r0: 0.15, r1: 0.9, alpha: 0.9, hk: 0.025 }, 1);
      } else if (t === 'blizzard') {
        disc({ a: [0.97, 0.99, 1], b: [0.68, 0.78, 0.92], spin: 0.6, arms: 1, twist: 0.8, solid: 0.6, alpha: 0.9, lift: 0.004 }, 1);
        disc({ a: [1, 1, 1], b: [0.85, 0.9, 1], spin: 0.9, arms: 2, twist: 1.2, solid: 0.75, alpha: 0.55, lift: 0.008, order: 4 }, 0.7);
        parts3({ n: 420, c: [1, 1, 1], spin: 1.2, rise: -1.5, size: 3.2, r0: 0.05, r1: 1.1, alpha: 0.95, hk: 0.016 }, 1);
      } else if (t === 'sandstorm') {
        disc({ a: [0.9, 0.7, 0.45], b: [0.6, 0.42, 0.24], spin: 0.45, arms: 1, twist: 0.6, solid: 0.8, alpha: 0.88, lift: 0.003 }, 1);
        add(mesh(WALL_GEO, wallMat({ a: [0.92, 0.72, 0.46], b: [0.62, 0.42, 0.24], height: 0.024, alpha: 0.9 }), 5), 0.95, { wall: true, ahead: 0.8 });
        parts3({ n: 260, c: [0.8, 0.6, 0.36], spin: 1.3, rise: 0.6, size: 4.5, r0: 0.2, r1: 1.05, alpha: 0.7, hk: 0.012 }, 1);
      } else if (t === 'supercell') {
        disc({ a: [0.5, 0.53, 0.6], b: [0.19, 0.21, 0.27], spin: 1.1, arms: 1.5, twist: 1.2, solid: 0.55, alpha: 0.95, lift: 0.004 }, 0.6, { flash: true });
        add(mesh(SHAFT_GEO, funnelMat({ a: [0.55, 0.58, 0.65], b: [0.3, 0.32, 0.38], alpha: 0.4, sway: 0.03, speed: 2 }), 5), 0.42, { shaft: true });
        disc({ a: [0.95, 0.96, 0.98], b: [0.52, 0.55, 0.63], spin: 0.15, arms: 0, solid: 0.85, alpha: 0.8, lift: 0.022, order: 7 }, 1.05, { flash: true, behind: 0.25 });
      } else if (t === 'wildfire') {
        disc({ a: [0.4, 0.37, 0.35], b: [0.11, 0.1, 0.09], spin: 0.3, arms: 1, solid: 0.7, alpha: 0.5, lift: 0.016, order: 3 }, 1.1, { behind: 0.9 });
        disc({ a: [1, 0.6, 0.16], b: [0.85, 0.16, 0.02], spin: 0.25, arms: 0, solid: 0.6, ring: 0.6, glow: 1.6, alpha: 1, lift: 0.002, additive: true, order: 4 }, 1, { flicker: true });
        parts3({ n: 220, c: [1, 0.55, 0.15], spin: 0.4, rise: 1.2, size: 4, r0: 0.3, r1: 1, alpha: 1, additive: true, hk: 0.02 }, 1);
      }
      const ring = add(mesh(RING_GEO, ringMat(s.color, { alpha: s.ai ? 0.55 : 0.9, width: 0.035, notch: 1.2, additive: true }), 2), 1.08, { ring: true });
      scene.add(group);
      const basis = new T.Matrix4();
      let flash = 0, flashT = 0;
      function update(dt) {
        group.visible = s.alive;
        if (!s.alive) return;
        const p = v3(s.p), h = v3(s.heading);
        const x = new T.Vector3().crossVectors(p, h);
        basis.makeBasis(x, p, h);
        group.position.copy(p);
        group.quaternion.setFromRotationMatrix(basis);
        const r = s.r / R, I = s.E / 100;
        const shield = s.shield > 0 ? 0.55 + 0.45 * Math.sin(uTime.value * 22) : 1;
        if (s.type === 'supercell') {   // lightning inside the cloud
          flashT -= dt;
          if (flashT <= 0) { flash = 1; flashT = 0.15 + Math.random() * (1.6 - I); }
          flash *= Math.exp(-dt * 18);
        }
        const hemi = s.p[1] < 0 ? -1 : 1;
        for (const pt of parts) {
          const o = pt.obj, u = o.material.uniforms;
          if (u.uDir) u.uDir.value = hemi;
          if (pt.disc) {
            o.scale.set(r * pt.k, 1, r * pt.k);
            o.position.set(0, 0, pt.behind ? -pt.behind * r : 0);
            u.uAlpha.value = (u.uAlpha.base ??= u.uAlpha.value) * shield * (0.55 + 0.45 * Math.min(1, I * 2.5));
            if (pt.flash) u.uFlash.value = flash;
            if (pt.flicker) u.uGlow.value = 1.4 + 0.25 * Math.sin(uTime.value * 17) * Math.sin(uTime.value * 7.3);
            if (pt.top) u.uLift.value = 0.032 + 0.025 * I;
          } else if (pt.funnel) {
            const hgt = 0.032 + 0.025 * I;
            o.scale.set(r * pt.k * (s.dashT > 0 ? 0.8 : 1), hgt, r * pt.k * (s.dashT > 0 ? 0.8 : 1));
            u.uAlpha.value = shield;
          } else if (pt.shaft) {
            o.scale.set(r * pt.k, 0.02, r * pt.k);
          } else if (pt.wall) {
            o.scale.set(r * pt.k, 1, 1);
            o.position.set(0, 0, r * pt.ahead);
            u.uAlpha.value = 0.9 * shield * Math.min(1, 0.4 + I);
          } else if (pt.part) {
            u.uScale.value.set(r * pt.k, pt.hk * (0.6 + 0.6 * I));
            u.uAlpha.value = (u.uAlpha.base ??= u.uAlpha.value) * shield;
          } else if (pt.ring) {
            o.scale.set(r * pt.k, 1, r * pt.k);
          }
        }
      }
      function dispose() { scene.remove(group); group.traverse((o) => { if (o.material) o.material.dispose(); if (o.isPoints) o.geometry.dispose(); }); }
      return { update, dispose, group };
    }

    // ---------------------------------------------------------------- tracks
    const TRACK_N = 700;
    function trackView(s) {
      const g = new T.BufferGeometry();
      const pos = new Float32Array(TRACK_N * 6), tm = new Float32Array(TRACK_N * 2).fill(-1e9);
      g.setAttribute('position', new T.BufferAttribute(pos, 3));
      g.setAttribute('aT', new T.BufferAttribute(tm, 1));
      g.boundingSphere = new T.Sphere(new T.Vector3(), 2);
      const mat = new T.ShaderMaterial({
        uniforms: { uNow: { value: 0 }, uColor: { value: color(s.color) } },
        vertexShader: `attribute float aT; uniform float uNow; varying float vA; void main() { vA = clamp(1.0 - (uNow - aT) / 90.0, 0.0, 1.0); gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0); }`,
        fragmentShader: `uniform vec3 uColor; varying float vA; void main() { gl_FragColor = vec4(uColor, vA * vA * 0.85);
          #include <tonemapping_fragment>
          #include <colorspace_fragment>
        }`,
        transparent: true, depthWrite: false,
      });
      const line = new T.LineSegments(g, mat);
      line.renderOrder = 2;
      scene.add(line);
      let n = 0, last = null, acc = 0;
      function update(dt, now) {
        mat.uniforms.uNow.value = now;
        if (!s.alive) { last = null; return; }
        acc += dt;
        if (acc < 0.12 && last) return;
        acc = 0;
        const p = s.p.map(x => x * 1.0025);
        if (last) {
          const i = n % TRACK_N;
          pos.set(last, i * 6); pos.set(p, i * 6 + 3);
          tm[i * 2] = tm[i * 2 + 1] = now;
          n++;
          g.attributes.position.needsUpdate = true; g.attributes.aT.needsUpdate = true;
        }
        last = p;
      }
      function dispose() { scene.remove(line); g.dispose(); mat.dispose(); }
      return { update, dispose };
    }

    // ---------------------------------------------------------------- the moves (sim.effects)
    const at = (obj, p, h) => {
      const P = v3(p), H = h ? v3(h) : v3(E.north(p)), X = new T.Vector3().crossVectors(P, H);
      obj.position.copy(P);
      obj.quaternion.setFromRotationMatrix(new T.Matrix4().makeBasis(X, P, H));
    };
    function effectView(f, sim) {
      const s = sim.storms[f.owner];
      const g = new T.Group();
      scene.add(g);
      const items = [];
      let update = () => {};
      if (f.kind === 'surge') {
        const ring = mesh(RING_GEO, ringMat(lin(0.55, 0.95, 1), { width: 0.06, fill: 1, alpha: 1, additive: true, lift: 0.006 }), 8);
        const sea = mesh(DISC_GEO, discMat({ a: [0.75, 0.92, 1], b: [0.25, 0.5, 0.7], spin: 2, arms: 6, twist: 0.5, solid: 0.4, alpha: 0.5, lift: 0.003 }), 3);
        g.add(sea, ring); items.push(ring, sea);
        at(g, f.p);
        update = () => {
          const Rn = (f.r0 + (f.r1 - f.r0) * Math.pow(Math.min(1, f.t / f.dur), 0.6)) / R, fade = 1 - Math.pow(f.t / f.dur, 2);
          ring.scale.set(Rn, 1, Rn); sea.scale.set(Rn, 1, Rn);
          ring.material.uniforms.uAlpha.value = fade; sea.material.uniforms.uAlpha.value = 0.45 * fade;
        };
      } else if (f.kind === 'whiteout') {
        const fog = mesh(DISC_GEO, discMat({ a: [1, 1, 1], b: [0.75, 0.86, 1], spin: 0.5, arms: 0, solid: 1, alpha: 0.45, lift: 0.012 }), 8);
        const rim = mesh(RING_GEO, ringMat(lin(0.7, 0.9, 1), { width: 0.05, alpha: 0.9, additive: true, lift: 0.012, dash: 24 }), 8);
        g.add(fog, rim); items.push(fog, rim);
        update = () => {
          if (!s.alive) { g.visible = false; return; }
          at(g, s.p, s.heading);
          const r = f.r / R, k = Math.min(1, f.t * 4) * Math.min(1, (f.dur - f.t) * 2);
          fog.scale.set(r, 1, r); rim.scale.set(r, 1, r);
          fog.material.uniforms.uAlpha.value = 0.45 * k; rim.material.uniforms.uAlpha.value = 0.9 * k;
        };
      } else if (f.kind === 'haboob') {
        const wall = mesh(WALL_GEO, wallMat({ a: [0.94, 0.74, 0.48], b: [0.6, 0.4, 0.22], height: 0.04, alpha: 0.95 }), 8);
        const dust = mesh(DISC_GEO, discMat({ a: [0.88, 0.68, 0.42], b: [0.58, 0.4, 0.22], spin: 0.3, arms: 0, solid: 1, alpha: 0.5, lift: 0.004 }), 3);
        g.add(wall, dust); items.push(wall, dust);
        update = () => {
          at(g, f.p, f.u);
          const k = Math.min(1, f.t * 5) * Math.min(1, (f.dur - f.t) * 3);
          wall.scale.set(f.half / R, 1, 1);
          dust.scale.set(f.half / R * 0.6, 1, f.half / R * 0.6); dust.position.set(0, 0, -f.half / R * 0.5);
          wall.material.uniforms.uAlpha.value = 0.95 * k; dust.material.uniforms.uAlpha.value = 0.45 * k;
        };
      } else if (f.kind === 'lightning') {
        const mark = mesh(RING_GEO, ringMat(lin(0.75, 0.82, 1), { width: 0.12, alpha: 0.9, additive: true, dash: 10 }), 8);
        g.add(mark); items.push(mark);
        at(g, f.target);
        update = () => { const r = 320 / R * (1.3 - 0.3 * f.t / f.dur); mark.scale.set(r, 1, r); mark.material.uniforms.uAlpha.value = 1 - f.t / f.dur; };
      } else if (f.kind === 'fire') {
        const discs = f.patches.map((p) => {
          const m = mesh(DISC_GEO, discMat({ a: [1, 0.6, 0.15], b: [0.55, 0.06, 0.01], spin: 0.2, arms: 0, solid: 0.7, glow: 1, alpha: 0.9, lift: 0.0025, additive: true }), 3);
          const holder = new T.Group(); holder.add(m); at(holder, p); g.add(holder); items.push(m);
          m.scale.set(f.pr / R, 1, f.pr / R);
          return m;
        });
        update = () => { const k = Math.min(1, f.t * 3) * Math.min(1, (f.dur - f.t) * 1.5); for (const m of discs) { m.material.uniforms.uAlpha.value = 0.9 * k; m.material.uniforms.uGlow.value = 0.8 + 0.2 * Math.sin(uTime.value * 13 + m.id); } };
      }
      function dispose() { scene.remove(g); for (const m of items) m.material.dispose(); }
      return { update: () => update(), dispose };
    }

    // ---------------------------------------------------------------- short-lived things
    const fx = [];
    function bolt(p, big = true) {
      const P = v3(p), up = P.clone().multiplyScalar(big ? 1.06 : 1.03), side = v3(E.east(p)), fwd = v3(E.north(p));
      const pts = [];
      const zig = (a, b, n, jit) => {
        let prev = a.clone();
        for (let i = 1; i <= n; i++) {
          const t = i / n, c = a.clone().lerp(b, t);
          if (i < n) c.addScaledVector(side, (Math.random() - 0.5) * jit).addScaledVector(fwd, (Math.random() - 0.5) * jit);
          pts.push(prev, c); prev = c;
        }
      };
      zig(up, P.clone().multiplyScalar(1.0008), 14, 0.008);
      for (let k = 0; k < 2; k++) { const s0 = up.clone().lerp(P, 0.3 + Math.random() * 0.3); zig(s0, s0.clone().lerp(P, 0.6).addScaledVector(side, (Math.random() - 0.5) * 0.03), 6, 0.006); }
      const geo = new T.BufferGeometry().setFromPoints(pts);
      const line = new T.LineSegments(geo, new T.LineBasicMaterial({ color: lin(0.85, 0.9, 1).multiplyScalar(4), transparent: true, blending: T.AdditiveBlending, depthWrite: false }));
      line.renderOrder = 9;
      const glow = sprite(lin(0.7, 0.8, 1).multiplyScalar(3));
      glow.position.copy(P.clone().multiplyScalar(1.004)); glow.scale.setScalar(big ? 0.12 : 0.05);
      scene.add(line, glow);
      fx.push({ life: 0.35, t: 0, update(k) { line.material.opacity = (Math.random() < 0.7 ? 1 : 0.3) * (1 - k); glow.material.opacity = 1 - k; }, dispose() { scene.remove(line, glow); geo.dispose(); line.material.dispose(); glow.material.dispose(); } });
    }
    function burst(p, c, size, life = 0.5) {
      const s = sprite(color(c).multiplyScalar(2.5));
      s.position.copy(v3(p).multiplyScalar(1.01)); s.scale.setScalar(size);
      scene.add(s);
      fx.push({ life, t: 0, update(k) { s.material.opacity = 1 - k; s.scale.setScalar(size * (1 + k)); }, dispose() { scene.remove(s); s.material.dispose(); } });
    }
    function shock(p, c, r1, life = 1.2) {
      const m = mesh(RING_GEO, ringMat(color(c), { width: 0.08, fill: 0.6, alpha: 1, additive: true, lift: 0.006 }), 8);
      at(m, p);
      scene.add(m);
      fx.push({ life, t: 0, update(k) { const r = r1 / R * Math.pow(k, 0.5); m.scale.set(r, 1, r); m.material.uniforms.uAlpha.value = 1 - k; }, dispose() { scene.remove(m); m.material.dispose(); } });
    }
    // arcs between storms that are brawling, redrawn several times a second
    const arcs = new T.LineSegments(new T.BufferGeometry(), new T.LineBasicMaterial({ color: lin(0.8, 0.7, 1).multiplyScalar(3), transparent: true, opacity: 0.85, blending: T.AdditiveBlending, depthWrite: false }));
    arcs.renderOrder = 9; arcs.frustumCulled = false;
    scene.add(arcs);
    let arcT = 0;
    function drawArcs(sim, dt) {
      arcT -= dt;
      if (arcT > 0) return;
      arcT = 0.07;
      const pts = [];
      const st = sim.storms;
      for (let i = 0; i < st.length; i++) for (let j = i + 1; j < st.length; j++) {
        const a = st[i], b = st[j];
        if (!a.alive || !b.alive || E.dist(a.p, b.p) >= (a.r + b.r) * 0.7) continue;
        const A = v3(a.p), B = v3(b.p);
        for (let k = 0; k < 3; k++) {
          let prev = A.clone().multiplyScalar(1.012);
          for (let n = 1; n <= 10; n++) {
            const c = A.clone().lerp(B, n / 10).normalize().multiplyScalar(1.012 + (n < 10 ? Math.random() * 0.012 : 0));
            if (n < 10) c.add(new T.Vector3(Math.random() - 0.5, Math.random() - 0.5, Math.random() - 0.5).multiplyScalar(0.02));
            pts.push(prev, c); prev = c;
          }
        }
      }
      arcs.geometry.dispose();
      arcs.geometry = new T.BufferGeometry().setFromPoints(pts);
    }

    // energy orbs
    function surgeView(g) {
      const orb = sprite(lin(1, 0.82, 0.3).multiplyScalar(2.6));
      const ring = mesh(RING_GEO, ringMat(lin(1, 0.8, 0.3), { width: 0.1, fill: 0.5, alpha: 0.9, additive: true, dash: 8 }), 8);
      at(ring, g.p);
      scene.add(orb, ring);
      const P = v3(g.p);
      return {
        update() { const k = 1 + 0.15 * Math.sin(uTime.value * 5); orb.position.copy(P.clone().multiplyScalar(1.02 + 0.004 * Math.sin(uTime.value * 3))); orb.scale.setScalar(0.07 * k); const r = 250 / R * k; ring.scale.set(r, 1, r); },
        dispose() { scene.remove(orb, ring); orb.material.dispose(); ring.material.dispose(); },
      };
    }

    // ---------------------------------------------------------------- bloom
    let composer = null, bloom = null;
    if (q.get('bloom') !== '0' && window.EffectComposer && window.UnrealBloomPass) {
      composer = new window.EffectComposer(renderer);
      composer.addPass(new window.RenderPass(scene, camera));
      bloom = new window.UnrealBloomPass(new T.Vector2(container.clientWidth, container.clientHeight), 0.55, 0.45, 0.9);
      composer.addPass(bloom);
      composer.addPass(new window.OutputPass());
    }

    // ---------------------------------------------------------------- per match
    let sim = null, views = [], tracks = [], effViews = new Map(), surgeViews = new Map();
    function setSim(next) {
      for (const v of views) v.dispose();
      for (const v of tracks) v.dispose();
      for (const v of effViews.values()) v.dispose();
      for (const v of surgeViews.values()) v.dispose();
      for (const f of fx) f.dispose();
      fx.length = 0;
      effViews = new Map(); surgeViews = new Map();
      sim = next;
      views = sim.storms.map(stormView);
      tracks = sim.storms.map(trackView);
      cityFlash.fill(0);
    }
    let dmgT = 0;
    function updateDamage() {
      const TINT = { hurricane: [86, 96, 84], tornado: [104, 74, 44], blizzard: [228, 238, 248], sandstorm: [206, 162, 100], supercell: [74, 76, 88], wildfire: [26, 18, 14] };
      for (let i = 0; i < E.RW * E.RH; i++) {
        const lost = 1 - sim.ruralH[i], o = i * 4;
        if (lost < 0.004 || sim.ruralBy[i] < 0) { dmg[o + 3] = 0; continue; }
        const c = TINT[sim.storms[sim.ruralBy[i]].type];
        dmg[o] = c[0]; dmg[o + 1] = c[1]; dmg[o + 2] = c[2];
        dmg[o + 3] = Math.min(235, lost * 1.8 * 255);
      }
      dmgTex.needsUpdate = true;
    }
    function onEvent(e) {
      if (e.type === 'bolt') bolt(e.p, true);
      else if (e.type === 'hit' && e.kind !== 'bolt') burst(e.p, sim.storms[e.a].color, 0.06 + e.amount * 0.004, 0.45);
      else if (e.type === 'ko') { shock(e.p, sim.storms[e.s].color, 900, 1.3); burst(e.p, '#ffffff', 0.2, 0.7); }
      else if (e.type === 'respawn') shock(sim.storms[e.s].p, sim.storms[e.s].color, 600, 0.9);
      else if (e.type === 'pickup') burst(sim.storms[e.s].p, '#ffd36b', 0.25, 0.8);
      else if (e.type === 'city') cityFlash[e.c] = Math.min(1.5, cityFlash[e.c] + 0.8);
    }

    // ---------------------------------------------------------------- each frame
    // cam: { p (unit), fwd (unit tangent: screen up), alt (km), tilt (rad), shake, shiftX, center
    // (look at the Earth's centre, not the point under the camera) }
    function frame(dt, cam, sunAngle) {
      uTime.value += dt;
      const s0 = new T.Vector3(Math.cos(sunAngle), 0.33, -Math.sin(sunAngle)).normalize();
      uSun.value.copy(s0);
      sun.position.copy(s0).multiplyScalar(60);
      if (clouds) clouds.material.uniforms.uOff.value += dt * 0.0012;
      uPx.value = renderer.domElement.height / (2 * Math.tan(camera.fov * Math.PI / 360)) * 0.0022;
      if (sim) {
        for (const v of views) v.update(dt);
        for (const v of tracks) v.update(dt, sim.time);
        const seen = new Set();
        for (const f of sim.effects) { if (f.kind === 'dash') continue; seen.add(f.id); if (!effViews.has(f.id)) effViews.set(f.id, effectView(f, sim)); effViews.get(f.id).update(); }
        for (const [id, v] of effViews) if (!seen.has(id)) { v.dispose(); effViews.delete(id); }
        const live = new Set();
        for (const g of sim.surges) { live.add(g.id); if (!surgeViews.has(g.id)) surgeViews.set(g.id, surgeView(g)); surgeViews.get(g.id).update(); }
        for (const [id, v] of surgeViews) if (!live.has(id)) { v.dispose(); surgeViews.delete(id); }
        drawArcs(sim, dt);
        cityHealth.set(sim.cityH);
        for (let i = 0; i < NC; i++) if (cityFlash[i] > 0) cityFlash[i] = Math.max(0, cityFlash[i] - dt * 2.5);
        cityGeo.attributes.aH.needsUpdate = true; cityGeo.attributes.aFlash.needsUpdate = true;
        dmgT -= dt;
        if (dmgT <= 0) { dmgT = 0.25; updateDamage(); }
      }
      for (let i = fx.length - 1; i >= 0; i--) { const f = fx[i]; f.t += dt; if (f.t >= f.life) { f.dispose(); fx.splice(i, 1); } else f.update(f.t / f.life); }
      // the camera
      const p = v3(cam.p), fwd = v3(cam.fwd), h = cam.alt / R;
      const eye = p.clone().multiplyScalar(1 + h * Math.cos(cam.tilt)).addScaledVector(fwd, -h * Math.sin(cam.tilt));
      const look = cam.center ? new T.Vector3() : p.clone().addScaledVector(fwd, h * 0.12);
      if (cam.shake > 0) eye.add(new T.Vector3(Math.random() - 0.5, Math.random() - 0.5, Math.random() - 0.5).multiplyScalar(cam.shake * h * 0.04));
      camera.position.copy(eye);
      camera.up.copy(fwd);
      camera.lookAt(look);
      // shiftX: the globe moved right by that share of the width (the select screen's panels are on the left)
      const w = container.clientWidth, hh = container.clientHeight;
      if (cam.shiftX) camera.setViewOffset(w, hh, -cam.shiftX * w, 0, w, hh); else if (camera.view && camera.view.enabled) camera.clearViewOffset();
      if (composer) composer.render(dt); else renderer.render(scene, camera);
    }
    // the point on the globe under normalised device coordinates (x, y), or null
    const ray = new T.Raycaster();
    function pick(x, y) {
      ray.setFromCamera(new T.Vector2(x, y), camera);
      const o = ray.ray.origin, d = ray.ray.direction;
      const b = o.dot(d), c = o.lengthSq() - 1, disc = b * b - c;
      if (disc < 0) return null;
      const t = -b - Math.sqrt(disc);
      if (t < 0) return null;
      const hit = o.clone().addScaledVector(d, t);
      return [hit.x, hit.y, hit.z];
    }
    // where a point on the globe (lifted by lift) is on the screen, in CSS pixels
    function project(p, lift = 0) {
      const w = v3(p).multiplyScalar(1 + lift);
      const facing = w.clone().normalize().dot(camera.position.clone().sub(w)) > 0;
      const s = w.project(camera);
      return { x: (s.x + 1) / 2 * container.clientWidth, y: (1 - s.y) / 2 * container.clientHeight, visible: facing && s.z < 1 && Math.abs(s.x) < 1.05 && Math.abs(s.y) < 1.05, nx: s.x, ny: s.y };
    }
    function resize() {
      const w = container.clientWidth, h = container.clientHeight;
      renderer.setSize(w, h);
      camera.aspect = w / h; camera.updateProjectionMatrix();
      if (composer) { composer.setSize(w, h); bloom.resolution.set(w, h); }
    }
    window.addEventListener('resize', resize);
    // the damage layer, for the map (RGBA, 1° cells, north first)
    return { renderer, scene, camera, frame, setSim, onEvent, pick, project, resize, damage: dmg, mapImage: mapImg, get bloom() { return !!composer; } };
  }
  return { create };
})();
