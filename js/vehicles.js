/* Vehicle specs for the physics lattice, the guidance and the occupant model. No dependencies:
 * runs in the browser (classic script, global CrashVehicles) and in Node.
 *
 * 'lab' is the original procedural car; its numbers are the physics baseline and must not change.
 * The imported cars are built from models/<key>.phys.js (written by tools/export-car.py): body
 * size and profile, hub positions, tyre size, H-point and the part list.
 * Car-local axes everywhere: x forward, y up, z right, metres, ground at y = 0.
 */
(function (root) {
'use strict';

const NODE_R = 0.12;

const LAB = {
  key: 'lab', title: 'Crash Lab sedan', short: 'Lab sedan', note: 'procedural, no detachable parts',
  massKg: 1500,
  length: 4.6, width: 1.8, xMin: -2.3,
  nx: 19, ny: 5, nz: 8,
  latHalfL: 2.18, latHalfW: 0.78,
  yBottom: 0.32, yTop: 1.48,
  wheelRadius: 0.32,
  wheelI: [4, 14],
  nodeRadius: NODE_R,
  bodyClearance: 0.10,
  hPoint: [-0.25, 0.60, -0.40],
  // top-surface height (m) along the car; u = distance from the rear bumper
  profile: [
    [0.00, 0.78], [0.10, 0.98], [0.75, 1.04], [1.30, 1.42], [2.70, 1.45],
    [3.35, 1.00], [3.55, 0.96], [4.45, 0.86], [4.60, 0.64],
  ],
  // zones (u, absolute heights)
  firewallU: 3.30, rearU: 1.0,
  engine: { u0: 3.35, u1: 4.0, yMax: 0.95, zHalf: 0.55 },
  cabin: { u0: 1.3, u1: 3.1, frontU: 2.6, rearU: 1.8, topJ: 3 },
  dash: { u0: 3.0, u1: 3.35, yMax: 1.0 },
  seat: { u0: 1.75, u1: 2.35, yMax: 0.9 },
  kScale: 1,
  wheelCornerMass: 0,
  duration: { rigid: 1.2, brick: 2.2 },
  interior: null,         // occupant INTERIOR as is
  parts: null,
};

// Moving deformable barrier for the side-impact lab: a 1,900 kg trolley with an SUV-height
// crushable face (0.38 to 1.14 m above the ground, 0.45 m deep), the rest of it rigid. It is a
// lattice like the cars, so it crushes against the struck car's side with the same physics.
const MDB = {
  key: 'mdb', title: 'Side-impact barrier', short: 'Side-impact barrier', note: 'moving deformable barrier',
  massKg: 1900,
  length: 3.6, width: 1.7, xMin: -1.8,
  nx: 15, ny: 4, nz: 8,
  latHalfL: 1.68, latHalfW: 0.73,
  // the lattice starts at the face's lower edge, so the face rides over the struck car's sill as
  // a real barrier face does; its wheel nodes roll on a ground contact at that height
  yBottom: 0.50, yTop: 1.14,
  wheelRadius: 0.50, rimRadius: 0.2, tireWidth: 0.22,
  wheelI: [2, 12],
  nodeRadius: NODE_R,
  bodyClearance: 0.10,
  hPoint: null,
  profile: [[0, 1.14], [3.6, 1.14]],
  face: { y0: 0.38, y1: 1.14, depth: 0.45, width: 1.68 },
  firewallU: 3.15, rearU: 0,
  engine: { u0: 9, u1: 9, yMax: 0, zHalf: 0 },
  noEngine: true,
  zoneK: { front: [0.8, 0.9], cell: [6, 30], rear: [6, 30] },   // honeycomb face; rigid trolley
  cabin: { u0: 0.6, u1: 3.0, frontU: 2.4, rearU: 1.2, topJ: 3 },
  dash: { u0: 2.6, u1: 3.0, yMax: 1.2 },
  seat: { u0: 0.8, u1: 1.4, yMax: 1.2 },
  kScale: 1,
  wheelCornerMass: 0,
  duration: { rigid: 1.0, brick: 1.0 },
  interior: null,
  parts: null,
};

// Lattice and zones for an imported car. The zones keep the lab car's positions relative to the
// H-point (cabin, dash, seat, firewall, engine) and the rear axle (rear zone).
function fromPhys(key, d, extra) {
  const r = NODE_R;
  const xMin = d.xMin, xMax = d.xMin + d.length;
  const hubF = d.hubs.FL, hubR = d.hubs.RL;
  const wb = hubF[0] - hubR[0];
  const sx = wb / Math.round(wb / 0.24);
  // columns: a regular grid through both axles, end cells stretched to reach the bumpers
  const x0 = xMin + r, x1 = xMax - r;
  const colX = [x0];
  let k0 = Math.ceil((x0 + 0.5 * sx - hubR[0]) / sx);
  for (let k = k0; hubR[0] + k * sx < x1 - 0.5 * sx; k++) colX.push(hubR[0] + k * sx);
  colX.push(x1);
  const near = (x) => colX.reduce((b, c, i) => Math.abs(c - x) < Math.abs(colX[b] - x) ? i : b, 0);
  const yBottom = 0.5 * (hubF[1] + hubR[1]);
  const topMax = Math.max(...d.profileTop.map(p => p[1]));
  const yTop = topMax + 0.03;
  const ny = Math.max(4, Math.round((yTop - yBottom) / 0.29) + 1);
  const latHalfW = d.width / 2 - r;
  const nz = Math.round(2 * latHalfW / 0.223) + 1;
  const sy = (yTop - yBottom) / (ny - 1), sz = 2 * latHalfW / (nz - 1);
  const H = d.hPoint, uH = H[0] - xMin, uR = hubR[0] - xMin;
  const s = Math.cbrt(sx * sy * sz) / Math.cbrt((2 * 2.18 / 18) * (1.16 / 4) * (1.56 / 7));
  return Object.assign({
    key, title: d.title, short: d.title, note: '',
    massKg: 1500,
    length: d.length, width: d.width, height: d.height, xMin,
    colX, nx: colX.length, ny, nz,
    latHalfL: 0.5 * (x1 - x0), latCenter: 0.5 * (x0 + x1), latHalfW,
    yBottom, yTop,
    // the wheel nodes sit at hub height; a tyre measured even 1 mm larger would start them below
    // the ground and the first step would pop them up
    wheelRadius: Math.min(d.tireRadius, yBottom), rimRadius: d.rimRadius, tireWidth: d.tireWidth,
    wheelI: [near(hubR[0]), near(hubF[0])],
    hubs: d.hubs,
    nodeRadius: r,
    bodyClearance: 0.10,
    hPoint: H.slice(),
    profile: d.profileTop.map(p => [p[0], p[1]]),
    firewallU: uH + 1.25, rearU: uR - 0.089,
    engine: { u0: uH + 1.30, u1: uH + 1.95, yMax: H[1] + 0.35, zHalf: 0.55 },
    cabin: { u0: uH - 0.75, u1: uH + 1.05, frontU: uH + 0.55, rearU: uH - 0.25, topJ: ny - 2 },
    dash: { u0: uH + 0.95, u1: uH + 1.30, yMax: H[1] + 0.40 },
    seat: { u0: uH - 0.30, u1: uH + 0.30, yMax: H[1] + 0.30 },
    kScale: s,               // springs scale with spacing, so the material stays as stiff
    wheelCornerMass: 20,     // wheel, tyre, brake and hub per corner, carried by the wheel nodes
    duration: { rigid: 2.0, brick: 2.4 },
    interior: interiorFrom(d, H),
    parts: d.parts,
    materials: d.materials,
    credit: d.credit,
  }, extra || {});
}

// Occupant interior lines in the H-point frame (x forward, y up), from the windshield pane and
// the roof above the seat.
function interiorFrom(d, H) {
  const ws = d.parts.find(p => p.name === 'BRITTLE_GlassWS');
  let wsA = null, wsB = null;
  if (ws) {
    // lowest and highest points of the pane on the car's centre line, 1 cm in for the glass
    const [lo, hi] = ws.centreLine;
    wsA = [lo[0] - H[0], lo[1] - H[1] - 0.01];
    wsB = [hi[0] - H[0], hi[1] - H[1] - 0.01];
  }
  const uH = H[0] - d.xMin;
  let roof = 0;
  for (const [u, h] of d.profileTop) if (Math.abs(u - uH) < 0.25) roof = Math.max(roof, h);
  return { wsA, wsB, roofY: roof - H[1] - 0.06 };
}

const specs = { lab: LAB };
const order = ['lexus', 'mustang', 'lab'];
const extras = {
  lexus: { massKg: 1950, short: 'Lexus RX 350', note: 'midsize SUV', addEngine: true },   // the model has no engine
  mustang: { massKg: 1890, short: 'Ford Mustang GT500', note: 'coupe' },
};
let physData = root.CAR_PHYS || {};
if (typeof module === 'object' && module.exports && typeof require === 'function') {
  const path = require('path');
  for (const key of ['lexus', 'mustang']) {
    try { physData[key] = require(path.join(__dirname, '..', 'models', key + '.phys.js')); } catch (e) { /* model not exported */ }
  }
}
for (const key of order) if (key !== 'lab' && physData[key]) specs[key] = fromPhys(key, physData[key], extras[key]);

const api = {
  LAB, MDB, specs,
  keys: order.filter(k => specs[k]),
  get(key) { return specs[key] || LAB; },
  defaultKey: specs.lexus ? 'lexus' : 'lab',
};
root.CrashVehicles = api;
if (typeof module === 'object' && module.exports) module.exports = api;
})(typeof window !== 'undefined' ? window : globalThis);
