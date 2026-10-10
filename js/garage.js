/* The garage: every vehicle the Race and Destruction games offer, in one list (docs/garage-gdd.md has
 * the design). No dependencies: runs in the browser (classic script, global CrashGarage, loaded before
 * js/vehicles.js) and in Node.
 *
 * type 'car': a road car on the crash lattice. Its model is models/<key>.glb.js and .phys.js (from
 * downloaded models, split into parts by tools/export-car.py with tools/cars/<key>.json), and
 * `lattice` is what js/vehicles.js adds to the spec it builds from the .phys.js: mass, names, the Race
 * tuning (`tune`, read by js/race/vehicle.js; the Lexus and Mustang keep theirs there), the engine's
 * place, the structure's stiffness and (a pickup) the lattice over the open bed. Other types ('bike',
 * 'hover', 'tracked') are rigs: rigid bodies, not on the lattice (js/race/rigs.js); their model is
 * models/<key>.glb.js and .phys.js (the motorcycle and the armoured car from downloaded models, by
 * tools/export-rig.py with tools/rigs/<key>.json; the drone, which films and isn't driven, from
 * tools/build-rig.py), and `rig` holds their mass, tuning and armour.
 *
 * Per entry: key, name, kind (the select list's tag), line (the class line under the name), type,
 * size [L, W, H] (m), paint ({ name, hex }: the signature paint, the one it starts in, added to the
 * select screen's palette; null: it starts in crimson red), targets (the design's numbers: top km/h,
 * t100 s, lateralG g), note (the design's one-liner), race ('ranked' | 'unranked' | false), destruction (bool), rival (AI rivals may drive it).
 * Added from SOUND below: sound (its recorded engine and crash sounds).
 */
