/* The Destruction mode's level: one busy crossroads at dusk, built in code.
 *
 * Main St (two lanes each way) climbs gently away to the south; the player starts at the top, 340 m
 * from the junction, and drives down into it. Harbor Blvd crosses it (three lanes each way and a
 * painted median) with a steady stream of cars, buses, box trucks and gas tankers, on green for
 * the whole run-up; Main St is on red, with a queue waiting on the far side. Around the junction a
 * gas station (its pumps explode), a bus stop and a cafe, roadworks, shop windows; a roadworks ramp
 * in the right lane, 55 m before the junction, throws a fast car over the near lanes into the
 * traffic. The ground within 75 m of the junction is flat (the crash solver works on flat ground).
 *
 * Conventions (as js/physics.js and the Race game): x and z on the ground, y up; a heading h points
 * along (cos h, sin h); a lateral offset l is measured to the right of that, along (-sin h, cos h).
 * Main St runs along z (the player heads +z, h = pi/2, so its right is -x); Harbor Blvd along x.
 *
 * The traffic is the same every attempt (schedule: when each vehicle enters which lane, at what
 * speed), so a player can learn the junction: when to boost to meet the tanker, when to take the
 * ramp. traffic.js drives it.
 *
 * DOM-free: global DestructionLevel in the browser, module.exports in Node.
 */
