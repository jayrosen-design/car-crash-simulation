/* The Hurricane Brawl game's Earth: the land mask, a rough climate, the cities and the countryside,
 * and the geometry of moving on a sphere.
 *
 * Positions are unit vectors [x, y, z] (y to the north pole, longitude 0 along +x, 90° E along -z,
 * the same as three.js's SphereGeometry with an equirectangular texture); distances are kilometres
 * along the surface (R = 6371 km). Velocities are tangent vectors in km/s.
 *
 * The climate is a game's, not a model: each half-degree cell is sea, lake or land, and gets a
 * terrain from its latitude, a few boxes (the deserts, the cold currents on the oceans' eastern
 * sides, the Gulf of Mexico, the Gulf Stream and the Kuroshio, Tibet) and Greenland's and Antarctica's ice:
 *   warm ocean, ocean, cold ocean, lake, tropical land, temperate land, desert, tundra & taiga, ice
 * Each storm gains or loses energy by the terrain under its centre (storms.js).
 *
 * What there is to damage (in US$):
 *   a city       its metro population x ($15,000 + 0.6 x its country's GDP per person): a rough
 *                value of what is built there, so a rich city is worth more, but not in proportion
 *   the country  1° cells of land, together worth 30% of all the cities: each cell's share follows
 *                its area and the value of the cities within 1,200 km (fading over 350 km), with a
 *                little everywhere; deserts, tundra and ice are worth less
 *
 * DOM-free: global BrawlEarth in the browser (after earth-data.js), module.exports in Node.
 */