(function (root) {
'use strict';

const LIST = [
  { key: 'lexus', name: 'Lexus RX 350', kind: 'SUV', line: 'Midsize SUV · all-wheel drive', type: 'car', size: [4.86, 1.92, 1.75], paint: null,
    race: 'ranked', destruction: true, rival: true,
    lattice: { massKg: 1950, short: 'Lexus RX 350', note: 'midsize SUV', addEngine: true } },   // the model has no engine
  { key: 'mustang', name: 'Ford Mustang GT500', kind: 'Coupe', line: 'Muscle coupe · rear-wheel drive', type: 'car', size: [4.82, 1.96, 1.46], paint: null,
    race: 'ranked', destruction: true, rival: true,
    lattice: { massKg: 1890, short: 'Ford Mustang GT500', note: 'coupe' } },
  { key: 'civic', name: 'Honda Civic Type R', kind: 'Hot hatch', line: 'Hot hatch · front-wheel drive', type: 'car', size: [4.57, 1.91, 1.48],
    paint: { name: 'rallye red', hex: 0xc41e2a }, targets: { top: 272, t100: 5.8 }, note: '0-100 km/h in 5.8 s',
    race: 'ranked', destruction: true, rival: true,
    lattice: { massKg: 1380, short: 'Honda Civic Type R', note: 'hot hatch', addEngine: true, stiffness: 0.85,
      tune: { power: 198e3, cdA: 0.73, drive: [1, 0], grip: 1.12, hcg: 0.52, steer: 0.55, gears: [3.63, 2.12, 1.53, 1.13, 0.91, 0.73], final: 4.1, redline: 7000 } } },
  { key: 'supra', name: 'Toyota GR Supra', kind: 'Sports coupe', line: 'Sports coupe · rear-wheel drive', type: 'car', size: [4.38, 1.81, 1.23],
    paint: { name: 'nitro yellow', hex: 0xf2c200 }, targets: { top: 250, t100: 4.3 }, note: '0-100 km/h in 4.3 s',
    race: 'ranked', destruction: true, rival: true,
    lattice: { massKg: 1540, short: 'Toyota GR Supra', note: 'sports coupe', addEngine: true, frontK: 1.6,
      tune: { power: 190e3, cdA: 0.8, drive: [0, 1], grip: 1.14, hcg: 0.46, steer: 0.55, launch: 1.1, gears: [5.25, 3.36, 2.17, 1.72, 1.31, 1.0, 0.82, 0.64], final: 3.15, redline: 6500 } } },
  { key: 'z350', name: 'Nissan 350Z', kind: 'Sports coupe', line: 'Sports coupe · rear-wheel drive', type: 'car', size: [4.32, 1.86, 1.31],
    paint: { name: 'sunset orange', hex: 0xe8661c }, targets: { top: 250, t100: 5.8 }, note: '0-100 km/h in 5.8 s',
    race: 'ranked', destruction: true, rival: true,
    lattice: { massKg: 1450, short: 'Nissan 350Z', note: 'sports coupe', addEngine: true,
      tune: { power: 130e3, cdA: 0.58, drive: [0, 1], grip: 1.08, launch: 0.7, hcg: 0.48, steer: 0.55, gears: [3.79, 2.32, 1.62, 1.27, 1.0, 0.79], final: 3.54, redline: 7000 } } },
  { key: 'gtr', name: 'Nissan GT-R Nismo', kind: 'Supercar', line: 'Twin-turbo coupe · all-wheel drive', type: 'car', size: [4.81, 2.15, 1.4],
    paint: { name: 'pearl white', hex: 0xe6e6e2 }, targets: { top: 315, t100: 2.7 }, note: '0-100 km/h in 2.7 s',
    race: 'ranked', destruction: true, rival: true,
    lattice: { massKg: 1720, short: 'Nissan GT-R Nismo', note: 'supercar', addEngine: true, partLimit: { DEFORM_BumperF: 1.4 },
      tune: { power: 304e3, cdA: 0.7, drive: [0.35, 0.65], grip: 1.22, hcg: 0.48, steer: 0.52, launch: 1.3, gears: [4.06, 2.3, 1.59, 1.25, 1.0, 0.8], final: 3.7, redline: 7100 } } },
  { key: 'corvette', name: 'Chevrolet Corvette Stingray', kind: 'Sports car', line: 'V8 sports coupe · rear-wheel drive', type: 'car', size: [4.49, 1.89, 1.26],
    paint: { name: 'laguna blue', hex: 0x1f5fa8 }, targets: { top: 290, t100: 3.9 }, note: '0-100 km/h in 3.9 s',
    race: 'ranked', destruction: true, rival: true,
    lattice: { massKg: 1500, short: 'Chevrolet Corvette', note: 'sports car', addEngine: true, frontK: 1.7,
      tune: { power: 226e3, cdA: 0.66, drive: [0, 1], grip: 1.16, hcg: 0.44, steer: 0.55, launch: 1.05, gears: [2.97, 2.07, 1.43, 1.0, 0.71, 0.57, 0.48], final: 3.42, redline: 6600 } } },
  { key: 'sf90', name: 'Ferrari SF90 Stradale', kind: 'Hypercar', line: 'Plug-in hybrid · mid-engine · all-wheel drive', type: 'car', size: [4.73, 2.01, 1.27],
    paint: { name: 'rosso corsa', hex: 0xd40000 }, targets: { top: 340, t100: 2.5 }, note: '0-100 km/h in 2.5 s',
    race: 'ranked', destruction: true, rival: true,
    lattice: { massKg: 1750, short: 'Ferrari SF90', note: 'hypercar', addEngine: true, engine: 'mid', frontK: 2.05, partLimit: { DEFORM_BumperF: 1.6 },
      tune: { power: 375e3, cdA: 0.7, drive: [0.3, 0.7], grip: 1.32, hcg: 0.4, steer: 0.5, cgf: 0.42, launch: 1.25, gears: [3.08, 2.19, 1.63, 1.29, 1.03, 0.84, 0.69, 0.58], final: 4.0, redline: 8000 } } },
  { key: 'crownvic', name: 'Ford Crown Victoria Police Interceptor', kind: 'Police sedan', line: 'Full-size police sedan · rear-wheel drive', type: 'car', size: [5.42, 1.95, 1.57],
    paint: { name: 'police black', hex: 0x0e0e10 }, targets: { top: 208, t100: 8.5 }, note: 'soft springs, big slides',
    race: 'ranked', destruction: true, rival: true,
    lattice: { massKg: 1870, short: 'Crown Victoria', note: 'police sedan', addEngine: true, frontK: 2,
      tune: { power: 116e3, cdA: 0.84, drive: [0, 1], grip: 0.94, hcg: 0.6, steer: 0.5, rearGrip: 0.9, lean: 1.8, launch: 0.5, gears: [2.84, 1.55, 1.0, 0.7], final: 3.55, redline: 5000 } } },
  { key: 'trx', name: 'Ram 1500 TRX', kind: 'Pickup', line: 'Supercharged crew-cab pickup · four-wheel drive', type: 'car', size: [5.94, 2.24, 2.14],
    paint: { name: 'sandblast', hex: 0xb39a74 }, targets: { top: 190, t100: 3.7 }, note: '0-100 km/h in 3.7 s',
    race: 'ranked', destruction: true, rival: true,
    lattice: { massKg: 2900, short: 'Ram 1500 TRX', note: 'crew-cab pickup', addEngine: true, bedTop: [0.15, 1.85, 1.45],
      tune: { power: 400e3, cdA: 1.35, drive: [0.45, 0.55], grip: 1.0, hcg: 0.8, steer: 0.48, launch: 1.05, vlimit: 52.8, gears: [4.71, 3.14, 2.1, 1.67, 1.29, 1.0, 0.84, 0.67], final: 3.55, redline: 6200 } } },
  { key: 'ducati', name: 'Ducati Hypermotard', kind: 'Motorcycle', line: 'Supermoto · L-twin', type: 'bike', size: [2.11, 0.82, 1.57],
    paint: { name: 'ducati red', hex: 0xb0141c }, targets: { top: 230, t100: 3.3 }, note: '0-100 km/h in 3.3 s',
    race: 'ranked', destruction: true, rival: false,
    rig: { massKg: 204, riderKg: 80,
      tune: { power: 72e3, cdA: 0.45, drive: [0, 1], grip: 1.18, hcg: 0.65, steer: 0.5, launch: 0.9, cgf: 0.5, gears: [2.47, 1.76, 1.35, 1.09, 0.96, 0.84], final: 4.3, redline: 9500 } } },
  { key: 'osprey', name: 'Osprey', kind: 'Drone', line: 'Hexacopter camera drone', type: 'hover', size: [2.33, 2.6, 0.7],
    paint: { name: 'peach', hex: 0xecccac }, targets: { top: 140 }, note: 'films the races',
    race: false, destruction: false, rival: false,   // not driven: the camera crew's drone
    // thrust: forward push (x weight), slide: how fast sideways speed dies away (1/s), steer: yaw rate
    rig: { massKg: 180, tune: { power: 45e3, cdA: 1.27, thrust: 0.9, slide: 0.8, steer: 1.6, gears: [1], final: 1, redline: 9000 } } },
  { key: 'type87', name: 'Type 87 Reconnaissance Vehicle', kind: 'Armoured car', line: 'Six-wheeled armoured car · 15 t', type: 'tracked', size: [6.22, 3.17, 2.88],
    paint: { name: 'digital camo', hex: 0x4b5b72 }, targets: { top: 100 }, note: 'shoves traffic aside',
    race: 'unranked', destruction: true, rival: false,
    // driven as the tank was (type 'tracked': heavy, armoured, turns on the spot); vmax: the governor
    // (m/s; vmaxBoost with boost), grip: sideways (x weight), steer: turn rate (rad/s)
    rig: { massKg: 15000, armour: { car: 0, wall: 0.25, post: 0.25 },
      tune: { power: 330e3, cdA: 3.2, vmax: 27.8, vmaxBoost: 30.6, grip: 0.9, steer: 0.75, gears: [6, 3.5, 2.2, 1.4, 1.0], final: 6, redline: 2800 } } },
];

// Each vehicle's recorded sounds (js/fx.js; the clips are cut from the recordings in media/audio by
// tools/build-sfx.py). idle and drive: engine loops pitched with the revs, idle at low revs crossfading
// to drive above about twice idle; tracks: a loop that follows the speed; pitch: scales the revs, for a
// recording of another engine; start: plays in the garage when the vehicle is picked; crash: at its
// crash's first impact (the bike and the drone, whose crashes aren't on the lattice).
const SOUND = {
  lexus: { idle: 'idle-petrol', drive: 'drive-porsche', pitch: 0.9 },
  mustang: { idle: 'idle-impala', drive: 'drive-muscle', start: 'rev-v8' },
  civic: { idle: 'idle-petrol', drive: 'drive-fox', pitch: 1.1 },
  supra: { idle: 'idle-lotus', drive: 'drive-porsche', start: 'rev-lotus' },
  z350: { idle: 'idle-petrol', drive: 'drive-porsche', pitch: 0.95 },
  gtr: { idle: 'idle-lotus', drive: 'drive-porsche', pitch: 0.9, start: 'rev-lotus' },
  corvette: { idle: 'idle-impala', drive: 'drive-muscle', start: 'rev-v8' },
  sf90: { idle: 'idle-lotus', drive: 'drive-bike', start: 'start-lotus' },
  crownvic: { idle: 'idle-impala', drive: 'drive-muscle', pitch: 0.9, start: 'rev-impala' },
  trx: { idle: 'idle-impala', drive: 'drive-muscle', pitch: 0.85, start: 'rev-v8' },
  ducati: { idle: 'idle-bike', drive: 'drive-bike', pitch: 0.8, start: 'start-bike', crash: 'crash-bike' },
  osprey: { drive: 'drone', crash: 'crash-drone' },
  type87: { drive: 'tank-engine', pitch: 0.8, start: 'rev-tank' },
};

const byKey = {};
for (const v of LIST) { byKey[v.key] = v; v.sound = SOUND[v.key] || null; }

const api = {
  LIST,
  get: (key) => byKey[key] || null,
  keys: LIST.map(v => v.key),
  // road cars on the crash lattice (their models are the exporter's .glb.js and .phys.js)
  latticeKeys: LIST.filter(v => v.type === 'car').map(v => v.key),
  raceKeys: LIST.filter(v => v.race).map(v => v.key),
  destructionKeys: LIST.filter(v => v.destruction).map(v => v.key),
  rivalKeys: LIST.filter(v => v.rival).map(v => v.key),
};
root.CrashGarage = api;
if (typeof module === 'object' && module.exports) module.exports = api;
})(typeof window !== 'undefined' ? window : globalThis);