const DestructionLevel = (() => {
  'use strict';
  const LANE_W = 3.5;
  const MAIN_HALF = 7;           // Main St's kerb line (|x|)
  const HARBOR_HALF = 11.5;      // Harbor Blvd's kerb line (|z|): 3 + 3 lanes and a 2 m median
  const MEDIAN = 1;              // half the median
  const WALK = 5;                // pavement width
  const APPROACH = 340;          // Main St's south arm, from the junction's centre
  const ARM = 260;               // the other three arms
  const RISE = 9;                // the approach climbs 9 m from the plateau to its far end
  const PLATEAU = 75;            // flat within 75 m of the centre, along Main St
  const STOP_MAIN = 16, STOP_HARBOR = 11.5;   // stop lines: |z| on Main St, |x| on Harbor Blvd

  function rng(seed) {
    let a = seed >>> 0;
    return () => { a = (a + 0x6D2B79F5) >>> 0; let t = a; t = Math.imul(t ^ (t >>> 15), t | 1); t ^= t + Math.imul(t ^ (t >>> 7), t | 61); return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
  }

  // Things to knock over that the Race game doesn't have (registered into RaceProps.TYPES by the page
  // and the checks): fuel pumps (they explode), a bus shelter, shop-window panes (they shatter),
  // cafe tables. Half sizes (m), mass (kg), restitution, friction, as props.js.
  const PROP_TYPES = {
    pump: { hx: 0.45, hy: 0.95, hz: 0.32, m: 320, e: 0.1, mu: 0.6, metal: true },
    shelter: { hx: 1.8, hy: 1.25, hz: 0.65, m: 260, e: 0.1, mu: 0.6, metal: true },
    pane: { hx: 1.35, hy: 1.2, hz: 0.04, m: 60, e: 0.05, mu: 0.5 },
    table: { hx: 0.4, hy: 0.37, hz: 0.4, m: 14, e: 0.3, mu: 0.6 },
    // traffic lights (as the Race game's signal posts), showing red to Main St and green to Harbor Blvd
    signalR: { hx: 0.15, hy: 3.0, hz: 0.15, m: 110, e: 0.05, mu: 0.6, pole: true, metal: true },
    signalG: { hx: 0.15, hy: 3.0, hz: 0.15, m: 110, e: 0.05, mu: 0.6, pole: true, metal: true },
  };

  // what each thing is worth when wrecked (game dollars): vehicles pay their value times their
  // damage (0..1), plus a quarter more when totalled; props pay on the first knock; explosions
  // pay a bonus of their own
  const VALUES = {
    lexus: 48000, mustang: 80000, truck: 95000, bus: 250000, tanker: 300000,
    explode: { car: 15000, truck: 30000, bus: 60000, tanker: 250000, pump: 20000, crashbreaker: 0 },
    props: { lamp: 4000, signal: 18000, signalR: 18000, signalG: 18000, hydrant: 3000, bench: 1500, bin: 600, newsbox: 800, cone: 50, barrel: 200, crate: 150, pump: 30000, shelter: 12000, pane: 6000, table: 400 },
  };

  /* opts: { seed } -> the level (see the return value) */
  // ---------------------------------------------------------------- the levels
  // The same streets three ways: the time of day (look, for render.js), how tall the city grows
  // (base + rand, up to tall more toward the junction within radius, spike for a few towers), the
  // skyline (radius, tallest), the traffic (a car every gap[0] + rand gap[1] s per lane; the share
  // of sedans and trucks, the rest buses), the specials (lane, type, speed, when they reach the middle)
  // and the medal targets (set from the scripted attempts, ?test=plain|tanker|ramp); water: the docks
  // beyond the far end of Main St (cranes on the quay), yard: container stacks in the back lots.
  const LEVELS = {
    crossroads: { name: 'Crossroads at dusk', seed: 20261009, look: 'dusk',
      heights: { base: 10, rand: 16, tall: [26, 60], spike: 40, radius: 420 }, skyline: [620, 170],
      traffic: { gap: [3.0, 2.6], sedans: 0.88, trucks: 0.96 },
      specials: [['W1', 'tanker', 13, 10.6], ['E1', 'bus', 13.5, 12.2], ['E2', 'truck', 14, 9.2], ['W2', 'truck', 13, 13.6], ['E0', 'tanker', 13, 21.0], ['W0', 'bus', 13, 17.5]],
      medals: { bronze: 300000, silver: 1000000, gold: 3000000 } },
    // the docks after dark: low warehouses, freight traffic, three tankers
    docklands: { name: 'Docklands at night', seed: 5511, look: 'night', water: 300, yard: true,
      heights: { base: 7, rand: 8, tall: [6, 14], spike: 12, radius: 300 }, skyline: [700, 60],
      traffic: { gap: [2.8, 2.4], sedans: 0.66, trucks: 0.94 },
      specials: [['W1', 'tanker', 13, 10.6], ['E1', 'tanker', 13.5, 12.4], ['E2', 'truck', 14, 9.2], ['W2', 'truck', 13, 13.6], ['W0', 'truck', 13, 16.0], ['E0', 'tanker', 13, 20.0]],
      // scripted: no boost $1.8M, boosting into the tanker $2.2M, the ramp and its x4 $9.0M
      medals: { bronze: 500000, silver: 1500000, gold: 4000000 } },
    // downtown at midday: towers, a bus lane's worth of buses, one tanker
    boulevard: { name: 'Boulevard at noon', seed: 8123, look: 'day',
      heights: { base: 14, rand: 22, tall: [40, 90], spike: 60, radius: 500 }, skyline: [620, 230],
      traffic: { gap: [2.6, 2.2], sedans: 0.8, trucks: 0.86 },
      specials: [['W1', 'tanker', 13, 10.6], ['E1', 'bus', 13.5, 12.2], ['E2', 'bus', 14, 9.2], ['W2', 'bus', 13, 13.6], ['E0', 'truck', 13, 19.0], ['W0', 'bus', 13, 17.5]],
      // scripted: no boost $0.77M, boosting into the tanker $1.15M, the ramp and its x4 $1.77M
      medals: { bronze: 250000, silver: 800000, gold: 1500000 } },
  };

  /* opts: { level (a LEVELS key, default crossroads), seed } */
  function build(opts = {}) {
    const levelKey = LEVELS[opts.level] ? opts.level : 'crossroads', D = LEVELS[levelKey];
    const R = rng(opts.seed || D.seed);

    // ------------------------------------------------ the ground: flat around the junction, Main St
    // climbing to the south (the whole hillside, so the buildings along it climb too)
    const SLOPE = APPROACH - PLATEAU;
    function terrain(x, z) {
      if (z >= -PLATEAU) return 0;
      const u = Math.min(1, (-PLATEAU - z) / SLOPE);
      return RISE * u * u * (3 - 2 * u);
    }
    // the roadworks ramp in Main St's right-hand (outer) northbound lane: from z0 up `up` m to
    // `height`, a short top and a steep kicker down; lanes l0..l1 of the street (right of +z: -x)
    const ramps = [];
    {
      const up = 14, top = 1, down = 2, height = 2.0, z0 = -70, len = up + top + down;
      ramps.push({ up, top, down, height, len, x: 0, z: z0, h: Math.PI / 2, l0: 3.5, l1: MAIN_HALF, cx: -5.25, cz: z0 + len / 2, rad: len / 2 + 4 });
    }
    function rampProfile(r, u) {
      if (u < 0 || u >= r.len) return [0, 0];
      if (u < r.up) return [r.height * u / r.up, r.height / r.up];
      if (u < r.up + r.top) return [r.height, 0];
      return [r.height * (1 - (u - r.up - r.top) / r.down), -r.height / r.down];
    }
    // the surface cars and props stand on -> out { h, gx, gz } (height and its gradient)
    function groundAt(x, z, out = {}) {
      let h = terrain(x, z), gx = 0, gz = 0;
      if (z < -PLATEAU) {
        const u = Math.min(1, (-PLATEAU - z) / SLOPE);
        if (u < 1) gz = -RISE * 6 * u * (1 - u) / SLOPE;
      }
      for (const r of ramps) {
        if ((x - r.cx) ** 2 + (z - r.cz) ** 2 > r.rad * r.rad) continue;
        const c = Math.cos(r.h), s = Math.sin(r.h), dx = x - r.x, dz = z - r.z;
        const u = dx * c + dz * s, l = -dx * s + dz * c;
        if (l < r.l0 || l > r.l1) continue;
        const [rh, sl] = rampProfile(r, u);
        h += rh; gx += sl * c; gz += sl * s;
      }
      out.h = h; out.gx = gx; out.gz = gz;
      return out;
    }

    // ------------------------------------------------ streets: rectangles { x, z, h, len, wid }
    const along = (x0, z0, x1, z1, wid, extra) => Object.assign({ x: (x0 + x1) / 2, z: (z0 + z1) / 2, h: Math.atan2(z1 - z0, x1 - x0), len: Math.hypot(x1 - x0, z1 - z0), wid }, extra);
    const roads = [
      along(-ARM, 0, ARM, 0, 2 * HARBOR_HALF),                                    // Harbor Blvd, through the junction
      along(0, -APPROACH, 0, -HARBOR_HALF, 2 * MAIN_HALF),                        // Main St, south (the approach)
      along(0, HARBOR_HALF, 0, ARM, 2 * MAIN_HALF),                               // and north
    ];
    // pavements: an L in each corner; kerbs along the street edges; the gas station's forecourt
    const walks = [], kerbs = [], lines = [];
    const SX = [1, -1], SZ = [1, -1];
    for (const sx of SX) for (const sz of SZ) {
      const zEnd = sz < 0 ? APPROACH : ARM;
      const gas = sx > 0 && sz > 0;
      walks.push(along(sx * (MAIN_HALF + 0.3 + (WALK - 0.3) / 2), sz * HARBOR_HALF, sx * (MAIN_HALF + 0.3 + (WALK - 0.3) / 2), sz * zEnd, WALK - 0.3));
      walks.push(along(sx * (MAIN_HALF + WALK), sz * (HARBOR_HALF + 0.3 + (WALK - 0.3) / 2), sx * ARM, sz * (HARBOR_HALF + 0.3 + (WALK - 0.3) / 2), WALK - 0.3));
      kerbs.push(along(sx * (MAIN_HALF + 0.15), sz * HARBOR_HALF, sx * (MAIN_HALF + 0.15), sz * zEnd, 0.3));
      kerbs.push(along(sx * MAIN_HALF, sz * (HARBOR_HALF + 0.15), sx * ARM, sz * (HARBOR_HALF + 0.15), 0.3));
      if (gas) kerbs.push(along(MAIN_HALF + WALK + 0.2, 34, 50, 34, 34));   // the forecourt (concrete), x 12..50, z 17..51
    }
    // markings: centre lines, lane lines, edge lines, the median, stop lines, zebra crossings
    for (const [z0, z1] of [[-APPROACH, -STOP_MAIN], [STOP_MAIN, ARM]]) {
      for (const x of [-0.12, 0.12]) lines.push(along(x, z0, x, z1, 0.12, { color: 'yellow' }));
      for (const x of [-3.5, 3.5]) lines.push(along(x, z0, x, z1, 0.14, { color: 'white', dash: [3, 9] }));
      for (const x of [-MAIN_HALF + 0.25, MAIN_HALF - 0.25]) lines.push(along(x, z0, x, z1, 0.15, { color: 'white' }));
    }
    for (const [x0, x1] of [[-ARM, -STOP_HARBOR], [STOP_HARBOR, ARM]]) {
      for (const z of [-MEDIAN + 0.08, MEDIAN - 0.08]) lines.push(along(x0, z, x1, z, 0.16, { color: 'yellow' }));
      for (const z of [-MEDIAN - 3.5, -MEDIAN - 7, MEDIAN + 3.5, MEDIAN + 7]) lines.push(along(x0, z, x1, z, 0.14, { color: 'white', dash: [3, 9] }));
      for (const z of [-HARBOR_HALF + 0.25, HARBOR_HALF - 0.25]) lines.push(along(x0, z, x1, z, 0.15, { color: 'white' }));
      // the median's chevrons: short diagonal bars every 6 m
      for (let x = Math.min(x0, x1) + 3; x < Math.max(x0, x1) - 2; x += 6) lines.push({ x, z: 0, h: Math.PI / 4, len: 2.6, wid: 0.18, color: 'yellow' });
    }
    // stop lines across the lanes coming in, and zebra crossings between them and the junction
    lines.push(along(-MAIN_HALF, -STOP_MAIN, 0, -STOP_MAIN, 0.5, { color: 'white' }));
    lines.push(along(0, STOP_MAIN, MAIN_HALF, STOP_MAIN, 0.5, { color: 'white' }));
    lines.push(along(-STOP_HARBOR - 0.25, MEDIAN, -STOP_HARBOR - 0.25, HARBOR_HALF, 0.5, { color: 'white' }));
    lines.push(along(STOP_HARBOR + 0.25, -HARBOR_HALF, STOP_HARBOR + 0.25, -MEDIAN, 0.5, { color: 'white' }));
    for (const sz of [-1, 1]) for (let x = -MAIN_HALF + 0.6; x < MAIN_HALF - 0.3; x += 1.2) lines.push(along(x, sz * 12.2, x, sz * 15.2, 0.55, { color: 'white' }));
    for (const sx of [-1, 1]) for (let z = -HARBOR_HALF + 0.6; z < HARBOR_HALF - 0.3; z += 1.2) lines.push(along(sx * 7.6, z, sx * 10.6, z, 0.55, { color: 'white' }));

    // ------------------------------------------------ colliders and buildings
    const boxes = [], cyls = [], buildings = [], trees = [], barriers = [];
    // the gas station's lot (no buildings but its kiosk)
    const inGas = (b) => b.x + b.hx > MAIN_HALF + WALK && b.x - b.hx < 52 && b.z + b.hz > HARBOR_HALF + WALK && b.z - b.hz < 52;
    // and the roadworks yard on the near-right corner
    const inYard = (b) => b.x - b.hx < -MAIN_HALF - WALK && b.x + b.hx > -32 && b.z + b.hz > -42 && b.z - b.hz < -HARBOR_HALF - WALK;
    const containers = [], cranes = [];
    function yardLot(x, z, w, d) {
      for (let i = -1; i <= 1; i++) for (let j = -1; j <= 1; j += 2) {
        const cx = x + i * 13.4, cz = z + j * 2.4, n = 1 + Math.floor(R() * 3);
        if (buildings.some((o) => Math.abs(o.x - cx) < o.hx + 8 && Math.abs(o.z - cz) < o.hz + 3)) continue;
        for (let k = 0; k < n; k++) containers.push({ x: cx, z: cz, y: k * 2.6, angle: 0, color: Math.floor(R() * 6) });
        boxes.push({ x: cx, z: cz, hx: 6.1, hz: 1.22, angle: 0, height: n * 2.6 });
      }
    }
    function addBuilding(b) {
      for (const o of buildings) if (Math.abs(o.x - b.x) < o.hx + b.hx + 1 && Math.abs(o.z - b.z) < o.hz + b.hz + 1) return false;
      if (inGas(b) || inYard(b)) return false;
      if (D.water && b.z + b.hz > D.water - 6) return false;
      buildings.push(b);
      boxes.push({ x: b.x, z: b.z, hx: b.hx, hz: b.hz, angle: b.angle, height: Math.min(b.height, 12) });
      return true;
    }
    // how tall: a downtown junction, taller toward it, a few towers
    const HT = D.heights;
    const tall = (x, z) => { const d = Math.hypot(x, z * 0.8), k = Math.max(0, 1 - d / HT.radius), r = R(); return HT.base + r * HT.rand + k * k * (HT.tall[0] + R() * HT.tall[1]) + (r > 0.92 ? HT.spike : 0); };
    // frontage along each arm, both sides, facing the street (axis-aligned)
    const frontage = (axis, sign, from, to) => {
      for (let s = from; s < to;) {
        const w = 14 + R() * 22, d = 14 + R() * 16, mid = s + w / 2, set = (axis === 'z' ? MAIN_HALF : HARBOR_HALF) + WALK + 1 + R() * 2;
        if (s + w > to) break;
        const b = axis === 'z' ? { x: sign * (set + d / 2), z: mid, hx: d / 2, hz: w / 2 } : { x: mid, z: sign * (set + d / 2), hx: w / 2, hz: d / 2 };
        Object.assign(b, { angle: 0, height: tall(b.x, b.z), style: Math.floor(R() * 4) });
        addBuilding(b);
        s += w + 1 + R() * 3;
      }
    };
    for (const sign of [-1, 1]) {
      frontage('z', sign, -APPROACH - 20, -(HARBOR_HALF + WALK + 1));
      frontage('z', sign, HARBOR_HALF + WALK + 1, ARM + 20);
      frontage('x', sign, -ARM - 20, -(MAIN_HALF + WALK + 1));
      frontage('x', sign, MAIN_HALF + WALK + 1, ARM + 20);
    }
    // blocks behind the frontage, and a distant skyline (no colliders)
    for (let gx = -320; gx <= 320; gx += 48) for (let gz = -420; gz <= 320; gz += 48) {
      if (R() < 0.15) continue;
      const x = gx + (R() - 0.5) * 10, z = gz + (R() - 0.5) * 10, w = 16 + R() * 22, d = 16 + R() * 22;
      if (Math.abs(x) < MAIN_HALF + WALK + 22 + w / 2 || Math.abs(z) < HARBOR_HALF + WALK + 22 + d / 2) continue;
      // the docklands' container yards: stacks in the lots north of Harbor Blvd
      if (D.yard && z > 40) { if (z + d / 2 < D.water - 6) yardLot(x, z, w, d); continue; }
      addBuilding({ x, z, hx: w / 2, hz: d / 2, angle: 0, height: tall(x, z), style: Math.floor(R() * 4) });
    }
    const skyline = [];
    for (let a = 0; a < 2 * Math.PI; a += 0.05) {
      const rr = D.skyline[0] + R() * 360;
      skyline.push({ x: Math.cos(a) * rr, z: -40 + Math.sin(a) * rr, hx: 14 + R() * 24, hz: 14 + R() * 24, angle: R() * 0.4, height: 30 * D.skyline[1] / 170 + R() * R() * D.skyline[1], style: Math.floor(R() * 4) });
    }
    // the gas station: a kiosk at the back of the lot, the canopy's four posts over two pump islands
    const gas = { kiosk: { x: 41, z: 44, hx: 8, hz: 5, angle: 0, height: 4.2, style: 3 }, canopy: { x: 30, z: 31, hx: 11, hz: 7.5, height: 5.4 }, pumps: [] };
    buildings.push(gas.kiosk); boxes.push({ x: 41, z: 44, hx: 8, hz: 5, angle: 0, height: 4.2 });
    for (const px of [21, 39]) for (const pz of [26, 36]) cyls.push({ x: px, z: pz, r: 0.25, height: 5.4 });
    for (const px of [25, 35]) for (const pz of [28.5, 33.5]) gas.pumps.push({ x: px, z: pz });
    // trees along the north arm's and Harbor Blvd's pavements
    for (const sx of [-1, 1]) for (let z = 30; z < ARM - 10; z += 26) { trees.push({ x: sx * (MAIN_HALF + 2.4), z, size: 0.85 + R() * 0.4, seed: Math.floor(R() * 1e6) }); cyls.push({ x: sx * (MAIN_HALF + 2.4), z, r: 0.22, height: 4 }); }
    for (const sz of [-1, 1]) for (const sx of [-1, 1]) for (let x = 34; x < ARM - 10; x += 26) {
      if (sx > 0 && sz > 0 && x < 56) continue;   // the gas station's frontage
      trees.push({ x: sx * x, z: sz * (HARBOR_HALF + 2.4), size: 0.85 + R() * 0.4, seed: Math.floor(R() * 1e6) });
      cyls.push({ x: sx * x, z: sz * (HARBOR_HALF + 2.4), r: 0.22, height: 4 });
    }
    // barriers closing the far ends of the arms (traffic comes and goes through them)
    for (const [x, z, angle, len] of [[0, -APPROACH - 6, 0, 2 * MAIN_HALF], [0, ARM + 6, 0, 2 * MAIN_HALF], [-ARM - 6, 0, Math.PI / 2, 2 * HARBOR_HALF], [ARM + 6, 0, Math.PI / 2, 2 * HARBOR_HALF]]) {
      barriers.push({ x, z, angle, len });
      boxes.push({ x, z, hx: len / 2, hz: 0.35, angle, height: 1.1 });
    }

    // ------------------------------------------------ things to knock over { type, x, z, h, y }
    const props = [];
    const nearRamp = (x, z) => ramps.some(r => Math.abs(x - r.cx) < 6 && Math.abs(z - r.cz) < r.len / 2 + 4);
    // street lights every 30 m along every pavement (at the kerb), facing the street
    for (const sx of [-1, 1]) for (const [z0, z1] of [[-APPROACH + 10, -24], [24, ARM - 10]]) for (let z = z0; z < z1; z += 30) props.push({ type: 'lamp', x: sx * (MAIN_HALF + 0.7), z, h: sx > 0 ? Math.PI : 0, y: 0 });
    for (const sz of [-1, 1]) for (const sx of [-1, 1]) for (let x = 24; x < ARM - 10; x += 30) props.push({ type: 'lamp', x: sx * x, z: sz * (HARBOR_HALF + 0.7), h: sz > 0 ? -Math.PI / 2 : Math.PI / 2, y: 0 });
    // traffic signals on all four corners (two each: one for each street)
    for (const sx of [-1, 1]) for (const sz of [-1, 1]) {
      props.push({ type: 'signalR', x: sx * (MAIN_HALF + 0.9), z: sz * (HARBOR_HALF + 1.4), h: sz > 0 ? -Math.PI / 2 : Math.PI / 2, y: 0 });
      props.push({ type: 'signalG', x: sx * (MAIN_HALF + 1.6), z: sz * (HARBOR_HALF + 0.9), h: sx > 0 ? Math.PI : 0, y: 0 });
    }
    // the gas station's pumps
    for (const p of gas.pumps) props.push({ type: 'pump', x: p.x, z: p.z, h: 0, y: 0 });
    // the bus stop (north-west corner, on Harbor Blvd's pavement), a newspaper box and bins
    props.push({ type: 'shelter', x: -24, z: HARBOR_HALF + 3.4, h: 0, y: 0 });
    props.push({ type: 'newsbox', x: -19.5, z: HARBOR_HALF + 1.2, h: 0.2, y: 0 }, { type: 'bin', x: -28.6, z: HARBOR_HALF + 1.2, h: 0, y: 0 }, { type: 'bench', x: -32, z: HARBOR_HALF + 3.8, h: Math.PI, y: 0 });
    // the cafe on the south-east... (near-left from the approach: x > 0, z < 0): tables on the
    // pavement, shop windows along its front
    for (const [x, z] of [[MAIN_HALF + 2.2, -24], [MAIN_HALF + 2.2, -29], [MAIN_HALF + 3.8, -26.5], [MAIN_HALF + 2.2, -34], [MAIN_HALF + 3.8, -31.5]]) props.push({ type: 'table', x, z, h: R() * 6.28, y: 0 });
    // shop windows: panes along the frontage nearest the junction on all four corners
    for (const sx of [-1, 1]) for (const sz of [-1, 1]) {
      if ((sx > 0 && sz > 0) || (sx < 0 && sz < 0)) continue;   // the gas station, the roadworks yard
      const face = MAIN_HALF + WALK + 0.15;
      for (let k = 0; k < 4; k++) props.push({ type: 'pane', x: sx * face, z: sz * (HARBOR_HALF + WALK + 3 + k * 2.8), h: Math.PI / 2, y: 0 });
      const faceZ = HARBOR_HALF + WALK + 0.15;
      for (let k = 0; k < 4; k++) props.push({ type: 'pane', x: sx * (MAIN_HALF + WALK + 3 + k * 2.8), z: sz * faceZ, h: 0, y: 0 });
    }
    // roadworks: cones and barrels along both sides of the ramp, a yard of crates and barrels on
    // the near-right corner
    {
      const r = ramps[0];
      for (let z = r.z - 10; z <= r.z + r.len; z += 2.5) { props.push({ type: 'cone', x: -3.25, z, h: 0, y: 0 }); }
      props.push({ type: 'barrel', x: -5.25, z: r.z - 12, h: 0, y: 0 }, { type: 'barrel', x: -4.2, z: r.z - 12.5, h: 0, y: 0 }, { type: 'barrel', x: -6.3, z: r.z - 12.5, h: 0, y: 0 });
      for (const [x, z, type, y] of [[-14, -24, 'crate', 0], [-14.9, -24, 'crate', 0], [-14.45, -24, 'crate', 0.8], [-16, -27, 'barrel', 0], [-16.7, -27.6, 'barrel', 0], [-15, -30, 'crate', 0], [-17.5, -25, 'barrel', 0]]) props.push({ type, x, z, h: R() * 0.4, y });
    }
    // along the pavements: hydrants, bins, newspaper boxes, benches
    const KINDS = [['bin', 0.3], ['newsbox', 0.2], ['hydrant', 0.25], ['bench', 0.25]];
    const pick = () => { let u = R(); for (const [k, w] of KINDS) { if (u < w) return k; u -= w; } return 'bin'; };
    for (const sx of [-1, 1]) for (const [z0, z1] of [[-APPROACH + 20, -40], [40, ARM - 20]]) for (let z = z0; z < z1; z += 22 + R() * 14) {
      const type = pick(), l = type === 'hydrant' ? MAIN_HALF + 1.0 : MAIN_HALF + 3.4;
      if (nearRamp(sx * l, z)) continue;
      props.push({ type, x: sx * l, z, h: type === 'bench' ? (sx > 0 ? Math.PI / 2 : -Math.PI / 2) : R() * 6.28, y: 0 });
    }
    for (const sz of [-1, 1]) for (const sx of [-1, 1]) for (let x = 40; x < ARM - 20; x += 22 + R() * 14) {
      if (sx > 0 && sz > 0 && x < 56) continue;
      const type = pick(), l = type === 'hydrant' ? HARBOR_HALF + 1.0 : HARBOR_HALF + 3.4;
      props.push({ type, x: sx * x, z: sz * l, h: type === 'bench' ? (sz > 0 ? 0 : Math.PI) : R() * 6.28, y: 0 });
    }

    // ------------------------------------------------ lanes, signals and the traffic schedule
    // a lane: a straight path from (x0, z0) heading h for len m; stop: how far along it the stop
    // line is; light: which signal it obeys
    const lanes = [];
    for (const [i, z] of [[0, MEDIAN + 1.75], [1, MEDIAN + 5.25], [2, MEDIAN + 8.75]]) lanes.push({ id: 'E' + i, x0: -ARM, z0: z, h: 0, len: 2 * ARM, stop: ARM - STOP_HARBOR, light: 'harbor', index: i });
    for (const [i, z] of [[0, -MEDIAN - 1.75], [1, -MEDIAN - 5.25], [2, -MEDIAN - 8.75]]) lanes.push({ id: 'W' + i, x0: ARM, z0: z, h: Math.PI, len: 2 * ARM, stop: ARM - STOP_HARBOR, light: 'harbor', index: i });
    for (const [i, x] of [[0, 1.75], [1, 5.25]]) lanes.push({ id: 'S' + i, x0: x, z0: ARM, h: -Math.PI / 2, len: ARM + APPROACH, stop: ARM - STOP_MAIN, light: 'main', index: i });
    for (const L of lanes) L.at = (s) => ({ x: L.x0 + Math.cos(L.h) * s, z: L.z0 + Math.sin(L.h) * s, h: L.h });
    // Harbor Blvd green all through an attempt; Main St red
    const signal = (light) => (light === 'harbor' ? 'green' : 'red');

    // the schedule: { t (s after the start signal it enters the lane; negative: before),
    // lane, type ('lexus' | 'mustang' | 'truck' | 'bus' | 'tanker'), v (m/s), paint index, s (where
    // it starts along the lane; 0 = the lane's beginning) }. The traffic is run from WARMUP so the
    // street is busy when the countdown starts.
    const WARMUP = -24;
    const schedule = [];
    const sedan = () => (R() < 0.6 ? 'lexus' : 'mustang');
    // specials, timed by when they reach the middle of the junction (centre at ARM along their lane)
    const special = (lane, type, v, tMid) => schedule.push({ t: tMid - ARM / v, lane, type, v, paint: Math.floor(R() * 8), special: true });
    // (crossroads: W1's tanker meets a boosted run, E1's bus a run without boost, E0's tanker joins
    // the pile-up)
    for (const sp of D.specials) special(...sp);
    const TR = D.traffic;
    for (const L of lanes.filter(q => q.light === 'harbor')) {
      for (let t = WARMUP + R() * 3; t < 60; t += TR.gap[0] + R() * TR.gap[1]) {
        const v = 13.5 + R() * 3.5;
        // keep clear of the specials in this lane (they set the pace near their time)
        if (schedule.some(q => q.special && q.lane === L.id && Math.abs(q.t - t) < 3.2)) continue;
        const u = R(), type = u < TR.sedans ? sedan() : u < TR.trucks ? 'truck' : 'bus';
        schedule.push({ t, lane: L.id, type, v, paint: Math.floor(R() * 8) });
      }
    }
    // the queue at Main St's red light, on the far side (facing the player): four cars a lane
    // (queue: placed nose to tail behind the stop line, in schedule order)
    for (const L of lanes.filter(q => q.light === 'main')) for (let k = 0; k < 4; k++) schedule.push({ t: WARMUP, lane: L.id, type: k === 2 && L.index === 1 ? 'truck' : sedan(), v: 13, paint: Math.floor(R() * 8), queue: true });
    schedule.sort((a, b) => a.t - b.t);
    // parked at the pumps
    const parked = [{ type: 'lexus', x: 25, z: 31, h: Math.PI / 2, paint: 3 }, { type: 'mustang', x: 35, z: 31, h: -Math.PI / 2, paint: 0 }];

    // ------------------------------------------------ pickups (collected by your car or your wreck)
    const pickups = [
      { kind: 'mult', mult: 2, x: 1.75, y: 0.9, z: -200, r: 2.2 },          // in the empty oncoming lane
      { kind: 'cash', amount: 25000, x: -5.25, y: 0.9, z: -150, r: 2.2 },   // the right lane
      { kind: 'mult', mult: 4, x: -5.25, y: 3.7, z: -30, r: 2.2 },          // only in the air off the ramp
      { kind: 'cash', amount: 100000, x: -1.5, y: 0.9, z: 1.5, r: 2.2 },    // in the middle of the junction
    ];

    // ------------------------------------------------ queries
    const GCELL = 20, cgrid = new Map(), key = (i, j) => i * 100003 + j;
    const addTo = (o, x0, x1, z0, z1) => { for (let i = Math.floor(x0 / GCELL); i <= Math.floor(x1 / GCELL); i++) for (let j = Math.floor(z0 / GCELL); j <= Math.floor(z1 / GCELL); j++) { const k = key(i, j); if (!cgrid.has(k)) cgrid.set(k, []); cgrid.get(k).push(o); } };
    for (const b of boxes) { const c = Math.cos(b.angle), s = Math.sin(b.angle), ex = Math.abs(c) * b.hx + Math.abs(s) * b.hz, ez = Math.abs(s) * b.hx + Math.abs(c) * b.hz; b.box = true; addTo(b, b.x - ex, b.x + ex, b.z - ez, b.z + ez); }
    for (const q of cyls) { q.box = false; addTo(q, q.x - q.r, q.x + q.r, q.z - q.r, q.z + q.r); }
    function collidersNear(x, z, r) {
      const out = new Set();
      for (let i = Math.floor((x - r) / GCELL); i <= Math.floor((x + r) / GCELL); i++) for (let j = Math.floor((z - r) / GCELL); j <= Math.floor((z + r) / GCELL); j++) {
        const list = cgrid.get(key(i, j));
        if (list) for (const o of list) out.add(o);
      }
      return Array.from(out);
    }
    // is (x, z) on a street (or its pavement)?  (for the ground mesh: it lies lower under them)
    const underStreet = (x, z) => (Math.abs(x) < MAIN_HALF + WALK + 0.5 && z < ARM) || (Math.abs(z) < HARBOR_HALF + WALK + 0.5 && Math.abs(x) < ARM);

    return {
      level: levelKey, name: D.name, look: D.look, seed: opts.seed || D.seed,
      containers, cranes: D.water ? [-150, -60, 60, 150].map((x) => ({ x, z: D.water - 4, angle: Math.PI })) : [], water: D.water ? { z: D.water, north: true } : null,
      laneWidth: LANE_W, roadHalf: MAIN_HALF, mainHalf: MAIN_HALF, harborHalf: HARBOR_HALF, walk: WALK, approach: APPROACH, arm: ARM, plateau: PLATEAU,
      start: null, player: { x: -1.75, z: -APPROACH + 16, h: Math.PI / 2 },
      surfaces: { roads, walks, kerbs, lines }, groundGrid: { x0: -340, x1: 340, z0: -460, z1: -PLATEAU + 10 }, underStreet,
      buildings, skyline, trees, barriers, props, ramps, gas, hills: [],
      colliders: { boxes, cyls }, collidersNear, terrain, groundAt, rampProfile,
      lanes, signal, schedule, warmup: WARMUP, parked, pickups, values: VALUES,
      // medal targets (game dollars), set from scripted attempts (tools/destruction-check.js)
      medals: D.medals,
      bounds: { x0: -ARM, x1: ARM, z0: -APPROACH, z1: ARM },
    };
  }

  return { build, rng, LEVELS, PROP_TYPES, VALUES, LANE_W };
})();
if (typeof module === 'object' && module.exports) module.exports = DestructionLevel;
