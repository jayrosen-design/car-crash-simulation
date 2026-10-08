/* Imported car models (models/<key>.glb.js) for the three.js scene.
 *
 * Every body part is skinned to the vehicle's physics lattice on the GPU: each vertex keeps the 8
 * nodes of its lattice cell and its position in that cell, and the vertex shader rebuilds the
 * position from the node positions (a float texture, updated each frame) and turns the authored
 * normal with the cell's deformation gradient (n' = cof(F) n), so the model keeps its own
 * smoothing and hard edges while it crumples. The same texture carries the plastic strain for
 * the strain map. Wheels are one mesh, instanced four times (mirrored on the left).
 *
 * Crumpled metal: the lattice is too coarse for sheet-metal folds, so where it says the metal
 * yielded the shader adds them (broad buckles in the geometry, finer folds in the shading, running
 * across the direction the cell was compressed), darkens the creases and cracks the paint along
 * the sharpest ones. Visual only; the numbers come from the lattice.
 *
 * Destruction (from the impact result): parts that came off become rigid meshes frozen in their
 * crushed shape and follow their debris bodies; tempered panes and lamps burst into instanced
 * shards whose paths are worked out from the break (so scrubbing back and forth is consistent);
 * the laminated windshield gets a spider-web crack; burst tyres flatten against the ground.
 * Uses window.THREE, window.GLTFLoader and window.DRACOLoader (set up by index.html).
 */
