/* The garage's rigs drawn: the motorcycle, the drone and the tank (models from tools/build-rig.py).
 *
 * RigModels.create(key, spec, renderer) -> a model with the calls the games make on a CarModels one:
 * setRigid(matrix, steer, spinDelta, UP, ZAXIS, st) places it (st, the drawing state: wheelie, and
 * car, the driving model, whose wheels the model's turn with; the rotors always turn); setPaint(hex) repaints the
 * paint; play(view, k, k2, s) shows a rigid crash frame (RaceRigs.crash: the hull and the pieces that
 * came off, blended between frames k and k2); clearDestruction() puts the pieces back; warm()
 * compiles its shaders. The model is one glTF node per part, with its origin at the part's pivot:
 * WHEEL_ spins about the axle, STEER_ turns about its axis, ROTOR_ spins, TURRET_ and GUN_ hold.
 *
 * Uses window.THREE and CarModels (its GLB parser and reflections).
 */
const RigModels = (() => {
  'use strict';
  const T = THREE;
  const Qa = new T.Quaternion(), Qb = new T.Quaternion(), Pv = new T.Vector3(), Sv = new T.Vector3(1, 1, 1), Ax = new T.Vector3(), M = new T.Matrix4(), Mw = new T.Matrix4();

  async function create(key, spec, renderer) {
    const gltf = await CarModels.parseGLB(key);
    const group = new T.Group();
    group.matrixAutoUpdate = false;
    group.add(gltf.scene);
    const env = CarModels.environment(renderer), paints = [], nodes = {};
    const names = new Set(spec.parts.map(p => p.name));
    gltf.scene.traverse((o) => {
      if (names.has(o.name) && !nodes[o.name]) nodes[o.name] = o;
      if (!o.isMesh) return;
      o.castShadow = true; o.receiveShadow = true; o.frustumCulled = false;
      o.layers.set(1);   // solid in the glow pass, like the cars
      const m = o.material;
      m.envMap = env; m.envMapIntensity = /^paint/.test(m.name) ? 0.9 : 0.6;
      if (m.name === 'paint' && !paints.includes(m)) paints.push(m);
    });
    // each part's resting place, to put it back after a crash
    const rest = {};
    for (const [n, o] of Object.entries(nodes)) rest[n] = { parent: o.parent, p: o.position.clone(), q: o.quaternion.clone() };
    const part = (n) => spec.parts.find(p => p.name === n);
    const wheels = Object.keys(nodes).filter(n => n.startsWith('WHEEL_')), rotors = Object.keys(nodes).filter(n => n.startsWith('ROTOR_'));
    const steerN = Object.keys(nodes).find(n => n.startsWith('STEER_'));
    const steerAxis = steerN ? new T.Vector3(...part(steerN).axis).normalize() : null;
    const rear = spec.hubs.RL;   // a wheelie turns about the rear tyre's contact
    let rotorA = 0, broken = [];
    const spin = {};
    for (const n of wheels) spin[n] = 0;
    // which of the driving model's four wheels a part turns with
    const wheelOf = (n) => spec.rig === 'tracked' ? (n[6] === 'L' ? 2 : 3) : n === 'WHEEL_F' ? 0 : 2;

    const api = {
      key, group, rig: true, nodes,
      setPaint(hex) { for (const m of paints) m.color.setHex(hex); },
      setRigid(matrix, steer, spinDelta, UP, ZAXIS, st) {
        if (broken.length) api.clearDestruction();
        group.matrix.copy(matrix);
        if (st && st.wheelie) group.matrix.multiply(M.makeTranslation(rear[0], 0, 0)).multiply(Mw.makeRotationZ(st.wheelie)).multiply(M.makeTranslation(-rear[0], 0, 0));
        group.matrixWorldNeedsUpdate = true;
        for (const n of wheels) {
          // the driving model's wheel turns (the tank's: its left or right track), else the frame's turn
          spin[n] = st && st.car ? st.car.wheels[wheelOf(n)].spin : spin[n] + (spinDelta || 0);
          nodes[n].quaternion.copy(rest[n].q).multiply(Qa.setFromAxisAngle(ZAXIS, -spin[n]));
        }
        if (steerN) nodes[steerN].quaternion.copy(rest[steerN].q).multiply(Qa.setFromAxisAngle(steerAxis, -(steer || 0)));
        rotorA += 0.9;
        for (const n of rotors) nodes[n].quaternion.copy(rest[n].q).multiply(Qa.setFromAxisAngle(UP, rotorA + n.charCodeAt(6)));
      },
      // a rigid crash frame: the hull's pose, and each piece that has come off at its own
      play(view, k, k2, s) {
        const A = view.frames.poses[k], B = view.frames.poses[k2] || A;
        const pose = (a, b, out) => {
          if (!b) b = a;
          Pv.set(a[0] + (b[0] - a[0]) * s, a[1] + (b[1] - a[1]) * s, a[2] + (b[2] - a[2]) * s);
          Qa.set(a[3], a[4], a[5], a[6]); Qb.set(b[3], b[4], b[5], b[6]); Qa.slerp(Qb, s);
          return out.compose(Pv, Qa, Sv);
        };
        pose(A[0], B[0], group.matrix); group.matrixWorldNeedsUpdate = true;
        view.pieces.forEach((n, i) => {
          const o = nodes[n], a = A[i + 1];
          if (!o) return;
          if (!a) { if (broken.includes(n)) api.clearDestruction(); return; }
          if (!broken.includes(n)) {   // off: out of the model, into the crash group
            group.parent.add(o); o.matrixAutoUpdate = false; broken.push(n);
          }
          pose(a, B[i + 1], o.matrix); o.matrixWorldNeedsUpdate = true;
        });
        rotorA += 0.15;
        for (const n of rotors) nodes[n].quaternion.copy(rest[n].q).multiply(Qa.setFromAxisAngle(Ax.set(0, 1, 0), rotorA));
      },
      clearDestruction() {
        for (const n of broken) {
          const o = nodes[n], r = rest[n];
          r.parent.add(o); o.matrixAutoUpdate = true; o.position.copy(r.p); o.quaternion.copy(r.q);
        }
        broken = [];
      },
      prepareDestruction() {}, syncDestruction() {}, updateDestruction() {},
      pieces() { return { debris: broken.map(n => nodes[n]), wheels: [] }; },
      warm(renderer, camera) { renderer.compile(group, camera); },
    };
    return api;
  }
  return { create };
})();
