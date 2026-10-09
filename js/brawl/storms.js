/* The Hurricane Brawl game's six storms: what feeds each one, how big and fast it is, how hard it
 * hits, and its special move.
 *
 *   gain     energy per second (of 100) by the terrain under the storm's centre (earth.js):
 *            a hurricane feeds on warm ocean and dies over land, a tornado the other way round
 *   rMin/rMax  the radius (km) at no energy and at full energy
 *   speed    cruising speed (km/s along the surface; boost is x1.9); accel how quickly it answers
 *   power    the share of a city's remaining value it wrecks per second, at the storm's centre and at
 *            full energy (it falls off to nothing at the edge: 1 - (d/r)^2)
 *   hits     a multiplier on that by the city's terrain, and for coastal cities
 *   drift    how much the prevailing winds carry it (trade winds to the west in the tropics,
 *            westerlies to the east further out)
 *   special  its move, and the seconds before it can be used again
 *
 * Who beats whom (x1.5 in a brawl, and x0.7 the other way): each storm beats the next one round the
 * circle sandstorm > hurricane > wildfire > blizzard > tornado > supercell > sandstorm.
 *
 * DOM-free: global BrawlStorms in the browser, module.exports in Node.
 */
const BrawlStorms = (() => {
  'use strict';
  //            warm   sea  cold  lake  jungle plains desert tundra ice
  const g = (warm, sea, cold, lake, jungle, plains, desert, tundra, ice) => ({ warm, sea, cold, lake, jungle, plains, desert, tundra, ice });
  const TYPES = {
    hurricane: {
      name: 'Hurricane', scale: (c) => c ? 'Cat ' + c : 'Tropical storm', color: '#e9f4ff',
      blurb: 'The biggest storm on Earth. Feeds on warm ocean and falls apart over land, so strike the coasts and get back out to sea.',
      gain: g(6, -1.5, -5, -3, -4, -5, -7, -6, -7),
      rMin: 280, rMax: 760, speed: 380, accel: 2.2, power: 0.12, drift: 1,
      hits: { coastal: 1.7, land: 0.55 },
      special: { key: 'surge', name: 'Storm surge', cooldown: 10, text: 'A ring of wind and sea bursts out, flinging storms back and flooding every coastal city it reaches.' },
    },
    tornado: {
      name: 'Tornado', scale: (c) => 'EF' + c, color: '#8d8f96',
      blurb: 'Small, fast and violent. Lives on the open plains and dies over the sea. Its dash tears through cities and rivals.',
      gain: g(-4, -5, -6, -3, 3, 6, -1, -2, -5),
      rMin: 110, rMax: 240, speed: 560, accel: 4, power: 0.36, drift: 0.4,
      hits: { plains: 1.2 },
      special: { key: 'dash', name: 'Twister dash', cooldown: 6, text: 'A second at three times the speed, hitting harder and taking less.' },
    },
    blizzard: {
      name: 'Blizzard', scale: (c) => c ? 'RSI ' + c : 'Snow squall', color: '#cfe9ff',
      blurb: 'A wall of snow from the far north. Strong over ice, tundra and cold seas; it can cross temperate land but melts in the tropics.',
      gain: g(-6, -1, 4, 1, -6, 2.5, -4, 5, 6),
      rMin: 300, rMax: 700, speed: 350, accel: 2, power: 0.15, drift: 1,
      hits: { tundra: 1.3, plains: 1.2, jungle: 0.5, desert: 0.6 },
      special: { key: 'whiteout', name: 'Whiteout', cooldown: 12, text: 'Freezes everything around it for five seconds: rivals inside crawl and drain away.' },
    },
    sandstorm: {
      name: 'Sandstorm', scale: (c) => c ? 'Haboob ' + c : 'Dust devil', color: '#d9a35f',
      blurb: 'A haboob off the great deserts. Strong over sand, fading slowly elsewhere. Its dust wall rolls out ahead of it.',
      gain: g(-5, -5, -6, -4, -3.5, -2, 7, -2, -5),
      rMin: 230, rMax: 580, speed: 440, accel: 2.6, power: 0.13, drift: 0.7,
      hits: { desert: 1.4 },
      special: { key: 'haboob', name: 'Dust wall', cooldown: 8, text: 'A wall of dust 2,000 km long rolls out ahead, battering storms and cities in its way.' },
    },
    supercell: {
      name: 'Supercell', scale: (c) => c ? 'Level ' + c : 'Thunderstorm', color: '#7a86a8',
      blurb: 'A rotating thunderstorm that does well almost anywhere warm and wet. Calls lightning down far from itself.',
      gain: g(3, 0, -3, 1, 4, 4, -3, -1, -5),
      rMin: 170, rMax: 430, speed: 470, accel: 3, power: 0.14, drift: 0.8,
      hits: {},
      special: { key: 'lightning', name: 'Lightning', cooldown: 6, text: 'Three bolts up to 2,600 km away, where you aim (or at the nearest rival).' },
    },
    wildfire: {
      name: 'Wildfire', scale: (c) => c ? 'Level ' + c : 'Brush fire', color: '#ff7a2e',
      blurb: 'A firestorm that makes its own weather. Burns through forests and grassland; water and ice put it out.',
      gain: g(-7, -7, -7, -5, 3, 5, -2, 3, -7),
      rMin: 170, rMax: 470, speed: 360, accel: 2.4, power: 0.12, drift: 0.3,
      hits: { coastal: 0.8, desert: 0.6 },
      special: { key: 'firestorm', name: 'Firestorm', cooldown: 11, text: 'Sets the ground round it alight for seven seconds: cities and rivals there burn.' },
    },
  };
  const ORDER = ['hurricane', 'tornado', 'blizzard', 'sandstorm', 'supercell', 'wildfire'];
  // each beats the next: sandstorm > hurricane > wildfire > blizzard > tornado > supercell > sandstorm
  const CIRCLE = ['sandstorm', 'hurricane', 'wildfire', 'blizzard', 'tornado', 'supercell'];
  const WHY = {
    sandstorm: 'Dry desert dust starves a hurricane',
    hurricane: 'Torrential rain drowns a fire',
    wildfire: 'Fire melts the snow',
    blizzard: 'Cold, stable air kills a tornado’s updraft',
    tornado: 'A tornado tears the storm’s updraft apart',
    supercell: 'Rain washes the dust out of the air',
  };
  for (const k of ORDER) { TYPES[k].key = k; }
  const beats = (a) => CIRCLE[(CIRCLE.indexOf(a) + 1) % CIRCLE.length];
  const beatenBy = (a) => CIRCLE[(CIRCLE.indexOf(a) + CIRCLE.length - 1) % CIRCLE.length];
  const MATCH = { strong: 1.5, weak: 0.7 };
  // the multiplier on what storm type a does to storm type b in a brawl
  const matchup = (a, b) => beats(a) === b ? MATCH.strong : beats(b) === a ? MATCH.weak : 1;
  // the category (0-5) for energy E (of 100)
  const category = (E) => E >= 90 ? 5 : E >= 75 ? 4 : E >= 58 ? 3 : E >= 40 ? 2 : E >= 20 ? 1 : 0;
  // names for the storms in a match: not any storm's retired name
  const NAMES = ['Ava', 'Bram', 'Cora', 'Dex', 'Elio', 'Fern', 'Gus', 'Hana', 'Ivo', 'Juno', 'Kai', 'Lia', 'Milo', 'Nell', 'Otto', 'Pia', 'Rex', 'Sol', 'Tess', 'Vito', 'Wren'];
  // the storms' colours in a match: the player's first
  const COLORS = ['#38d4ff', '#ff5a4f', '#ffc23d', '#a98bff', '#5fe08a', '#ff7ad9'];
  return { TYPES, ORDER, CIRCLE, WHY, beats, beatenBy, matchup, MATCH, category, NAMES, COLORS };
})();
if (typeof module === 'object' && module.exports) module.exports = BrawlStorms;