const CarModels = (() => {
  'use strict';
  const T = THREE, P = CrashPhysics;
  const DRACO_PATH = 'https://cdn.jsdelivr.net/npm/three@0.170.0/examples/jsm/libs/draco/gltf/';
  const GRAV = 9.81;
  const CRUMPLE_DEPTH = 0.022;   // m: how far the crumple folds stand out of a fully yielded panel
  let loader = null;

  // The shader's simplex noise and crumple pattern (NOISE below) in JS, to freeze a part's folds
  // when it comes off.
  const m289 = (x) => x - Math.floor(x * (1 / 289)) * 289, perm = (x) => m289((x * 34 + 1) * x);
  function crNoise(vx, vy, vz) {
    const s = (vx + vy + vz) / 3;
    let ix = Math.floor(vx + s), iy = Math.floor(vy + s), iz = Math.floor(vz + s);
    const t = (ix + iy + iz) / 6, x0 = vx - ix + t, y0 = vy - iy + t, z0 = vz - iz + t;
    const gx = x0 >= y0 ? 1 : 0, gy = y0 >= z0 ? 1 : 0, gz = z0 >= x0 ? 1 : 0, lx = 1 - gx, ly = 1 - gy, lz = 1 - gz;
    const i1 = [Math.min(gx, lz), Math.min(gy, lx), Math.min(gz, ly)], i2 = [Math.max(gx, lz), Math.max(gy, lx), Math.max(gz, ly)];
    const X = [x0, x0 - i1[0] + 1 / 6, x0 - i2[0] + 1 / 3, x0 - 0.5], Y = [y0, y0 - i1[1] + 1 / 6, y0 - i2[1] + 1 / 3, y0 - 0.5], Z = [z0, z0 - i1[2] + 1 / 6, z0 - i2[2] + 1 / 3, z0 - 0.5];
    ix = m289(ix); iy = m289(iy); iz = m289(iz);
    const oz = [0, i1[2], i2[2], 1], oy = [0, i1[1], i2[1], 1], ox = [0, i1[0], i2[0], 1];
    const nsx = 0.142857142857 * 2, nsy = 0.142857142857 * 0.5 - 1, nsz = 0.142857142857;
    let out = 0;
    for (let k = 0; k < 4; k++) {
      const p = perm(perm(perm(iz + oz[k]) + iy + oy[k]) + ix + ox[k]);
      const j = p - 49 * Math.floor(p * nsz * nsz), x_ = Math.floor(j * nsz), y_ = Math.floor(j - 7 * x_);
      const gxk = x_ * nsx + nsy, gyk = y_ * nsx + nsy, h = 1 - Math.abs(gxk) - Math.abs(gyk), sh = h <= 0 ? -1 : 0;
      const ax = gxk + (Math.floor(gxk) * 2 + 1) * sh, ay = gyk + (Math.floor(gyk) * 2 + 1) * sh;
      const nr = 1.79284291400159 - 0.85373472095314 * (ax * ax + ay * ay + h * h);
      const m = Math.max(0.6 - (X[k] * X[k] + Y[k] * Y[k] + Z[k] * Z[k]), 0);
      out += m * m * m * m * (ax * X[k] + ay * Y[k] + h * Z[k]) * nr;
    }
    return 42 * out;
  }
  function crPattern(x, y, z, c, s) {
    const iso = crNoise(x * s, y * s, z * s), w = [c[0] * c[0], c[1] * c[1], c[2] * c[2]], tot = w[0] + w[1] + w[2];
    if (tot < 1e-4) return iso;
    const dir = (w[0] * crNoise(2.2 * s * x + 17, s * y + 17, s * z + 17) + w[1] * crNoise(s * x + 31, 2.2 * s * y + 31, s * z + 31) + w[2] * crNoise(s * x + 47, s * y + 47, 2.2 * s * z + 47)) / tot;
    return iso + (dir - iso) * Math.max(0, Math.min(1, Math.sqrt(tot) * 2.5));
  }
  const crAmount = (s) => { const t = Math.max(0, Math.min(1, (s - 0.09) / 0.27)); return t * t * (3 - 2 * t); };
  const crBuckle = (x, y, z, c) => crPattern(x, y, z, c, 2.6);

  function gltfLoader() {
    if (loader) return loader;
    const draco = new DRACOLoader();
    draco.setDecoderPath(DRACO_PATH);
    loader = new GLTFLoader();
    loader.setDRACOLoader(draco);
    return loader;
  }

  function parseGLB(key) {
    const b64 = (window.CAR_ASSETS || {})[key];
    if (!b64) return Promise.reject(new Error('No model data for "' + key + '" (models/' + key + '.glb.js not loaded)'));
    const bin = atob(b64), buf = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) buf[i] = bin.charCodeAt(i);
    return new Promise((resolve, reject) => gltfLoader().parse(buf.buffer, '', resolve, reject));
  }

  // seeded random numbers, so shards and cracks come out the same on every replay
  function rng(seed) {
    let a = seed >>> 0;
    return () => { a = (a + 0x6D2B79F5) >>> 0; let t = a; t = Math.imul(t ^ (t >>> 15), t | 1); t ^= t + Math.imul(t ^ (t >>> 7), t | 61); return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
  }
  const hash = (str) => { let h = 2166136261; for (let i = 0; i < str.length; i++) h = Math.imul(h ^ str.charCodeAt(i), 16777619); return h >>> 0; };

  // ---------------------------------------------------------------- environment for reflections
  let envTex = null;
  function environment(renderer) {
    if (envTex) return envTex;
    const pm = new T.PMREMGenerator(renderer);
    const room = new T.Scene();
    room.background = new T.Color(0x9aa6b2);
    const box = new T.Mesh(new T.BoxGeometry(30, 12, 30), new T.MeshBasicMaterial({ color: 0x6b7480, side: T.BackSide }));
    box.position.y = 5;
    const sky = new T.Mesh(new T.PlaneGeometry(26, 26), new T.MeshBasicMaterial({ color: 0xf2f5f8 }));
    sky.rotation.x = Math.PI / 2; sky.position.y = 10.9;
    const ground = new T.Mesh(new T.PlaneGeometry(30, 30), new T.MeshBasicMaterial({ color: 0x3a3e44 }));
    ground.rotation.x = -Math.PI / 2; ground.position.y = -0.9;
    const strip = new T.Mesh(new T.PlaneGeometry(26, 2), new T.MeshBasicMaterial({ color: 0xffffff }));
    strip.position.set(0, 6, -14.5);
    room.add(box, sky, ground, strip);
    envTex = pm.fromScene(room, 0.04).texture;
    pm.dispose();
    return envTex;
  }

  // ---------------------------------------------------------------- skinning shader patch
  // 3D simplex noise (Ashima Arts / Stefan Gustavson, MIT licence) for the crumple pattern
  const NOISE = `
vec3 crMod289(vec3 x) { return x - floor(x * (1.0 / 289.0)) * 289.0; }
vec4 crMod289(vec4 x) { return x - floor(x * (1.0 / 289.0)) * 289.0; }
vec4 crPermute(vec4 x) { return crMod289(((x * 34.0) + 1.0) * x); }
float crNoise(vec3 v) {
  const vec2 C = vec2(1.0 / 6.0, 1.0 / 3.0);
  const vec4 D = vec4(0.0, 0.5, 1.0, 2.0);
  vec3 i = floor(v + dot(v, C.yyy));
  vec3 x0 = v - i + dot(i, C.xxx);
  vec3 g = step(x0.yzx, x0.xyz), l = 1.0 - g;
  vec3 i1 = min(g.xyz, l.zxy), i2 = max(g.xyz, l.zxy);
  vec3 x1 = x0 - i1 + C.xxx, x2 = x0 - i2 + C.yyy, x3 = x0 - D.yyy;
  i = crMod289(i);
  vec4 p = crPermute(crPermute(crPermute(i.z + vec4(0.0, i1.z, i2.z, 1.0)) + i.y + vec4(0.0, i1.y, i2.y, 1.0)) + i.x + vec4(0.0, i1.x, i2.x, 1.0));
  vec3 ns = 0.142857142857 * D.wyz - D.xzx;
  vec4 j = p - 49.0 * floor(p * ns.z * ns.z);
  vec4 x_ = floor(j * ns.z), y_ = floor(j - 7.0 * x_);
  vec4 x = x_ * ns.x + ns.yyyy, y = y_ * ns.x + ns.yyyy, h = 1.0 - abs(x) - abs(y);
  vec4 b0 = vec4(x.xy, y.xy), b1 = vec4(x.zw, y.zw);
  vec4 s0 = floor(b0) * 2.0 + 1.0, s1 = floor(b1) * 2.0 + 1.0, sh = -step(h, vec4(0.0));
  vec4 a0 = b0.xzyw + s0.xzyw * sh.xxyy, a1 = b1.xzyw + s1.xzyw * sh.zzww;
  vec3 p0 = vec3(a0.xy, h.x), p1 = vec3(a0.zw, h.y), p2 = vec3(a1.xy, h.z), p3 = vec3(a1.zw, h.w);
  vec4 nr = 1.79284291400159 - 0.85373472095314 * vec4(dot(p0, p0), dot(p1, p1), dot(p2, p2), dot(p3, p3));
  p0 *= nr.x; p1 *= nr.y; p2 *= nr.z; p3 *= nr.w;
  vec4 m = max(0.6 - vec4(dot(x0, x0), dot(x1, x1), dot(x2, x2), dot(x3, x3)), 0.0);
  m = m * m;
  return 42.0 * dot(m * m, vec4(dot(p0, x0), dot(p1, x1), dot(p2, x2), dot(p3, x3)));
}
// Crumpled sheet metal: noise on the part's rest shape. Where the lattice cell was compressed the
// pattern blends toward copies squeezed 2.2x along that axis, so folds run across the crush the way
// buckled panels do. (Blending fixed patterns keeps it stable; scaling the coordinates by the
// compression itself would jump to unrelated noise between neighbouring vertices.)
float crPattern(vec3 p, vec3 comp, float s) {
  float iso = crNoise(p * s);
  vec3 w = comp * comp;
  float tot = w.x + w.y + w.z;
  if (tot < 1e-4) return iso;
  float dir = (w.x * crNoise(p * vec3(2.2 * s, s, s) + 17.0) + w.y * crNoise(p * vec3(s, 2.2 * s, s) + 31.0) + w.z * crNoise(p * vec3(s, s, 2.2 * s) + 47.0)) / tot;
  return mix(iso, dir, clamp(sqrt(tot) * 2.5, 0.0, 1.0));
}
float crFold(vec3 p, vec3 comp, float scale) { float n = crPattern(p, comp, scale); return 0.75 - 2.0 * sqrt(n * n + 0.012); }
float crAmount(float strain) { return smoothstep(0.09, 0.36, strain); }
float crBuckle(vec3 p, vec3 comp) { return crPattern(p, comp, 2.6); }
`;
  const DECL = `
uniform sampler2D nodeTex;
uniform float uSkin;
uniform float uCrumple;
attribute vec4 skinA;
attribute vec4 skinB;
attribute vec3 skinT;
attribute vec3 skinN;
attribute vec3 skinS;
attribute vec3 skinR;
varying float vStrain;
varying vec3 vRest;
varying vec3 vComp;
${NOISE}
vec4 skinNode(float i) { return texelFetch(nodeTex, ivec2(int(i), 0), 0); }
// position, normal, plastic strain, and the compression of the lattice cell along x, y, z
// (0 = rest length, 0.8 = crushed to a fifth); the displacement direction (smooth normal) too
void skinCompute(out vec3 pos, out vec3 nrm, out float strain, out vec3 comp, out vec3 dir) {
  vec4 n0 = skinNode(skinA.x), n1 = skinNode(skinA.y), n2 = skinNode(skinA.z), n3 = skinNode(skinA.w);
  vec4 n4 = skinNode(skinB.x), n5 = skinNode(skinB.y), n6 = skinNode(skinB.z), n7 = skinNode(skinB.w);
  float tx = skinT.x, ty = skinT.y, tz = skinT.z, ux = 1.0 - tx, uy = 1.0 - ty, uz = 1.0 - tz;
  vec4 p = ux*uy*uz*n0 + tx*uy*uz*n1 + ux*ty*uz*n2 + tx*ty*uz*n3 + ux*uy*tz*n4 + tx*uy*tz*n5 + ux*ty*tz*n6 + tx*ty*tz*n7;
  pos = p.xyz; strain = p.w;
  vec3 g1 = uy*uz*(n1.xyz-n0.xyz) + ty*uz*(n3.xyz-n2.xyz) + uy*tz*(n5.xyz-n4.xyz) + ty*tz*(n7.xyz-n6.xyz);
  vec3 g2 = ux*uz*(n2.xyz-n0.xyz) + tx*uz*(n3.xyz-n1.xyz) + ux*tz*(n6.xyz-n4.xyz) + tx*tz*(n7.xyz-n5.xyz);
  vec3 g3 = ux*uy*(n4.xyz-n0.xyz) + tx*uy*(n5.xyz-n1.xyz) + ux*ty*(n6.xyz-n2.xyz) + tx*ty*(n7.xyz-n3.xyz);
  vec3 c23 = cross(g2, g3), c31 = cross(g3, g1), c12 = cross(g1, g2);
  nrm = skinN.x * c23 + skinN.y * c31 + skinN.z * c12;
  dir = skinS.x * c23 + skinS.y * c31 + skinS.z * c12;
  comp = clamp(1.0 - vec3(length(g1), length(g2), length(g3)) / max(skinR, vec3(1e-4)), 0.0, 0.8);
}
`;
  // The panels also buckle out of their surface (along the smoothed normal, so hard edges stay
  // closed): broad buckles only, as the mesh's vertices are 3-8 cm apart; the folds are shading.
  const CRUMPLE_VERTEX = `
#ifdef CRUMPLE
  { float ca = uCrumple * crAmount(vStrain); if (ca > 0.0) skinnedPos += normalize(skinDir + vec3(1e-6)) * ca * crBuckle(position, vComp); }
#endif
`;
  const NORMAL_CHUNK = `
vec3 objectNormal = vec3(normal);
vec3 skinnedPos = position;
vec3 skinDir = vec3(0.0);
vStrain = 0.0; vRest = position; vComp = vec3(0.0);
if (uSkin > 0.5) {
  skinCompute(skinnedPos, objectNormal, vStrain, vComp, skinDir);
${CRUMPLE_VERTEX}
}
#ifdef USE_TANGENT
vec3 objectTangent = vec3(tangent.xyz);
#endif
`;
  const POS_CHUNK = `vec3 transformed = skinnedPos;`;
  // for shaders without the normal chunk (depth, unlit overlay): compute the position here
  const POS_ONLY_CHUNK = `
vec3 transformed = vec3(position);
if (uSkin > 0.5) {
  vec3 objectNormal0, skinDir; vec3 skinnedPos = transformed;
  skinCompute(skinnedPos, objectNormal0, vStrain, vComp, skinDir);
${CRUMPLE_VERTEX}
  transformed = skinnedPos;
}
`;
  const FRAG_DECL = `
varying float vStrain;
varying vec3 vRest;
varying vec3 vComp;
uniform float uStrainMode;
uniform float uCrumple;
${NOISE}
vec3 strainRamp(float t) {
  vec3 c0 = vec3(0.788, 0.808, 0.839), c1 = vec3(0.941, 0.894, 0.259), c2 = vec3(0.902, 0.624, 0.0), c3 = vec3(0.659, 0.220, 0.039);
  if (t < 0.12) return mix(c0, c1, t / 0.12);
  if (t < 0.35) return mix(c1, c2, (t - 0.12) / 0.23);
  return mix(c2, c3, (t - 0.35) / 0.65);
}
`;
  // Damaged paint: creases darken, and along the sharpest folds of the most strained metal the paint
  // cracks off to grey primer and bare steel.
  const FRAG_COLOR = `
#include <color_fragment>
float crA = uCrumple > 0.0 ? crAmount(vStrain) : 0.0;
// fold detail finer than a few pixels would only shimmer: fade it out with distance
float crPx = length(fwidth(vRest)) * 9.0 * (1.0 + 1.2 * max(vComp.x, max(vComp.y, vComp.z)));
float crFine = 1.0 - smoothstep(0.15, 0.45, crPx);
float crF = 0.0;
// (some stretches fold more than others)
if (crA > 0.001) crF = (0.75 * crFold(vRest, vComp, 5.0) + 0.25 * crFine * crFold(vRest + 7.3, vComp, 9.0)) * (0.65 + 0.35 * crNoise(vRest * 1.7 + 5.0));
float crChip = 0.0;
{
  float st = clamp(vStrain, 0.0, 1.0);
  if (uStrainMode > 0.5) diffuseColor.rgb = strainRamp(sqrt(st));
  else {
    diffuseColor.rgb *= 1.0 - 0.14 * min(1.0, st * 3.0) - 0.12 * crA * (1.0 - smoothstep(-0.8, 0.0, crF));
    if (crA > 0.001) {
      // paint cracks off along the sharpest crease lines, showing grey primer and steel
      crChip = 0.75 * smoothstep(0.40, 0.50, crF) * smoothstep(0.15, 0.45, st);
      diffuseColor.rgb = mix(diffuseColor.rgb, vec3(0.38, 0.39, 0.40), crChip);
    }
  }
}
`;
  // the folds' fine relief shades the surface (bump from the fold height's screen-space slope)
  const FRAG_BUMP = `
#include <normal_fragment_maps>
// (derivatives outside any branch: inside one they are undefined)
float crH = crA * 0.009 * crF * (1.0 - 0.6 * smoothstep(0.3, 0.9, crPx * 0.5));
vec3 crSx = dFdx(-vViewPosition), crSy = dFdy(-vViewPosition);
vec2 crDH = vec2(dFdx(crH), dFdy(crH));
vec3 crR1 = cross(crSy, normal), crR2 = cross(normal, crSx);
float crDet = dot(crSx, crR1) * faceDirection;
vec3 crGrad = sign(crDet) * (crDH.x * crR1 + crDH.y * crR2);
if (crA > 0.001 && uStrainMode < 0.5) normal = normalize(abs(crDet) * normal - crGrad);
`;
  const FRAG_BUMP_COAT = `
#include <clearcoat_normal_fragment_maps>
#ifdef USE_CLEARCOAT
if (crA > 0.001 && uStrainMode < 0.5) clearcoatNormal = normalize(abs(crDet) * clearcoatNormal - crGrad);
#endif
`;
  const FRAG_ROUGH = `
#include <roughnessmap_fragment>
roughnessFactor = mix(roughnessFactor, 0.72, crChip);
`;
  function patchSkin(mat, uniforms, mode) {   // mode: 'strain' | 'plain' | 'posOnly'
    mat.onBeforeCompile = (sh) => {
      sh.uniforms.nodeTex = uniforms.nodeTex; sh.uniforms.uSkin = uniforms.uSkin; sh.uniforms.uStrainMode = uniforms.uStrainMode; sh.uniforms.uCrumple = uniforms.uCrumple;
      const def = mode === 'strain' ? '#define CRUMPLE\n' : '';
      sh.vertexShader = def + sh.vertexShader.replace('#include <common>', '#include <common>\n' + DECL);
      if (mode === 'posOnly') sh.vertexShader = sh.vertexShader.replace('#include <begin_vertex>', POS_ONLY_CHUNK);
      else sh.vertexShader = sh.vertexShader.replace('#include <beginnormal_vertex>', NORMAL_CHUNK).replace('#include <begin_vertex>', POS_CHUNK);
      if (mode === 'strain') {
        sh.fragmentShader = sh.fragmentShader
          .replace('#include <common>', '#include <common>\n' + FRAG_DECL)
          .replace('#include <color_fragment>', FRAG_COLOR)
          .replace('#include <normal_fragment_maps>', FRAG_BUMP)
          .replace('#include <clearcoat_normal_fragment_maps>', FRAG_BUMP_COAT)
          .replace('#include <roughnessmap_fragment>', FRAG_ROUGH);
      }
    };
    mat.customProgramCacheKey = () => 'carskin2-' + mode;
    return mat;
  }
  // a part that came off: its shape (folds included) is baked into the geometry; the paint damage
  // and fold shading come from its rest position, strain and cell compression stored per vertex
  function patchFrozen(mat, uniforms) {
    mat.onBeforeCompile = (sh) => {
      sh.uniforms.uStrainMode = uniforms.uStrainMode; sh.uniforms.uCrumple = uniforms.uCrumple;
      sh.vertexShader = sh.vertexShader
        .replace('#include <common>', '#include <common>\nattribute vec3 aRest;\nattribute float aStrain;\nattribute vec3 aComp;\nvarying float vStrain;\nvarying vec3 vRest;\nvarying vec3 vComp;')
        .replace('#include <begin_vertex>', '#include <begin_vertex>\nvRest = aRest; vStrain = aStrain; vComp = aComp;');
      sh.fragmentShader = sh.fragmentShader
        .replace('#include <common>', '#include <common>\n' + FRAG_DECL)
        .replace('#include <color_fragment>', FRAG_COLOR)
        .replace('#include <normal_fragment_maps>', FRAG_BUMP)
        .replace('#include <clearcoat_normal_fragment_maps>', FRAG_BUMP_COAT)
        .replace('#include <roughnessmap_fragment>', FRAG_ROUGH);
    };
    mat.customProgramCacheKey = () => 'carfrozen';
    return mat;
  }
  function depthMaterial(uniforms) {
    const m = new T.MeshDepthMaterial({ depthPacking: T.RGBADepthPacking });
    m.onBeforeCompile = (sh) => {
      sh.uniforms.nodeTex = uniforms.nodeTex; sh.uniforms.uSkin = uniforms.uSkin; sh.uniforms.uCrumple = uniforms.uCrumple;
      sh.vertexShader = '#define CRUMPLE\n' + sh.vertexShader
        .replace('#include <common>', '#include <common>\n' + DECL)
        .replace('#include <begin_vertex>', POS_ONLY_CHUNK);
    };
    m.customProgramCacheKey = () => 'carskindepth2';
    return m;
  }
  // tyres never go through the ground: a burst tyre on a dropped hub flattens into a contact patch
  function patchTyre(mat) {
    mat.onBeforeCompile = (sh) => {
      sh.vertexShader = sh.vertexShader.replace('#include <project_vertex>', `
vec4 wpos = modelMatrix * vec4(transformed, 1.0);
wpos.y = max(wpos.y, 0.004);
vec4 mvPosition = viewMatrix * wpos;
gl_Position = projectionMatrix * mvPosition;`);
    };
    mat.customProgramCacheKey = () => 'tyreflat';
    return mat;
  }

  // ---------------------------------------------------------------- materials by class
  function makeMaterial(info, env) {
    const c = new T.Color().setRGB(info.color[0], info.color[1], info.color[2], T.LinearSRGBColorSpace);
    switch (info.cls) {
      case 'paint': return new T.MeshPhysicalMaterial({ color: c, metalness: 0.35, roughness: 0.38, clearcoat: 1, clearcoatRoughness: 0.08, envMap: env, envMapIntensity: 0.9 });
      case 'chrome': return new T.MeshStandardMaterial({ color: 0xd8dde3, metalness: 1, roughness: 0.16, envMap: env, envMapIntensity: 1.1 });
      case 'glass': return new T.MeshPhysicalMaterial({ color: 0x0d141c, metalness: 0, roughness: 0.04, transparent: true, opacity: 0.42, envMap: env, envMapIntensity: 1.2, depthWrite: false, side: T.DoubleSide });
      case 'light': return new T.MeshStandardMaterial({ color: c, metalness: 0.2, roughness: 0.15, emissive: c.clone().multiplyScalar(info.emit ? 0.35 : 0.08), transparent: true, opacity: 0.85, envMap: env });
      case 'tire': return new T.MeshStandardMaterial({ color: 0x141517, roughness: 0.92, metalness: 0 });
      case 'rim': return new T.MeshStandardMaterial({ color: c, metalness: 0.9, roughness: 0.28, envMap: env });
      case 'mech': return new T.MeshStandardMaterial({ color: c, metalness: 0.5, roughness: 0.5, envMap: env, envMapIntensity: 0.5 });
      default: return new T.MeshStandardMaterial({ color: c, metalness: info.metal > 0.5 ? 0.8 : 0.1, roughness: Math.max(0.3, info.rough), envMap: env, envMapIntensity: 0.6 });
    }
  }

  // CPU version of the shader skinning (for freezing a part's shape when it comes off, and for
  // placing shards): world position and normal of vertex v for node positions X (3 per node).
  // extra (optional): { S: skinS, R: skinR, strain: per-node Uint8 } -> also fills extra.dir (unit
  // smoothed normal), extra.comp (cell compression) and extra.st (plastic strain, 1 = 50%)
  function skinVertex(X, A, B, Tt, Nn, v, outP, outN, extra) {
    const id = [A[4 * v], A[4 * v + 1], A[4 * v + 2], A[4 * v + 3], B[4 * v], B[4 * v + 1], B[4 * v + 2], B[4 * v + 3]];
    const tx = Tt[3 * v], ty = Tt[3 * v + 1], tz = Tt[3 * v + 2], ux = 1 - tx, uy = 1 - ty, uz = 1 - tz;
    const w = [ux * uy * uz, tx * uy * uz, ux * ty * uz, tx * ty * uz, ux * uy * tz, tx * uy * tz, ux * ty * tz, tx * ty * tz];
    const n = (c, d) => X[3 * id[c] + d];
    for (let d = 0; d < 3; d++) {
      let p = 0;
      for (let c = 0; c < 8; c++) p += w[c] * n(c, d);
      outP[d] = p;
    }
    if (!outN) return;
    const g1 = [0, 0, 0], g2 = [0, 0, 0], g3 = [0, 0, 0];
    for (let d = 0; d < 3; d++) {
      g1[d] = uy * uz * (n(1, d) - n(0, d)) + ty * uz * (n(3, d) - n(2, d)) + uy * tz * (n(5, d) - n(4, d)) + ty * tz * (n(7, d) - n(6, d));
      g2[d] = ux * uz * (n(2, d) - n(0, d)) + tx * uz * (n(3, d) - n(1, d)) + ux * tz * (n(6, d) - n(4, d)) + tx * tz * (n(7, d) - n(5, d));
      g3[d] = ux * uy * (n(4, d) - n(0, d)) + tx * uy * (n(5, d) - n(1, d)) + ux * ty * (n(6, d) - n(2, d)) + tx * ty * (n(7, d) - n(3, d));
    }
    const cr = (a, b) => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
    const c23 = cr(g2, g3), c31 = cr(g3, g1), c12 = cr(g1, g2);
    const turn = (N, out) => {
      const nx = N[3 * v], ny = N[3 * v + 1], nz = N[3 * v + 2];
      const ox = nx * c23[0] + ny * c31[0] + nz * c12[0], oy = nx * c23[1] + ny * c31[1] + nz * c12[1], oz = nx * c23[2] + ny * c31[2] + nz * c12[2];
      const l = Math.hypot(ox, oy, oz) || 1;
      out[0] = ox / l; out[1] = oy / l; out[2] = oz / l;
    };
    turn(Nn, outN);
    if (!extra) return;
    turn(extra.S, extra.dir);
    const R = extra.R, lg = [Math.hypot(...g1), Math.hypot(...g2), Math.hypot(...g3)];
    for (let d = 0; d < 3; d++) extra.comp[d] = Math.max(0, Math.min(0.8, 1 - lg[d] / Math.max(1e-4, R[3 * v + d])));
    let st = 0;
    for (let c = 0; c < 8; c++) st += w[c] * extra.strain[id[c]];
    extra.st = st / 255;
  }

  // ---------------------------------------------------------------- windshield cracks
  function drawCracks(ctx, S, origins) {
    ctx.clearRect(0, 0, S, S);
    for (const o of origins) {
      const r = rng(o.seed), cx = o.u * S, cy = (1 - o.v) * S;
      const rays = 14 + Math.floor(r() * 8), pts = [];
      for (let i = 0; i < rays; i++) {
        let a = (i + r() * 0.6) / rays * Math.PI * 2, x = cx, y = cy;
        const len = S * (0.08 + r() * 0.3 * o.size), path = [[x, y]];
        for (let d = 0; d < len;) {
          const step = 6 + r() * 12;
          a += (r() - 0.5) * 0.5; x += Math.cos(a) * step; y += Math.sin(a) * step; d += step;
          path.push([x, y]);
        }
        pts.push(path);
      }
      const stroke = (w, a) => {
        ctx.strokeStyle = `rgba(235,242,246,${a})`; ctx.lineWidth = w;
        for (const path of pts) { ctx.beginPath(); ctx.moveTo(path[0][0], path[0][1]); for (const p of path) ctx.lineTo(p[0], p[1]); ctx.stroke(); }
        // rings joining neighbouring rays
        for (const ring of [2, 5, 9, 14]) {
          ctx.beginPath();
          for (let i = 0; i < pts.length; i++) {
            const pa = pts[i], pb = pts[(i + 1) % pts.length];
            if (pa.length <= ring || pb.length <= ring) continue;
            ctx.moveTo(pa[ring][0], pa[ring][1]);
            ctx.quadraticCurveTo((pa[ring][0] + pb[ring][0]) / 2 + (r() - 0.5) * 6, (pa[ring][1] + pb[ring][1]) / 2 + (r() - 0.5) * 6, pb[ring][0], pb[ring][1]);
          }
          ctx.stroke();
        }
      };
      stroke(7, 0.22); stroke(2.4, 0.95);
      ctx.fillStyle = 'rgba(235,242,246,0.6)'; ctx.beginPath(); ctx.arc(cx, cy, 5 + 6 * o.size, 0, Math.PI * 2); ctx.fill();
    }
  }

  // ---------------------------------------------------------------- one car
  async function create(key, spec, lat, renderer) {
    const gltf = await parseGLB(key);
    const env = environment(renderer);
    const n = lat.n;
    const nodeData = new Float32Array(4 * n);
    const nodeTex = new T.DataTexture(nodeData, n, 1, T.RGBAFormat, T.FloatType);
    nodeTex.needsUpdate = true;
    const uniforms = { nodeTex: { value: nodeTex }, uSkin: { value: 0 }, uStrainMode: { value: 0 }, uCrumple: { value: CRUMPLE_DEPTH } };
    const depthMat = depthMaterial(uniforms);
    // the body in flat black, deformed like the real thing: hides what glows behind it (scene.js bloom)
    const blackMat = patchSkin(new T.MeshBasicMaterial({ color: 0x000000 }), uniforms, 'posOnly');
    const matCache = {}, wheelMats = {}, plainMats = {}, frozenMats = {};
    const extraInfo = { 'mech:engine': { cls: 'mech', color: [0.09, 0.09, 0.1], metal: 0.6, rough: 0.5 }, 'mech:cover': { cls: 'mech', color: [0.2, 0.21, 0.23], metal: 0.4, rough: 0.4 } };
    const infoOf = (name) => (spec.materials || {})[name] || extraInfo[name] || { cls: 'paint', color: [0.5, 0.5, 0.5], metal: 0, rough: 0.5 };
    const materialFor = (name, kind) => {
      const info = infoOf(name);
      const cache = kind === 'wheel' ? wheelMats : kind === 'plain' ? plainMats : kind === 'frozen' ? frozenMats : matCache;
      if (!cache[name]) {
        let m = makeMaterial(info, env);
        m.userData.cls = info.cls;
        m.userData.baseOpacity = m.opacity; m.userData.baseTransparent = m.transparent;
        if (kind === 'wheel') { if (info.cls === 'tire') patchTyre(m); }
        else if (kind === 'frozen') patchFrozen(m, uniforms);
        else if (kind !== 'plain') patchSkin(m, uniforms, info.cls !== 'glass' && info.cls !== 'light' ? 'strain' : 'plain');
        cache[name] = m;
      }
      return cache[name];
    };

    const group = new T.Group();
    group.matrixAutoUpdate = false;
    const bodyMeshes = [], parts = {};
    const wheelGeo = [];
    const SZ = [0, 0, 0], idx = new Int32Array(8), tt = new Float64Array(3);
    gltf.scene.updateMatrixWorld(true);
    gltf.scene.traverse((obj) => {
      if (!obj.isMesh) return;
      let top = obj;
      while (top.parent && !/^(RIGID_|DEFORM_|BRITTLE_|BREAKAWAY_)/.test(top.name)) top = top.parent;
      const part = top.name.replace(/_\d+$/, '');
      const geo = obj.geometry.clone();
      geo.applyMatrix4(obj.matrixWorld);
      if (part === 'RIGID_Mech_Wheel') { wheelGeo.push({ geo, mat: materialFor(obj.material.name, 'wheel') }); return; }
      addSkinned(geo, obj.material.name, part);
    });
    // Skin a car-local geometry to the lattice and add it as part of `part`.
    function addSkinned(geo, matName, part) {
      const pos = geo.attributes.position, nrm = geo.attributes.normal, nv = pos.count;
      const skA = new Float32Array(4 * nv), skB = new Float32Array(4 * nv), skT = new Float32Array(3 * nv), skN = new Float32Array(3 * nv);
      const skS = new Float32Array(3 * nv), skR = new Float32Array(3 * nv);
      // smoothed normals (vertices split at hard edges share one), for the crumple displacement
      const smooth = new Map(), key = (v) => `${Math.round(pos.getX(v) * 2000)},${Math.round(pos.getY(v) * 2000)},${Math.round(pos.getZ(v) * 2000)}`;
      for (let v = 0; v < nv; v++) { const k = key(v), s = smooth.get(k) || [0, 0, 0]; s[0] += nrm.getX(v); s[1] += nrm.getY(v); s[2] += nrm.getZ(v); smooth.set(k, s); }
      for (let v = 0; v < nv; v++) {
        P.embedPoint(lat, pos.getX(v), pos.getY(v), pos.getZ(v), idx, 0, tt, 0, SZ);
        for (let c = 0; c < 4; c++) { skA[4 * v + c] = idx[c]; skB[4 * v + c] = idx[4 + c]; }
        skT[3 * v] = tt[0]; skT[3 * v + 1] = tt[1]; skT[3 * v + 2] = tt[2];
        skN[3 * v] = nrm.getX(v) * SZ[0]; skN[3 * v + 1] = nrm.getY(v) * SZ[1]; skN[3 * v + 2] = nrm.getZ(v) * SZ[2];
        const s = smooth.get(key(v)), sl = Math.hypot(s[0], s[1], s[2]) || 1;
        skS[3 * v] = s[0] / sl * SZ[0]; skS[3 * v + 1] = s[1] / sl * SZ[1]; skS[3 * v + 2] = s[2] / sl * SZ[2];
        skR[3 * v] = SZ[0]; skR[3 * v + 1] = SZ[1]; skR[3 * v + 2] = SZ[2];   // the cell's rest edge lengths
      }
      geo.setAttribute('skinA', new T.BufferAttribute(skA, 4));
      geo.setAttribute('skinB', new T.BufferAttribute(skB, 4));
      geo.setAttribute('skinT', new T.BufferAttribute(skT, 3));
      geo.setAttribute('skinN', new T.BufferAttribute(skN, 3));
      geo.setAttribute('skinS', new T.BufferAttribute(skS, 3));
      geo.setAttribute('skinR', new T.BufferAttribute(skR, 3));
      const mat = materialFor(matName, 'skin');
      const mesh = new T.Mesh(geo, mat);
      mesh.name = part;
      mesh.userData.matName = matName;
      mesh.castShadow = mat.userData.cls !== 'glass';
      mesh.receiveShadow = true;
      mesh.customDepthMaterial = depthMat;
      mesh.userData.blackMat = blackMat;
      mesh.frustumCulled = false;
      mesh.layers.set(1);
      mesh.renderOrder = mat.transparent ? 2 : 0;
      group.add(mesh);
      bodyMeshes.push(mesh);
      (parts[part] = parts[part] || []).push(mesh);
    }
    // A plain engine block and radiator for a model that has none, so an open engine bay isn't
    // empty; they sit in the lattice's engine zone and crush with it.
    if (spec.addEngine) {
      const E = spec.engine, x0 = spec.xMin + E.u0, x1 = spec.xMin + E.u1, yb = spec.yBottom + 0.08, yt = Math.min(E.yMax, spec.yBottom + 0.62);
      const box = (sx, sy, sz, x, y, z, name) => { const g = new T.BoxGeometry(sx, sy, sz); g.translate(x, y, z); addSkinned(g, name, 'RIGID_Mech_Engine'); };
      box(x1 - x0, yt - yb, 0.62, 0.5 * (x0 + x1), 0.5 * (yb + yt), 0, 'mech:engine');
      box(0.75 * (x1 - x0), 0.06, 0.5, 0.5 * (x0 + x1), yt + 0.03, 0, 'mech:cover');
      box(0.06, 0.45, 1.25, x1 + 0.12, spec.yBottom + 0.3, 0, 'mech:engine');
    }

    // wheels: hub at the origin, axle along +z (outboard on the right); mirrored for the left
    const wheels = [];
    for (const k of ['RL', 'RR', 'FL', 'FR']) {
      const w = new T.Group();
      const left = k[1] === 'L';
      for (const { geo, mat } of wheelGeo) {
        const m = new T.Mesh(geo, mat);
        m.castShadow = true; m.receiveShadow = true; m.layers.set(1);
        if (left) m.scale.z = -1;
        w.add(m);
      }
      const h = spec.hubs[k];
      const hub = new T.Vector3(h[0], h[1], h[2]);
      const ei = new Int32Array(8), et = new Float64Array(3);
      P.embedPoint(lat, hub.x, hub.y, hub.z, ei, 0, et, 0, null);
      wheels.push({ key: k, group: w, hub, ei, et, front: k[0] === 'F', left, spin: 0 });
      group.add(w);
    }

    // windshield crack overlay: planar coordinates on the pane, a canvas texture drawn on demand
    const crack = { meshes: [], canvas: null, ctx: null, tex: null, frame: null, drawn: '' };
    const wsInfo = (spec.parts || []).find(p => p.name === 'BRITTLE_GlassWS');
    if (wsInfo && parts.BRITTLE_GlassWS) {
      const c = new T.Vector3(...wsInfo.centre), nn = new T.Vector3(...wsInfo.normal);
      const a1 = new T.Vector3().crossVectors(nn, new T.Vector3(0, 1, 0)).normalize(), a2 = new T.Vector3().crossVectors(nn, a1).normalize();
      let lo1 = Infinity, hi1 = -Infinity, lo2 = Infinity, hi2 = -Infinity;
      const tmp = new T.Vector3();
      for (const m of parts.BRITTLE_GlassWS) {
        const p = m.geometry.attributes.position;
        for (let v = 0; v < p.count; v++) { tmp.fromBufferAttribute(p, v).sub(c); const u = tmp.dot(a1), w = tmp.dot(a2); lo1 = Math.min(lo1, u); hi1 = Math.max(hi1, u); lo2 = Math.min(lo2, w); hi2 = Math.max(hi2, w); }
      }
      crack.frame = { c, a1, a2, lo1, hi1, lo2, hi2 };
      crack.canvas = document.createElement('canvas'); crack.canvas.width = crack.canvas.height = 1024;
      crack.ctx = crack.canvas.getContext('2d');
      crack.tex = new T.CanvasTexture(crack.canvas);
      const cm = patchSkin(new T.MeshBasicMaterial({ map: crack.tex, transparent: true, depthWrite: false, side: T.DoubleSide, polygonOffset: true, polygonOffsetFactor: -4, polygonOffsetUnits: -4 }), uniforms, 'posOnly');
      for (const m of parts.BRITTLE_GlassWS) {
        const p = m.geometry.attributes.position, uv = new Float32Array(2 * p.count);
        for (let v = 0; v < p.count; v++) { tmp.fromBufferAttribute(p, v).sub(c); uv[2 * v] = (tmp.dot(a1) - lo1) / (hi1 - lo1); uv[2 * v + 1] = (tmp.dot(a2) - lo2) / (hi2 - lo2); }
        m.geometry.setAttribute('uv', new T.BufferAttribute(uv, 2));
        const o = new T.Mesh(m.geometry, cm);
        o.visible = false; o.frustumCulled = false; o.renderOrder = 3; o.layers.set(0);
        group.add(o);
        crack.meshes.push(o);
      }
    }
    const crackUV = (p) => {
      const f = crack.frame, d = new T.Vector3(p[0], p[1], p[2]).sub(f.c);
      return { u: Math.min(1, Math.max(0, (d.dot(f.a1) - f.lo1) / (f.hi1 - f.lo1))), v: Math.min(1, Math.max(0, (d.dot(f.a2) - f.lo2) / (f.hi2 - f.lo2))) };
    };

    let strainMode = false, xray = false;
    const allMats = () => Object.values(matCache).concat(Object.values(wheelMats));
    const xyz = new Float32Array(3 * n);
    const cabinQ = new T.Quaternion(), qa = new T.Quaternion(), qb = new T.Quaternion(), FLIP = new T.Quaternion().setFromAxisAngle(new T.Vector3(1, 0, 0), Math.PI);
    let D = null;   // destruction state for the current result

    // ---------------------------------------------------------------- destruction
    // Body pose at time t from the recorded frames (bodies after the wall's bricks); between a
    // body's spawn and the next recorded frame, blend from its spawn pose.
    function bodyPose(F, k, k2, s, t, d, outP, outQ) {
      const o = 7 * d.body, A = F.bricks[k], B = F.bricks[k2];
      const t0 = F.t[k] < d.t ? d.t : F.t[k], fa = F.t[k] < d.t ? null : A;
      const ss = F.t[k2] > t0 ? Math.min(1, Math.max(0, (t - t0) / (F.t[k2] - t0))) : 0;
      const ax = fa ? fa[o] : d.pos[0], ay = fa ? fa[o + 1] : d.pos[1], az = fa ? fa[o + 2] : d.pos[2];
      if (fa) qa.set(fa[o + 3], fa[o + 4], fa[o + 5], fa[o + 6]); else qa.set(d.quat[0], d.quat[1], d.quat[2], d.quat[3]);
      if (F.t[k2] >= d.t) qb.set(B[o + 3], B[o + 4], B[o + 5], B[o + 6]); else qb.copy(qa);
      const bx = F.t[k2] >= d.t ? B[o] : ax, by = F.t[k2] >= d.t ? B[o + 1] : ay, bz = F.t[k2] >= d.t ? B[o + 2] : az;
      outP.set(ax + (bx - ax) * ss, ay + (by - ay) * ss, az + (bz - az) * ss);
      outQ.copy(qa).slerp(qb, ss);
    }
    // a frozen copy of a part's meshes, in its debris body's frame, keeping its crumple folds and
    // damaged paint (strain: the lattice's plastic strain when it came off)
    function debrisMeshes(d, strain) {
      const g = new T.Group(), c0 = new T.Vector3(...d.pos), q0inv = new T.Quaternion(...d.quat).invert();
      const pw = [0, 0, 0], nw = [0, 0, 0], v3 = new T.Vector3();
      for (const m of parts[d.name] || []) {
        const src = m.geometry, A = src.attributes.skinA.array, B = src.attributes.skinB.array, Tt = src.attributes.skinT.array, Nn = src.attributes.skinN.array;
        const nv = src.attributes.position.count, pos = new Float32Array(3 * nv), nrm = new Float32Array(3 * nv);
        const crumpled = !['glass', 'light'].includes(m.material.userData.cls);
        const ex = { S: src.attributes.skinS.array, R: src.attributes.skinR.array, strain, dir: [0, 0, 0], comp: [0, 0, 0], st: 0 };
        const aStrain = new Float32Array(nv), aComp = new Float32Array(3 * nv), rest = src.attributes.position;
        for (let v = 0; v < nv; v++) {
          skinVertex(d.X, A, B, Tt, Nn, v, pw, nw, crumpled ? ex : null);
          if (crumpled) {
            const rx = rest.getX(v), ry = rest.getY(v), rz = rest.getZ(v), a = CRUMPLE_DEPTH * crAmount(ex.st);
            if (a > 0) { const h = a * crBuckle(rx, ry, rz, ex.comp); for (let k = 0; k < 3; k++) pw[k] += ex.dir[k] * h; }
            aStrain[v] = ex.st; aComp[3 * v] = ex.comp[0]; aComp[3 * v + 1] = ex.comp[1]; aComp[3 * v + 2] = ex.comp[2];
          }
          v3.set(pw[0], pw[1], pw[2]).sub(c0).applyQuaternion(q0inv); pos[3 * v] = v3.x; pos[3 * v + 1] = v3.y; pos[3 * v + 2] = v3.z;
          v3.set(nw[0], nw[1], nw[2]).applyQuaternion(q0inv); nrm[3 * v] = v3.x; nrm[3 * v + 1] = v3.y; nrm[3 * v + 2] = v3.z;
        }
        const geo = new T.BufferGeometry();
        geo.setAttribute('position', new T.BufferAttribute(pos, 3));
        geo.setAttribute('normal', new T.BufferAttribute(nrm, 3));
        if (crumpled) { geo.setAttribute('aRest', rest); geo.setAttribute('aStrain', new T.BufferAttribute(aStrain, 1)); geo.setAttribute('aComp', new T.BufferAttribute(aComp, 3)); }
        geo.setIndex(src.index);
        const mesh = new T.Mesh(geo, materialFor(m.userData.matName, crumpled ? 'frozen' : 'plain'));
        mesh.castShadow = true; mesh.receiveShadow = true; mesh.layers.set(1);
        g.add(mesh);
      }
      g.visible = false;
      return g;
    }
    // Shards of a broken pane or lamp: start on the pane at the break, with the pane's velocity
    // plus a burst; fall, bounce and settle. Paths are precomputed as up to 6 ballistic segments.
    function shards(gb, F, rigidBarrier) {
      const info = (spec.parts || []).find(p => p.name === gb.name), meshes = (parts[gb.name] || []).filter(m => m.material.userData.cls === (gb.lamp ? 'light' : 'glass'));
      if (!info || !meshes.length) return null;
      const r = rng(hash(gb.name) ^ Math.round(gb.t * 1e5));
      const count = gb.lamp ? Math.max(20, Math.min(80, Math.round(info.area * 120))) : Math.max(60, Math.min(260, Math.round(info.area * 350)));
      const X = F.pos[gb.frame], ax = F.axes[gb.frame];
      const fv = new T.Vector3(ax[3], ax[4], ax[5]), uv = new T.Vector3(ax[6], ax[7], ax[8]), lv = new T.Vector3().crossVectors(fv, uv);
      const nCar = info.normal || [0, 0, 0];
      const nW = new T.Vector3().addScaledVector(fv, nCar[0]).addScaledVector(uv, nCar[1]).addScaledVector(lv, nCar[2]).normalize();
      const SEG = 7, seg = new Float32Array(count * SEG * 7), nseg = new Uint8Array(count), spin = new Float32Array(4 * count), size = new Float32Array(count);
      const pw = [0, 0, 0];
      for (let i = 0; i < count; i++) {
        // a random point on a random triangle of the pane, placed by the skinning at the break
        const m = meshes[Math.floor(r() * meshes.length)], g = m.geometry, ix = g.index.array;
        const tri = Math.floor(r() * (ix.length / 3)), A = g.attributes.skinA.array, B = g.attributes.skinB.array, Tt = g.attributes.skinT.array, Nn = g.attributes.skinN.array;
        let a = r(), b = r(); if (a + b > 1) { a = 1 - a; b = 1 - b; }
        const p = [0, 0, 0];
        for (const [vi, w] of [[ix[3 * tri], 1 - a - b], [ix[3 * tri + 1], a], [ix[3 * tri + 2], b]]) { skinVertex(X, A, B, Tt, Nn, vi, pw, null); p[0] += w * pw[0]; p[1] += w * pw[1]; p[2] += w * pw[2]; }
        const out = r() < 0.6 ? 1 : -1, burst = gb.lamp ? 0.8 + r() * 2.2 : 0.4 + r() * 2.0;
        const v = [gb.vel[0] + nW.x * burst * out + (r() - 0.5) * 1.2, gb.vel[1] + nW.y * burst * out + (r() - 0.2) * 1.0, gb.vel[2] + nW.z * burst * out + (r() - 0.5) * 1.2];
        let tc = 0, k = 0;
        for (; k < SEG - 1; k++) {
          const o = (i * SEG + k) * 7;
          seg[o] = tc; seg[o + 1] = p[0]; seg[o + 2] = p[1]; seg[o + 3] = p[2]; seg[o + 4] = v[0]; seg[o + 5] = v[1]; seg[o + 6] = v[2];
          const y0 = Math.max(0.006, p[1]), th = (v[1] + Math.sqrt(v[1] * v[1] + 2 * GRAV * (y0 - 0.006))) / GRAV;
          p[0] += v[0] * th; p[1] = 0.006; p[2] += v[2] * th;
          v[1] = -(v[1] - GRAV * th) * 0.28; v[0] *= 0.5; v[2] *= 0.5;
          tc += th;
          if (Math.hypot(v[0], v[1], v[2]) < 0.35) { k++; break; }
        }
        const o = (i * SEG + k) * 7;
        seg[o] = tc; seg[o + 1] = p[0]; seg[o + 2] = p[1]; seg[o + 3] = p[2]; seg[o + 4] = seg[o + 5] = seg[o + 6] = 0;
        nseg[i] = k + 1;
        const ax3 = new T.Vector3(r() - 0.5, r() - 0.5, r() - 0.5).normalize();
        spin[4 * i] = ax3.x; spin[4 * i + 1] = ax3.y; spin[4 * i + 2] = ax3.z; spin[4 * i + 3] = 8 + r() * 30;
        size[i] = gb.lamp ? 0.012 + r() * 0.018 : 0.006 + r() * 0.011;
      }
      const geo = gb.lamp ? new T.BoxGeometry(1, 0.25, 1) : new T.TetrahedronGeometry(1);
      const lampInfo = gb.lamp ? infoOf(meshes[0].userData.matName) : null;
      const mat = gb.lamp
        ? new T.MeshStandardMaterial({ color: new T.Color().setRGB(...lampInfo.color, T.LinearSRGBColorSpace), roughness: 0.2, metalness: 0.1, transparent: true, opacity: 0.85, envMap: env })
        : new T.MeshStandardMaterial({ color: 0xc4dde4, roughness: 0.12, metalness: 0.25, transparent: true, opacity: 0.85, envMap: env, envMapIntensity: 1.4 });
      const im = new T.InstancedMesh(geo, mat, count);
      im.frustumCulled = false; im.visible = false; im.castShadow = false;
      im.instanceMatrix.setUsage(T.DynamicDrawUsage);
      return { gb, im, count, seg, nseg, spin, size, SEG, rigidBarrier };
    }
    // a part that came off (frozen meshes), or a wheel; a broken pane or lamp (shards), or the
    // laminated windshield's crack
    function addDebris(d) {
      const F = D.result.frames;
      if (d.kind === 'part') {
        let k = 0; while (k < F.t.length - 1 && F.t[k + 1] <= d.t) k++;
        const g = debrisMeshes(d, F.strain[k]); scene().add(g); D.debris.push({ d, g });
      }
      else D.wheelOff[d.key] = d;
    }
    function addPane(gb) {
      if (gb.t < 0) return;
      if (gb.laminated) { if (crack.frame) D.cracks.push({ t: gb.t, seed: hash(gb.name), size: 1, ...crackUV(gb.origin) }); return; }
      D.panes[gb.name] = gb;
      const S = shards(gb, D.result.frames, D.result.barrier === 'rigid');
      if (S) { scene().add(S.im); D.shards.push(S); }
    }
    const M4 = new T.Matrix4(), PV = new T.Vector3(), QV = new T.Quaternion(), SV = new T.Vector3(), AX = new T.Vector3();
    function updateShards(S, t) {
      const tau = t - S.gb.t;
      S.im.visible = tau >= 0;
      if (tau < 0) return;
      for (let i = 0; i < S.count; i++) {
        let k = 0;
        while (k < S.nseg[i] - 1 && S.seg[(i * S.SEG + k + 1) * 7] <= tau) k++;
        const o = (i * S.SEG + k) * 7, dt = tau - S.seg[o];
        let x = S.seg[o + 1] + S.seg[o + 4] * dt, y = S.seg[o + 2] + S.seg[o + 5] * dt - 0.5 * GRAV * dt * dt, z = S.seg[o + 3] + S.seg[o + 6] * dt;
        if (k === S.nseg[i] - 1) { x = S.seg[o + 1]; y = S.seg[o + 2]; z = S.seg[o + 3]; }
        if (S.rigidBarrier && x > -0.004) x = -0.004;
        const tRest = S.seg[(i * S.SEG + S.nseg[i] - 1) * 7], ang = S.spin[4 * i + 3] * Math.min(tau, tRest);
        AX.set(S.spin[4 * i], S.spin[4 * i + 1], S.spin[4 * i + 2]);
        QV.setFromAxisAngle(AX, ang);
        PV.set(x, Math.max(0.004, y), z); SV.setScalar(S.size[i]);
        M4.compose(PV, QV, SV);
        S.im.setMatrixAt(i, M4);
      }
      S.im.instanceMatrix.needsUpdate = true;
    }

    const api = {
      key, group, parts, wheels, lat, uniforms,
      // rigid placement (setup / approach): car-local mesh under a pose matrix
      setRigid(matrix, steer, spinDelta, UP, ZAXIS) {
        uniforms.uSkin.value = 0;
        group.matrix.copy(matrix); group.matrixWorldNeedsUpdate = true;
        api.clearDestruction();
        for (const w of wheels) {
          w.spin += spinDelta || 0;
          w.group.position.copy(w.hub);
          w.group.quaternion.setFromAxisAngle(UP, w.front ? -(steer || 0) : 0).multiply(new T.Quaternion().setFromAxisAngle(ZAXIS, -w.spin));
        }
      },
      // deformed (impact / playback): world node positions, blended between two frames
      setDeformed(X, X2, s, strain, cabinQuat, ZAXIS) {
        uniforms.uSkin.value = 1;
        group.matrix.identity(); group.matrixWorldNeedsUpdate = true;
        const blend = X2 && s > 0;
        for (let a = 0; a < n; a++) {
          const a3 = 3 * a;
          const x = blend ? X[a3] + (X2[a3] - X[a3]) * s : X[a3], y = blend ? X[a3 + 1] + (X2[a3 + 1] - X[a3 + 1]) * s : X[a3 + 1], z = blend ? X[a3 + 2] + (X2[a3 + 2] - X[a3 + 2]) * s : X[a3 + 2];
          nodeData[4 * a] = xyz[a3] = x; nodeData[4 * a + 1] = xyz[a3 + 1] = y; nodeData[4 * a + 2] = xyz[a3 + 2] = z;
          nodeData[4 * a + 3] = strain ? strain[a] / 255 : 0;
        }
        nodeTex.needsUpdate = true;
        cabinQ.copy(cabinQuat);
        const p = [0, 0, 0];
        for (const w of wheels) {
          if (w.off) continue;
          P.embeddedPos(xyz, w.ei, 0, w.et, 0, p);
          w.group.position.set(p[0], p[1], p[2]);
          w.group.quaternion.copy(cabinQuat).multiply(new T.Quaternion().setFromAxisAngle(ZAXIS, -w.spin));
        }
      },
      // build the destruction for an impact result: debris meshes, shards, crack origins
      prepareDestruction(result) {
        api.clearDestruction();
        D = { result, debris: [], shards: [], wheelOff: {}, cracks: [], panes: {} };
        for (const d of result.debris || []) addDebris(d);
        for (const gb of result.glass || []) addPane(gb);
      },
      // the same for a result that is still growing (the Race game's live crash): builds only the
      // debris and panes added since the last call. Frames must arrive before the debris and glass
      // that refer to them; for the finished result, prepareDestruction does it in one go.
      // tUntil, maxNew (optional): build only what happens before tUntil, at most maxNew pieces this call
      // (each costs some CPU work), so a burst of breakage doesn't stall a frame
      syncDestruction(result, tUntil = Infinity, maxNew = Infinity) {
        if (!D || D.result !== result) { api.clearDestruction(); D = { result, debris: [], shards: [], wheelOff: {}, cracks: [], panes: {}, nDebris: 0, nGlass: 0 }; }
        const debris = result.debris || [], glass = result.glass || [];
        let made = 0;
        for (; D.nDebris < debris.length && made < maxNew && debris[D.nDebris].t <= tUntil; D.nDebris++, made++) addDebris(debris[D.nDebris]);
        for (; D.nGlass < glass.length && made < maxNew && glass[D.nGlass].t <= tUntil; D.nGlass++, made++) addPane(glass[D.nGlass]);
      },
      // compile the shaders a crash will need (debris, shards) now, with a dummy break, and draw it
      // once (some drivers finish a shader only at its first draw), so the first real break doesn't
      // stall a frame
      warm(renderer, camera) {
        const X = Float32Array.from(lat.rest), S = new Uint8Array(n), ax = Float32Array.of(0, 0, 0, 1, 0, 0, 0, 1, 0);
        const F = { t: [0, 0.001], pos: [X, X], strain: [S, S], bricks: [new Float32Array(7 * 64), new Float32Array(7 * 64)], axes: [ax, ax] };
        const part = Object.keys(parts).find(k => k.startsWith('DEFORM_'));
        // a side window, a lamp and the windshield's crack overlay
        const all = spec.parts || [];
        const panes = [all.find(p => p.name.startsWith('BRITTLE_Glass') && !p.laminated), all.find(p => p.name.startsWith('BRITTLE_Light')), all.find(p => p.laminated)].filter(Boolean);
        const fake = { frames: F, barrier: 'world',
          debris: part ? [{ name: part, kind: 'part', body: 0, t: 0, X, pos: [0, 0, 0], quat: [0, 0, 0, 1] }] : [],
          glass: panes.map(p => ({ name: p.name, lamp: p.name.startsWith('BRITTLE_Light'), laminated: !!p.laminated, t: 0, frame: 0, origin: p.centre || [0, 0, 0], centre: [0, 0, 0], vel: [0, 0, 0] })) };
        const was = group.visible;
        group.visible = true;
        api.prepareDestruction(fake);
        api.updateDestruction(0.0005, 0, 1, 0.5);
        renderer.compile(scene(), camera);
        const culled = [];
        for (const { g } of D.debris) g.traverse((o) => { if (o.isMesh && o.frustumCulled) { o.frustumCulled = false; culled.push(o); } });
        renderer.render(scene(), camera);
        for (const o of culled) o.frustumCulled = true;
        api.clearDestruction();
        group.visible = was;
      },
      // windshield hits from the occupant model (re-run with other restraints: call again)
      setHeadStrikes(list) {
        if (!D || !crack.frame) return;
        D.cracks = D.cracks.filter(c => !c.head);
        for (const h of list) D.cracks.push({ t: h.t, seed: 77 + Math.round(h.t * 1e4), size: Math.min(1.2, 0.5 + h.mag / 12000), head: true, ...crackUV(h.p) });
        crack.drawn = '';
      },
      updateDestruction(t, k, k2, s) {
        if (!D) return;
        const F = D.result.frames;
        const pv = new T.Vector3(), qv = new T.Quaternion();
        for (const { d, g } of D.debris) {
          const on = t >= d.t;
          g.visible = on;
          for (const m of parts[d.name] || []) m.visible = !on;
          if (on) { bodyPose(F, k, k2, s, t, d, pv, qv); g.position.copy(pv); g.quaternion.copy(qv); }
        }
        for (const w of wheels) {
          const d = D.wheelOff[w.key];
          w.off = !!(d && t >= d.t);
          if (w.off) { bodyPose(F, k, k2, s, t, d, pv, qv); w.group.position.copy(pv); w.group.quaternion.copy(qv); if (w.left) w.group.quaternion.multiply(FLIP); }
        }
        for (const name in D.panes) {
          const gb = D.panes[name], broken = t >= gb.t;
          for (const m of parts[name] || []) if (m.material.userData.cls === (gb.lamp ? 'light' : 'glass')) m.visible = !broken;
        }
        for (const S of D.shards) updateShards(S, t);
        // cracks visible so far
        const active = D.cracks.filter(c => t >= c.t);
        const keyStr = active.map(c => c.seed).join(',');
        for (const m of crack.meshes) m.visible = active.length > 0;
        if (active.length && keyStr !== crack.drawn) { drawCracks(crack.ctx, 1024, active); crack.tex.needsUpdate = true; crack.drawn = keyStr; }
      },
      clearDestruction() {
        if (!D) return;
        for (const { g } of D.debris) { g.parent && g.parent.remove(g); g.traverse(o => { if (o.isMesh) o.geometry.dispose(); }); }
        for (const S of D.shards) { S.im.parent && S.im.parent.remove(S.im); S.im.geometry.dispose(); S.im.material.dispose(); S.im.dispose(); }
        for (const m of bodyMeshes) m.visible = true;
        for (const m of crack.meshes) m.visible = false;
        for (const w of wheels) w.off = false;
        crack.drawn = '';
        D = null;
      },
      setStrainMode(on) { strainMode = on; uniforms.uStrainMode.value = on ? 1 : 0; api.applyOpacity(); },
      setXray(on) { xray = on; api.applyOpacity(); },
      applyOpacity() {
        for (const m of allMats()) {
          const glassy = m.userData.cls === 'glass';
          const op = xray ? (glassy ? 0.08 : 0.16) : (glassy && strainMode ? 0.2 : m.userData.baseOpacity);
          m.transparent = xray || m.userData.baseTransparent;
          m.opacity = op;
          m.depthWrite = !xray && !glassy;
          m.needsUpdate = true;
        }
      },
      set visible(v) { group.visible = v; if (!v) api.clearDestruction(); },
      dispose() {
        api.clearDestruction();
        group.traverse((o) => { if (o.isMesh) o.geometry.dispose(); });
        for (const m of allMats().concat(Object.values(plainMats), Object.values(frozenMats))) m.dispose();
        depthMat.dispose(); blackMat.dispose(); nodeTex.dispose();
      },
    };
    const scene = () => group.parent;
    return api;
  }

  // crumple shading for another mesh (the procedural lab car): its geometry needs aRest (rest
  // position), aStrain (plastic strain, 1 = 50%) and aComp (cell compression); uniforms: uStrainMode, uCrumple
  return { create, environment, crumpleMaterial: patchFrozen, CRUMPLE_DEPTH };
})();
