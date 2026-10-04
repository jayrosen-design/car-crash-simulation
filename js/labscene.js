/* 3D props for the crash labs (lab.js), added to the Scene3D scene: the offset barrier with its
 * crushable honeycomb face, the side-impact pole and barrier trolley, the whiplash sled with its
 * seat and articulated dummy, the pedestrian, the emergency-braking sensor cone, momentum arrows
 * and the head-trajectory trail. Uses window.THREE. */
const LabScene = (() => {
  'use strict';
  const T = THREE, P = CrashPhysics;
  const V = (x = 0, y = 0, z = 0) => new T.Vector3(x, y, z);
  const YAXIS = V(0, 1, 0);
  const std = (color, rough = 0.6, metal = 0, extra) => new T.MeshStandardMaterial(Object.assign({ color, roughness: rough, metalness: metal }, extra || {}));
  const scene = () => Scene3D.scene;
  function shadowed(m) { m.castShadow = true; m.receiveShadow = true; return m; }
  function placeSeg(mesh, a, b, base) {
    const d = V().subVectors(b, a), len = d.length();
    mesh.position.copy(a).addScaledVector(d, 0.5);
    if (len > 1e-6) mesh.quaternion.setFromUnitVectors(YAXIS, d.divideScalar(len));
    mesh.scale.y = Math.max(1e-3, len / base);
  }
  let honeyTex = null;
  function honeycombTexture() {
    if (honeyTex) return honeyTex;
    honeyTex = Scene3D.canvasTexture(128, 128, (c, w, h) => {
      c.fillStyle = '#b9c0c6'; c.fillRect(0, 0, w, h);
      c.strokeStyle = '#7d868e'; c.lineWidth = 2;
      const r = 10, dx = r * Math.sqrt(3);
      for (let row = -1; row < 10; row++) for (let col = -1; col < 10; col++) {
        const cx = col * dx + (row % 2 ? dx / 2 : 0), cy = row * r * 1.5;
        c.beginPath();
        for (let k = 0; k <= 6; k++) { const a = Math.PI / 6 + k * Math.PI / 3; c.lineTo(cx + r * Math.cos(a), cy + r * Math.sin(a)); }
        c.stroke();
      }
    }, [1, 1]);
    return honeyTex;
  }

  // ---------------------------------------------------------------- offset barrier
  /* def: { zEdge, side, width, height, edgeRadius, honeycomb: { cell, nzc, nyc, y0, depth } | null } */
  function offsetBarrier(def) {
    const g = new T.Group(), s = -def.side, rho = Math.max(0.002, def.edgeRadius);
    // the rigid block: a rounded-edge outline in the (x, w) plane, extruded upward
    const sh = new T.Shape(), D = 2.6, Wd = def.width;
    sh.moveTo(D, 0); sh.lineTo(D, -Wd); sh.lineTo(0, -Wd); sh.lineTo(0, -rho);
    sh.absarc(rho, -rho, rho, Math.PI, Math.PI / 2, true);
    sh.lineTo(D, 0);
    const geo = new T.ExtrudeGeometry(sh, { depth: def.height, bevelEnabled: false, curveSegments: 12 });
    // shape x -> world x, shape y (= w) -> world z through the edge, extrusion -> up
    geo.rotateX(-Math.PI / 2);   // shape y -> -z, extrusion z -> y
    const block = shadowed(new T.Mesh(geo, std(0x9a9ea3, 0.85)));
    block.scale.z = -s;          // w = s (z - zEdge): shape y = w, mapped to z = zEdge + w / s
    block.position.set(0, 0, def.zEdge);
    g.add(block);
    // hazard stripe along the top of the face
    const stripeTex = Scene3D.canvasTexture(256, 32, (c, w, h) => {
      c.fillStyle = '#f0c419'; c.fillRect(0, 0, w, h); c.fillStyle = '#1b1b1b';
      for (let x = -h; x < w; x += 32) { c.beginPath(); c.moveTo(x, h); c.lineTo(x + 16, h); c.lineTo(x + 16 + h, 0); c.lineTo(x + h, 0); c.fill(); }
    }, [3, 1]);
    const stripe = new T.Mesh(new T.BoxGeometry(0.03, 0.2, Wd - rho), std(0xffffff, 0.7, 0, { map: stripeTex }));
    stripe.position.set(-0.016, def.height - 0.12, def.zEdge + s * -(Wd + rho) / 2 * 1);
    stripe.position.z = def.zEdge - s * (Wd + rho) / 2;
    g.add(stripe);
    let cells = null, H = def.honeycomb;
    if (H) {
      // one instanced box per crush cell: its back on the rigid face, its front where the cell is crushed to
      const mat = std(0xffffff, 0.45, 0.6, { map: honeycombTexture() });
      cells = new T.InstancedMesh(new T.BoxGeometry(1, 1, 1), mat, H.nzc * H.nyc);
      cells.castShadow = true; cells.receiveShadow = true; cells.frustumCulled = false;
      g.add(cells);
      const plate = shadowed(new T.Mesh(new T.BoxGeometry(0.02, H.nyc * H.cell + 0.04, Wd), std(0x59606a, 0.6, 0.3)));
      plate.position.set(-0.01, H.y0 + H.nyc * H.cell / 2, def.zEdge - s * Wd / 2);
      g.add(plate);
    }
    const M = new T.Matrix4(), q = new T.Quaternion(), pv = V(), sv = V();
    function setCrush(crush) {
      if (!cells) return;
      for (let iy = 0; iy < H.nyc; iy++) for (let iz = 0; iz < H.nzc; iz++) {
        const i = iy * H.nzc + iz, len = Math.max(0.01, H.depth[i] - (crush ? crush[i] : 0));
        pv.set(-0.02 - len / 2, H.y0 + (iy + 0.5) * H.cell, def.zEdge - s * (iz + 0.5) * H.cell);
        sv.set(len, H.cell * 0.985, H.cell * 0.985);
        cells.setMatrixAt(i, M.compose(pv, q, sv));
      }
      cells.instanceMatrix.needsUpdate = true;
    }
    setCrush(null);
    scene().add(g);
    return { group: g, setCrush, dispose() { scene().remove(g); g.traverse(o => { if (o.isMesh) { o.geometry.dispose(); } }); } };
  }

  // ---------------------------------------------------------------- pole
  function pole(def) {
    const g = new T.Group();
    const m = shadowed(new T.Mesh(new T.CylinderGeometry(def.r, def.r, 3, 32), std(0xa9b0b8, 0.45, 0.25)));
    m.position.set(def.x, 1.5, def.z);
    const base = shadowed(new T.Mesh(new T.CylinderGeometry(0.4, 0.45, 0.08, 32), std(0x5b6168, 0.7, 0.3)));
    base.position.set(def.x, 0.04, def.z);
    const cap = new T.Mesh(new T.CylinderGeometry(def.r * 1.02, def.r * 1.02, 0.25, 32), std(0xf0c419, 0.6));
    cap.position.set(def.x, 2.0, def.z);
    g.add(m, base, cap);
    scene().add(g);
    return { group: g, dispose() { scene().remove(g); } };
  }

  // ---------------------------------------------------------------- the side-impact barrier trolley
  // Built like the real thing: a crushable aluminium honeycomb block on a steel backing plate, on a
  // low trolley with ballast, rails, four wheels and crash-test target markers. Every piece is
  // skinned to the barrier's lattice (on the CPU), so the honeycomb crushes as the physics says.
  let alu = null, target = null;
  function aluTexture() {   // honeycomb cells, about 2 cm across at 0.15 m per tile
    if (alu) return alu;
    alu = Scene3D.canvasTexture(256, 256, (c, w, h) => {
      c.fillStyle = '#c9cfd4'; c.fillRect(0, 0, w, h);
      const r = 9, dx = r * Math.sqrt(3);
      for (let row = -1; row < 21; row++) for (let col = -1; col < 18; col++) {
        const cx = col * dx + (row % 2 ? dx / 2 : 0), cy = row * r * 1.5;
        c.beginPath();
        for (let k = 0; k <= 6; k++) { const a = Math.PI / 6 + k * Math.PI / 3; c.lineTo(cx + r * Math.cos(a), cy + r * Math.sin(a)); }
        c.fillStyle = `rgba(90,98,106,${0.10 + 0.08 * ((row * 7 + col * 3) % 5) / 5})`; c.fill();
        c.strokeStyle = '#eef1f3'; c.lineWidth = 1.6; c.stroke();
      }
    }, [1, 1]);
    return alu;
  }
  function targetTexture() {   // the black and yellow quadrant marker the high-speed cameras track
    if (target) return target;
    target = Scene3D.canvasTexture(128, 128, (c, w, h) => {
      c.clearRect(0, 0, w, h);
      const r = w / 2 - 2;
      c.fillStyle = '#f0c419'; c.beginPath(); c.arc(w / 2, h / 2, r, 0, Math.PI * 2); c.fill();
      c.fillStyle = '#111';
      for (const a of [0, Math.PI]) { c.beginPath(); c.moveTo(w / 2, h / 2); c.arc(w / 2, h / 2, r, a, a + Math.PI / 2); c.fill(); }
      c.strokeStyle = '#111'; c.lineWidth = 3; c.beginPath(); c.arc(w / 2, h / 2, r, 0, Math.PI * 2); c.stroke();
    });
    return target;
  }
  function trolley(spec) {
    const lat = P.buildCar(spec.massKg, 'standard', spec);
    const L = spec.length, F = spec.face, xF = spec.xMin + L, hw = spec.width / 2;
    const group = new T.Group(), parts = [];
    const steel = std(0x2c3036, 0.55, 0.55), deck = std(0x3b4047, 0.7, 0.4), ballast = std(0x6b727b, 0.6, 0.3), paint = std(0x8a929b, 0.5, 0.35);
    const aluMat = std(0xffffff, 0.42, 0.75, { map: aluTexture() });
    // a box (planar UVs at `uvTile` metres per texture tile, if given), embedded in the lattice
    function part(geo, mat, uvTile) {
      const pos = geo.attributes.position, nrm = geo.attributes.normal, n = pos.count;
      if (uvTile) {
        const uv = geo.attributes.uv;
        for (let i = 0; i < n; i++) {
          const ax = Math.abs(nrm.getX(i)), ay = Math.abs(nrm.getY(i));
          const x = pos.getX(i), y = pos.getY(i), z = pos.getZ(i);
          if (ax > 0.5) uv.setXY(i, z / uvTile, y / uvTile); else if (ay > 0.5) uv.setXY(i, x / uvTile, z / uvTile); else uv.setXY(i, x / uvTile, y / uvTile);
        }
      }
      const rest = Float32Array.from(pos.array), idx = new Int32Array(8 * n), tt = new Float64Array(3 * n);
      for (let i = 0; i < n; i++) P.embedPoint(lat, rest[3 * i], rest[3 * i + 1], rest[3 * i + 2], idx, 8 * i, tt, 3 * i, null);
      const mesh = shadowed(new T.Mesh(geo, mat));
      mesh.frustumCulled = false;
      group.add(mesh);
      parts.push({ geo, rest, idx, tt, n });
    }
    const box = (x0, x1, y0, y1, z0, z1, mat, seg, uvTile) => { const g = new T.BoxGeometry(x1 - x0, y1 - y0, z1 - z0, seg ? seg[0] : 1, seg ? seg[1] : 1, seg ? seg[2] : 1); g.translate((x0 + x1) / 2, (y0 + y1) / 2, (z0 + z1) / 2); part(g, mat, uvTile); };
    // the honeycomb block (finely divided, as it crushes) and its backing plate
    box(xF - F.depth, xF, F.y0, F.y1, -F.width / 2, F.width / 2, aluMat, [10, 10, 24], 0.15);
    box(xF - F.depth - 0.04, xF - F.depth, F.y0 - 0.04, F.y1 + 0.04, -F.width / 2 - 0.02, F.width / 2 + 0.02, steel, [1, 4, 8]);
    // the trolley: front bulkhead, deck, ballast, side rails, push plate at the back
    box(xF - F.depth - 0.22, xF - F.depth - 0.04, 0.30, F.y1 - 0.02, -hw + 0.08, hw - 0.08, steel, [1, 4, 8]);
    box(spec.xMin + 0.06, xF - F.depth - 0.2, 0.30, 0.47, -hw + 0.06, hw - 0.06, deck, [12, 1, 6]);
    for (const [x0, x1] of [[-1.45, -0.5], [-0.3, 0.65]]) {
      box(x0, x1, 0.47, 0.92, -0.52, 0.52, ballast, [4, 2, 4]);
      box(x0 + 0.04, x1 - 0.04, 0.92, 0.95, -0.48, 0.48, paint, [4, 1, 4]);
    }
    for (const s of [-1, 1]) box(spec.xMin + 0.1, xF - F.depth - 0.2, 0.92, 1.0, s * (hw - 0.14) - 0.04, s * (hw - 0.14) + 0.04, steel, [12, 1, 1]);
    box(spec.xMin, spec.xMin + 0.07, 0.30, 0.95, -hw + 0.2, hw - 0.2, steel, [1, 3, 6]);
    // target markers on the ballast sides
    const tMat = new T.MeshStandardMaterial({ map: targetTexture(), transparent: true, roughness: 0.6, polygonOffset: true, polygonOffsetFactor: -2 });
    for (const x of [-0.97, 0.18]) for (const s of [-1, 1]) {
      const g = new T.PlaneGeometry(0.22, 0.22); g.rotateY(s > 0 ? 0 : Math.PI); g.translate(x, 0.70, s * 0.523);
      part(g, tMat);
    }
    const wheels = [], wheelGeo = new T.CylinderGeometry(0.28, 0.28, 0.2, 24); wheelGeo.rotateX(Math.PI / 2);
    const hubGeo = new T.CylinderGeometry(0.13, 0.13, 0.21, 16); hubGeo.rotateX(Math.PI / 2);
    const wheelMat = std(0x17181a, 0.9), hubMat = std(0xb8bec6, 0.35, 0.8);
    for (const wx of [-1.25, 1.0]) for (const s of [-1, 1]) {
      const w = new T.Group();
      w.add(shadowed(new T.Mesh(wheelGeo, wheelMat)), shadowed(new T.Mesh(hubGeo, hubMat)));
      const hub = [wx, 0.28, s * (hw - 0.12)], ei = new Int32Array(8), et = new Float64Array(3);
      P.embedPoint(lat, hub[0], 0.6, hub[2], ei, 0, et, 0, null);
      wheels.push({ mesh: w, hub, ei, et });
      group.add(w);
    }
    scene().add(group);
    const p3 = [0, 0, 0];
    function setRigid(pose) {
      const c = Math.cos(pose.heading), s = Math.sin(pose.heading);
      for (const q of parts) {
        const p = q.geo.attributes.position.array, r = q.rest;
        for (let i = 0; i < q.n; i++) { const lx = r[3 * i], ly = r[3 * i + 1], lz = r[3 * i + 2]; p[3 * i] = pose.x + c * lx - s * lz; p[3 * i + 1] = ly; p[3 * i + 2] = pose.z + s * lx + c * lz; }
        q.geo.attributes.position.needsUpdate = true; q.geo.computeVertexNormals();
      }
      for (const w of wheels) { w.mesh.position.set(pose.x + c * w.hub[0] - s * w.hub[2], w.hub[1], pose.z + s * w.hub[0] + c * w.hub[2]); w.mesh.rotation.set(0, -pose.heading, 0); }
    }
    // X: this barrier's node positions (world), X2/s: blend toward the next frame; axes: [o, f, u]
    function setDeformed(X, X2, s, axes) {
      const blend = X2 && s > 0;
      const get = (a, d) => blend ? X[3 * a + d] + (X2[3 * a + d] - X[3 * a + d]) * s : X[3 * a + d];
      for (const q of parts) {
        const p = q.geo.attributes.position.array;
        for (let i = 0; i < q.n; i++) {
          let x = 0, y = 0, z = 0;
          for (let c = 0; c < 8; c++) {
            const a = q.idx[8 * i + c], w = P.cornerWeight(q.tt, 3 * i, c);
            x += w * get(a, 0); y += w * get(a, 1); z += w * get(a, 2);
          }
          p[3 * i] = x; p[3 * i + 1] = y; p[3 * i + 2] = z;
        }
        q.geo.attributes.position.needsUpdate = true; q.geo.computeVertexNormals();
      }
      const f = V(axes[3], axes[4], axes[5]).normalize();
      for (const w of wheels) {
        P.embeddedPos(X, w.ei, 0, w.et, 0, p3);
        w.mesh.position.set(p3[0], 0.28, p3[2]);
        w.mesh.rotation.set(0, -Math.atan2(f.z, f.x), 0);
      }
    }
    return { group, setRigid, setDeformed, lat, dispose() { scene().remove(group); for (const q of parts) q.geo.dispose(); } };
  }

  // ---------------------------------------------------------------- whiplash sled
  function sled(W) {
    const g = new T.Group();
    const H0 = [0, 0.86, 0];   // the H-point above the ground
    // rails and the ram (an air cylinder pushing the sled from behind)
    for (const z of [-0.45, 0.45]) { const r = shadowed(new T.Mesh(new T.BoxGeometry(14, 0.1, 0.12), std(0x6a7078, 0.4, 0.6))); r.position.set(3, 0.05, z); g.add(r); }
    const tank = shadowed(new T.Mesh(new T.CylinderGeometry(0.35, 0.35, 1.6, 28), std(0x2f5f9e, 0.4, 0.4)));
    tank.rotation.z = Math.PI / 2; tank.position.set(-3.1, 0.5, 0); g.add(tank);
    const rod = shadowed(new T.Mesh(new T.CylinderGeometry(0.07, 0.07, 1, 16), std(0xd8dde3, 0.2, 0.9)));
    rod.rotation.z = Math.PI / 2; g.add(rod);
    // the sled: platform, seat cushion, seatback (rotates on its recliner) and head restraint
    const carriage = new T.Group(); g.add(carriage);
    const plat = shadowed(new T.Mesh(new T.BoxGeometry(2.2, 0.16, 1.1), std(0x5b6168, 0.5, 0.5))); plat.position.set(0.1, 0.22, 0); carriage.add(plat);
    const floorPlate = shadowed(new T.Mesh(new T.BoxGeometry(0.9, 0.03, 0.9), std(0x1d2024, 0.9))); floorPlate.position.set(0.55, 0.31, 0); carriage.add(floorPlate);
    const seatMat = std(0x30353d, 0.9);
    const cushion = shadowed(new T.Mesh(new T.BoxGeometry(0.5, 0.14, 0.52), seatMat)); cushion.position.set(0.02, H0[1] - 0.13, 0); carriage.add(cushion);
    const post = shadowed(new T.Mesh(new T.BoxGeometry(0.08, H0[1] - 0.33, 0.4), std(0x3a4048, 0.6, 0.4))); post.position.set(-0.05, (H0[1] - 0.2) / 2 + 0.25, 0); carriage.add(post);
    const pivot = new T.Group(); pivot.position.set(W.SEAT.hinge[0], H0[1] + W.SEAT.hinge[1], 0); carriage.add(pivot);
    const geo = W.lastGeometry;
    const backLen = 0.78, a = W.SEAT.angle;
    const back = shadowed(new T.Mesh(new T.BoxGeometry(0.12, backLen, 0.5), seatMat));
    // the seatback surface passes backOff behind the H-point; place the box so its front face lies on it
    const n0 = [Math.cos(a), Math.sin(a)], d0 = [-Math.sin(a), Math.cos(a)];
    const surfPt = [-W.SEAT.backOff * n0[0], -W.SEAT.backOff * n0[1]];
    const ctr = [surfPt[0] - 0.06 * n0[0] + d0[0] * (backLen / 2 - 0.05), surfPt[1] - 0.06 * n0[1] + d0[1] * (backLen / 2 - 0.05)];
    back.position.set(ctr[0] - W.SEAT.hinge[0], ctr[1] - W.SEAT.hinge[1], 0); back.rotation.z = a;
    pivot.add(back);
    const hr = shadowed(new T.Mesh(new T.BoxGeometry(0.1, W.SEAT.hrLen, 0.28), std(0x30353d, 0.85)));
    pivot.add(hr);
    const hrPostL = new T.Mesh(new T.CylinderGeometry(0.01, 0.01, 0.2, 8), std(0xb8bec6, 0.3, 0.8)), hrPostR = hrPostL.clone();
    pivot.add(hrPostL, hrPostR);
    // the dummy: pelvis, 24 vertebrae (lumbar blue, thoracic grey, cervical orange), torso flesh, head, limbs
    const skin = std(0xe2b33a, 0.55), skinT = std(0xe2b33a, 0.6, 0, { transparent: true, opacity: 0.35, depthWrite: false });
    const fig = new T.Group(); carriage.add(fig);
    const pelvis = shadowed(new T.Mesh(new T.BoxGeometry(0.24, 0.16, 0.36), skin)); fig.add(pelvis);
    const vert = [];
    const vMat = { L: std(0x4f9cf0, 0.5), T: std(0xc9ced6, 0.5), C: std(0xe69f00, 0.5) };
    const regions = [];
    for (let i = 0; i < 5; i++) regions.push('L');
    for (let i = 0; i < 12; i++) regions.push('T');
    for (let i = 0; i < 7; i++) regions.push('C');
    for (let i = 0; i < 24; i++) {
      const r = regions[i], sz = r === 'C' ? [0.035, 0.014, 0.045] : r === 'L' ? [0.06, 0.03, 0.07] : [0.05, 0.02, 0.06];
      const m = shadowed(new T.Mesh(new T.BoxGeometry(sz[0], sz[1], sz[2]), vMat[r]));
      fig.add(m); vert.push(m);
    }
    const torso = new T.Mesh(new T.CapsuleGeometry(0.13, 0.34, 6, 14), skinT); fig.add(torso);
    const neckFlesh = new T.Mesh(new T.CapsuleGeometry(0.05, 0.08, 4, 10), skinT); fig.add(neckFlesh);
    const head = shadowed(new T.Mesh(new T.SphereGeometry(W.HEAD_R, 24, 18), std(0xe2b33a, 0.5))); fig.add(head);
    const face = shadowed(new T.Mesh(new T.BoxGeometry(0.03, 0.08, 0.1), std(0x2a2b2e, 0.6))); fig.add(face);
    const limbs = {};
    for (const s of ['L', 'R']) {
      limbs['thigh' + s] = shadowed(new T.Mesh(new T.CapsuleGeometry(0.075, 0.36, 4, 12), skin)); limbs['shin' + s] = shadowed(new T.Mesh(new T.CapsuleGeometry(0.055, 0.36, 4, 12), skin));
      limbs['upper' + s] = shadowed(new T.Mesh(new T.CapsuleGeometry(0.045, 0.26, 4, 10), skin)); limbs['fore' + s] = shadowed(new T.Mesh(new T.CapsuleGeometry(0.04, 0.24, 4, 10), skin));
      for (const k of ['thigh', 'shin', 'upper', 'fore']) fig.add(limbs[k + s]);
    }
    scene().add(g);
    let sledX = 0;
    /* state: { x (seat-frame particle x), y, sb (seatback rotation), sledX, hrForce, geometry (from simulate) } */
    function set(st) {
      sledX = st.sledX || 0;
      carriage.position.set(sledX, 0, 0);
      rod.scale.y = 0.6 + sledX; rod.position.set(-2.3 + (0.6 + sledX) / 2, 0.5, 0);
      pivot.rotation.z = st.sb || 0;
      const G = st.geometry;
      // head restraint: its front face runs from hrBot0 to hrTop0 (seat frame, before rotation)
      const mid = [(G.hrTop0[0] + G.hrBot0[0]) / 2 - 0.05 * Math.cos(a), (G.hrTop0[1] + G.hrBot0[1]) / 2 - 0.05 * Math.sin(a)];
      hr.position.set(mid[0] - W.SEAT.hinge[0], mid[1] + H0[1] - (H0[1] + W.SEAT.hinge[1]), 0); hr.rotation.z = a;
      hr.material.color.set(st.hrForce > 10 ? 0xd55e00 : 0x30353d);
      const postBase = [G.hrBot0[0] - 0.08 * Math.cos(a) - W.SEAT.hinge[0] + 0.03, G.hrBot0[1] - W.SEAT.hinge[1] - 0.06];
      hrPostL.position.set(postBase[0], postBase[1], -0.08); hrPostR.position.set(postBase[0], postBase[1], 0.08);
      hrPostL.rotation.z = hrPostR.rotation.z = a;
      // dummy
      const X = st.x, Y = st.y, PT = W.PARTS, toW = (i, z) => V(X[i], Y[i] + H0[1], z || 0);
      pelvis.position.copy(toW(PT.PEL)).add(V(-0.02, 0.02, 0));
      for (let i = 0; i < 24; i++) {
        const a2 = toW(1 + i), b2 = toW(2 + i);
        vert[i].position.copy(a2).lerp(b2, 0.5);
        vert[i].rotation.set(0, 0, -Math.atan2(b2.x - a2.x, b2.y - a2.y));
      }
      const back0 = toW(1), t1 = toW(PT.T1);
      const tdir = V().subVectors(t1, back0).normalize(), tn = V(tdir.y, -tdir.x, 0);
      placeSeg(torso, back0.clone().addScaledVector(tn, 0.07), t1.clone().addScaledVector(tn, 0.07), 0.34);
      torso.scale.z = 1.5;
      const c1 = toW(PT.C1), hd = toW(PT.HEAD);
      placeSeg(neckFlesh, t1, c1, 0.08);
      head.position.copy(hd);
      const hdir = V().subVectors(hd, c1).normalize(), hf = V(hdir.y, -hdir.x, 0);
      face.position.copy(hd).addScaledVector(hf, 0.09);
      face.rotation.set(0, 0, -Math.atan2(hdir.x, hdir.y));
      for (const [s, sz] of [['L', -1], ['R', 1]]) {
        const hip = toW(PT.PEL, sz * 0.1).add(V(0.02, -0.02, 0)), knee = V(0.46, H0[1] + 0.04, sz * 0.12), ankle = V(0.62, 0.36, sz * 0.13);
        placeSeg(limbs['thigh' + s], hip, knee, 0.36); placeSeg(limbs['shin' + s], knee, ankle, 0.36);
        const sh = t1.clone().add(V(0, -0.03, sz * 0.2)), elbow = sh.clone().add(V(0.12, -0.24, sz * 0.03)), hand = elbow.clone().add(V(0.24, -0.04, 0));
        placeSeg(limbs['upper' + s], sh, elbow, 0.26); placeSeg(limbs['fore' + s], elbow, hand, 0.24);
      }
    }
    return { group: g, set, get sledX() { return sledX; }, headWorld() { return head.getWorldPosition(V()); }, dispose() { scene().remove(g); } };
  }

  // ---------------------------------------------------------------- pedestrian
  function pedestrian(kind, B) {
    const g = new T.Group(), sc = kind === 'child' ? 0.67 : 1;
    const skin = std(kind === 'child' ? 0xe69f00 : 0xe2b33a, 0.55), joint = std(0x2a2b2e, 0.6);
    const m = (geo, mat) => { const x = shadowed(new T.Mesh(geo, mat)); g.add(x); return x; };
    const parts = {
      pelvis: m(new T.BoxGeometry(0.32 * sc, 0.18 * sc, 0.2 * sc), skin),
      torso: m(new T.CapsuleGeometry(0.15 * sc, 0.34 * sc, 6, 14), skin),
      neck: m(new T.CapsuleGeometry(0.045 * sc, 0.06 * sc, 4, 10), joint),
      head: m(new T.SphereGeometry(B.r[5], 22, 16), skin),
    };
    for (const s of ['L', 'R']) {
      parts['thigh' + s] = m(new T.CapsuleGeometry(0.07 * sc, 0.32 * sc, 4, 12), skin);
      parts['shin' + s] = m(new T.CapsuleGeometry(0.05 * sc, 0.34 * sc, 4, 12), skin);
      parts['foot' + s] = m(new T.BoxGeometry(0.1 * sc, 0.07 * sc, 0.24 * sc), joint);
      parts['upper' + s] = m(new T.CapsuleGeometry(0.042 * sc, 0.24 * sc, 4, 10), skin);
      parts['fore' + s] = m(new T.CapsuleGeometry(0.038 * sc, 0.24 * sc, 4, 10), skin);
    }
    const box = new T.LineSegments(new T.EdgesGeometry(new T.BoxGeometry(0.7 * sc + 0.2, B.y[5] + B.r[5] + 0.1, 0.7)), new T.LineBasicMaterial({ color: 0xf0e442 }));
    box.visible = false; g.add(box);
    scene().add(g);
    const Y = B.y;
    // standing / walking toward -z at (x, z); phase in radians
    function walk(x, z, phase, walking) {
      const sw = walking ? 0.35 * Math.sin(phase) : 0;
      const hipY = Y[2], kneeY = Y[1], ankY = Y[0];
      for (const [s, sx, sg] of [['L', -0.09 * sc, 1], ['R', 0.09 * sc, -1]]) {
        const a = sg * sw, hip = V(x + sx, hipY, z), legL = hipY - ankY;
        const knee = V(x + sx, hipY - (hipY - kneeY) * Math.cos(a), z - (hipY - kneeY) * Math.sin(a));
        const ank = V(x + sx, Math.max(ankY, hipY - legL * Math.cos(a)), z - legL * Math.sin(a));
        placeSeg(parts['thigh' + s], hip, knee, 0.32 * sc); placeSeg(parts['shin' + s], knee, ank, 0.34 * sc);
        parts['foot' + s].position.set(ank.x, 0.035 * sc, ank.z - 0.05 * sc);
        parts['foot' + s].rotation.set(0, 0, 0);
        const sh = V(x + sx * 2.1, Y[3] - 0.04, z), elbow = V(sh.x, sh.y - 0.27 * sc, z + 0.12 * Math.sin(-a)), hand = V(sh.x, elbow.y - 0.26 * sc, z + 0.25 * Math.sin(-a));
        placeSeg(parts['upper' + s], sh, elbow, 0.24 * sc); placeSeg(parts['fore' + s], elbow, hand, 0.24 * sc);
      }
      parts.pelvis.position.set(x, hipY + 0.02, z); parts.pelvis.rotation.set(0, 0, 0);
      placeSeg(parts.torso, V(x, hipY + 0.1 * sc, z), V(x, Y[3] - 0.08 * sc, z), 0.34 * sc);
      placeSeg(parts.neck, V(x, Y[3], z), V(x, Y[4], z), 0.06 * sc);
      parts.head.position.set(x, Y[5], z);
      box.position.set(x, (Y[5] + B.r[5]) / 2, z);
    }
    // impact pose: the chain (foot, knee, hip, chest, neck, head) in the car's x-y plane at z
    function chain(px, py, z) {
      const p = (i, dx) => V(px[i] + (dx || 0), py[i], z);
      const dir = V(px[3] - px[2], py[3] - py[2], 0).normalize(), lat = V(dir.y, -dir.x, 0);   // the body's left-right
      for (const [s, sg] of [['L', -1], ['R', 1]]) {
        const o = lat.clone().multiplyScalar(sg * 0.09 * sc);
        const hip = p(2).add(o), knee = p(1).add(o), ank = p(0).add(o);
        placeSeg(parts['thigh' + s], hip, knee, 0.32 * sc); placeSeg(parts['shin' + s], knee, ank, 0.34 * sc);
        parts['foot' + s].position.copy(ank).add(V(0, -0.02, -0.05 * sc));
        const sh = p(3).add(lat.clone().multiplyScalar(sg * 0.2 * sc)), elbow = sh.clone().addScaledVector(dir, -0.26 * sc).add(lat.clone().multiplyScalar(sg * 0.06)), hand = elbow.clone().addScaledVector(dir, -0.25 * sc);
        placeSeg(parts['upper' + s], sh, elbow, 0.24 * sc); placeSeg(parts['fore' + s], elbow, hand, 0.24 * sc);
      }
      parts.pelvis.position.copy(p(2)); parts.pelvis.rotation.set(0, 0, -Math.atan2(dir.x, dir.y));
      placeSeg(parts.torso, p(2).addScaledVector(dir, 0.1 * sc), p(3).addScaledVector(dir, -0.08 * sc), 0.34 * sc);
      placeSeg(parts.neck, p(3), p(4), 0.06 * sc);
      parts.head.position.copy(p(5));
    }
    return { group: g, walk, chain, setBox(on) { box.visible = on; }, dispose() { scene().remove(g); } };
  }

  // ---------------------------------------------------------------- sensor cone (AEB)
  const SENSOR_COLORS = [0x4f9cf0, 0x56b4e9, 0xf0e442, 0xe69f00, 0xd55e00, 0x8b95a1];
  function sensorCone(fov, range) {
    const g = new T.Group();
    const fan = new T.Mesh(new T.CircleGeometry(range, 48, -fov, 2 * fov), new T.MeshBasicMaterial({ color: SENSOR_COLORS[0], transparent: true, opacity: 0.16, depthWrite: false, side: T.DoubleSide }));
    fan.rotation.x = -Math.PI / 2; fan.position.y = 0.06; fan.renderOrder = 4;
    const edgeMat = new T.LineBasicMaterial({ color: SENSOR_COLORS[0], transparent: true, opacity: 0.8 });
    const pts = [V(0, 0.07, 0), V(range * Math.cos(fov), 0.07, -range * Math.sin(fov)), V(0, 0.07, 0), V(range * Math.cos(fov), 0.07, range * Math.sin(fov))];
    const edges = new T.LineSegments(new T.BufferGeometry().setFromPoints(pts), edgeMat);
    const sweep = new T.Line(new T.BufferGeometry().setFromPoints([V(0, 0.08, 0), V(range, 0.08, 0)]), new T.LineBasicMaterial({ color: 0xffffff, transparent: true, opacity: 0.5 }));
    g.add(fan, edges, sweep);
    scene().add(g);
    let ph = 0;
    function set(x, z, heading, state, dt) {
      g.position.set(x, 0, z); g.rotation.y = -heading;
      const c = SENSOR_COLORS[Math.min(state, SENSOR_COLORS.length - 1)];
      fan.material.color.set(c); edgeMat.color.set(c);
      ph += (dt || 0) * 2.2;
      sweep.rotation.y = Math.sin(ph) * fov;
      fan.material.opacity = state >= 4 ? 0.26 : 0.16;
    }
    return { group: g, set, dispose() { scene().remove(g); } };
  }

  // ---------------------------------------------------------------- momentum arrows
  function arrows(colors) {
    const list = colors.map(c => { const a = new T.ArrowHelper(V(1, 0, 0), V(), 1, c, 0.5, 0.3); a.line.material.linewidth = 3; scene().add(a); return a; });
    return {
      set(i, from, vec, scale) {
        const a = list[i], len = Math.hypot(vec[0], vec[2]) * scale;
        a.visible = len > 0.05;
        if (!a.visible) return;
        a.position.set(from[0], from[1], from[2]);
        a.setDirection(V(vec[0], 0, vec[2]).normalize());
        a.setLength(len, Math.min(0.6, 0.3 * len + 0.15), Math.min(0.35, 0.15 * len + 0.1));
      },
      hide() { for (const a of list) a.visible = false; },
      dispose() { for (const a of list) scene().remove(a); },
    };
  }

  // ---------------------------------------------------------------- head trail (inside a car slot)
  function trail(slot, color) {
    const N = 600, geo = new T.BufferGeometry(), pos = new Float32Array(3 * N);
    geo.setAttribute('position', new T.BufferAttribute(pos, 3));
    geo.setDrawRange(0, 0);
    const line = new T.Line(geo, new T.LineBasicMaterial({ color, transparent: true, opacity: 0.95, depthTest: false }));
    line.renderOrder = 10; line.frustumCulled = false;
    let parent = null;
    function attach() { if (parent !== slot.interior) { if (parent) parent.remove(line); parent = slot.interior; parent.add(line); } }
    // pts: [x, y, z] in the H-point frame (occupant x forward, y up), car-local after the H-point
    function set(pts) {
      attach();
      const n = Math.min(N, pts.length), H = slot.hPoint;
      for (let i = 0; i < n; i++) { pos[3 * i] = H[0] + pts[i][0]; pos[3 * i + 1] = H[1] + pts[i][1]; pos[3 * i + 2] = H[2] + (pts[i][2] || 0); }
      geo.attributes.position.needsUpdate = true; geo.setDrawRange(0, n);
    }
    return { set, hide() { geo.setDrawRange(0, 0); }, dispose() { if (parent) parent.remove(line); } };
  }

  return { offsetBarrier, pole, trolley, sled, pedestrian, sensorCone, arrows, trail };
})();