const BrawlEarth = (() => {
  'use strict';
  const D = BRAWL_EARTH_DATA;
  const R = 6371;
  const DEG = Math.PI / 180;

  // ---------------------------------------------------------------- vectors (3-element arrays)
  const dot = (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
  const len = (a) => Math.hypot(a[0], a[1], a[2]);
  const norm = (a) => { const l = len(a) || 1; return [a[0] / l, a[1] / l, a[2] / l]; };
  const cross = (a, b) => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
  const add = (a, b, s = 1) => [a[0] + b[0] * s, a[1] + b[1] * s, a[2] + b[2] * s];
  const scale = (a, s) => [a[0] * s, a[1] * s, a[2] * s];
  const vec = (lat, lon) => [Math.cos(lat * DEG) * Math.cos(lon * DEG), Math.sin(lat * DEG), -Math.cos(lat * DEG) * Math.sin(lon * DEG)];
  const latLon = (p) => ({ lat: Math.asin(Math.max(-1, Math.min(1, p[1]))) / DEG, lon: Math.atan2(-p[2], p[0]) / DEG });
  const dist = (a, b) => R * Math.acos(Math.max(-1, Math.min(1, dot(a, b))));
  // the part of v along the surface at p
  const tangent = (p, v) => add(v, p, -dot(p, v));
  // the direction along the surface from p toward q (zero if q is p or its antipode)
  const toward = (p, q) => { const t = tangent(p, q), l = len(t); return l < 1e-9 ? [0, 0, 0] : scale(t, 1 / l); };
  // local north and east at p (east is zero at the poles)
  const north = (p) => { const t = tangent(p, [0, 1, 0]), l = len(t); return l < 1e-6 ? [1, 0, 0] : scale(t, 1 / l); };
  const east = (p) => { const e = cross([0, 1, 0], p), l = len(e); return l < 1e-6 ? [0, 0, -1] : scale(e, 1 / l); };
  // the point d km from p in the tangent direction u (a great circle)
  const along = (p, u, d) => { const a = d / R; return norm(add(scale(p, Math.cos(a)), u, Math.sin(a))); };
  // rotate the tangent vector v about p by angle a (counter-clockwise seen from above)
  const turn = (p, v, a) => { const c = Math.cos(a), s = Math.sin(a), w = cross(p, v); return [v[0] * c + w[0] * s, v[1] * c + w[1] * s, v[2] * c + w[2] * s]; };

  // ---------------------------------------------------------------- the land mask
  const MW = D.w, MH = D.h;
  const mask = new Uint8Array(MW * MH);
  {
    const b = typeof atob === 'function' ? Uint8Array.from(atob(D.mask), (c) => c.charCodeAt(0)) : Buffer.from(D.mask, 'base64');
    let i = 0, p = 0;
    while (p < b.length) {
      let x = 0, s = 1, c;
      do { c = b[p++]; x += (c & 127) * s; s *= 128; } while (c & 128);
      const n = Math.floor(x / 4);
      mask.fill(x % 4, i, i + n);
      i += n;
    }
    if (i !== MW * MH) throw new Error('earth-data.js: the land mask is ' + i + ' cells, not ' + MW * MH);
  }
  const maskAt = (lat, lon) => {
    const x = Math.min(MW - 1, Math.max(0, Math.floor((lon + 180) / 360 * MW))), y = Math.min(MH - 1, Math.max(0, Math.floor((90 - lat) / 180 * MH)));
    return mask[y * MW + x];
  };

  // ---------------------------------------------------------------- terrain
  const TERRAINS = [
    { key: 'warm', label: 'Warm ocean', sea: true },
    { key: 'sea', label: 'Ocean', sea: true },
    { key: 'cold', label: 'Cold ocean', sea: true },
    { key: 'lake', label: 'Lake', sea: true },
    { key: 'jungle', label: 'Tropical land' },
    { key: 'plains', label: 'Temperate land' },
    { key: 'desert', label: 'Desert' },
    { key: 'tundra', label: 'Tundra & taiga' },
    { key: 'ice', label: 'Ice' },
  ];
  const T = {};
  TERRAINS.forEach((t, i) => { t.id = i; T[t.key] = i; });
  // boxes [lat0, lat1, lon0, lon1]
  const BOXES = {
    deserts: [
      [15, 32, -17, 34],      // Sahara
      [13, 32, 34, 60],       // Arabia
      [24, 37, 52, 75],       // Iran, Afghanistan, the Thar
      [36, 46, 52, 68],       // Karakum and Kyzylkum
      [36, 46, 75, 112],      // Taklamakan and Gobi
      [25, 37, -117, -103],   // Mojave, Sonoran, Chihuahuan
      [-28, -17, 12, 26],     // Namib and Kalahari
      [-28, -15, -72, -68],   // Atacama
      [-50, -38, -71, -64],   // Patagonia
      [1, 12, 40, 51],        // the Horn of Africa
    ],
    outback: [-32, -19, 117, 143],   // a desert more than 150 km inland
    tibet: [28, 38, 78, 100],
    greenland: [[60, 90, -55, -20], [66, 90, -73, -12]],
  };
  const box = ([lat0, lat1, lon0, lon1]) => (lat, lon) => lat >= lat0 && lat <= lat1 && lon >= lon0 && lon <= lon1;
  const DESERTS = BOXES.deserts.map(box);
  const AUS_DESERT = box(BOXES.outback);
  const TIBET = box(BOXES.tibet);
  const COLD_CURRENTS = [[15, 42, -132, -112], [-42, -4, -92, -72], [10, 34, -26, -12], [-36, -14, 0, 15], [-36, -20, 104, 115]].map(box);
  const WARM_CURRENTS = [[17, 31, -98, -80], [23, 38, -82, -60], [23, 35, 122, 146]].map(box);   // the Gulf of Mexico, the Gulf Stream, the Kuroshio
  const GREENLAND = BOXES.greenland.map(box);
  const greenland = (lat, lon) => GREENLAND.some(f => f(lat, lon));
  function landTerrain(lat, lon, coastKm) {
    if (lat < -60 || lat > 72 || greenland(lat, lon)) return T.ice;
    if (TIBET(lat, lon)) return T.tundra;
    if (Math.abs(lat) >= 55) return T.tundra;
    if (DESERTS.some(f => f(lat, lon)) || (AUS_DESERT(lat, lon) && coastKm > 150)) return T.desert;
    if (Math.abs(lat) < 18) return T.jungle;
    return T.plains;
  }
  function seaTerrain(lat, lon) {
    const a = Math.abs(lat);
    if (lat > 78 || lat < -68) return T.ice;   // sea ice
    if (WARM_CURRENTS.some(f => f(lat, lon))) return T.warm;
    if (a < 26 && !COLD_CURRENTS.some(f => f(lat, lon))) return T.warm;
    if (a >= (lat < 0 ? 40 : 45)) return T.cold;
    return T.sea;
  }

  // the half-degree climate grid: what each cell is, and how far it is to the coast
  const TW = 720, TH = 360;
  const kind = new Uint8Array(TW * TH);        // 0 sea, 1 land, 2 lake (at the cell's centre)
  for (let y = 0; y < TH; y++) for (let x = 0; x < TW; x++) kind[y * TW + x] = maskAt(90 - (y + 0.5) / 2, (x + 0.5) / 2 - 180);
  // distance to the nearest cell of the other side (sea against land and lake), by a chamfer pass
  const coast = new Float32Array(TW * TH);
  {
    for (let i = 0; i < coast.length; i++) coast[i] = 1e9;
    const isSea = (i) => kind[i] === 0;
    for (let y = 0; y < TH; y++) for (let x = 0; x < TW; x++) {
      const i = y * TW + x;
      for (const [dx, dy] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
        const yy = y + dy;
        if (yy < 0 || yy >= TH) continue;
        if (isSea((yy * TW) + (x + dx + TW) % TW) !== isSea(i)) { coast[i] = 0; break; }
      }
    }
    const dyKm = R * 0.5 * DEG;
    const relax = (x, y, dx, dy) => {
      const yy = y + dy;
      if (yy < 0 || yy >= TH) return;
      const i = y * TW + x, j = yy * TW + (x + dx + TW) % TW;
      if (isSea(i) !== isSea(j)) return;
      const lat = 90 - (y + 0.5) / 2, dxKm = dyKm * Math.cos(lat * DEG);
      const d = coast[j] + Math.hypot(dx * dxKm, dy * dyKm);
      if (d < coast[i]) coast[i] = d;
    };
    for (let pass = 0; pass < 2; pass++) {   // twice, for the wrap at 180°
      for (let y = 0; y < TH; y++) for (let x = 0; x < TW; x++) { relax(x, y, -1, 0); relax(x, y, -1, -1); relax(x, y, 0, -1); relax(x, y, 1, -1); }
      for (let y = TH - 1; y >= 0; y--) for (let x = TW - 1; x >= 0; x--) { relax(x, y, 1, 0); relax(x, y, 1, 1); relax(x, y, 0, 1); relax(x, y, -1, 1); }
    }
  }
  const terrainGrid = new Uint8Array(TW * TH);
  for (let y = 0; y < TH; y++) for (let x = 0; x < TW; x++) {
    const i = y * TW + x, lat = 90 - (y + 0.5) / 2, lon = (x + 0.5) / 2 - 180;
    terrainGrid[i] = kind[i] === 1 ? landTerrain(lat, lon, coast[i]) : kind[i] === 2 ? T.lake : seaTerrain(lat, lon);
  }
  const cell = (lat, lon) => Math.min(TH - 1, Math.max(0, Math.floor((90 - lat) * 2))) * TW + Math.min(TW - 1, Math.max(0, Math.floor((lon + 180) * 2)));
  const terrainAt = (p) => { const { lat, lon } = latLon(p); return terrainGrid[cell(lat, lon)]; };
  const coastKmAt = (p) => { const { lat, lon } = latLon(p); return coast[cell(lat, lon)]; };

  // ---------------------------------------------------------------- cities
  const cities = D.cities.map(([name, country, lat, lon, pop, gdp], i) => {
    const c = cell(lat, lon);
    return {
      i, name, country, lat, lon, pop, gdp, p: vec(lat, lon),
      value: pop * (15000 + 0.6 * gdp),
      coastal: kind[c] === 0 || coast[c] < 80,
      terrain: landTerrain(lat, lon, kind[c] === 1 ? coast[c] : 0),
    };
  });
  const cityValue = cities.reduce((s, c) => s + c.value, 0);
  // 5° buckets for finding the cities near a point
  const BW = 72, BH = 36;
  const buckets = Array.from({ length: BW * BH }, () => []);
  for (const c of cities) buckets[Math.min(BH - 1, Math.floor((90 - c.lat) / 5)) * BW + Math.min(BW - 1, Math.floor((c.lon + 180) / 5))].push(c.i);
  // fn(index) for each cell of a rows x cols grid over the globe (5° buckets, 1° cells) that may hold
  // a point within km of p: the rows the circle spans, and in each the longitudes of its widest part,
  // asin(sin(radius) / cos(lat)) either side (all of them if it takes in a pole)
  function scan(p, km, rows, cols, fn) {
    const { lat, lon } = latLon(p), deg = km / (R * DEG), size = 180 / rows;
    const y0 = Math.max(0, Math.floor((90 - lat - deg) / size)), y1 = Math.min(rows - 1, Math.floor((90 - lat + deg) / size));
    const span = deg >= 90 - Math.abs(lat) ? 180 : Math.asin(Math.min(1, Math.sin(deg * DEG) / Math.cos(lat * DEG))) / DEG;
    for (let y = y0; y <= y1; y++) {
      if (span >= 180 - size) { for (let x = 0; x < cols; x++) fn(y * cols + x); continue; }
      const x0 = Math.floor((lon - span + 180) / size), x1 = Math.floor((lon + span + 180) / size);
      for (let x = x0; x <= x1; x++) fn(y * cols + ((x % cols) + cols) % cols);
    }
  }
  function citiesNear(p, km, fn) {
    const cmin = Math.cos(km / R);
    scan(p, km + 400, BH, BW, (b) => { for (const i of buckets[b]) { const d = dot(p, cities[i].p); if (d >= cmin) fn(cities[i], R * Math.acos(Math.min(1, d))); } });
  }

  // ---------------------------------------------------------------- the countryside (1° cells)
  const RW = 360, RH = 180;
  const ruralP = new Float32Array(RW * RH * 3);
  const ruralValue = new Float64Array(RW * RH);
  const ruralTerrain = new Uint8Array(RW * RH);
  {
    const dev = new Float64Array(RW * RH), land = new Float32Array(RW * RH);
    for (let y = 0; y < RH; y++) for (let x = 0; x < RW; x++) {
      const i = y * RW + x, lat = 89.5 - y, lon = x + 0.5 - 180, v = vec(lat, lon);
      ruralP.set(v, i * 3);
      let n = 0;
      for (let k = 0; k < 4; k++) if (kind[(y * 2 + (k >> 1)) * TW + x * 2 + (k & 1)] === 1) n++;
      land[i] = n / 4;
      ruralTerrain[i] = n ? landTerrain(lat, lon, coast[cell(lat, lon)]) : seaTerrain(lat, lon);
    }
    for (const c of cities) {
      scan(c.p, 1200, RH, RW, (i) => {
        if (!land[i]) return;
        const d = dist(c.p, [ruralP[i * 3], ruralP[i * 3 + 1], ruralP[i * 3 + 2]]);
        if (d < 1200) dev[i] += c.value * Math.exp(-d / 350);
      });
    }
    let mean = 0, nLand = 0;
    for (let i = 0; i < dev.length; i++) if (land[i]) { mean += dev[i]; nLand++; }
    mean /= nLand;
    const worth = { desert: 0.3, tundra: 0.4, ice: 0.05 };
    let sum = 0;
    for (let y = 0; y < RH; y++) for (let x = 0; x < RW; x++) {
      const i = y * RW + x;
      if (!land[i]) continue;
      ruralValue[i] = land[i] * Math.cos((89.5 - y) * DEG) * (dev[i] + 0.1 * mean) * (worth[TERRAINS[ruralTerrain[i]].key] || 1);
      sum += ruralValue[i];
    }
    for (let i = 0; i < ruralValue.length; i++) ruralValue[i] *= 0.3 * cityValue / sum;
  }
  const ruralNear = (p, km, fn) => {
    const cmin = Math.cos(km / R);
    scan(p, km + 120, RH, RW, (i) => {
      if (!ruralValue[i]) return;
      const d = p[0] * ruralP[i * 3] + p[1] * ruralP[i * 3 + 1] + p[2] * ruralP[i * 3 + 2];
      if (d >= cmin) fn(i, R * Math.acos(Math.min(1, d)));
    });
  };
  const ruralTotal = ruralValue.reduce((s, v) => s + v, 0);

  // a seeded random number generator (mulberry32): () -> [0, 1)
  function rng(seed) {
    let a = seed >>> 0;
    return () => { a = (a + 0x6D2B79F5) >>> 0; let t = a; t = Math.imul(t ^ (t >>> 15), t | 1); t ^= t + Math.imul(t ^ (t >>> 7), t | 61); return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
  }

  return {
    R, DEG, dot, len, norm, cross, add, scale, vec, latLon, dist, tangent, toward, north, east, along, turn,
    MW, MH, mask, maskAt, TW, TH, kind, coast, terrainGrid, TERRAINS, T, BOXES, terrainAt, coastKmAt, landTerrain,
    cities, cityValue, citiesNear, RW, RH, ruralP, ruralValue, ruralTerrain, ruralNear, ruralTotal, rng,
  };
})();
if (typeof module === 'object' && module.exports) module.exports = BrawlEarth;
